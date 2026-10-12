// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { InstallationMetadata } from "../types/session";
import { logger } from "../seams/logger";
import { decodeJwtClaims } from "./jwtClaims";
import { getKiroCliDbPath, getKiroStateDbPath } from "./pathResolver";
import { openVendorDb, type VendorDb } from "./sqliteReader";
import { redactSecrets } from "../redaction/secrets";

// ── Claude Code telemetry event shape ───────────────────────────────────────

interface TelemetryEventData {
  email?: string;
  auth?: {
    organization_uuid?: string;
    account_uuid?: string;
  };
  device_id?: string;
  entrypoint?: string;
  version?: string;
  env?: {
    platform?: string;
    is_claude_ai_auth?: boolean;
  };
  model?: string;
}

interface TelemetryEvent {
  event_data?: TelemetryEventData;
}

// Rough heuristic: is a given model name an Opus variant? Opus access implies
// Pro / Team / Enterprise; non-Opus alone is ambiguous between Free and Pro.
//
// Rule source: Anthropic's public pricing (https://www.anthropic.com/pricing)
// gates Opus access behind the paid Claude Pro / Team / Enterprise plans —
// Free-tier users cannot invoke Opus models. Substring match on "opus"
// deliberately accepts future Opus variants (claude-opus-4-7, claude-opus-5,
// etc.) without code churn. The heuristic is wrong if that gating changes.
function isOpusModel(model: string | undefined): boolean {
  return typeof model === "string" && model.toLowerCase().includes("opus");
}

// ── Claude Code session file shape ──────────────────────────────────────────

// A file under ~/.claude/sessions/. The filename is the PID (e.g. 59251.json);
// the session it describes is identified by the inner `sessionId`, never the
// filename. `kind` is "interactive" or "background" (headless).
interface SessionFile {
  sessionId?: string;
  kind?: string;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Detects plan tier from Claude Code telemetry files.
 *
 * CC writes `1p_failed_events.*.json` JSONL files into `<claudeDir>/telemetry/`
 * any time its first-party telemetry upload to Anthropic fails — which happens
 * routinely on most machines. The files exist regardless of whether the user
 * enabled CLAUDE_CODE_ENABLE_TELEMETRY, and contain hundreds of `tengu_*`
 * events per file. Only a small fraction (~1–2%) of these events — lifecycle
 * events like `tengu_init`, `tengu_started`, `tengu_shell_set_cwd` — carry the
 * `event_data.auth.{organization_uuid, account_uuid}` fields that pin down
 * team tier. The rest (api_query, tool_use, etc.) omit `auth` entirely.
 *
 * Reading only the last line of the newest file misses the auth event almost
 * always, so this scans every event in every file, newest → oldest, returning
 * as soon as it finds an auth-bearing event. Cost is bounded by the vendor's
 * file rotation (on the order of 14 files × ~60 events).
 *
 * When no auth event is found but any model was seen, we fall back to
 * model-based inference — Opus access implies Pro/Team, everything else
 * collapses to "pro_or_free". Returns null only when the telemetry dir is
 * missing entirely or contains zero parseable events.
 */
export function detectClaudeCodeTier(claudeDir: string): InstallationMetadata | null {
  try {
    const telemetryDir = join(claudeDir, "telemetry");

    let entries: { name: string; mtimeMs: number }[];
    try {
      entries = readdirSync(telemetryDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".json"))
        .map((d) => {
          const fullPath = join(telemetryDir, d.name);
          const s = statSync(fullPath);
          return { name: d.name, mtimeMs: s.mtimeMs };
        });
    } catch {
      return null; // telemetry dir doesn't exist
    }

    if (entries.length === 0) return null;
    // Newest file first — most recent session is likeliest to carry the
    // current auth context.
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

    // Track fallback signals while scanning. If we never hit an auth event,
    // these let us still emit something better than null.
    let latestEventData: TelemetryEventData | null = null;
    let sawOpusModel = false;
    let sawAnyModel = false;

    for (const entry of entries) {
      let content: string;
      try {
        content = readFileSync(join(telemetryDir, entry.name), "utf-8");
      } catch {
        continue;
      }

      // Within a file, iterate newest → oldest so the first auth hit
      // reflects the most recent session, not the oldest.
      const lines = content.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i]!.trim();
        if (trimmed.length === 0) continue;

        let event: TelemetryEvent;
        try {
          event = JSON.parse(trimmed) as TelemetryEvent;
        } catch {
          continue; // malformed line — skip, keep scanning
        }

        const data = event.event_data;
        if (!data) continue;

        if (!latestEventData) latestEventData = data;
        if (typeof data.model === "string" && data.model.length > 0) {
          sawAnyModel = true;
          if (isOpusModel(data.model)) sawOpusModel = true;
        }

        const orgUuid = data.auth?.organization_uuid;
        if (orgUuid && orgUuid.length > 0) {
          return buildClaudeCodeMetadata(data, orgUuid, "cc_telemetry_inferred");
        }
      }
    }

    // No auth event found across any file. Fall back to model-based inference
    // when we at least saw a model name — still better than unknown because
    // Opus access is a hard signal for paid tier.
    if (latestEventData && sawAnyModel) {
      const planTier = sawOpusModel ? "pro" : "pro_or_free";
      return buildClaudeCodeMetadata(latestEventData, undefined, "cc_model_inferred", planTier);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Assembles the InstallationMetadata payload for a Claude Code session.
 * When orgUuid is provided, tier is "team"; otherwise the caller supplies an
 * inferred tier.
 */
function buildClaudeCodeMetadata(
  data: TelemetryEventData,
  orgUuid: string | undefined,
  planTierSource: string,
  inferredPlanTier?: string,
): InstallationMetadata {
  const planTier = orgUuid && orgUuid.length > 0
    ? "team"
    : inferredPlanTier ?? (isOpusModel(data.model) ? "pro" : "pro_or_free");

  const metadata: InstallationMetadata = {
    plan_tier: planTier,
    plan_tier_source: planTierSource,
  };

  if (typeof data.email === "string" && data.email.length > 0) {
    metadata.login_email = data.email;
  }
  if (typeof data.device_id === "string" && data.device_id.length > 0) {
    metadata.device_id = data.device_id;
  }
  if (typeof data.entrypoint === "string" && data.entrypoint.length > 0) {
    metadata.entrypoint = data.entrypoint;
  }
  if (typeof data.version === "string" && data.version.length > 0) {
    metadata.cc_version = data.version;
  }
  if (typeof data.env?.platform === "string" && data.env.platform.length > 0) {
    metadata.platform = data.env.platform;
  }
  if (typeof data.env?.is_claude_ai_auth === "boolean") {
    metadata.is_oauth_auth = data.env.is_claude_ai_auth;
  }
  if (typeof orgUuid === "string" && orgUuid.length > 0) {
    metadata.organization_uuid = orgUuid;
  }
  const accountUuid = data.auth?.account_uuid;
  if (typeof accountUuid === "string" && accountUuid.length > 0) {
    metadata.account_uuid = accountUuid;
  }

  return metadata;
}

// ── Claude Code authoritative account record (~/.claude.json `oauthAccount`) ───

interface ClaudeOauthAccount {
  seatTier?: string;
  organizationType?: string;
  billingType?: string;
  organizationRole?: string;
  organizationRateLimitTier?: string;
  userRateLimitTier?: string;
  subscriptionCreatedAt?: string;
  organizationUuid?: string;
  accountUuid?: string;
  emailAddress?: string;
  hasExtraUsageEnabled?: boolean;
}

interface ClaudeConfigFile {
  oauthAccount?: ClaudeOauthAccount;
}

/**
 * Reads the authoritative Claude Code account record from `~/.claude.json`.
 *
 * Unlike `detectClaudeCodeTier` (which *infers* a tier from telemetry/model
 * usage), this returns the RAW `oauthAccount` fields verbatim — the canonical
 * plan_tier is derived from `seatTier`/`organizationType` on a consumer, so we
 * deliberately do NOT compute plan_tier here. Returned fields are MERGED onto
 * the conversation's installation metadata after the inferred cascade runs, so
 * they never blank an already-resolved plan_tier.
 *
 * Returns null when the file is missing, unparseable, or has no `oauthAccount`.
 *
 * Security: `~/.claude.json` also holds OAuth tokens at the top level. We parse
 * the file but only ever read `oauthAccount`, and never log the raw file, the
 * parsed object, or any non-whitelisted key.
 */
export function detectClaudeCodeOAuthAccount(configPath: string): InstallationMetadata | null {
  try {
    if (!existsSync(configPath)) return null;

    let parsed: ClaudeConfigFile;
    try {
      parsed = JSON.parse(readFileSync(configPath, "utf-8")) as ClaudeConfigFile;
    } catch {
      return null; // malformed JSON — fall through to inferred sources
    }

    const account = parsed.oauthAccount;
    if (!account || typeof account !== "object") return null;

    const asNonEmptyString = (value: unknown): string | undefined =>
      typeof value === "string" && value.length > 0 ? value : undefined;

    // subscription_created_at must be a valid RFC-3339 string, so a consumer that
    // parses it as a timestamp does not reject the row. Normalize via Date and drop
    // anything unparseable rather than forwarding it raw.
    const asRfc3339Timestamp = (value: unknown): string | undefined => {
      const rawValue = asNonEmptyString(value);
      if (rawValue === undefined) return undefined;
      const epochMs = Date.parse(rawValue);
      return Number.isNaN(epochMs) ? undefined : new Date(epochMs).toISOString();
    };

    const metadata: InstallationMetadata = {};
    metadata.seat_tier = asNonEmptyString(account.seatTier);
    metadata.organization_type = asNonEmptyString(account.organizationType);
    metadata.billing_type = asNonEmptyString(account.billingType);
    metadata.organization_role = asNonEmptyString(account.organizationRole);
    metadata.organization_rate_limit_tier = asNonEmptyString(account.organizationRateLimitTier);
    metadata.user_rate_limit_tier = asNonEmptyString(account.userRateLimitTier);
    metadata.subscription_created_at = asRfc3339Timestamp(account.subscriptionCreatedAt);
    // oauthAccount is also the authoritative source for these already-captured ids
    // and the account email (login_email; authoritative over the telemetry email).
    metadata.organization_uuid = asNonEmptyString(account.organizationUuid);
    metadata.account_uuid = asNonEmptyString(account.accountUuid);
    metadata.login_email = asNonEmptyString(account.emailAddress);
    // Boolean flag — keep an explicit false; only drop when the key is absent.
    metadata.has_extra_usage_enabled =
      typeof account.hasExtraUsageEnabled === "boolean" ? account.hasExtraUsageEnabled : undefined;

    // Drop undefined keys so a later Object.assign merge never overwrites an
    // existing value with undefined, and so "nothing usable" is detectable.
    for (const key of Object.keys(metadata) as (keyof InstallationMetadata)[]) {
      if (metadata[key] === undefined) delete metadata[key];
    }
    if (Object.keys(metadata).length === 0) return null;

    return metadata;
  } catch {
    return null;
  }
}

// ── Cursor Statsig account record (`user.custom`) ────────────────────────────

/** Raw shape of the Statsig `user.custom` object; every field is untrusted. */
interface CursorStatsigCustom {
  isEnterpriseUser?: unknown;
  isEnterpriseTrialUser?: unknown;
  teamID?: unknown;
  teamRole?: unknown;
}

/**
 * Extracts Cursor's raw team/enterprise account fields from a parsed Statsig
 * bootstrap object (`{ user: { custom: … } }`).
 *
 * Both Cursor surfaces expose the identical object — the IDE under state.vscdb's
 * `workbench.experiments.statsigBootstrap` key, the CLI under `data` in
 * ~/.cursor/statsig-cache.json — so both ship the same raw fields and the
 * consumer derives one canonical tier from them. These fields, not
 * `stripeMembershipType`, are what separate a priceable self-serve Teams seat
 * from an unpriceable negotiated Enterprise contract.
 *
 * Never throws: any shape carrying none of the fields yields an empty object, so
 * a malformed blob degrades to "no fields" rather than failing extraction.
 */
export function extractCursorStatsigAccount(bootstrap: unknown): Partial<InstallationMetadata> {
  const metadata: Partial<InstallationMetadata> = {};
  if (bootstrap === null || typeof bootstrap !== "object") return metadata;

  const user = (bootstrap as { user?: unknown }).user;
  if (user === null || typeof user !== "object") return metadata;

  // Read before the `custom` guard: userID sits one level up, so a blob missing
  // `custom` still yields the account identity.
  const userID = (user as { userID?: unknown }).userID;
  if (typeof userID === "string" && userID.length > 0) {
    metadata.cursor_user_id = userID;
  }

  const custom = (user as { custom?: unknown }).custom;
  if (custom === null || typeof custom !== "object") return metadata;
  const fields = custom as CursorStatsigCustom;

  if (typeof fields.isEnterpriseUser === "boolean") {
    metadata.is_enterprise_user = fields.isEnterpriseUser;
  }
  if (typeof fields.isEnterpriseTrialUser === "boolean") {
    metadata.is_enterprise_trial_user = fields.isEnterpriseTrialUser;
  }
  // Cursor emits teamID as a NUMBER; the wire field is a string. Reject
  // NaN/Infinity, which would stringify into a meaningless team id. A string is
  // accepted too in case the vendor ever changes the JSON type.
  if (typeof fields.teamID === "number" && Number.isFinite(fields.teamID)) {
    metadata.cursor_team_id = String(fields.teamID);
  } else if (typeof fields.teamID === "string" && fields.teamID.length > 0) {
    metadata.cursor_team_id = fields.teamID;
  }
  if (typeof fields.teamRole === "string" && fields.teamRole.length > 0) {
    metadata.cursor_team_role = fields.teamRole;
  }

  return metadata;
}

/**
 * Detects Cursor installation metadata from state.vscdb via a key-reading callback.
 *
 * The caller provides a function that reads a key from the `ItemTable` table.
 * This avoids opening a second SQLite connection — the caller already has one.
 *
 * `cursorAuth/stripeMembershipType` is shipped verbatim as plan_tier, but it
 * reports "enterprise" for every team seat, so it cannot price one alone; the
 * `workbench.experiments.statsigBootstrap` blob carries the account fields that
 * separate self-serve Teams from a negotiated Enterprise contract. That blob is
 * ~500KB, which is why this whole function is resolved once per extraction cycle
 * (installation-global) rather than per conversation.
 *
 * Returns null only when no key yielded anything usable.
 */
export function detectCursorTier(
  readVscdbKey: (key: string) => string | null
): InstallationMetadata | null {
  try {
    const metadata: InstallationMetadata = {};

    const planTier = readVscdbKey("cursorAuth/stripeMembershipType");
    if (planTier !== null && planTier.length > 0) {
      metadata.plan_tier = planTier;
      metadata.plan_tier_source = "cursor_vscdb";
    }

    const statsigBootstrap = readVscdbKey("workbench.experiments.statsigBootstrap");
    if (statsigBootstrap !== null && statsigBootstrap.length > 0) {
      try {
        Object.assign(metadata, extractCursorStatsigAccount(JSON.parse(statsigBootstrap)));
        // The Statsig facts are read from state.vscdb and are authoritative, so
        // they carry the same provenance as the membership string. Stamping the
        // source here matters when that string is empty — common in practice —
        // because the tier a consumer then derives from the team id would
        // otherwise be classified UNSPECIFIED despite resting on a billing fact.
        if (metadata.cursor_team_id || metadata.is_enterprise_user || metadata.is_enterprise_trial_user) {
          metadata.plan_tier_source ??= "cursor_vscdb";
        }
      } catch (err) {
        logger.warn("extraction.cursor", "statsig_bootstrap_parse_failed", {
          key: "workbench.experiments.statsigBootstrap",
          bytes: statsigBootstrap.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // A logged-out or partially-provisioned install has neither signal — nothing
    // worth attaching, and the remaining keys are all preference flags. Note
    // stripeMembershipType is empty on many installs, so this deliberately
    // does not gate on it alone: a team seat must still ship its team fields.
    if (Object.keys(metadata).length === 0) return null;

    // Identity and preference reads require a real account signal. A parsed
    // Statsig blob is not one on its own: it carries `isEnterpriseUser: false` on
    // ordinary individual accounts, so gating merely on "the blob parsed" would
    // attach an email address to installs reporting no plan and no team. An
    // enterprise flag counts even without a team id or membership string — it is
    // the highest-precedence tier signal, and a trial account can carry it with
    // neither.
    const hasAccountSignal =
      Boolean(metadata.plan_tier) ||
      Boolean(metadata.cursor_team_id) ||
      metadata.is_enterprise_user === true ||
      metadata.is_enterprise_trial_user === true;
    if (!hasAccountSignal) return metadata;

    const email = readVscdbKey("cursorAuth/cachedEmail");
    if (email !== null && email.length > 0) {
      metadata.login_email = email;
    }

    const onboardingDate = readVscdbKey("cursorAuth/onboardingDate");
    if (onboardingDate !== null && onboardingDate.length > 0) {
      metadata.cursor_onboarding_date = onboardingDate;
    }

    const privacyMode = readVscdbKey("cursorai/donotchange/privacyMode");
    if (privacyMode !== null) {
      metadata.cursor_privacy_mode = privacyMode === "true";
    }

    const memoriesEnabled = readVscdbKey("cursor/memoriesEnabled");
    if (memoriesEnabled !== null) {
      metadata.cursor_memories_enabled = memoriesEnabled === "true";
    }

    const personalContext = readVscdbKey("aicontext.personalContext");
    if (personalContext !== null) {
      metadata.cursor_personal_context_configured = personalContext.length > 0;
    }

    // Cursor stores this as a JSON array that is commonly "[]" before
    // classification runs. A plain length check would let "[]" through and
    // falsely flag every session as classified — parse and require at least
    // one element.
    const conversationScoring = readVscdbKey("conversationClassificationScoredConversations");
    if (conversationScoring !== null && conversationScoring.length > 0) {
      try {
        const parsed = JSON.parse(conversationScoring);
        if (Array.isArray(parsed) && parsed.length > 0) {
          metadata.cursor_conversation_scoring = conversationScoring;
        }
      } catch {
        // Unexpected shape — treat as absent rather than crashing extraction.
      }
    }

    return metadata;
  } catch {
    return null;
  }
}

/**
 * Maps each Claude Code session's id to its kind ("interactive" or "background")
 * by reading every `<claudeDir>/sessions/*.json`.
 *
 * session_kind is a PER-SESSION fact, so it is keyed by the file's inner
 * `sessionId` — not the filename (CC names these files by PID) and not a single
 * newest file, which would stamp one machine-wide kind onto every session in
 * a batch. Files are read newest-first so that if two files ever carry the same
 * session id (a resumed session under a new PID while the old PID's file
 * lingers) the most recent kind wins deterministically, not by directory order.
 * A file that is unreadable, not valid JSON, not an object, or missing
 * `sessionId`/`kind` is skipped.
 *
 * Returns an empty map when the sessions directory is missing or unreadable.
 * The directory holds only currently-live/recent sessions, so a session absent
 * from it has no known kind rather than a guessed one.
 */
export function detectClaudeCodeSessionKinds(claudeDir: string): Map<string, string> {
  const kinds = new Map<string, string>();
  const sessionsDir = join(claudeDir, "sessions");

  let entries: { name: string; mtimeMs: number }[];
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".json"))
      // stat per entry, skipping any file that vanished between readdir and stat.
      // CC prunes this directory as its own sessions end, concurrently with this
      // scan, so letting one stat failure abort the whole map would drop the
      // kinds of every other live session in the cycle.
      .flatMap((d) => {
        try {
          return [{ name: d.name, mtimeMs: statSync(join(sessionsDir, d.name)).mtimeMs }];
        } catch (err) {
          // Benign, expected race: CC prunes this dir as its own sessions end.
          // Logged (not silently dropped) so a non-transient stat failure is
          // still visible, at debug to avoid noise on the normal prune case.
          logger.debug("extraction.claude_code", "session_kind_stat_skip", {
            file: d.name,
            error: err instanceof Error ? err.message : String(err),
          });
          return [];
        }
      });
  } catch {
    return kinds; // sessions dir doesn't exist
  }

  entries.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first → newest wins

  for (const { name } of entries) {
    let parsed: SessionFile | null;
    try {
      parsed = JSON.parse(readFileSync(join(sessionsDir, name), "utf-8")) as SessionFile | null;
    } catch (err) {
      // Unreadable or malformed session file — an anomaly worth surfacing: it
      // leaves a live session's kind unknown with no other trace.
      logger.warn("extraction.claude_code", "session_kind_parse_error", {
        file: name,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    // Optional chaining guards a file whose content is a bare JSON `null`
    // (valid JSON, so JSON.parse does not throw) — destructuring it would.
    const sessionId = parsed?.sessionId;
    const kind = parsed?.kind;
    if (
      typeof sessionId === "string" && sessionId.length > 0 &&
      typeof kind === "string" && kind.length > 0 &&
      !kinds.has(sessionId)
    ) {
      kinds.set(sessionId, kind);
    }
  }

  return kinds;
}

// ── Copilot VS Code ───────────────────────────────────────────────────────────

/**
 * Maps a raw copilotSku value from state.vscdb to a normalised plan tier string.
 * New SKUs from GitHub may appear over time; unknown values fall back to "unknown"
 * so we don't silently drop the field.
 */
function copilotSkuToTier(sku: string): string {
  if (sku.includes("business") || sku.includes("enterprise")) return "team";
  if (sku.includes("individual") || sku.includes("pro")) return "pro";
  if (sku.includes("free")) return "free";
  return "unknown";
}

/**
 * Reads Copilot installation metadata from a VS Code variant's state.vscdb.
 *
 * Opens the SQLite DB read-only and reads:
 *   extensionsAssignmentFilterProvider.copilotSku   → plan_tier
 *   GitHub.copilot (JSON)                           → cc_version (installedVersion)
 *   extensionsAssignmentFilterProvider.copilotTrackingId → device_id
 *
 * Returns null if the DB is absent, locked, or has no Copilot keys.
 */
// Vendor state values read below (VS Code, Kiro) have no documented format and
// are stored as installation metadata, so each is accepted only in the shape it is
// known to have; anything else is dropped rather than sent.
const COPILOT_TRACKING_ID = /^[0-9a-f]{32}$/i;
// A release version such as "1.388.0" or "1.388.0-insiders".
const RELEASE_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,32})?$/;
// A model id, optionally vendor-prefixed: "copilot/gpt-4.1", "claude-sonnet-4-6".
const COPILOT_MODEL_ID = /^(?:[a-z0-9-]{1,32}\/)?[a-z0-9][a-z0-9.-]{0,79}$/;
// A device or machine id: a UUID, or a hex digest.
const DEVICE_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,64})$/i;
const LOGIN_EMAIL = /^[^\s@{}[\]"'<>]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
// VS Code's built-in chat modes; a user-named custom mode is not sent.
const COPILOT_CHAT_MODES = new Set(["ask", "agent", "edit"]);

// A value is sent only in its known shape and only if the secret scrubber leaves
// it untouched. The scrubber knows vendor-prefixed token formats; an unprefixed
// hex string is indistinguishable from the tracking id these keys hold.
function acceptShape(value: unknown, shape: RegExp): string | undefined {
  return typeof value === "string" && shape.test(value) && redactSecrets(value) === value ? value : undefined;
}

export function detectCopilotVSCodeMetadata(dbPath: string): InstallationMetadata | null {
  if (!existsSync(dbPath)) return null;
  try {
    const db = openVendorDb(dbPath, 3000);

    const read = (key: string): string | null => {
      try {
        const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key) as { value: string } | undefined;
        return row ? row.value : null;
      } catch {
        return null;
      }
    };

    try {
      const metadata: InstallationMetadata = { entrypoint: "copilot-vscode" };

      const sku = read("extensionsAssignmentFilterProvider.copilotSku");
      if (sku && sku.length > 0) {
        metadata.plan_tier = copilotSkuToTier(sku);
        metadata.plan_tier_source = "copilot_vscode_vscdb";
      }

      const copilotRaw = read("GitHub.copilot");
      if (copilotRaw) {
        try {
          const parsed = JSON.parse(copilotRaw) as Record<string, unknown>;
          const version = acceptShape(parsed["installedVersion"], RELEASE_VERSION);
          if (version !== undefined) metadata.cc_version = version;
        } catch { /* malformed JSON */ }
      }

      const trackingId = acceptShape(read("extensionsAssignmentFilterProvider.copilotTrackingId"), COPILOT_TRACKING_ID);
      if (trackingId !== undefined) metadata.device_id = trackingId;

      const defaultModel = acceptShape(read("chat.currentLanguageModel.panel"), COPILOT_MODEL_ID);
      if (defaultModel !== undefined) metadata.default_model = defaultModel;

      const lastChatMode = read("chat.lastChatMode");
      if (lastChatMode !== null && COPILOT_CHAT_MODES.has(lastChatMode)) metadata.last_chat_mode = lastChatMode;

      return Object.keys(metadata).length > 1 ? metadata : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

// ── Copilot CLI ───────────────────────────────────────────────────────────────

export interface CopilotCLIContext {
  cwd?: string;
  gitRoot?: string;
  branch?: string;
  headCommit?: string;
  repository?: string;
  startTime?: string;
}

/**
 * Reads Copilot CLI installation metadata and session context from a session's events.jsonl.
 *
 * Scans the file for the `session.start` event, which carries `copilotVersion` and
 * a structured `context` object with git/workspace fields.
 *
 * Returns null if the file is missing or the event is absent.
 */
export function detectCopilotCLIMetadata(
  eventsJsonlPath: string
): { installMeta: InstallationMetadata; cliContext: CopilotCLIContext } | null {
  if (!existsSync(eventsJsonlPath)) return null;
  try {
    const lines = readFileSync(eventsJsonlPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0);

    for (const line of lines) {
      let ev: Record<string, unknown>;
      try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (ev["type"] !== "session.start") continue;

      const data = ev["data"];
      if (!data || typeof data !== "object") continue;
      const d = data as Record<string, unknown>;

      const installMeta: InstallationMetadata = { entrypoint: "copilot-cli" };
      if (typeof d["copilotVersion"] === "string" && d["copilotVersion"].length > 0) {
        installMeta.cc_version = d["copilotVersion"];
      }

      const context = d["context"];
      const cliContext: CopilotCLIContext = {};
      if (context && typeof context === "object") {
        const ctx = context as Record<string, unknown>;
        if (typeof ctx["cwd"] === "string") cliContext.cwd = ctx["cwd"];
        if (typeof ctx["gitRoot"] === "string") cliContext.gitRoot = ctx["gitRoot"];
        if (typeof ctx["branch"] === "string") cliContext.branch = ctx["branch"];
        if (typeof ctx["headCommit"] === "string") cliContext.headCommit = ctx["headCommit"];
        if (typeof ctx["repository"] === "string") cliContext.repository = ctx["repository"];
      }
      if (typeof d["startTime"] === "string") cliContext.startTime = d["startTime"];

      return { installMeta, cliContext };
    }
    return null;
  } catch {
    return null;
  }
}

// ── Copilot JetBrains ─────────────────────────────────────────────────────────

export interface CopilotJBGlobalMetadata {
  /** GitHub username parsed from apps.json. */
  username: string | null;
  /** Plugin versions keyed by IDE code, e.g. {"copilot-intellij": "1.7.1-242"}. */
  versions: Record<string, string>;
}

/**
 * Reads the global JetBrains Copilot metadata shared across all IDE installs:
 *   ~/.config/github-copilot/apps.json   → GitHub username
 *   ~/.config/github-copilot/versions.json → plugin version per IDE code
 *
 * Call once and pass the result into detectCopilotJBMetadata per session.
 * Returns null if neither file exists.
 */
export function readCopilotJBGlobalMetadata(
  appsJsonPath: string,
  versionsJsonPath: string,
): CopilotJBGlobalMetadata | null {
  let username: string | null = null;
  const versions: Record<string, string> = {};

  if (existsSync(appsJsonPath)) {
    try {
      const raw = JSON.parse(readFileSync(appsJsonPath, "utf-8")) as Record<string, unknown>;
      // apps.json shape: { "github.com:<appId>": { user: "username", ... }, ... }
      for (const val of Object.values(raw)) {
        if (val && typeof val === "object") {
          const u = (val as Record<string, unknown>)["user"];
          if (typeof u === "string" && u.length > 0) { username = u; break; }
        }
      }
    } catch { /* malformed */ }
  }

  if (existsSync(versionsJsonPath)) {
    try {
      const raw = JSON.parse(readFileSync(versionsJsonPath, "utf-8")) as Record<string, unknown>;
      // versions.json shape: { "copilot-intellij": "1.7.1-242", ... }
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "string") versions[k] = v;
      }
    } catch { /* malformed */ }
  }

  if (username === null && Object.keys(versions).length === 0) return null;
  return { username, versions };
}

/**
 * Builds an InstallationMetadata for a specific JetBrains IDE session.
 *
 * ideCode: one of the JETBRAINS_IDE_CODES (e.g. "go", "iu", "intellij").
 * globalMeta: result of readCopilotJBGlobalMetadata (pass null to skip).
 *
 * Plugin version key in versions.json uses the pattern "copilot-<ideCode>"
 * for most IDEs; falls back to "copilot-intellij" as a common alias.
 */
export function detectCopilotJBMetadata(
  ideCode: string,
  globalMeta: CopilotJBGlobalMetadata | null,
): InstallationMetadata {
  const metadata: InstallationMetadata = { entrypoint: `copilot-jetbrains-${ideCode}` };

  if (globalMeta) {
    if (globalMeta.username) metadata.login_email = globalMeta.username;

    const versionKey = `copilot-${ideCode}`;
    const version =
      globalMeta.versions[versionKey] ??
      globalMeta.versions["copilot-intellij"] ??
      null;
    if (version) metadata.cc_version = version;
  }

  return metadata;
}

// ── Codex ─────────────────────────────────────────────────────────────────────

/**
 * Reads plan tier and login email from ~/.codex/auth.json.
 *
 * `auth_mode` is matched case-insensitively (upstream serializes it lowercase,
 * e.g. "apikey"; older builds wrote camelCase). For a ChatGPT OAuth login
 * ("chatgpt" | "chatgptauthtokens"), the plan is a namespaced claim
 * (`chatgpt_plan_type`) INSIDE the `tokens.id_token` JWT — NOT a top-level field —
 * so we base64url-decode the token payload to read it. For an API-key login
 * ("apikey"), an OpenAI key bills usage-based against the Platform with no ChatGPT
 * subscription behind it, so the tier is the dedicated "api" bucket and the key
 * TYPE (project / service-account / admin / legacy) is surfaced via planTierSource
 * for segmentation.
 *
 * Returns a sentinel object (never null) so a consumer can distinguish "no
 * Codex config" from "config present but no plan claim" — every branch attaches
 * a planTierSource a consumer can segment on.
 */
export function readCodexPlanTier(
  authJsonPath: string
): { planTier: string; planTierSource: string; loginEmail?: string } {
  // auth.json missing: return a sentinel rather than null so a consumer can
  // distinguish "no Codex config" from "Codex config present but no claim".
  // The caller still receives an object it can attach to installation_metadata;
  // dropping to null silently hides the extraction attempt.
  if (!existsSync(authJsonPath)) {
    return { planTier: "unknown", planTierSource: "codex_auth_json_missing" };
  }

  // Only file-read + JSON-parse go through the parse-error sentinel. Runtime
  // errors in the claim-inspection code (type mismatches, unexpected shapes)
  // should NOT collapse into "parse_error" — they indicate a parser bug on
  // our side, not a malformed user file. Those fall through to the outer
  // catch with a distinct "codex_auth_runtime_error" source.
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, unknown>;
  } catch {
    return { planTier: "unknown", planTierSource: "codex_auth_json_parse_error" };
  }

  try {
    // Match auth_mode case-insensitively: upstream Codex serializes the AuthMode
    // enum with serde(rename_all="lowercase") (so an API key is "apikey", not the
    // camelCase "apiKey" older builds wrote), and the spelling has drifted across
    // versions. Normalizing removes the guesswork — every casing resolves.
    const authModeRaw = raw["auth_mode"];
    const authMode = typeof authModeRaw === "string" ? authModeRaw.toLowerCase() : authModeRaw;

    if (authMode === "chatgpt" || authMode === "chatgptauthtokens") {
      // The plan lives in the id_token JWT's OpenAI-namespaced claim, not at the
      // top level of auth.json. Decode the payload and read chatgpt_plan_type.
      const tokens = raw["tokens"];
      const idToken =
        tokens && typeof tokens === "object"
          ? (tokens as Record<string, unknown>)["id_token"]
          : undefined;
      if (typeof idToken === "string" && idToken.length > 0) {
        const claims = decodeJwtClaims(idToken);
        const authClaim = claims?.["https://api.openai.com/auth"];
        if (authClaim && typeof authClaim === "object") {
          const planTypeRaw = (authClaim as Record<string, unknown>)["chatgpt_plan_type"];
          const planType = typeof planTypeRaw === "string" ? planTypeRaw : null;
          if (planType && planType.length > 0) {
            // Map ChatGPT plan names to this package's plan_tier vocabulary.
            const tierMap: Record<string, string> = {
              free: "free",
              plus: "pro",
              pro: "pro",
              team: "team",
              business: "team",
              enterprise: "enterprise",
            };
            const planTier = tierMap[planType.toLowerCase()] ?? planType;

            // Email is a standard claim on the id_token; fall back to a
            // top-level auth.json email if a future format carries one.
            let loginEmail: string | undefined;
            const emailClaim = claims?.["email"];
            if (typeof emailClaim === "string" && emailClaim.length > 0) {
              loginEmail = emailClaim;
            } else if (typeof raw["email"] === "string" && raw["email"].length > 0) {
              loginEmail = raw["email"];
            }

            return { planTier, planTierSource: "codex_auth_json", loginEmail };
          }
        }
      }
      return { planTier: "unknown", planTierSource: "codex_auth_json_no_claims" };
    }

    if (authMode === "apikey" || authMode === "api_key") {
      // OpenAI stores the key at OPENAI_API_KEY (legacy top-level api_key kept
      // as a fallback for older auth.json formats).
      const apiKeyRaw = raw["OPENAI_API_KEY"] ?? raw["api_key"];
      // An API key bills usage-based against the OpenAI Platform — there is no
      // ChatGPT subscription (free/pro/team) behind it — so these land in the
      // dedicated "api" tier, NOT a seat plan and NOT "unknown". The key PREFIX
      // records the key TYPE via the source, but it is only a weak
      // individual-vs-org signal: sk-proj- is the default for personal AND org
      // accounts, so it can't prove enterprise; only sk-svcacct- (service
      // account) / sk-admin- reliably imply an org/automation context. So we
      // surface the type for segmentation but do not claim a tier from it.
      let planTierSource = "codex_api_key_unknown";
      if (typeof apiKeyRaw === "string") {
        planTierSource = apiKeyRaw.startsWith("sk-svcacct-")
          ? "codex_api_key_svcacct"
          : apiKeyRaw.startsWith("sk-admin-")
            ? "codex_api_key_admin"
            : apiKeyRaw.startsWith("sk-proj-")
              ? "codex_api_key_proj"
              : "codex_api_key_individual";
      }
      return { planTier: "api", planTierSource };
    }

    return { planTier: "unknown", planTierSource: "codex_auth_mode_unknown" };
  } catch {
    // Not a parse error (we already parsed above) — this is a runtime failure
    // in the claim-inspection logic itself. Distinct source lets ops triage:
    // "parse_error" → malformed file on the user machine, nothing we can do.
    // "runtime_error" → bug in our parser, file it.
    return { planTier: "unknown", planTierSource: "codex_auth_runtime_error" };
  }
}

/**
 * Reads Codex installation metadata from ~/.codex/version.json.
 *
 * version.json shape: { "latest_version": "0.118.0", "last_checked_at": "...", ... }
 *
 * Returns null if the file is missing or unreadable.
 */
export function readCodexInstallationMetadata(versionJsonPath: string): InstallationMetadata | null {
  if (!existsSync(versionJsonPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(versionJsonPath, "utf-8")) as Record<string, unknown>;
    const version = raw["latest_version"];
    if (typeof version !== "string" || version.length === 0) return null;
    return { cc_version: version };
  } catch {
    return null;
  }
}

/**
 * Maps a Codex session source string to a normalised entrypoint value.
 * source comes from session_meta.source in rollout JSONL or threads.source in SQLite.
 *
 *   "vscode"   → "codex-vscode"
 *   "desktop"  → "codex-desktop"
 *   everything else (null / "cli" / unknown) → "codex-cli"
 */
export function codexSourceToEntrypoint(source: string | null | undefined): string {
  if (source === "vscode") return "codex-vscode";
  if (source === "desktop") return "codex-desktop";
  return "codex-cli";
}

// ── Kiro ──────────────────────────────────────────────────────────────────────

// Invocation limit thresholds for the Kiro desktop fallback tier inference.
// Based on AWS Q Developer standalone plan definitions (April 2026):
//   Free:       ≤50 invocations/month
//   Pro:        ≥500 invocations/month
//   Enterprise: anything between (account-provisioned seat, variable limit)
const KIRO_FREE_TIER_INVOCATION_LIMIT = 50;
const KIRO_PRO_TIER_INVOCATION_LIMIT = 500;

// Opens one of Kiro's plain SQLite files read-only.
function openKiroReadonlyDb(dbPath: string): VendorDb {
  return openVendorDb(dbPath, 3000);
}

/**
 * Returns true if the Kiro desktop state.vscdb shows an active free trial
 * (freeTrialUsage.expiryDate is present and in the future).
 *
 * The CLI DB profile_name ("Social_Default_Profile") does not encode trial
 * status — a free-trial user looks identical to a permanent free user in
 * the CLI DB. Checking state.vscdb is the only way to distinguish them.
 */
function hasKiroActiveFreeTrialInStateDb(): boolean {
  const stateDbPath = getKiroStateDbPath();
  if (!existsSync(stateDbPath)) return false;
  try {
    const db = openKiroReadonlyDb(stateDbPath);
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("kiro.kiroAgent") as { value: string } | undefined;
      if (!row?.value) return false;
      const state = JSON.parse(row.value) as Record<string, unknown>;
      const usageState = state["kiro.resourceNotifications.usageState"] as
        | Record<string, unknown>
        | undefined;
      const breakdowns = usageState?.["usageBreakdowns"] as
        | Array<{ freeTrialUsage?: { expiryDate?: string } }>
        | undefined;
      const expiryDate = breakdowns?.[0]?.freeTrialUsage?.expiryDate;
      return !!expiryDate && new Date(expiryDate) > new Date();
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * Maps a Kiro CLI profile from the state SQLite table to a plan tier. A known
 * standalone profile name maps to its tier; otherwise an AWS profile ARN marks
 * an account-provisioned profile ("enterprise"); a profile with neither says
 * nothing about the plan ("unknown").
 */
function mapKiroProfileToTier(profileName: string, arn: string | undefined): string {
  if (
    profileName === "Social_Default_Profile" ||
    profileName === "Q_DEVELOPER_STANDALONE_FREE"
  )
    return "free";
  if (profileName === "Q_DEVELOPER_STANDALONE_PRO_PLUS") return "pro_plus";
  if (profileName === "Q_DEVELOPER_STANDALONE_POWER") return "pro_power";
  if (
    profileName === "Q_DEVELOPER_STANDALONE_PRO" ||
    profileName === "Q_DEVELOPER_STANDALONE"
  )
    return "pro";
  return typeof arn === "string" && arn.startsWith("arn:") ? "enterprise" : "unknown";
}

/**
 * Decodes the email claim from a Kiro CLI JWT access token stored in the
 * auth_kv SQLite table under the key "kirocli:social:token".
 *
 * The JWT payload is base64url-encoded. We decode only the payload claim
 * and extract the email field. The raw token is never logged or persisted.
 *
 * Returns null if the token is absent, malformed, or has no email claim.
 */
function extractKiroLoginEmail(cliDbPath: string): string | null {
  if (!existsSync(cliDbPath)) return null;
  try {
    const db = openKiroReadonlyDb(cliDbPath);
    try {
      const row = db.prepare("SELECT CAST(value AS TEXT) AS value FROM auth_kv WHERE key = ?").get(
        "kirocli:social:token"
      ) as { value: string } | undefined;
      if (!row?.value) return null;

      let tokenJson: Record<string, unknown>;
      try {
        tokenJson = JSON.parse(row.value) as Record<string, unknown>;
      } catch {
        return null;
      }

      const accessToken = tokenJson["access_token"];
      if (typeof accessToken !== "string") return null;

      const claims = decodeJwtClaims(accessToken);
      if (claims === null) return null;
      const email = claims["email"];
      if (typeof email === "string" && email.length > 0) return email;
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Detects Kiro plan tier, version, and device ID from CLI SQLite (preferred)
 * or Desktop state.vscdb (fallback with invocation limit inference).
 *
 * Returns a partial InstallationMetadata — caller merges with other fields.
 * Returns null when neither source is available.
 */
export function detectKiroPlanTier(): Partial<InstallationMetadata> | null {
  const cliDbPath = getKiroCliDbPath();
  if (existsSync(cliDbPath)) {
    try {
      const db = openKiroReadonlyDb(cliDbPath);
      try {
        const profileRow = db
          .prepare("SELECT CAST(value AS TEXT) AS value FROM state WHERE key = ?")
          .get("api.codewhisperer.profile") as { value: string } | undefined;

        if (profileRow?.value) {
          const profile = JSON.parse(profileRow.value) as {
            arn?: string;
            profile_name?: string;
          };
          const profileName = profile.profile_name ?? "";

          const versionRow = db
            .prepare("SELECT CAST(value AS TEXT) AS value FROM state WHERE key = ?")
            .get("desktop.versionAtPreviousLaunch") as { value: string } | undefined;

          const deviceRow = db
            .prepare("SELECT CAST(value AS TEXT) AS value FROM state WHERE key = ?")
            .get("telemetryClientId") as { value: string } | undefined;

          const mappedTier = mapKiroProfileToTier(profileName, profile.arn);
          // "free" profile can still be on an active free trial — the CLI DB
          // doesn't encode trial status, so cross-check state.vscdb.
          const effectiveTier =
            mappedTier === "free" && hasKiroActiveFreeTrialInStateDb()
              ? "free_trial"
              : mappedTier;
          const result: Partial<InstallationMetadata> = {
            plan_tier: effectiveTier,
            plan_tier_source: "kiro_cli_profile",
          };
          if (versionRow?.value) {
            try {
              const version = acceptShape(JSON.parse(versionRow.value), RELEASE_VERSION);
              if (version !== undefined) result.ide_version = version;
            } catch { /* malformed */ }
          }
          if (deviceRow?.value) {
            try {
              const deviceId = acceptShape(JSON.parse(deviceRow.value), DEVICE_ID);
              if (deviceId !== undefined) result.device_id = deviceId;
            } catch { /* malformed */ }
          }

          const loginEmail = extractKiroLoginEmail(cliDbPath);
          // An email is the one value the secret scrubber always redacts, so it
          // passes on its shape alone.
          const email = typeof loginEmail === "string" && LOGIN_EMAIL.test(loginEmail) ? loginEmail : undefined;
          if (email !== undefined) result.login_email = email;

          return result;
        }
      } finally {
        db.close();
      }
    } catch { /* DB locked or missing — try desktop fallback */ }
  }

  // Desktop fallback: read plan tier, version, and device ID from state.vscdb.
  // state.vscdb is available on all Kiro desktop installs, even without the CLI.
  const stateDbPath = getKiroStateDbPath();
  if (existsSync(stateDbPath)) {
    try {
      const db = openKiroReadonlyDb(stateDbPath);
      try {
        const readStateKey = (key: string): string | null => {
          try {
            const r = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key) as { value: string } | undefined;
            return r?.value ?? null;
          } catch {
            return null;
          }
        };

        const agentRow = readStateKey("kiro.kiroAgent");
        if (agentRow) {
          const state = JSON.parse(agentRow) as Record<string, unknown>;
          const usageState = state["kiro.resourceNotifications.usageState"] as
            | Record<string, unknown>
            | undefined;
          const breakdowns = usageState?.["usageBreakdowns"] as
            | Array<{
                usageLimit?: number;
                currentUsage?: number;
                overageRate?: number;
                freeTrialUsage?: { expiryDate?: string };
              }>
            | undefined;
          const breakdown = breakdowns?.[0];
          if (breakdown) {
            const hasFreeTrialActive =
              breakdown.freeTrialUsage?.expiryDate &&
              new Date(breakdown.freeTrialUsage.expiryDate) > new Date();
            const usageLimit = breakdown.usageLimit ?? 0;
            const tier = hasFreeTrialActive
              ? "free_trial"
              : usageLimit <= KIRO_FREE_TIER_INVOCATION_LIMIT
                ? "free"
                : usageLimit >= KIRO_PRO_TIER_INVOCATION_LIMIT
                  ? "pro"
                  : "enterprise";

            const result: Partial<InstallationMetadata> = {
              plan_tier: tier,
              plan_tier_source: "kiro_desktop_inferred",
            };

            // storage.serviceMachineId is the VS Code service-level machine UUID.
            const machineId = readStateKey("storage.serviceMachineId");
            const machine = acceptShape(machineId, DEVICE_ID);
            if (machine !== undefined) result.device_id = machine;

            // releaseNotes/lastVersion is updated on every Kiro launch.
            const version = readStateKey("releaseNotes/lastVersion");
            const ideVersion = acceptShape(version, RELEASE_VERSION);
            if (ideVersion !== undefined) result.ide_version = ideVersion;

            return result;
          }
        }
      } finally {
        db.close();
      }
    } catch { /* DB locked or missing */ }
  }

  return null;
}
