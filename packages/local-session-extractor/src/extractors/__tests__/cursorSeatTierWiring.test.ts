// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * How the Cursor seat-tier resolver is WIRED, as distinct from what it decides.
 *
 * Four properties, each of which fails silently if it regresses:
 *   1. the resolver runs ONCE per cycle at the installation-global block, not
 *      once per conversation — per conversation it would be one credentialed
 *      vendor call per session on the machine;
 *   2. its raw fields land on every conversation's installation metadata, and
 *      `plan_tier_source` keeps the LOCAL origin — a row never claims vendor
 *      provenance;
 *   3. the gate is whether the caller supplied a lookup, and reaches the
 *      resolver as that, with no escape hatch;
 *   4. the Cursor CLI surface READS the cache row and never writes it.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync as Database } from "node:sqlite";
import { SessionStore } from "../../store/SessionStore";
import { extractCursor, scanCursor } from "../cursorExtractor";
import { extractCursorCli, detectCursorCliTier } from "../cursorCliExtractor";
import { setHomeOverride, setPathOverrides } from "../pathResolver";
import {
  resolveCursorSeatTier,
  SEAT_TIER_LOOKUP_TTL_MS,
  SEAT_TIER_META_KEY,
  type ResolveCursorSeatTierOptions,
  type SeatTierLookup,
  type SeatTierResolution,
} from "../../seams/seatTier";
import { createHash } from "node:crypto";

/** A lookup that must never run: every test here that supplies one also stubs the resolver. */
const unusedLookup: SeatTierLookup = () => Promise.reject(new Error("the lookup is not called in this test"));

const TEAM_ID = "1234567";
const SUBJECT = "auth0|user-abc";
const ACCOUNT_FP = createHash("sha256").update(SUBJECT).digest("hex").slice(0, 8);

/** A state.vscdb with two composers plus the ItemTable keys the resolver reads. */
function buildIdeDb(path: string, composerIds: string[]): void {
  const raw = new Database(path);
  raw.exec("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);");
  raw.exec("CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT);");
  const kv = raw.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)");
  for (const composerId of composerIds) {
    const lastUpdatedAt = Date.now() - 3 * 60 * 60 * 1000; // outside the settle window
    kv.run(
      `composerData:${composerId}`,
      JSON.stringify({
        composerId,
        createdAt: lastUpdatedAt - 60_000,
        lastUpdatedAt,
        name: "session",
        fullConversationHeadersOnly: [
          { bubbleId: "u1", type: 1 },
          { bubbleId: "a1", type: 2 },
        ],
        modelConfig: { modelName: "claude-sonnet-4-6" },
      }),
    );
    kv.run(`bubbleId:${composerId}:u1`, JSON.stringify({ bubbleId: "u1", type: 1, text: "ask" }));
    kv.run(
      `bubbleId:${composerId}:a1`,
      JSON.stringify({
        bubbleId: "a1",
        type: 2,
        text: "answer",
        tokenCount: { inputTokens: 10, outputTokens: 20 },
      }),
    );
  }
  const item = raw.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)");
  item.run("cursorAuth/stripeMembershipType", "enterprise");
  item.run("cursorAuth/accessToken", "a.token.value");
  item.run(
    "workbench.experiments.statsigBootstrap",
    JSON.stringify({
      user: {
        userID: SUBJECT,
        custom: { isEnterpriseUser: false, isEnterpriseTrialUser: false, teamID: Number(TEAM_ID) },
      },
    }),
  );
  raw.close();
}

function installMetaOf(db: SessionStore, sessionId: string): Record<string, unknown> {
  const row = db
    .raw()
    .prepare(
      "SELECT installation_metadata FROM conversations WHERE ide_type = 'cursor' AND session_id = ?",
    )
    .get(sessionId) as { installation_metadata: string | null };
  assert.ok(row.installation_metadata, `installation_metadata missing for ${sessionId}`);
  return JSON.parse(row.installation_metadata) as Record<string, unknown>;
}

describe("cursorExtractor — seat-tier resolver wiring", () => {
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-cursor-seat-wiring-"));
    // Keep the developer's real ~/.cursor out of these counts and assertions.
    setHomeOverride(join(tmpDir, "home"));
    setPathOverrides({
      CURSOR_CLI_CHATS_PATH: join(tmpDir, "no-cli-chats"),
      CURSOR_CLI_CONFIG_PATH: join(tmpDir, "no-cli-config.json"),
      CURSOR_STATSIG_CACHE_PATH: join(tmpDir, "no-statsig-cache.json"),
    });
  });

  after(() => {
    setHomeOverride(undefined);
    setPathOverrides({
      CURSOR_DB_PATH: undefined,
      CURSOR_CLI_CHATS_PATH: undefined,
      CURSOR_CLI_CONFIG_PATH: undefined,
      CURSOR_STATSIG_CACHE_PATH: undefined,
    });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  /**
   * Records every resolver invocation and returns a fixed stamp. The token read
   * is performed INSIDE the call, because the vscdb reader is closed by the time
   * the cycle returns — which is itself the reason the resolver is awaited while
   * the reader is still open.
   */
  function spyResolver(stamp: Partial<Record<string, unknown>> = {}) {
    const calls: (ResolveCursorSeatTierOptions & { tokenRead: string | null })[] = [];
    const impl = (options: ResolveCursorSeatTierOptions): Promise<SeatTierResolution> => {
      calls.push({ ...options, tokenRead: options.readVscdbKey("cursorAuth/accessToken") });
      return Promise.resolve({
        outcome: "ok",
        status: 200,
        stamp: stamp as SeatTierResolution["stamp"],
        attempted: true,
      });
    };
    return { calls, impl };
  }

  it("resolves once per cycle, not once per conversation, and stamps every row", async () => {
    const ide = join(tmpDir, "two-composers.vscdb");
    buildIdeDb(ide, ["seat-a", "seat-b"]);
    setPathOverrides({ CURSOR_DB_PATH: ide });
    const db = new SessionStore(join(tmpDir, "two-composers-local.db"));

    const spy = spyResolver({
      cursor_billing_tier: "TEAM_MEMBER_BILLING_TIER_TIER_2000",
      cursor_team_membership_type: "SELF_SERVE",
      cursor_is_yearly_plan: false,
    });
    const count = await extractCursor(db, {
      seatTierLookup: unusedLookup,
      resolveSeatTier: spy.impl,
    });

    assert.equal(count, 2, "both composers extracted");
    assert.equal(spy.calls.length, 1, "one resolver call for the whole cycle");
    for (const sessionId of ["seat-a", "seat-b"]) {
      const meta = installMetaOf(db, sessionId);
      assert.equal(meta["cursor_billing_tier"], "TEAM_MEMBER_BILLING_TIER_TIER_2000");
      assert.equal(meta["cursor_team_membership_type"], "SELF_SERVE");
      assert.equal(meta["cursor_is_yearly_plan"], false);
    }
  });

  it("hands the resolver the gate, the lookup, the local team id, and a working vscdb reader", async () => {
    const ide = join(tmpDir, "options.vscdb");
    buildIdeDb(ide, ["seat-options"]);
    setPathOverrides({ CURSOR_DB_PATH: ide });
    const db = new SessionStore(join(tmpDir, "options-local.db"));

    const spy = spyResolver();
    await extractCursor(db, { seatTierLookup: unusedLookup, resolveSeatTier: spy.impl });

    const options = spy.calls[0];
    assert.ok(options);
    assert.equal(options.enabled, true, "a supplied lookup opens the gate");
    assert.equal(options.lookup, unusedLookup, "the caller's lookup reaches the resolver");
    assert.equal(options.teamId, TEAM_ID, "the local team gate comes from the Statsig blob");
    assert.equal(
      options.tokenRead,
      "a.token.value",
      "the seam reads the ItemTable the extractor already has open",
    );
    assert.equal(options.meta, db, "the cache row lives in the package store's meta table");
  });

  it("passes the gate through as false when the caller supplies no lookup", async () => {
    const ide = join(tmpDir, "gate-default.vscdb");
    buildIdeDb(ide, ["seat-gate-default"]);
    setPathOverrides({ CURSOR_DB_PATH: ide });
    const db = new SessionStore(join(tmpDir, "gate-default-local.db"));

    const spy = spyResolver();
    await extractCursor(db, { resolveSeatTier: spy.impl });
    assert.equal(spy.calls[0]?.enabled, false, "no lookup is off, never inherited");
  });

  it("reports the outcome once per cycle in the scan result", async () => {
    const ide = join(tmpDir, "outcome.vscdb");
    buildIdeDb(ide, ["seat-outcome-a", "seat-outcome-b"]);
    setPathOverrides({ CURSOR_DB_PATH: ide });
    const db = new SessionStore(join(tmpDir, "outcome-local.db"));

    const { seatTier } = await scanCursor(db, {
      resolveSeatTier: () =>
        Promise.resolve({
          outcome: "error",
          errorKind: "TIMEOUT",
          stamp: {},
          attempted: true,
        }),
    });
    assert.deepEqual(seatTier, { outcome: "error", errorKind: "TIMEOUT" });
  });

  it("makes no vendor call and writes no cache row when the gate is off", async () => {
    // The REAL resolver, with only the global fetch stubbed: this install is a
    // team seat with a readable token, so every precondition for a credentialed
    // call is met and the missing lookup is the only thing withholding it.
    const ide = join(tmpDir, "gate-off.vscdb");
    buildIdeDb(ide, ["seat-gate-off"]);
    setPathOverrides({ CURSOR_DB_PATH: ide });
    const db = new SessionStore(join(tmpDir, "gate-off-local.db"));

    const fetches: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((url: string) => {
      fetches.push(String(url));
      return Promise.reject(new Error("no vendor call is permitted here"));
    }) as unknown as typeof fetch;
    let seatTier;
    try {
      ({ seatTier } = await scanCursor(db, { resolveSeatTier: resolveCursorSeatTier }));
    } finally {
      globalThis.fetch = originalFetch;
    }

    assert.deepEqual(fetches, [], "the vendor is not contacted with the gate off");
    assert.deepEqual(seatTier, { outcome: "disabled" });
    assert.equal(db.getMeta(SEAT_TIER_META_KEY), null, "no row is written on a disabled cycle");
    const meta = installMetaOf(db, "seat-gate-off");
    assert.ok(!("cursor_billing_tier" in meta), "no tier without a lookup");
  });

  it("never stamps plan_tier_source from the vendor path — the local origin survives", async () => {
    // Provenance belongs to the consumer that ACCEPTS a vendor tier. A stamp
    // here would give a rejected tier REPORTED provenance
    // and destroy the local origin that says where it actually came from.
    const ide = join(tmpDir, "provenance.vscdb");
    buildIdeDb(ide, ["seat-provenance"]);
    setPathOverrides({ CURSOR_DB_PATH: ide });
    const db = new SessionStore(join(tmpDir, "provenance-local.db"));

    const spy = spyResolver({
      cursor_billing_tier: "TEAM_MEMBER_BILLING_TIER_TIER_1000",
      cursor_team_membership_type: "SELF_SERVE",
    });
    await extractCursor(db, { seatTierLookup: unusedLookup, resolveSeatTier: spy.impl });

    const meta = installMetaOf(db, "seat-provenance");
    assert.equal(meta["cursor_billing_tier"], "TEAM_MEMBER_BILLING_TIER_TIER_1000");
    assert.equal(
      meta["plan_tier_source"],
      "cursor_vscdb",
      "the local origin is what the row carries, unchanged by the lookup",
    );
  });
});

// ── The CLI surface: reader only ─────────────────────────────────────────────

describe("cursorCliExtractor — reads the seat-tier row, never writes it", () => {
  let tmpDir: string;
  let statsigPath: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-cursor-cli-seat-"));
    statsigPath = join(tmpDir, "statsig-cache.json");
    setHomeOverride(join(tmpDir, "home"));
    setPathOverrides({
      CURSOR_STATSIG_CACHE_PATH: statsigPath,
      CURSOR_CLI_CONFIG_PATH: join(tmpDir, "no-cli-config.json"),
    });
    writeFileSync(
      statsigPath,
      JSON.stringify({
        data: JSON.stringify({
          user: {
            userID: SUBJECT,
            custom: {
              isEnterpriseUser: false,
              isEnterpriseTrialUser: false,
              teamID: Number(TEAM_ID),
            },
          },
        }),
      }),
    );
  });

  after(() => {
    setHomeOverride(undefined);
    setPathOverrides({
      CURSOR_STATSIG_CACHE_PATH: undefined,
      CURSOR_CLI_CONFIG_PATH: undefined,
      CURSOR_CLI_CHATS_PATH: undefined,
    });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const okRow = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      outcome: "ok",
      fetchedAt: new Date(Date.now() - 60_000).toISOString(),
      billingTier: "TEAM_MEMBER_BILLING_TIER_TIER_2000",
      teamMembershipType: "SELF_SERVE",
      isYearlyPlan: true,
      accountFp: ACCOUNT_FP,
      ...over,
    });

  it("stamps the cached tier for the account the CLI itself is signed into", () => {
    const meta = detectCursorCliTier({ getMeta: () => okRow() });
    assert.equal(meta?.cursor_billing_tier, "TEAM_MEMBER_BILLING_TIER_TIER_2000");
    assert.equal(meta?.cursor_team_membership_type, "SELF_SERVE");
    assert.equal(meta?.cursor_is_yearly_plan, true);
    assert.equal(
      meta?.plan_tier_source,
      "cursor_cli_statsig",
      "the CLI's own local origin is untouched by the cached vendor values",
    );
  });

  it("stamps nothing for another account, a stale row, or a non-ok outcome", () => {
    const cases: { label: string; row: string }[] = [
      { label: "another account", row: okRow({ accountFp: "deadbeef" }) },
      { label: "no fingerprint", row: okRow({ accountFp: undefined }) },
      {
        label: "aged out",
        row: okRow({
          fetchedAt: new Date(Date.now() - SEAT_TIER_LOOKUP_TTL_MS - 1000).toISOString(),
        }),
      },
      { label: "enterprise", row: okRow({ outcome: "enterprise" }) },
      { label: "error", row: okRow({ outcome: "error" }) },
      { label: "lease only", row: JSON.stringify({ attemptStartedAt: new Date().toISOString() }) },
    ];
    for (const c of cases) {
      const meta = detectCursorCliTier({ getMeta: () => c.row });
      assert.equal(meta?.cursor_billing_tier, undefined, c.label);
      assert.equal(meta?.cursor_team_membership_type, undefined, c.label);
      assert.equal(meta?.cursor_is_yearly_plan, undefined, c.label);
    }
  });

  it("a CLI-sourced cycle reads the row and writes nothing to it", () => {
    // Write ownership is single (readCachedSeatTierStamp).
    const chats = join(tmpDir, "chats-empty");
    mkdirSync(chats, { recursive: true });
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: chats });

    const reads: string[] = [];
    const writes: string[] = [];
    const fakeDb = {
      getMeta: (key: string) => {
        reads.push(key);
        return key === SEAT_TIER_META_KEY ? okRow() : null;
      },
      setMeta: (key: string) => {
        writes.push(key);
      },
    } as unknown as SessionStore;

    assert.equal(extractCursorCli(fakeDb, new Set(), { cursorSeatTierLookupEnabled: true }), 0);
    assert.ok(reads.includes(SEAT_TIER_META_KEY), "the cycle consults the cached row");
    assert.deepEqual(writes, [], "and writes nothing — not the row, not anything else");
  });
});

// ── The CLI surface obeys the same kill switch ───────────────────────────────

describe("cursorCliExtractor — the seat-tier kill switch", () => {
  let tmpDir: string;
  let chatsRoot: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-cursor-cli-killswitch-"));
    chatsRoot = join(tmpDir, "chats");
    setHomeOverride(join(tmpDir, "home"));
    setPathOverrides({
      CURSOR_CLI_CHATS_PATH: chatsRoot,
      CURSOR_CLI_CONFIG_PATH: join(tmpDir, "no-cli-config.json"),
      CURSOR_STATSIG_CACHE_PATH: join(tmpDir, "statsig-cache.json"),
    });
    // The CLI is signed into the same account the cached row describes, so an
    // absent stamp below is the gate's doing and not a fingerprint mismatch.
    writeFileSync(
      join(tmpDir, "statsig-cache.json"),
      JSON.stringify({
        data: JSON.stringify({
          user: {
            userID: SUBJECT,
            custom: { isEnterpriseUser: false, isEnterpriseTrialUser: false, teamID: Number(TEAM_ID) },
          },
        }),
      }),
    );
  });

  after(() => {
    setHomeOverride(undefined);
    setPathOverrides({
      CURSOR_CLI_CHATS_PATH: undefined,
      CURSOR_CLI_CONFIG_PATH: undefined,
      CURSOR_STATSIG_CACHE_PATH: undefined,
    });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  /** A fresh, account-matching `ok` row — the state that outlives a disable. */
  const okRow = (): string =>
    JSON.stringify({
      outcome: "ok",
      fetchedAt: new Date(Date.now() - 60_000).toISOString(),
      billingTier: "TEAM_MEMBER_BILLING_TIER_TIER_2000",
      teamMembershipType: "SELF_SERVE",
      isYearlyPlan: true,
      accountFp: ACCOUNT_FP,
    });

  /**
   * One ingestible cursor-agent CLI session, in a chats root of its own — the
   * reader walks the whole tree, so a shared root would make each case ingest
   * every earlier case's session too.
   */
  function buildCliSession(sid: string): void {
    const root = join(chatsRoot, sid);
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: root });
    const dir = join(root, "ws", sid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        hasConversation: true,
        createdAtMs: Date.now() - 120_000,
        updatedAtMs: Date.now() - 60_000,
        cwd: join(tmpDir, "repo"),
      }),
    );
    const raw = new Database(join(dir, "store.db"));
    raw.exec("CREATE TABLE IF NOT EXISTS blobs (id INTEGER PRIMARY KEY, data TEXT)");
    raw.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
    raw
      .prepare("INSERT INTO blobs (data) VALUES (?)")
      .run(
        JSON.stringify({
          role: "user",
          content: [{ type: "text", text: "<user_query>ship it</user_query>" }],
        }),
      );
    raw.close();
  }

  function runCliCycle(sid: string, cursorSeatTierLookupEnabled: boolean): Record<string, unknown> {
    buildCliSession(sid);
    const db = new SessionStore(join(tmpDir, `${sid}-local.db`));
    db.setMeta(SEAT_TIER_META_KEY, okRow());
    assert.equal(
      extractCursorCli(db, new Set(), { cursorSeatTierLookupEnabled }),
      1,
      "the session must be ingested, or the metadata assertion is vacuous",
    );
    return installMetaOf(db, sid);
  }

  it("stamps the cached tier onto a CLI session while the gate is on", () => {
    const meta = runCliCycle("cli-gate-on", true);
    assert.equal(meta["cursor_billing_tier"], "TEAM_MEMBER_BILLING_TIER_TIER_2000");
    assert.equal(meta["cursor_team_membership_type"], "SELF_SERVE");
    assert.equal(meta["cursor_is_yearly_plan"], true);
  });

  it("stamps nothing once the gate is off, though the row is fresh and matching", () => {
    const meta = runCliCycle("cli-gate-off", false);
    // A cache row outlives the lookup's withdrawal for the rest of its 24h TTL, so
    // a CLI path that only stopped making calls would keep stamping vendor-derived
    // tiers out of it, and the withdrawn feature would stay partly active.
    assert.equal(meta["cursor_billing_tier"], undefined);
    assert.equal(meta["cursor_team_membership_type"], undefined);
    assert.equal(meta["cursor_is_yearly_plan"], undefined);
    // The locally-derived fields are untouched: the gate withholds the vendor's
    // account statement, not this surface's own reads.
    assert.equal(meta["plan_tier_source"], "cursor_cli_statsig");
    assert.equal(meta["cursor_team_id"], TEAM_ID);
  });

  it("reaches the CLI surface through extractCursor on both of its call sites", async () => {
    // Two sites run the CLI reader — the IDE-absent early return and the normal
    // post-IDE pass. A gate honoured on only one leaves the feature live for
    // whichever developers take the other, which is invisible from either alone.
    const noStamp = (): Promise<SeatTierResolution> =>
      Promise.resolve({ outcome: "not_team", stamp: {}, attempted: false });

    for (const ideDbPresent of [false, true]) {
      const sid = `cli-through-${String(ideDbPresent)}`;
      buildCliSession(sid);
      const ide = join(tmpDir, `${sid}.vscdb`);
      if (ideDbPresent) buildIdeDb(ide, [`ide-${sid}`]);
      setPathOverrides({ CURSOR_DB_PATH: ide });

      const db = new SessionStore(join(tmpDir, `${sid}-through.db`));
      db.setMeta(SEAT_TIER_META_KEY, okRow());
      await extractCursor(db, { resolveSeatTier: noStamp });

      const meta = installMetaOf(db, sid);
      const label = `ideDbPresent=${String(ideDbPresent)}`;
      assert.equal(meta["plan_tier_source"], "cursor_cli_statsig", `${label}: not the CLI row`);
      assert.equal(meta["cursor_billing_tier"], undefined, label);
      assert.equal(meta["cursor_team_membership_type"], undefined, label);
    }
    setPathOverrides({ CURSOR_DB_PATH: undefined });
  });

  it("leaves the row untouched in both states — this surface never writes it", () => {
    // Read-only is the invariant, and the gate must not turn into an invalidator:
    // the IDE resolver is the only writer, and a write here would consume the
    // day's attempt lease or thrash a row this surface holds no token to refresh.
    for (const enabled of [true, false]) {
      const sid = `cli-readonly-${String(enabled)}`;
      buildCliSession(sid);
      const db = new SessionStore(join(tmpDir, `${sid}-local.db`));
      db.setMeta(SEAT_TIER_META_KEY, okRow());
      const before = db.getMeta(SEAT_TIER_META_KEY);
      extractCursorCli(db, new Set(), { cursorSeatTierLookupEnabled: enabled });
      assert.equal(db.getMeta(SEAT_TIER_META_KEY), before, `gate=${String(enabled)}`);
    }
  });
});
