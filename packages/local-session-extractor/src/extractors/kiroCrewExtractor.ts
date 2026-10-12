// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Kiro Crew extractor — the autonomous-agent surface, alongside the IDE and CLI.
 *
 *   ~/.kiro/crew/
 *     ├── sessions/<surface>_<slot>.jsonl   one metadata line + role/content messages
 *     ├── usage/tokens/<date>.jsonl         per-slot metering — Kiro's ONLY cost source
 *     └── session_map.json                  slot → CLI session id, cwd, provider
 *
 * Why this surface matters beyond session count: Kiro is credit-metered, and the
 * IDE and CLI formats report no cost at all. `usage/tokens` is the only artifact
 * carrying a `cost` field, so without crew there is no cost for Kiro.
 *
 * The token columns (`input`/`output`/`cache_*`) exist here but read 0 in captured
 * data — same as the CLI. Credits are the real unit; the token fields are left
 * unwritten rather than stored as measured zeros.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import type {
  ConversationPrompt,
  InstallationMetadata,
  SessionMetaPayload,
} from "../types/session";
import type { SessionSink } from "../types/store";
import { redactPrompts, redactPath, sanitizeSessionMeta } from "../redaction";
import { resolveProjectAndRepo } from "./gitUtils";
import { dateMs, spanSeconds } from "./dateMs";
import { getKiroCrewPath } from "./pathResolver";
import { logger } from "../seams/logger";
import { reportRecordError } from "../seams/scanScope";
import { createHash } from "node:crypto";

/** The `_type: "metadata"` header line of a crew transcript. */
interface CrewMetadataLine {
  _type?: string;
  created_at?: string;
  updated_at?: string;
  title?: string;
  model?: string;
  project?: string;
  agent?: string;
  memory_mode?: string;
  tab_id?: string;
}

/** A conversation line: crew writes role/content/ts with the originating surface. */
interface CrewMessageLine {
  role?: string;
  content?: string;
  ts?: string;
  /** Where the message came from — "dashboard", a Slack thread, Discord, … */
  source_thread?: string;
  source_user?: string;
}

/** One metering row from `usage/tokens/<date>.jsonl`. */
interface CrewUsageRow {
  _type?: string;
  slot?: string;
  model?: string;
  cost?: number;
  credits?: number;
  duration_ms?: number;
  context_used?: number;
  context_window?: number;
  surface?: string;
  agent?: string;
}

/** Metering split by whether the row named its surface — see `readCrewUsage`. */
interface CrewUsageIndex {
  bySurfaceSlot: Map<string, CrewUsage>;
  bySlotOnly: Map<string, CrewUsage>;
}

interface CrewUsage {
  credits: number;
  costUsd: number;
  durationMs: number;
  contextUsed: number;
  contextWindow: number;
}

/**
 * Sums every metering row for a session. Rows are per-turn, so the session total
 * is their sum — except context, which is an occupancy level rather than a
 * quantity and so takes the maximum observed.
 *
 * Keyed by `<surface>:<slot>`, the same identity the transcript filenames and
 * `session_map.json` keys carry: a slot number is only unique within its
 * surface, so joining on the bare slot would hand a `slack` session the credits
 * a `dashboard` session of the same slot spent.
 *
 * A row that names no surface cannot be attributed, so it goes to a second map
 * that `crewUsageFor` adds on top of the composite hit. It is the lesser evil in
 * both directions: stranding those rows would drop real credits outright, and
 * they are only ever counted twice in the case that needs BOTH a slot shared
 * across surfaces and a metering file mixing formats.
 */
function readCrewUsage(crewRoot: string): CrewUsageIndex {
  const bySurfaceSlot = new Map<string, CrewUsage>();
  const bySlotOnly = new Map<string, CrewUsage>();
  const index: CrewUsageIndex = { bySurfaceSlot, bySlotOnly };
  const usageDir = join(crewRoot, "usage", "tokens");
  if (!existsSync(usageDir)) return index;

  let files: string[];
  try { files = readdirSync(usageDir).filter((f) => f.endsWith(".jsonl")); } catch { return index; }

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(join(usageDir, file), "utf-8");
    } catch (err) {
      // This is Kiro's ONLY cost source; a silent skip yields a crew row with
      // missing credits and no way to tell that from a genuinely free session.
      logger.warn("extraction.kiro", "crew_usage_read_failed", {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    let malformedRows = 0;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let row: CrewUsageRow;
      try { row = JSON.parse(line) as CrewUsageRow; } catch { malformedRows++; continue; }
      const slot = row.slot;
      if (!slot) continue;
      const target = row.surface ? bySurfaceSlot : bySlotOnly;
      const key = row.surface ? `${row.surface}:${slot}` : slot;
      const acc = target.get(key) ?? {
        credits: 0, costUsd: 0, durationMs: 0, contextUsed: 0, contextWindow: 0,
      };
      acc.credits += row.credits ?? 0;
      acc.costUsd += row.cost ?? 0;
      acc.durationMs += row.duration_ms ?? 0;
      // Both fields move together or not at all. Maxing them independently can
      // publish a used/window pair that never occurred on any turn: a 90k/100k
      // turn followed by a 100k/1M turn would report 100k of 1M — 10% — hiding
      // the 90% peak that is the whole point of tracking occupancy.
      const used = row.context_used ?? 0;
      const window = row.context_window ?? 0;
      if (used > 0 && window > 0 && used / window > occupancy(acc)) {
        acc.contextUsed = used;
        acc.contextWindow = window;
      }
      target.set(key, acc);
    }
    // Counted, not logged per line: a corrupt file would otherwise emit one entry
    // per row and bury the rest of the extraction log.
    if (malformedRows > 0) {
      logger.warn("extraction.kiro", "crew_usage_rows_malformed", { file, malformedRows });
    }
  }
  return index;
}

/**
 * The session's metering: its surface-attributed rows plus any row for the slot
 * that named no surface. Context is an occupancy level, so it takes the peak of
 * the two rather than their sum.
 */
/** Fraction of the context window occupied, or 0 when no row reported both. */
function occupancy(u: Pick<CrewUsage, "contextUsed" | "contextWindow">): number {
  return u.contextWindow > 0 ? u.contextUsed / u.contextWindow : 0;
}

function crewUsageFor(index: CrewUsageIndex, rawSurface: string, slot: string): CrewUsage | undefined {
  const attributed = index.bySurfaceSlot.get(`${rawSurface}:${slot}`);
  const unattributed = index.bySlotOnly.get(slot);
  if (!attributed) return unattributed;
  if (!unattributed) return attributed;
  return {
    credits: attributed.credits + unattributed.credits,
    costUsd: attributed.costUsd + unattributed.costUsd,
    durationMs: attributed.durationMs + unattributed.durationMs,
    // Whichever side peaked higher, kept as a pair for the reason above.
    ...(occupancy(unattributed) > occupancy(attributed)
      ? { contextUsed: unattributed.contextUsed, contextWindow: unattributed.contextWindow }
      : { contextUsed: attributed.contextUsed, contextWindow: attributed.contextWindow }),
  };
}

/**
 * Newest mtime and total size across the metering files, folded into every crew
 * session's dedup token. Cost and credits are read from there, not from the
 * transcript — so a metering append with no transcript change would otherwise
 * take the fast path and leave the cost fields permanently stale.
 */
function crewUsageStamp(crewRoot: string): { mtimeMs: number; totalSize: number } {
  let mtimeMs = 0;
  let totalSize = 0;
  // session_map.json is part of the stamp: it decides both the project path and
  // whether credits are suppressed as the CLI row's. A slot that gains a `sid`
  // after its last transcript write would otherwise keep the fast path and go on
  // double-counting the very credits the suppression exists to remove.
  try {
    const st = statSync(join(crewRoot, "session_map.json"));
    if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
    totalSize += st.size;
  } catch { /* absent — nothing to stamp */ }
  const usageDir = join(crewRoot, "usage", "tokens");
  if (!existsSync(usageDir)) return { mtimeMs, totalSize };
  let files: string[];
  try { files = readdirSync(usageDir).filter((f) => f.endsWith(".jsonl")); } catch { return { mtimeMs, totalSize }; }
  for (const file of files) {
    try {
      const st = statSync(join(usageDir, file));
      if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
      totalSize += st.size;
    } catch { /* vanished mid-scan */ }
  }
  return { mtimeMs, totalSize };
}

/** `<surface>:<slot>` → the CLI session id crew spawned for it, from `session_map.json`. */
function readCrewSessionMap(crewRoot: string): Map<string, { sid?: string; cwd?: string }> {
  const map = new Map<string, { sid?: string; cwd?: string }>();
  const mapPath = join(crewRoot, "session_map.json");
  if (!existsSync(mapPath)) return map;
  try {
    const raw = JSON.parse(readFileSync(mapPath, "utf-8")) as Record<
      string,
      { sid?: string; cwd?: string }
    >;
    // Keys are "<surface>:<slot>". Each is indexed under exactly the identity it
    // carries — a composite key is NOT also aliased to its bare slot. Aliasing
    // would let a `dashboard:chat-7` entry answer a lookup for `slack:chat-7`,
    // handing that session the wrong cwd and suppressing its credits because
    // `sid` looks set. Only a genuinely bare key (older maps, written without the
    // prefix) populates the bare-slot fallback.
    for (const [key, value] of Object.entries(raw)) {
      map.set(key, { ...(value.sid ? { sid: value.sid } : {}), ...(value.cwd ? { cwd: value.cwd } : {}) });
    }
  } catch (err) {
    // Treating every slot as unmapped is not a neutral fallback: it drops the
    // `cwd` repo resolution depends on AND disables the `sid` check that stops
    // crew credits being counted a second time by the CLI row.
    logger.warn("extraction.kiro", "crew_session_map_read_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return map;
}

/**
 * Maps a crew message's originating surface onto a CLOSED set of literals.
 *
 * `source_thread` is vendor-controlled and rides `installation_metadata`, which —
 * unlike `session_meta` — has no `sanitize*` choke point, so nothing would redact
 * it downstream. Crew can deliver over Slack, Discord, Teams, Telegram, Webex and
 * WeCom, and a per-thread or per-channel identifier appearing in this field would
 * stored verbatim. Passing only recognised platform tags through (and labelling
 * everything else "other") keeps the value space bounded by our code rather than
 * by the vendor's, matching how `codexSourceToEntrypoint` handles the same risk.
 */
/**
 * The surface component of a crew row's key. Normalization is a value-space
 * bound, not an identity: every unrecognized surface collapses to "other", so two
 * of them sharing a slot would upsert the same row and one conversation would
 * overwrite the other — while the usage and session-map joins still treat their
 * raw surfaces as distinct. A short digest of the raw value restores distinctness
 * without widening the value space back out to vendor control: it is fixed-length
 * hex, carries none of the channel or thread text the bound exists to keep out,
 * and is stable across runs so the row key does not churn.
 */
function crewSurfaceKey(rawSurface: string, normalized: string): string {
  if (normalized !== "other") return normalized;
  return `other-${createHash("sha256").update(rawSurface).digest("hex").slice(0, 8)}`;
}

function normalizeCrewSurface(sourceThread: string | undefined): string {
  switch (sourceThread?.toLowerCase()) {
    case "dashboard":
    case "slack":
    case "discord":
    case "teams":
    case "telegram":
    case "webex":
    case "wecom":
    case "cli":
      return sourceThread!.toLowerCase();
    case undefined:
    case "":
      return "unknown";
    default:
      // Deliberately NOT the raw value — an unrecognised tag may be an identifier.
      return "other";
  }
}

/**
 * Crew reports memory as "persistent"; SessionMeta.memory_mode carries Codex's
 * enabled/disabled vocabulary. Mapping onto that keeps the field answering one
 * question ("is memory on?") rather than mixing two vocabularies in one column —
 * an unrecognised value is dropped rather than passed through.
 */
function normalizeCrewMemoryMode(mode: string | undefined): string | undefined {
  switch (mode?.toLowerCase()) {
    case "persistent": return "enabled";
    case "none":
    case "off":
    case "ephemeral": return "disabled";
    default: return undefined;
  }
}

export interface ParsedCrewSession {
  prompts: ConversationPrompt[];
  metadata: CrewMetadataLine;
  userTimestampsMs: number[];
  /** Distinct originating surfaces seen on messages ("dashboard", "slack", …). */
  sourceThreads: string[];
  /** Lines that failed to parse. Non-zero means the row is a partial extraction. */
  malformedLines: number;
}

/** Parses one crew transcript: a metadata header followed by message lines. */
export function parseCrewSession(lines: string[]): ParsedCrewSession {
  const prompts: ConversationPrompt[] = [];
  const userTimestampsMs: number[] = [];
  const sourceThreads: string[] = [];
  let malformedLines = 0;
  let metadata: CrewMetadataLine = {};

  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: CrewMetadataLine & CrewMessageLine;
    // A dropped line here is not evenly damaging: lose the metadata header and
    // the row loses project, model and timing; lose a message and it loses a
    // prompt and its originating surface. The rest of the file is still stored, so
    // without a count the row looks whole. Warned once per file by the caller.
    try { parsed = JSON.parse(line) as CrewMetadataLine & CrewMessageLine; } catch { malformedLines++; continue; }

    if (parsed._type === "metadata") {
      metadata = parsed;
      continue;
    }

    const role = parsed.role === "assistant" ? "assistant" : parsed.role === "user" ? "user" : null;
    const content = parsed.content?.trim();
    if (!role || !content) continue;

    const tsMs = parsed.ts ? new Date(parsed.ts).getTime() : NaN;
    prompts.push({
      role,
      content,
      ...(isNaN(tsMs) ? {} : { timestamp: new Date(tsMs).toISOString() }),
    });
    if (role === "user" && !isNaN(tsMs)) userTimestampsMs.push(tsMs);
    if (parsed.source_thread && !sourceThreads.includes(parsed.source_thread)) {
      sourceThreads.push(parsed.source_thread);
    }
  }

  return { prompts, metadata, userTimestampsMs, sourceThreads, malformedLines };
}

/**
 * Extracts crew sessions. Returns the number upserted.
 *
 * A transcript is named `<surface>_<slot>.jsonl`; the slot is the key that joins
 * to both the metering rows and `session_map.json`.
 */
export function extractKiroCrew(db: SessionSink, installMeta: InstallationMetadata): number {
  const crewRoot = getKiroCrewPath();
  const sessionsDir = join(crewRoot, "sessions");
  if (!existsSync(sessionsDir)) return 0;

  let files: string[];
  try { files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl")); } catch { return 0; }

  // The metering directory accumulates one file per day forever, so parsing it
  // every cycle would cost more the longer the app has been installed. Nothing
  // needs it unless a transcript actually changed, which on a steady-state poll
  // is nothing — so the scan is deferred until the first session that survives
  // the dedup check, then reused for the rest of this run.
  // Both lookups take the RAW surface off the filename, not the normalized one:
  // normalization folds every unrecognized surface into a single literal, which
  // would re-introduce the very collision the composite key prevents.
  let usageIndex: CrewUsageIndex | null = null;
  const usageFor = (rawSurface: string, slot: string): CrewUsage | undefined => {
    usageIndex ??= readCrewUsage(crewRoot);
    return crewUsageFor(usageIndex, rawSurface, slot);
  };
  let sessionMap: Map<string, { sid?: string; cwd?: string }> | null = null;
  const mappingFor = (rawSurface: string, slot: string): { sid?: string; cwd?: string } | undefined => {
    sessionMap ??= readCrewSessionMap(crewRoot);
    return sessionMap.get(`${rawSurface}:${slot}`) ?? sessionMap.get(slot);
  };
  const usageStamp = crewUsageStamp(crewRoot);
  let count = 0;

  for (const file of files) {
    try {
      const filePath = join(sessionsDir, file);
      const st = statSync(filePath);
      const stem = file.replace(/\.jsonl$/, "");
      const underscore = stem.indexOf("_");
      // Normalized before it reaches rowId, because rowId becomes both the row's
      // session_id and kiro_id — and kiro_id is classified "structured", so
      // sanitizeSessionMeta does not touch it. The filename is as vendor-
      // controlled as source_thread, so bounding one and not the other would
      // leave the same untrusted value unredacted on the session_meta path.
      const rawSurface = underscore > 0 ? stem.slice(0, underscore) : "";
      const surface = normalizeCrewSurface(rawSurface || undefined);
      const slot = underscore > 0 ? stem.slice(underscore + 1) : stem;
      const rowId = `kiro-crew:${crewSurfaceKey(rawSurface, surface)}:${slot}`;

      const effectiveMtime = Math.max(st.mtimeMs, usageStamp.mtimeMs);
      const effectiveSize = st.size + usageStamp.totalSize;
      const tracking = db.getTracking("kiro", rowId);
      if (tracking?.last_mtime_ms === effectiveMtime && tracking?.last_size === effectiveSize) continue;

      const parsed = parseCrewSession(readFileSync(filePath, "utf-8").split("\n"));
      if (parsed.malformedLines > 0) {
        logger.warn("extraction.kiro", "crew_transcript_lines_malformed", {
          file: filePath,
          malformedLines: parsed.malformedLines,
        });
      }
      const userPrompts = parsed.prompts.filter((p) => p.role === "user");
      if (userPrompts.length === 0) continue;

      const meta = parsed.metadata;
      const usage = usageFor(rawSurface, slot);
      const mapped = mappingFor(rawSurface, slot);
      const projectPath = meta.project ?? mapped?.cwd;

      const createdMs = dateMs(meta.created_at, st.birthtimeMs);
      const updatedMs = dateMs(meta.updated_at, st.mtimeMs);
      const durationSeconds = spanSeconds(createdMs, updatedMs);

      // Crew records one model per session; apply it to every prompt as the IDE
      // and CLI extractors do, so crew rows are not model-blind.
      if (meta.model) {
        for (const p of parsed.prompts) p.metadata = { ...(p.metadata ?? {}), model: meta.model };
      }

      const sessionMeta: SessionMetaPayload = {
        source: "kiro-crew",
        session_title: meta.title,
        project_path: projectPath,
        session_duration_seconds: durationSeconds,
        ...(durationSeconds !== undefined && durationSeconds > 0 ? { duration_minutes: durationSeconds / 60 } : {}),
        user_message_count: userPrompts.length,
        assistant_message_count: parsed.prompts.filter((p) => p.role === "assistant").length,
        first_prompt: userPrompts[0]?.content,
        last_prompt: userPrompts[userPrompts.length - 1]?.content,
        memory_mode: normalizeCrewMemoryMode(meta.memory_mode),
        kiro_id: rowId,
        ...(parsed.userTimestampsMs.length > 0
          ? {
              user_message_timestamps: parsed.userTimestampsMs.map((ms) => new Date(ms).toISOString()),
              message_hours: parsed.userTimestampsMs.map((ms) => new Date(ms).getUTCHours()),
            }
          : {}),
        // Credits are Kiro's billing unit — but a crew slot that spawned a CLI
        // session reports the SAME credits that session already reports from its
        // own turn metering (verified identical to 16 significant figures on a
        // real pair). kiroCliExtractor extracts those sessions, so
        // writing them here too would double-count the spend. The crew row keeps
        // what only it has: the USD cost, the surface, and the conversation.
        ...(usage && usage.credits > 0 && !mapped?.sid
          ? { billing_credits_used: usage.credits }
          : {}),
        ...(usage && usage.costUsd > 0 ? { reported_cost_usd: usage.costUsd } : {}),
        ...(usage && usage.contextWindow > 0
          ? {
              context_tokens_used: usage.contextUsed,
              context_token_limit: usage.contextWindow,
              // A consumer's effective-context cascade reads
              // ide_context_usage_percent for Kiro; without it a crew row has an
              // absolute pair no consumer normalizes. 0-100, like every other
              // Kiro surface (the cascade divides).
              ide_context_usage_percent: (usage.contextUsed / usage.contextWindow) * 100,
            }
          : {}),
        // Vendor-measured working time, distinct from the wall-clock span.
        ...(usage && usage.durationMs > 0 ? { agent_active_seconds: usage.durationMs / 1000 } : {}),
      };

      const resolved = resolveProjectAndRepo(projectPath ?? undefined, []);

      db.upsert({
        ideType: "kiro",
        sessionId: rowId,
        conversation: redactPrompts(parsed.prompts),
        projectPath: projectPath ? redactPath(projectPath) : undefined,
        repoName: resolved?.repoName,
        lastMtimeMs: effectiveMtime,
        lastSize: effectiveSize,
        lastOffset: 0,
        conversationSourceCreatedAtMs: createdMs,
        sessionMeta: JSON.stringify(sanitizeSessionMeta(sessionMeta)),
        // The originating surface rides the entrypoint the way the CLI carries its
        // agent name — crew messages can arrive from Slack or Discord, not just
        // the dashboard, and no SessionMeta field carries surface-of-origin.
        installationMetadata: JSON.stringify({
          ...installMeta,
          entrypoint: `kiro-crew:${normalizeCrewSurface(parsed.sourceThreads[0] ?? surface)}`,
          platform: platform(),
        }),
      });
      count++;
    } catch (err) {
      logger.warn("extraction.kiro", "crew_session_error", {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
      reportRecordError(null, file, err);
    }
  }

  return count;
}
