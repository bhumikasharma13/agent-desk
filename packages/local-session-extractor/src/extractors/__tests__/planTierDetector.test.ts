// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectClaudeCodeTier, detectClaudeCodeSessionKinds, readCodexPlanTier, detectClaudeCodeOAuthAccount, detectCursorTier } from "../../internal";

// Minimal telemetry event builders — shape mirrors what CC actually writes to
// ~/.claude/telemetry/1p_failed_events.*.json. Only the fields the detector
// looks at are populated; everything else collapses to sensible defaults.
function authEvent(orgUuid: string, extras: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_type: "telemetry",
    event_data: {
      event_name: "tengu_shell_set_cwd",
      auth: { organization_uuid: orgUuid, account_uuid: "acc-1" },
      model: "claude-sonnet-4-6",
      user_type: "external",
      env: { is_claude_ai_auth: true, platform: "darwin" },
      ...extras,
    },
  });
}

function nonAuthEvent(model: string | null = "claude-sonnet-4-6"): string {
  // Passing null (explicit "no model") vs omitted (defaults to sonnet) is a
  // deliberate contract. Default-param semantics would trigger on undefined,
  // which silently masked a test bug in an earlier version.
  const base: Record<string, unknown> = {
    event_name: "tengu_tool_use_success",
    user_type: "external",
  };
  if (typeof model === "string" && model.length > 0) base.model = model;
  return JSON.stringify({ event_type: "telemetry", event_data: base });
}

describe("detectClaudeCodeTier", () => {
  let claudeDir: string;
  let telemetryDir: string;

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), "lse-pt-claude-"));
    telemetryDir = join(claudeDir, "telemetry");
    mkdirSync(telemetryDir, { recursive: true });
  });

  after(() => {
    // beforeEach creates a fresh dir each test; nothing to clean up here
    // because each run uses a new tmpdir. Kept for symmetry with other tests.
  });

  it("returns null when telemetry directory does not exist", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "lse-pt-empty-"));
    try {
      assert.equal(detectClaudeCodeTier(emptyDir), null);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("returns null when telemetry dir is empty", () => {
    assert.equal(detectClaudeCodeTier(claudeDir), null);
  });

  it("returns team tier when an auth event is present anywhere in the dir", () => {
    // Put auth event in the middle of many non-auth events — catches the
    // prior bug where only the last line was scanned.
    const lines = [
      ...Array.from({ length: 50 }, () => nonAuthEvent("claude-sonnet-4-6")),
      authEvent("org-uuid-abc"),
      ...Array.from({ length: 50 }, () => nonAuthEvent("claude-sonnet-4-6")),
    ];
    writeFileSync(join(telemetryDir, "1p_failed_events.a.json"), lines.join("\n") + "\n");

    const meta = detectClaudeCodeTier(claudeDir);
    assert.ok(meta, "metadata should be returned");
    assert.equal(meta.plan_tier, "team");
    assert.equal(meta.plan_tier_source, "cc_telemetry_inferred");
    assert.equal(meta.organization_uuid, "org-uuid-abc");
    assert.equal(meta.account_uuid, "acc-1");
  });

  it("scans multiple files, preferring the newest", () => {
    // Older file has a different org — newer file should win.
    const olderPath = join(telemetryDir, "1p_failed_events.old.json");
    const newerPath = join(telemetryDir, "1p_failed_events.new.json");
    writeFileSync(olderPath, authEvent("org-old") + "\n");
    writeFileSync(newerPath, authEvent("org-new") + "\n");

    // Force older mtime on the "old" file.
    const past = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(olderPath, past, past);

    const meta = detectClaudeCodeTier(claudeDir);
    assert.equal(meta?.organization_uuid, "org-new");
  });

  it("falls back to model-based pro tier when only opus events exist", () => {
    writeFileSync(
      join(telemetryDir, "1p_failed_events.a.json"),
      [nonAuthEvent("claude-opus-4-6"), nonAuthEvent("claude-sonnet-4-6")].join("\n") + "\n",
    );

    const meta = detectClaudeCodeTier(claudeDir);
    assert.ok(meta, "metadata should be returned via fallback");
    assert.equal(meta.plan_tier, "pro");
    assert.equal(meta.plan_tier_source, "cc_model_inferred");
    assert.equal(meta.organization_uuid, undefined);
  });

  it("falls back to pro_or_free when no opus and no auth events exist", () => {
    writeFileSync(
      join(telemetryDir, "1p_failed_events.a.json"),
      [nonAuthEvent("claude-sonnet-4-6"), nonAuthEvent("claude-haiku-4-5")].join("\n") + "\n",
    );

    const meta = detectClaudeCodeTier(claudeDir);
    assert.equal(meta?.plan_tier, "pro_or_free");
    assert.equal(meta?.plan_tier_source, "cc_model_inferred");
  });

  it("returns null when telemetry files exist but have no usable event_data", () => {
    writeFileSync(
      join(telemetryDir, "1p_failed_events.a.json"),
      [nonAuthEvent(null), JSON.stringify({ event_type: "telemetry" })].join("\n") + "\n",
    );

    assert.equal(detectClaudeCodeTier(claudeDir), null);
  });

  it("skips malformed JSONL lines and still finds auth in a later line", () => {
    const lines = [
      "{ not valid json",
      "",
      nonAuthEvent("claude-sonnet-4-6"),
      authEvent("org-recover"),
      "another bad line",
    ];
    writeFileSync(join(telemetryDir, "1p_failed_events.a.json"), lines.join("\n") + "\n");

    const meta = detectClaudeCodeTier(claudeDir);
    assert.equal(meta?.plan_tier, "team");
    assert.equal(meta?.organization_uuid, "org-recover");
  });
});

describe("detectClaudeCodeSessionKinds", () => {
  let claudeDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), "lse-sk-claude-"));
    sessionsDir = join(claudeDir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("returns an empty map when the sessions directory is absent", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "lse-sk-empty-"));
    try {
      assert.equal(detectClaudeCodeSessionKinds(emptyDir).size, 0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  // The crux: two sessions extracted in one run must be able to carry DIFFERENT
  // kinds. CC names each file by PID (`59251.json`), and the real session id is
  // the file's inner `sessionId` field — never the filename. Reading only the
  // newest file would return a single kind for the whole run.
  it("keys each session's kind by its inner sessionId, not the PID filename", () => {
    writeFileSync(
      join(sessionsDir, "59251.json"),
      JSON.stringify({ pid: 59251, sessionId: "uuid-interactive", kind: "interactive", entrypoint: "cli" }),
    );
    writeFileSync(
      join(sessionsDir, "60367.json"),
      JSON.stringify({ pid: 60367, sessionId: "uuid-background", kind: "background", entrypoint: "sdk-cli" }),
    );

    const kinds = detectClaudeCodeSessionKinds(claudeDir);
    assert.equal(kinds.get("uuid-interactive"), "interactive");
    assert.equal(kinds.get("uuid-background"), "background");
    // The PID filename must never leak in as a key.
    assert.equal(kinds.get("59251"), undefined);
  });

  it("skips files missing sessionId or kind, and malformed JSON", () => {
    writeFileSync(join(sessionsDir, "1.json"), JSON.stringify({ pid: 1, kind: "interactive" })); // no sessionId
    writeFileSync(join(sessionsDir, "2.json"), JSON.stringify({ pid: 2, sessionId: "u2" })); // no kind
    writeFileSync(join(sessionsDir, "3.json"), "{ not json");

    assert.equal(detectClaudeCodeSessionKinds(claudeDir).size, 0);
  });

  // A crash-truncated/partial write can leave a file whose content is the bare
  // JSON value `null` — valid JSON, so JSON.parse does not throw. Destructuring
  // it would; the whole extraction cycle must not fault on one bad file.
  it("does not throw on a session file whose content is JSON null", () => {
    writeFileSync(join(sessionsDir, "1.json"), "null");
    writeFileSync(join(sessionsDir, "2.json"), JSON.stringify({ sessionId: "u2", kind: "interactive" }));

    const kinds = detectClaudeCodeSessionKinds(claudeDir);
    assert.equal(kinds.get("u2"), "interactive");
    assert.equal(kinds.size, 1);
  });

  // Two files can legitimately carry the same session id (a resumed session
  // under a new PID while the old PID's file lingers). The most recently
  // modified file must win — deterministically, not by directory-iteration order.
  it("resolves a duplicated sessionId to the most recently modified file", () => {
    const older = join(sessionsDir, "10.json");
    const newer = join(sessionsDir, "11.json");
    writeFileSync(older, JSON.stringify({ sessionId: "dup", kind: "interactive" }));
    writeFileSync(newer, JSON.stringify({ sessionId: "dup", kind: "background" }));
    const past = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(older, past, past);

    assert.equal(detectClaudeCodeSessionKinds(claudeDir).get("dup"), "background");
  });
});

// Builds a fake (unsigned) JWT whose payload is `claims` — mirrors the real
// ~/.codex/auth.json, where the plan claim lives inside tokens.id_token, not at
// the top level. Signature is a placeholder; readCodexPlanTier never verifies it.
function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.sig`;
}

describe("readCodexPlanTier", () => {
  let baseDir: string;

  before(() => {
    baseDir = mkdtempSync(join(tmpdir(), "lse-pt-codex-"));
  });

  after(() => {
    rmSync(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("returns missing-sentinel when auth.json does not exist", () => {
    const missing = join(baseDir, "does-not-exist.json");
    const result = readCodexPlanTier(missing);
    assert.ok(result, "should return a sentinel, not null");
    assert.equal(result.planTier, "unknown");
    assert.equal(result.planTierSource, "codex_auth_json_missing");
  });

  it("reads chatgpt plan tier from the id_token claim", () => {
    const path = join(baseDir, "auth_chatgpt_pro.json");
    writeFileSync(path, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        id_token: makeJwt({
          email: "user@example.com",
          "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
        }),
      },
    }));

    const result = readCodexPlanTier(path);
    assert.equal(result?.planTier, "pro");
    assert.equal(result?.planTierSource, "codex_auth_json");
    assert.equal(result?.loginEmail, "user@example.com");
  });

  it("maps team / business plan names to team tier (chatgptAuthTokens mode)", () => {
    const path = join(baseDir, "auth_team.json");
    writeFileSync(path, JSON.stringify({
      auth_mode: "chatgptAuthTokens",
      tokens: { id_token: makeJwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "business" } }) },
    }));

    const result = readCodexPlanTier(path);
    assert.equal(result?.planTier, "team");
    assert.equal(result?.planTierSource, "codex_auth_json");
  });

  it("returns no-claims sentinel when chatgpt mode has no id_token", () => {
    const path = join(baseDir, "auth_chatgpt_empty.json");
    writeFileSync(path, JSON.stringify({ auth_mode: "chatgpt" }));

    const result = readCodexPlanTier(path);
    assert.equal(result?.planTier, "unknown");
    assert.equal(result?.planTierSource, "codex_auth_json_no_claims");
  });

  it("returns no-claims sentinel when the id_token carries no plan claim", () => {
    const path = join(baseDir, "auth_chatgpt_no_claim.json");
    writeFileSync(path, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { id_token: makeJwt({ email: "user@example.com" }) },
    }));

    const result = readCodexPlanTier(path);
    assert.equal(result?.planTier, "unknown");
    assert.equal(result?.planTierSource, "codex_auth_json_no_claims");
  });

  it("buckets a project-scoped API key as the api tier", () => {
    // API-key auth has no ChatGPT subscription behind it — the tier is the
    // usage-based "api" bucket (not "unknown"), and the key TYPE is the source.
    const path = join(baseDir, "auth_api_proj.json");
    writeFileSync(path, JSON.stringify({ auth_mode: "apiKey", OPENAI_API_KEY: "sk-proj-abc123" })); // fake credential, test fixture. gitleaks:allow

    const result = readCodexPlanTier(path);
    assert.equal(result?.planTier, "api");
    assert.equal(result?.planTierSource, "codex_api_key_proj");
  });

  it("buckets a legacy sk- API key as the api tier (individual key type)", () => {
    const path = join(baseDir, "auth_api_individual.json");
    writeFileSync(path, JSON.stringify({ auth_mode: "apiKey", OPENAI_API_KEY: "sk-abcdef123" })); // fake credential, test fixture. gitleaks:allow

    const result = readCodexPlanTier(path);
    assert.equal(result?.planTier, "api");
    assert.equal(result?.planTierSource, "codex_api_key_individual");
  });

  it("tags a service-account key type (reliable org/automation signal)", () => {
    const path = join(baseDir, "auth_api_svcacct.json");
    writeFileSync(path, JSON.stringify({ auth_mode: "apiKey", OPENAI_API_KEY: "sk-svcacct-xyz" }));

    const result = readCodexPlanTier(path);
    assert.equal(result?.planTier, "api");
    assert.equal(result?.planTierSource, "codex_api_key_svcacct");
  });

  it("tags an admin key type", () => {
    const path = join(baseDir, "auth_api_admin.json");
    writeFileSync(path, JSON.stringify({ auth_mode: "apiKey", OPENAI_API_KEY: "sk-admin-xyz" }));

    const result = readCodexPlanTier(path);
    assert.equal(result?.planTier, "api");
    assert.equal(result?.planTierSource, "codex_api_key_admin");
  });

  it("accepts the lowercase 'apikey' auth_mode (upstream serde spelling)", () => {
    // Upstream Codex serializes AuthMode with rename_all="lowercase" → "apikey";
    // matching is case-insensitive so this resolves to the api tier, not unknown.
    const path = join(baseDir, "auth_api_lowercase.json");
    writeFileSync(path, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-proj-xyz" }));

    const result = readCodexPlanTier(path);
    assert.equal(result?.planTier, "api");
    assert.equal(result?.planTierSource, "codex_api_key_proj");
  });

  it("still resolves the legacy snake_case api_key field", () => {
    // Older auth.json wrote auth_mode "api_key" + a top-level api_key; keep it
    // working so a stale login isn't mis-bucketed as unknown-mode.
    const path = join(baseDir, "auth_api_legacy.json");
    writeFileSync(path, JSON.stringify({ auth_mode: "api_key", api_key: "sk-proj-legacy" }));

    const result = readCodexPlanTier(path);
    assert.equal(result?.planTier, "api");
    assert.equal(result?.planTierSource, "codex_api_key_proj");
  });

  it("returns parse-error sentinel when auth.json is malformed", () => {
    const path = join(baseDir, "auth_malformed.json");
    writeFileSync(path, "{ not valid json");

    const result = readCodexPlanTier(path);
    assert.equal(result?.planTier, "unknown");
    assert.equal(result?.planTierSource, "codex_auth_json_parse_error");
  });

  it("distinguishes parse-error from runtime-error sources", () => {
    // Valid JSON but a field shape that should never crash the parser — we
    // only assert the parse-success path doesn't accidentally fall through
    // to the runtime-error sentinel when the data is structurally odd.
    const path = join(baseDir, "auth_weird_claims.json");
    writeFileSync(path, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { id_token: makeJwt({ "https://api.openai.com/auth": { chatgpt_plan_type: 123 } }) },
    }));

    const result = readCodexPlanTier(path);
    assert.equal(result?.planTier, "unknown");
    // non-string plan_type falls back to the no-claims path, NOT runtime-error
    assert.equal(result?.planTierSource, "codex_auth_json_no_claims");
  });

  it("returns unknown-mode sentinel for an unrecognised auth_mode", () => {
    const path = join(baseDir, "auth_unknown_mode.json");
    writeFileSync(path, JSON.stringify({ auth_mode: "something_new" }));

    const result = readCodexPlanTier(path);
    assert.equal(result?.planTier, "unknown");
    assert.equal(result?.planTierSource, "codex_auth_mode_unknown");
  });
});

describe("detectClaudeCodeOAuthAccount", () => {
  let baseDir: string;

  before(() => {
    baseDir = mkdtempSync(join(tmpdir(), "lse-pt-ccoauth-"));
  });

  after(() => {
    rmSync(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("returns null when ~/.claude.json does not exist", () => {
    assert.equal(detectClaudeCodeOAuthAccount(join(baseDir, "nope.json")), null);
  });

  it("returns null on malformed JSON (no throw)", () => {
    const path = join(baseDir, "malformed.json");
    writeFileSync(path, "{ not valid json");
    assert.equal(detectClaudeCodeOAuthAccount(path), null);
  });

  it("returns null when oauthAccount is absent", () => {
    const path = join(baseDir, "no_oauth.json");
    writeFileSync(path, JSON.stringify({ someOtherKey: 1 }));
    assert.equal(detectClaudeCodeOAuthAccount(path), null);
  });

  it("returns null when oauthAccount has no usable string fields", () => {
    const path = join(baseDir, "empty_oauth.json");
    writeFileSync(path, JSON.stringify({ oauthAccount: { seatTier: "", organizationType: 5 } }));
    assert.equal(detectClaudeCodeOAuthAccount(path), null);
  });

  it("extracts all raw fields (does NOT compute plan_tier)", () => {
    const path = join(baseDir, "full.json");
    writeFileSync(path, JSON.stringify({
      // top-level token must never surface — only oauthAccount is read.
      accessToken: "secret-should-be-ignored",
      oauthAccount: {
        seatTier: "team_tier_1",
        organizationType: "claude_team",
        billingType: "stripe_subscription",
        organizationRole: "user",
        organizationRateLimitTier: "default_raven",
        userRateLimitTier: "default_claude_max_5x",
        subscriptionCreatedAt: "2026-02-25T05:51:38Z",
        organizationUuid: "org-uuid",
        accountUuid: "acct-uuid",
        emailAddress: "dev@example.com",
        hasExtraUsageEnabled: true,
      },
    }));

    const meta = detectClaudeCodeOAuthAccount(path);
    assert.ok(meta);
    assert.equal(meta.seat_tier, "team_tier_1");
    assert.equal(meta.organization_type, "claude_team");
    assert.equal(meta.billing_type, "stripe_subscription");
    assert.equal(meta.organization_role, "user");
    assert.equal(meta.organization_rate_limit_tier, "default_raven");
    assert.equal(meta.user_rate_limit_tier, "default_claude_max_5x");
    // Normalized to a valid RFC-3339 string.
    assert.equal(meta.subscription_created_at, "2026-02-25T05:51:38.000Z");
    assert.equal(meta.organization_uuid, "org-uuid");
    assert.equal(meta.account_uuid, "acct-uuid");
    // oauthAccount.emailAddress → login_email (authoritative); extra-usage flag.
    assert.equal(meta.login_email, "dev@example.com");
    assert.equal(meta.has_extra_usage_enabled, true);
    // The detector never maps plan_tier — that happens on a consumer.
    assert.equal(meta.plan_tier, undefined);
    assert.equal(meta.plan_tier_source, undefined);
  });

  it("hasExtraUsageEnabled=false is preserved (not dropped as undefined)", () => {
    const path = join(baseDir, "extra_false.json");
    writeFileSync(path, JSON.stringify({
      oauthAccount: { seatTier: "team_tier_1", hasExtraUsageEnabled: false },
    }));

    const meta = detectClaudeCodeOAuthAccount(path);
    assert.ok(meta);
    assert.equal(meta.has_extra_usage_enabled, false);
    assert.ok("has_extra_usage_enabled" in meta, "explicit false must survive the undefined-drop");
  });

  it("omits absent fields and keeps present ones", () => {
    const path = join(baseDir, "partial.json");
    writeFileSync(path, JSON.stringify({ oauthAccount: { seatTier: "team_tier_1" } }));

    const meta = detectClaudeCodeOAuthAccount(path);
    assert.ok(meta);
    assert.equal(meta.seat_tier, "team_tier_1");
    assert.ok(!("organization_type" in meta));
    assert.ok(!("user_rate_limit_tier" in meta));
  });

  it("drops an unparseable subscriptionCreatedAt (would break consumer Timestamp parse)", () => {
    const path = join(baseDir, "bad_ts.json");
    writeFileSync(path, JSON.stringify({
      oauthAccount: { seatTier: "team_tier_1", subscriptionCreatedAt: "not-a-date" },
    }));

    const meta = detectClaudeCodeOAuthAccount(path);
    assert.ok(meta);
    assert.equal(meta.seat_tier, "team_tier_1");
    assert.ok(!("subscription_created_at" in meta), "invalid timestamp must be dropped");
  });
});

// ── Cursor IDE (state.vscdb) ─────────────────────────────────────────────────

describe("detectCursorTier", () => {
  const STATSIG_KEY = "workbench.experiments.statsigBootstrap";
  const MEMBERSHIP_KEY = "cursorAuth/stripeMembershipType";

  // Reads only what the fake DB holds; every other ItemTable key is absent.
  const readerFor = (rows: Record<string, string>) => (key: string) => rows[key] ?? null;

  // Mirrors the real bootstrap blob: `user.custom` nested inside a much larger
  // Statsig payload.
  const bootstrap = (custom: Record<string, unknown>) =>
    JSON.stringify({ feature_gates: {}, user: { userID: "u1", custom } });

  it("carries the team fields alongside the raw membership string", () => {
    const meta = detectCursorTier(
      readerFor({
        [MEMBERSHIP_KEY]: "enterprise",
        [STATSIG_KEY]: bootstrap({
          isEnterpriseUser: false,
          isEnterpriseTrialUser: false,
          teamID: 1234567,
          teamRole: "member",
        }),
      }),
    );

    assert.ok(meta);
    // stripeMembershipType stays verbatim — it reports "enterprise" for a
    // self-serve Teams seat, which is exactly why the team fields are needed.
    assert.equal(meta.plan_tier, "enterprise");
    assert.equal(meta.plan_tier_source, "cursor_vscdb");
    assert.equal(meta.is_enterprise_user, false);
    assert.equal(meta.is_enterprise_trial_user, false);
    assert.equal(meta.cursor_team_role, "member");
    assert.equal(meta.cursor_team_id, "1234567");
    assert.equal(typeof meta.cursor_team_id, "string", "numeric teamID must ship as a string");
  });

  it("keeps both enterprise flags when a negotiated contract sets them", () => {
    const meta = detectCursorTier(
      readerFor({
        [MEMBERSHIP_KEY]: "enterprise",
        [STATSIG_KEY]: bootstrap({
          isEnterpriseUser: true,
          isEnterpriseTrialUser: true,
          teamID: 42,
        }),
      }),
    );

    assert.ok(meta);
    assert.equal(meta.is_enterprise_user, true);
    assert.equal(meta.is_enterprise_trial_user, true);
    assert.equal(meta.cursor_team_id, "42");
    assert.ok(!("cursor_team_role" in meta));
  });

  it("omits cursor_team_id for an individual account with no teamID", () => {
    const meta = detectCursorTier(
      readerFor({
        [MEMBERSHIP_KEY]: "pro",
        [STATSIG_KEY]: bootstrap({ isEnterpriseUser: false, isEnterpriseTrialUser: false }),
      }),
    );

    assert.ok(meta);
    assert.equal(meta.plan_tier, "pro");
    assert.ok(!("cursor_team_id" in meta), "absent teamID must not become an empty string");
    assert.equal(meta.is_enterprise_user, false);
  });

  it("returns the membership string alone when the statsig blob is absent", () => {
    const meta = detectCursorTier(readerFor({ [MEMBERSHIP_KEY]: "pro" }));

    assert.ok(meta);
    assert.equal(meta.plan_tier, "pro");
    assert.ok(!("is_enterprise_user" in meta));
    assert.ok(!("cursor_team_id" in meta));
  });

  it("degrades to the membership string when the statsig blob is malformed JSON", () => {
    const meta = detectCursorTier(
      readerFor({ [MEMBERSHIP_KEY]: "enterprise", [STATSIG_KEY]: "{not json" }),
    );

    assert.ok(meta, "a malformed blob must not fail the whole detection");
    assert.equal(meta.plan_tier, "enterprise");
    assert.ok(!("is_enterprise_user" in meta));
  });

  it("ignores a statsig blob with no user.custom", () => {
    const meta = detectCursorTier(
      readerFor({ [MEMBERSHIP_KEY]: "free", [STATSIG_KEY]: JSON.stringify({ user: {} }) }),
    );

    assert.ok(meta);
    assert.equal(meta.plan_tier, "free");
    assert.ok(!("is_enterprise_user" in meta));
  });

  it("still ships the team fields when stripeMembershipType is empty", () => {
    // Many installs report "" here; a team seat must not lose its fields.
    const meta = detectCursorTier(
      readerFor({ [MEMBERSHIP_KEY]: "", [STATSIG_KEY]: bootstrap({ teamID: 7, teamRole: "owner" }) }),
    );

    assert.ok(meta);
    assert.ok(!("plan_tier" in meta));
    assert.equal(meta.cursor_team_id, "7");
    assert.equal(meta.cursor_team_role, "owner");
    // The team id is a billing fact read from state.vscdb, so it carries the
    // same provenance as the membership string. Without a source the tier the
    // consumer derives from it classifies as UNSPECIFIED and drops out of every
    // REPORTED-only surface.
    assert.equal(meta.plan_tier_source, "cursor_vscdb");
  });

  it("returns null when neither the membership key nor the statsig blob exists", () => {
    assert.equal(detectCursorTier(readerFor({})), null);
  });

  it("captures the per-member account id, distinct from the team-wide id", () => {
    const meta = detectCursorTier(
      readerFor({
        [MEMBERSHIP_KEY]: "enterprise",
        [STATSIG_KEY]: JSON.stringify({
          user: { userID: "auth0|user_01ABC", custom: { teamID: 1234567 } },
        }),
      }),
    );

    assert.ok(meta);
    assert.equal(meta.cursor_user_id, "auth0|user_01ABC");
    // The team id is shared by every member; only the user id identifies a seat.
    assert.equal(meta.cursor_team_id, "1234567");
    assert.notEqual(meta.cursor_user_id, meta.cursor_team_id);
  });

  it("captures the account id even when the blob carries no user.custom", () => {
    const meta = detectCursorTier(
      readerFor({
        [MEMBERSHIP_KEY]: "pro",
        [STATSIG_KEY]: JSON.stringify({ user: { userID: "auth0|user_01XYZ" } }),
      }),
    );

    assert.ok(meta);
    assert.equal(meta.cursor_user_id, "auth0|user_01XYZ");
    assert.ok(!("is_enterprise_user" in meta));
  });

  it("does not read identity when the account reports no plan and no team", () => {
    // `isEnterpriseUser: false` is present on ordinary individual accounts, so the
    // statsig blob parsing alone must not pull in an email address: an install with
    // no membership string and no team produces no metadata at all.
    const reads: string[] = [];
    const meta = detectCursorTier((key) => {
      reads.push(key);
      return readerFor({
        [MEMBERSHIP_KEY]: "",
        [STATSIG_KEY]: bootstrap({ isEnterpriseUser: false, isEnterpriseTrialUser: false }),
        "cursorAuth/cachedEmail": "someone@example.com",
      })(key);
    });

    assert.ok(meta);
    assert.equal(meta.is_enterprise_user, false);
    assert.ok(!("login_email" in meta), "must not attach an email for a no-plan, no-team install");
    assert.ok(!("cursor_onboarding_date" in meta));
    assert.ok(!reads.includes("cursorAuth/cachedEmail"), "must not even read the email key");
  });

  it("reads identity for an enterprise trial with no team id and no membership string", () => {
    // A consumer prices the enterprise flags ahead of teamID, and a trial seat
    // can carry neither a team nor a membership string — so the flag alone is a
    // real account signal and must not be gated out.
    const meta = detectCursorTier(
      readerFor({
        [MEMBERSHIP_KEY]: "",
        [STATSIG_KEY]: bootstrap({ isEnterpriseTrialUser: true }),
        "cursorAuth/cachedEmail": "trial@example.com",
      }),
    );

    assert.ok(meta);
    assert.equal(meta.is_enterprise_trial_user, true);
    assert.equal(meta.login_email, "trial@example.com");
  });

  it("reads identity once a team id is present, even with an empty membership string", () => {
    const meta = detectCursorTier(
      readerFor({
        [MEMBERSHIP_KEY]: "",
        [STATSIG_KEY]: bootstrap({ teamID: 7, teamRole: "member" }),
        "cursorAuth/cachedEmail": "dev@example.com",
      }),
    );

    assert.ok(meta);
    assert.equal(meta.cursor_team_id, "7");
    assert.equal(meta.login_email, "dev@example.com");
  });
});
