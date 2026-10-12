// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The scan entry points: source order and failure isolation, the Cursor
 * seat-tier gate and cache, the home-root override's reach, and the per-scan
 * result fields.
 */
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { platform, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DuplicateSourceError,
  UnknownPathKeyError,
  UnsupportedSourceError,
  capabilities,
  exportSessions,
  readAll,
  readSource,
  type ScanProgressEvent,
  type ScanResult,
  type SeatTierLookup,
  type UpsertParams,
} from "../index";
import { PATH_KEYS, setPathOverrides } from "../extractors/pathResolver";
import { DEFAULT_RUNNERS, DEFAULT_SOURCES, runScan } from "../scan";
import type { Logger } from "../seams/logger";
import { SEAT_TIER_META_KEY } from "../seams/seatTier";
import { hashUsername } from "../redaction/anonymizer";
import { SessionStore } from "../store/SessionStore";
import { IDE_TYPES } from "../types/session";

const FIXTURES = resolve(import.meta.dirname, "..", "..", "fixtures");
const CLAUDE_FIXTURE = join(FIXTURES, "extraction", "claude-code", "project_happy", "abc123def456.jsonl");
const CODEX_FIXTURE = join(FIXTURES, "extraction", "codex", "goal-rollout.jsonl");

const TEAM_ID = "1234567";
const SUBJECT = "auth0|user-abc";
const ACCOUNT_FP = createHash("sha256").update(SUBJECT).digest("hex").slice(0, 8);
/** A JWT-shaped token whose payload names SUBJECT, so the cache's fingerprint check can match. */
const TOKEN = `h.${Buffer.from(JSON.stringify({ sub: SUBJECT })).toString("base64url")}.s`;

let tmp: string;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "local-session-extractor-readall-"));
});

after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

function freshDir(name: string): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A home holding one Claude Code session under `project` and one Codex rollout keyed by `uuid`. */
function plantHome(home: string, project: string, uuid: string): void {
  const projectDir = join(home, ".claude", "projects", project);
  mkdirSync(projectDir, { recursive: true });
  copyFileSync(CLAUDE_FIXTURE, join(projectDir, "abc123def456.jsonl"));
  plantCodexRollout(join(home, ".codex"), uuid);
}

function plantCodexRollout(codexHome: string, uuid: string): void {
  const day = join(codexHome, "sessions", "2026", "01", "01");
  mkdirSync(day, { recursive: true });
  copyFileSync(CODEX_FIXTURE, join(day, `rollout-2026-01-01T00-00-00-${uuid}.jsonl`));
}

/** A Cursor state.vscdb with one composer and the ItemTable keys a team seat carries. */
function buildCursorDb(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);");
  const kv = raw.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  const lastUpdatedAt = Date.now() - 3 * 60 * 60 * 1000;
  kv.run(
    "composerData:seat-composer",
    JSON.stringify({
      composerId: "seat-composer",
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
  kv.run("bubbleId:seat-composer:u1", JSON.stringify({ bubbleId: "u1", type: 1, text: "ask" }));
  kv.run(
    "bubbleId:seat-composer:a1",
    JSON.stringify({ bubbleId: "a1", type: 2, text: "answer", tokenCount: { inputTokens: 10, outputTokens: 20 } }),
  );
  const item = raw.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
  item.run("cursorAuth/stripeMembershipType", "enterprise");
  item.run("cursorAuth/accessToken", TOKEN);
  item.run(
    "workbench.experiments.statsigBootstrap",
    JSON.stringify({
      user: { userID: SUBJECT, custom: { isEnterpriseUser: false, isEnterpriseTrialUser: false, teamID: Number(TEAM_ID) } },
    }),
  );
  raw.close();
}

function sessionIds(store: SessionStore): string[] {
  const rows = store.raw().prepare("SELECT ide_type, session_id FROM conversations ORDER BY ide_type, session_id").all() as {
    ide_type: string;
    session_id: string;
  }[];
  return rows.map((r) => `${r.ide_type}/${r.session_id}`);
}

/** Replaces the global fetch with one that throws and counts its calls. */
function stubFetch(): { calls: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    throw new Error("no network call is permitted in this scan");
  }) as typeof fetch;
  return { calls: () => calls, restore: () => void (globalThis.fetch = original) };
}

describe("the Cursor seat-tier gate", () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  beforeEach(() => (fetchStub = stubFetch()));
  afterEach(() => fetchStub.restore());

  it("with no lookup reports disabled when a Cursor state database exists, and never fetches", async () => {
    const home = freshDir("gate-disabled-home");
    const cursorDb = join(tmp, "gate-disabled.vscdb");
    buildCursorDb(cursorDb);
    const store = new SessionStore(join(tmp, "gate-disabled.db"));

    const result = await readAll(store, { home, paths: { CURSOR_DB_PATH: cursorDb } });

    assert.deepEqual(result.seatTier, { outcome: "disabled" });
    assert.equal(result.counts.cursor, 1, "the composer is still extracted");
    assert.equal(fetchStub.calls(), 0);
    assert.equal(store.getMeta(SEAT_TIER_META_KEY), null, "a disabled cycle writes no cache row");
    store.close();
  });

  it("with no lookup reports no seatTier when no Cursor state database exists, and never fetches", async () => {
    const home = freshDir("gate-absent-home");
    const store = new SessionStore(join(tmp, "gate-absent.db"));

    const result = await readAll(store, { home });

    assert.equal("seatTier" in result, false);
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.equal(fetchStub.calls(), 0);
    store.close();
  });

  it("with a lookup and a fresh cache row makes no call and stamps the cached tier", async () => {
    const home = freshDir("gate-cached-home");
    const cursorDb = join(tmp, "gate-cached.vscdb");
    buildCursorDb(cursorDb);
    const store = new SessionStore(join(tmp, "gate-cached.db"));
    store.setMeta(
      SEAT_TIER_META_KEY,
      JSON.stringify({
        outcome: "ok",
        fetchedAt: new Date(Date.now() - 60_000).toISOString(),
        billingTier: "TEAM_MEMBER_BILLING_TIER_TIER_2000",
        teamMembershipType: "SELF_SERVE",
        isYearlyPlan: false,
        accountFp: ACCOUNT_FP,
      }),
    );
    let lookups = 0;
    const lookup: SeatTierLookup = () => {
      lookups++;
      return Promise.reject(new Error("a fresh cache row must not reach the lookup"));
    };

    const result = await readSource("cursor", store, { home, paths: { CURSOR_DB_PATH: cursorDb }, cursor: { lookup } });

    assert.equal(lookups, 0);
    assert.equal(fetchStub.calls(), 0);
    assert.deepEqual(result.seatTier, { outcome: "cache_fresh" });
    const row = store.getConversation("cursor", "seat-composer");
    const meta = JSON.parse(row?.installation_metadata ?? "{}") as Record<string, unknown>;
    assert.equal(meta["cursor_billing_tier"], "TEAM_MEMBER_BILLING_TIER_TIER_2000");
    store.close();
  });
});

describe("source order and failure isolation", () => {
  it("runs the sources in the listed order", async () => {
    const home = freshDir("order-home");
    plantHome(home, "project_inroot", "11111111-1111-4111-8111-111111111111");
    const store = new SessionStore(join(tmp, "order.db"));
    const events: ScanProgressEvent[] = [];

    const result = await readAll(store, { home, sources: ["kiro", "claude-code", "codex"], onProgress: (e) => events.push(e) });

    assert.deepEqual(events, [
      { source: "kiro", state: "start" },
      { source: "kiro", state: "done", count: 0 },
      { source: "claude-code", state: "start" },
      { source: "claude-code", state: "done", count: 1 },
      { source: "codex", state: "start" },
      { source: "codex", state: "done", count: 1 },
    ]);
    assert.deepEqual(result.counts, { kiro: 0, "claude-code": 1, codex: 1 });
    assert.deepEqual(result.partial, { kiro: false, "claude-code": false, codex: false });
    store.close();
  });

  it("records a failing source as a whole-source error and still runs the next", async () => {
    const home = freshDir("failure-home");
    plantHome(home, "project_inroot", "11111111-1111-4111-8111-111111111111");
    const store = new SessionStore(join(tmp, "failure.db"));
    const events: ScanProgressEvent[] = [];
    const runners = {
      ...DEFAULT_RUNNERS,
      "claude-code": () => Promise.reject(new Error("projects root unreadable")),
    };

    const result = await runScan(store, { home, sources: ["kiro", "claude-code", "codex"], onProgress: (e) => events.push(e) }, runners);

    assert.deepEqual(
      events.map((e) => `${e.source}:${e.state}`),
      ["kiro:start", "kiro:done", "claude-code:start", "claude-code:done", "codex:start", "codex:done"],
    );
    assert.deepEqual(result.errors, [
      { source: "claude-code", scope: "source", sessionId: null, file: null, message: "projects root unreadable" },
    ]);
    assert.equal(result.partial["claude-code"], true);
    assert.equal(result.counts.codex, 1, "the source after the failure still wrote its session");
    store.close();
  });

  it("rejects an unknown source before running anything", async () => {
    const store = new SessionStore(join(tmp, "unsupported.db"));
    const events: ScanProgressEvent[] = [];
    await assert.rejects(
      readAll(store, { home: freshDir("unsupported-home"), sources: ["claude-code", "nope" as "kiro"], onProgress: (e) => events.push(e) }),
      (err: unknown) => err instanceof UnsupportedSourceError && err.source === "nope",
    );
    assert.deepEqual(events, []);
    assert.deepEqual(sessionIds(store), []);
    store.close();
  });
});

describe("the home-root override", () => {
  const saved: Record<string, string | undefined> = {};
  const ENV = ["HOME", "CODEX_HOME", "CODEX_SQLITE_HOME"] as const;
  let root: string;
  let decoyHome: string;
  let decoyCodexEnv: string;
  let decoySqliteEnv: string;

  /** A real-looking install of every source under `home`, plus Codex trees for the two Codex variables. */
  before(() => {
    for (const k of ENV) saved[k] = process.env[k];
    root = freshDir("home-root");
    plantHome(root, "project_inroot", "11111111-1111-4111-8111-111111111111");

    decoyHome = freshDir("decoy-home");
    plantHome(decoyHome, "project_decoy", "22222222-2222-4222-8222-222222222222");
    // Read from the home directory itself rather than a path getter, so it lands on every Claude Code row.
    writeFileSync(join(decoyHome, ".claude", "settings.json"), JSON.stringify({ mcpServers: { "decoy-mcp-server": {} } }));
    cpSync(join(FIXTURES, "extraction", "copilot", "cli-sessions"), join(decoyHome, ".copilot", "session-state"), { recursive: true });
    buildCursorDb(join(decoyHome, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"));
    const kiroCase = join(FIXTURES, "turn-telemetry", "kiro", "turn-brackets", "sess_7ccc8aec-13a6-da54-607a-72cec49b4db5");
    cpSync(kiroCase, join(decoyHome, ".kiro", "sessions", "ws_decoy", "sess_7ccc8aec-13a6-da54-607a-72cec49b4db5"), { recursive: true });

    decoyCodexEnv = freshDir("decoy-codex-env");
    plantCodexRollout(decoyCodexEnv, "33333333-3333-4333-8333-333333333333");
    decoySqliteEnv = freshDir("decoy-codex-sqlite-env");
    const sqlitePath = join(decoySqliteEnv, "state_5.sqlite");
    copyFileSync(join(FIXTURES, "extraction", "codex", "state_5.sqlite"), sqlitePath);
    const sqlite = new DatabaseSync(sqlitePath);
    sqlite.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(join(FIXTURES, "extraction", "codex", "rollout-fixture.jsonl"), "thread-fixture-001");
    sqlite.close();

    process.env["HOME"] = decoyHome;
  });

  after(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // Antigravity is left out of the unredirected scan: with no override it asks
  // the live Antigravity process for this machine's real sessions.
  const UNREDIRECTED_SOURCES = IDE_TYPES.filter((s) => s !== "antigravity");

  /** Every stored row, as one string, for a search for decoy content. */
  const allRows = (store: SessionStore): string =>
    JSON.stringify(store.raw().prepare("SELECT * FROM conversations").all());

  it("the decoy is a tree a scan reads when nothing redirects it", async () => {
    delete process.env["CODEX_HOME"];
    delete process.env["CODEX_SQLITE_HOME"];
    const store = new SessionStore(join(tmp, "decoy-control.db"));
    await readAll(store, { sources: UNREDIRECTED_SOURCES });
    assert.ok(allRows(store).includes("decoy-mcp-server"), "the decoy settings reach the rows");
    const ids = sessionIds(store);
    for (const want of [
      "claude-code/project_decoy::abc123def456",
      "codex/22222222-2222-4222-8222-222222222222",
      "copilot/cli-session-001",
      "cursor/seat-composer",
      "kiro/kiro-ide:sess_7ccc8aec-13a6-da54-607a-72cec49b4db5",
    ]) {
      assert.ok(ids.includes(want), `${want} missing from ${ids.join(", ")}`);
    }
    store.close();
  });

  it("with an empty environment reads only the root", async () => {
    delete process.env["CODEX_HOME"];
    delete process.env["CODEX_SQLITE_HOME"];
    const store = new SessionStore(join(tmp, "home-empty-env.db"));
    const result = await readAll(store, { home: root });
    assert.deepEqual(sessionIds(store), [
      "claude-code/project_inroot::abc123def456",
      "codex/11111111-1111-4111-8111-111111111111",
    ]);
    assert.ok(!allRows(store).includes("decoy"), "no decoy content reaches a root row");
    assert.equal("seatTier" in result, false, "the decoy's Cursor database is never reached");
    store.close();
  });

  it("reads only the root even when Codex's own variables point elsewhere", async () => {
    process.env["CODEX_HOME"] = decoyCodexEnv;
    process.env["CODEX_SQLITE_HOME"] = decoySqliteEnv;
    const store = new SessionStore(join(tmp, "home-codex-env.db"));
    await readAll(store, { home: root });
    assert.deepEqual(sessionIds(store), [
      "claude-code/project_inroot::abc123def456",
      "codex/11111111-1111-4111-8111-111111111111",
    ]);
    store.close();
  });
});

describe("the scan result", () => {
  it("stamps the caller's extractor version per source, and null for a source it omits", async () => {
    const home = freshDir("versions-home");
    plantHome(home, "project_inroot", "11111111-1111-4111-8111-111111111111");
    const store = new SessionStore(join(tmp, "versions.db"));
    await readAll(store, { home, sources: ["claude-code", "codex"], extractorVersions: { "claude-code": 7 } });
    assert.equal(store.getConversation("claude-code", "project_inroot::abc123def456")?.extractor_version, 7);
    assert.equal(store.getConversation("codex", "11111111-1111-4111-8111-111111111111")?.extractor_version, null);
    store.close();
  });

  it("records a session that fails to write as a per-session error, and the source still completes", async () => {
    const home = freshDir("session-error-home");
    plantHome(home, "project_inroot", "11111111-1111-4111-8111-111111111111");
    class FailingStore extends SessionStore {
      override upsert(params: UpsertParams): void {
        if (params.ideType === "claude-code") throw new Error("disk full");
        super.upsert(params);
      }
    }
    const store = new FailingStore(join(tmp, "session-error.db"));
    const result = await readAll(store, { home, sources: ["claude-code", "codex"] });
    assert.deepEqual(result.errors, [
      {
        source: "claude-code",
        scope: "session",
        sessionId: "project_inroot::abc123def456",
        // The scan follows a symlinked home (macOS's /var is one), so the path is the real one.
        file: join(realpathSync(home), ".claude", "projects", "project_inroot", "abc123def456.jsonl"),
        message: "disk full",
      },
    ]);
    assert.deepEqual(result.partial, { "claude-code": false, codex: false });
    assert.equal(result.counts.codex, 1);
    store.close();
  });

  it("counts unrecognized record kinds by provider and kind", async () => {
    const home = freshDir("unknown-kinds-home");
    const projectDir = join(home, ".claude", "projects", "project_drift");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "session.jsonl"),
      [
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, timestamp: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "ok" }, timestamp: "2026-01-01T00:00:01.000Z" }),
        JSON.stringify({ type: "__novel_cc_kind__", timestamp: "2026-01-01T00:00:02.000Z" }),
      ].join("\n"),
    );
    const store = new SessionStore(join(tmp, "unknown-kinds.db"));
    const counted: string[] = [];
    const result = await readSource("claude-code", store, {
      home,
      metrics: { inc: (name, tags) => counted.push(`${name} ${tags?.component ?? ""}`), observe: () => {} },
    });
    assert.deepEqual(result.unknownRecordKinds, { "claude-code:__novel_cc_kind__": 1 });
    assert.ok(counted.includes("unknown_record_kinds extraction.claude_code"), "the scan's sink got the counter");
    store.close();
  });

  it("routes the scan's logger to that scan", async () => {
    const home = freshDir("seams-home");
    plantHome(home, "project_inroot", "11111111-1111-4111-8111-111111111111");
    const store = new SessionStore(join(tmp, "seams.db"));
    const logged: string[] = [];
    await readSource("claude-code", store, {
      home,
      logger: {
        info: (c, e) => logged.push(`${c} ${e}`),
        warn: (c, e) => logged.push(`${c} ${e}`),
        error: (c, e) => logged.push(`${c} ${e}`),
        debug: (c, e) => logged.push(`${c} ${e}`),
      },
    });
    assert.ok(logged.some((l) => l.startsWith("extraction.claude_code ")), logged.join("\n"));
    store.close();
  });
});

describe("capabilities", () => {
  it("describes every source in the default scan order, the jsonl and json exports, macOS, and a code version per extractor", () => {
    const caps = capabilities();
    assert.deepEqual([...caps.sources], ["claude-code", "copilot", "antigravity", "codex", "kiro", "cursor"]);
    assert.deepEqual([...caps.sources].sort(), [...IDE_TYPES].sort());
    assert.deepEqual(caps.sources, DEFAULT_SOURCES);
    assert.deepEqual([...caps.formats], ["jsonl", "json"]);
    assert.deepEqual([...caps.platforms], ["darwin"]);
    assert.match(caps.packageVersion, /^\d+\.\d+\.\d+/);
    assert.ok(Number.isInteger(caps.schemaVersion) && caps.schemaVersion > 0);
    assert.deepEqual(Object.keys(caps.extractorCodeVersion).sort(), [...IDE_TYPES].sort());
  });
});

/** A logger that records `<component> <event>` and the event's data. */
function recordingLogger(): { logger: Logger; lines: { line: string; data: Record<string, unknown> | undefined }[] } {
  const lines: { line: string; data: Record<string, unknown> | undefined }[] = [];
  const record = (component: string, event: string, data?: Record<string, unknown>): void => {
    lines.push({ line: `${component} ${event}`, data });
  };
  return { logger: { info: record, warn: record, error: record, debug: record }, lines };
}

/** Replaces console's log, warn and error with counters, for a check that the package writes nothing there. */
function stubConsole(): { calls: () => number; restore: () => void } {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  let calls = 0;
  const count = (): void => void calls++;
  console.log = count;
  console.warn = count;
  console.error = count;
  return {
    calls: () => calls,
    restore: () => Object.assign(console, saved),
  };
}

/** The Cursor IDE state database's default location under `home`. */
function cursorDbUnder(home: string): string {
  return platform() === "darwin"
    ? join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")
    : join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

function writeGarbage(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "this is not a sqlite database\n".repeat(64));
}

describe("the error contract", () => {
  it("reports an unreadable Cursor, Codex or Antigravity database as a source-scoped error and a partial source, writing nothing to the console", async () => {
    const home = freshDir("garbage-db-home");
    writeGarbage(cursorDbUnder(home));
    writeGarbage(join(home, ".codex", "state_5.sqlite"));
    const antigravityDb = join(tmp, "garbage-antigravity.vscdb");
    writeGarbage(antigravityDb);
    const store = new SessionStore(join(tmp, "garbage-db.db"));
    const consoleStub = stubConsole();
    let result: ScanResult;
    try {
      result = await readAll(store, { home, sources: ["cursor", "codex", "antigravity"], paths: { ANTIGRAVITY_DB_PATH: antigravityDb } });
    } finally {
      consoleStub.restore();
    }
    assert.deepEqual(result.partial, { cursor: true, codex: true, antigravity: true });
    for (const source of ["cursor", "codex", "antigravity"]) {
      const sourceErrors = result.errors.filter((e) => e.source === source && e.scope === "source" && e.sessionId === null);
      assert.equal(sourceErrors.length, 1, `${source}: ${JSON.stringify(result.errors)}`);
    }
    assert.equal(consoleStub.calls(), 0, "the default logger is silent and nothing bypasses it");
    store.close();
  });

  it("reports an unreadable Claude Code projects folder as a source error, not as no sessions", async () => {
    const home = freshDir("unreadable-claude-home");
    plantHome(home, "-proj", "55555555-5555-4555-8555-555555555555");
    const projects = join(home, ".claude", "projects");
    chmodSync(projects, 0o000);
    const store = new SessionStore(join(tmp, "unreadable-claude.db"));
    let result: ScanResult;
    try {
      result = await readAll(store, { home, sources: ["claude-code"] });
    } finally {
      chmodSync(projects, 0o755);
    }
    assert.deepEqual(result.partial, { "claude-code": true });
    const sourceErrors = result.errors.filter((e) => e.source === "claude-code" && e.scope === "source");
    assert.equal(sourceErrors.length, 1, JSON.stringify(result.errors));
    assert.match(sourceErrors[0]!.message, /EACCES/);
    store.close();
  });

  it("reports an unreadable Claude Code project folder and still reads the others", async () => {
    const home = freshDir("unreadable-claude-project-home");
    plantHome(home, "-readable", "66666666-6666-4666-8666-666666666666");
    const locked = join(home, ".claude", "projects", "-locked");
    mkdirSync(locked);
    copyFileSync(CLAUDE_FIXTURE, join(locked, "abc123def456.jsonl"));
    chmodSync(locked, 0o000);
    const store = new SessionStore(join(tmp, "unreadable-claude-project.db"));
    let result: ScanResult;
    try {
      result = await readAll(store, { home, sources: ["claude-code"] });
    } finally {
      chmodSync(locked, 0o755);
    }
    assert.equal(result.counts["claude-code"], 1, "the readable project's session is read");
    assert.deepEqual(result.partial, { "claude-code": true });
    assert.equal(result.errors.filter((e) => e.source === "claude-code" && e.scope === "source").length, 1, JSON.stringify(result.errors));
    store.close();
  });

  it("names the unreadable folder in the error, its owner hashed and a token in it masked", async () => {
    const owner = "eacces-owner";
    const home = freshDir(join("Users", owner));
    plantHome(home, "-readable", "77777777-7777-4777-8777-777777777777");
    const projects = join(home, ".claude", "projects");
    const locked = join(projects, "-ghp_0123456789abcdefghij0123456789abcdef"); // fake credential, test fixture. gitleaks:allow
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    const store = new SessionStore(join(tmp, "eacces-message.db"));
    let lockedResult: ScanResult;
    let rootResult: ScanResult;
    try {
      lockedResult = await readAll(store, { home, sources: ["claude-code"] });
      chmodSync(projects, 0o000);
      try {
        rootResult = await readAll(store, { home, sources: ["claude-code"] });
      } finally {
        chmodSync(projects, 0o755);
      }
    } finally {
      chmodSync(locked, 0o755);
      store.close();
    }
    const shownProjects = join(realpathSync(join(tmp, "Users")), hashUsername(owner), ".claude", "projects");
    assert.deepEqual(
      rootResult.errors.map((e) => e.message),
      [`EACCES: permission denied, scandir '${shownProjects}'`],
    );
    assert.deepEqual(
      lockedResult.errors.map((e) => e.message),
      [`EACCES: permission denied, scandir '${shownProjects}/-████████'`],
    );
  });

  it("treats a missing Claude Code projects folder as no sessions, with no error", async () => {
    const home = freshDir("no-claude-home");
    const store = new SessionStore(join(tmp, "no-claude.db"));
    const result = await readAll(store, { home, sources: ["claude-code"] });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.partial, { "claude-code": false });
    store.close();
  });

  it("logs a progress callback that throws, and the scan still finishes", async () => {
    const home = freshDir("progress-throws-home");
    plantHome(home, "project_inroot", "11111111-1111-4111-8111-111111111111");
    const store = new SessionStore(join(tmp, "progress-throws.db"));
    const { logger, lines } = recordingLogger();
    const result = await readAll(store, {
      home,
      sources: ["claude-code", "codex"],
      logger,
      onProgress: () => {
        throw new Error("host callback bug");
      },
    });
    assert.deepEqual(result.counts, { "claude-code": 1, codex: 1 });
    assert.equal(lines.filter((l) => l.line === "local_session_extractor.scan progress_callback_failed").length, 4);
    store.close();
  });

  it("redacts the file and message of every recorded error, and writes nothing to the console", async () => {
    const home = join(tmp, "error-redaction", "Users", "alice");
    plantHome(home, "project_inroot", "11111111-1111-4111-8111-111111111111");
    const cursorDb = join(tmp, "error-redaction.vscdb");
    buildCursorDb(cursorDb);
    const secret = "AKIAABCDEFGHIJKLMNOP"; // fake credential, test fixture. gitleaks:allow
    class FailingStore extends SessionStore {
      override upsert(params: UpsertParams): void {
        if (params.ideType === "claude-code" || params.ideType === "cursor") {
          throw new Error(`disk full writing ${home}/.claude/cache with ${secret}`);
        }
        super.upsert(params);
      }
    }
    const store = new FailingStore(join(tmp, "error-redaction.db"));
    const consoleStub = stubConsole();
    let sessionScan: ScanResult;
    let sourceScan: ScanResult;
    try {
      sessionScan = await readAll(store, { home, sources: ["claude-code", "cursor"], paths: { CURSOR_DB_PATH: cursorDb } });
      sourceScan = await runScan(store, { home, sources: ["codex"] }, {
        ...DEFAULT_RUNNERS,
        codex: () => Promise.reject(new Error(`cannot open ${home}/.codex with ${secret}`)),
      });
    } finally {
      consoleStub.restore();
    }
    assert.equal(consoleStub.calls(), 0, "a failing session logs through the package logger only");
    assert.deepEqual(
      sessionScan.errors.map((e) => `${e.source}:${e.scope}`),
      ["claude-code:session", "cursor:session"],
    );
    assert.equal(sourceScan.errors.length, 1);
    for (const e of [...sessionScan.errors, ...sourceScan.errors]) {
      const text = JSON.stringify(e);
      assert.ok(!text.includes(secret), text);
      assert.ok(!text.includes("alice"), text);
    }
    store.close();
  });
});

describe("scan option validation", () => {
  const cases: { name: string; opts: Parameters<typeof readAll>[1]; error: (err: unknown) => boolean }[] = [
    { name: "an unknown paths key", opts: { paths: { NOT_A_KEY: "/x" } as never }, error: (e) => e instanceof UnknownPathKeyError && e.key === "NOT_A_KEY" },
    { name: "HOME as a paths key", opts: { paths: { HOME: "/x" } as never }, error: (e) => e instanceof UnknownPathKeyError },
    { name: "an empty home", opts: { home: "" }, error: (e) => e instanceof TypeError && /home/.test(e.message) },
    { name: "an empty path value", opts: { paths: { CURSOR_DB_PATH: "" } }, error: (e) => e instanceof TypeError && /CURSOR_DB_PATH/.test(e.message) },
    { name: "a duplicate source", opts: { sources: ["codex", "kiro", "codex"] }, error: (e) => e instanceof DuplicateSourceError && e.source === "codex" },
  ];
  for (const c of cases) {
    it(`rejects ${c.name} before running anything`, async () => {
      const store = new SessionStore(join(tmp, `validation-${c.name.replace(/\W+/g, "-")}.db`));
      const events: ScanProgressEvent[] = [];
      await assert.rejects(readAll(store, { ...c.opts, onProgress: (e) => events.push(e) }), c.error);
      assert.deepEqual(events, []);
      store.close();
    });
  }
});

describe("a scan's home root", () => {
  it("shadows a process-wide path override, while the scan's own paths still win", async () => {
    const home = freshDir("shadow-home");
    plantHome(home, "project_inroot", "11111111-1111-4111-8111-111111111111");
    const elsewhere = freshDir("shadow-elsewhere");
    plantHome(elsewhere, "project_elsewhere", "22222222-2222-4222-8222-222222222222");
    const elsewhereProjects = join(elsewhere, ".claude", "projects");
    setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: elsewhereProjects });
    try {
      const shadowed = new SessionStore(join(tmp, "shadow-home.db"));
      await readAll(shadowed, { home, sources: ["claude-code"] });
      assert.deepEqual(sessionIds(shadowed), ["claude-code/project_inroot::abc123def456"]);
      shadowed.close();

      const own = new SessionStore(join(tmp, "shadow-own.db"));
      await readAll(own, { home, sources: ["claude-code"], paths: { CLAUDE_CODE_PROJECTS_PATH: elsewhereProjects } });
      assert.deepEqual(sessionIds(own), ["claude-code/project_elsewhere::abc123def456"]);
      own.close();
    } finally {
      setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: undefined });
    }
  });

  it("never stores or exports, in a path, the name of a home it scans as another user", { skip: userInfo().username === "alice" }, async () => {
    const home = join(tmp, "redaction-root", "Users", "alice");
    const projectDir = join(home, ".claude", "projects", "project_inroot");
    mkdirSync(projectDir, { recursive: true });
    const transcript = readFileSync(CLAUDE_FIXTURE, "utf8")
      .replaceAll("/home/user/project", `${home}/project`)
      .replace("Write a function to sort an array", "sort the list in /Users/alice/notes.txt");
    writeFileSync(join(projectDir, "abc123def456.jsonl"), transcript);
    const store = new SessionStore(join(tmp, "redaction-root.db"));
    const result = await readAll(store, { home, sources: ["claude-code"] });
    assert.equal(result.counts["claude-code"], 1);
    const stored = JSON.stringify(store.raw().prepare("SELECT * FROM conversations").all());
    assert.ok(stored.includes("sort the list"), "the prompt was stored");
    assert.ok(!stored.includes("alice"), stored);
    const out = join(tmp, "redaction-root.jsonl");
    await exportSessions(store, { format: "jsonl", out });
    assert.ok(!readFileSync(out, "utf8").includes("alice"));
    store.close();
  });

  it("hashes a scanned home owner's name in paths but not as a word in prose", { skip: userInfo().username === "test" }, async () => {
    const home = join(tmp, "word-root", "home", "test");
    const projectDir = join(home, ".claude", "projects", "project_inroot");
    mkdirSync(projectDir, { recursive: true });
    const transcript = readFileSync(CLAUDE_FIXTURE, "utf8").replace(
      "Write a function to sort an array",
      "run the test suite, then open /home/test/x",
    );
    writeFileSync(join(projectDir, "abc123def456.jsonl"), transcript);
    const store = new SessionStore(join(tmp, "word-root.db"));
    await readAll(store, { home, sources: ["claude-code"] });
    const stored = JSON.stringify(store.raw().prepare("SELECT conversation FROM conversations").all());
    assert.ok(stored.includes(`run the test suite, then open /home/${hashUsername("test")}/x`), stored);
    assert.ok(!stored.includes("/home/test/"), stored);
    store.close();
  });

  it("spawns no git process in a scanned repository, even one planting an fsmonitor and a filter driver", async () => {
    const home = freshDir("nogit-home");
    const repo = join(home, "src", "repo");
    mkdirSync(repo, { recursive: true });
    const git = (...args: string[]): void => {
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, stdio: "ignore" });
    };
    git("init", "-q");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "init");
    writeFileSync(join(repo, "a.txt"), "a\nb\n");
    const fsmonitorRan = join(tmp, "nogit-fsmonitor-ran");
    const filterRan = join(tmp, "nogit-filter-ran");
    const fsmonitor = join(tmp, "nogit-fsmonitor.sh");
    const filter = join(tmp, "nogit-filter.sh");
    writeFileSync(fsmonitor, `#!/bin/sh\ntouch "${fsmonitorRan}"\n`);
    writeFileSync(filter, `#!/bin/sh\ntouch "${filterRan}"\ncat\n`);
    chmodSync(fsmonitor, 0o755);
    chmodSync(filter, 0o755);
    git("config", "core.fsmonitor", fsmonitor);
    git("config", "filter.x.clean", filter);
    writeFileSync(join(repo, ".gitattributes"), "*.txt filter=x\n");
    // Both are live: a plain diff in this repository runs them.
    execFileSync("git", ["diff", "HEAD", "--numstat"], { cwd: repo, stdio: "ignore" });
    assert.ok(existsSync(fsmonitorRan), "the fixture's fsmonitor runs under a plain git call");
    assert.ok(existsSync(filterRan), "the fixture's filter driver runs under a plain git call");
    rmSync(fsmonitorRan);
    rmSync(filterRan);

    // A git on PATH that records each call before handing it to the real one.
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const wrapperDir = freshDir("nogit-bin");
    const calls = join(tmp, "nogit-calls.log");
    writeFileSync(join(wrapperDir, "git"), `#!/bin/sh\necho "$@" >> "${calls}"\nexec "${realGit}" "$@"\n`);
    chmodSync(join(wrapperDir, "git"), 0o755);

    const codexHome = join(home, ".codex");
    plantCodexRollout(codexHome, "44444444-4444-4444-8444-444444444444");
    const rollout = join(codexHome, "sessions", "2026", "01", "01", "rollout-2026-01-01T00-00-00-44444444-4444-4444-8444-444444444444.jsonl");
    writeFileSync(rollout, readFileSync(rollout, "utf8").replaceAll("/Users/example-user/src/example-repo", repo));
    const store = new SessionStore(join(tmp, "nogit.db"));
    const savedPath = process.env["PATH"];
    process.env["PATH"] = `${wrapperDir}:${savedPath ?? ""}`;
    try {
      // The wrapper is the git a spawn resolves.
      execFileSync("git", ["--version"], { stdio: "ignore" });
      assert.ok(existsSync(calls), "the recording git wrapper is on PATH");
      rmSync(calls);

      const result = await readAll(store, { home, sources: ["codex"] });
      assert.equal(result.counts.codex, 1);
    } finally {
      process.env["PATH"] = savedPath;
      store.close();
    }
    assert.equal(existsSync(calls), false, existsSync(calls) ? readFileSync(calls, "utf8") : "");
    assert.equal(existsSync(fsmonitorRan), false, "the scan ran the repository's fsmonitor");
    assert.equal(existsSync(filterRan), false, "the scan ran the repository's filter driver");
  });

  it("runs git in the session's project directory when no home is given", async () => {
    const root = freshDir("git-cwd");
    const repo = join(root, "src", "repo");
    mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const wrapperDir = freshDir("git-cwd-bin");
    const calls = join(root, "calls.log");
    writeFileSync(join(wrapperDir, "git"), `#!/bin/sh\necho "$(pwd -P) $*" >> "${calls}"\nexec "${realGit}" "$@"\n`);
    chmodSync(join(wrapperDir, "git"), 0o755);

    // Every source location redirected under the temp root, so no real home is read.
    const paths = Object.fromEntries(PATH_KEYS.map((k) => [k, join(root, "absent", k)]));
    const codexHome = join(root, "codex");
    paths["CODEX_HOME"] = codexHome;
    plantCodexRollout(codexHome, "55555555-5555-4555-8555-555555555555");
    const rollout = join(codexHome, "sessions", "2026", "01", "01", "rollout-2026-01-01T00-00-00-55555555-5555-4555-8555-555555555555.jsonl");
    writeFileSync(rollout, readFileSync(rollout, "utf8").replaceAll("/Users/example-user/src/example-repo", repo));
    const store = new SessionStore(join(root, "git-cwd.db"));
    const savedPath = process.env["PATH"];
    process.env["PATH"] = `${wrapperDir}:${savedPath ?? ""}`;
    try {
      const result = await readAll(store, { paths });
      assert.equal(result.counts.codex, 1);
    } finally {
      process.env["PATH"] = savedPath;
      store.close();
    }
    const cwds = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((l) => l.split(" ")[0]) : [];
    assert.ok(cwds.length > 0, "the scan ran git");
    assert.ok(cwds.includes(realpathSync(repo)), cwds.join("\n"));
  });

  it("never rotates the Cursor stop-hook ledger it reads", async () => {
    const home = freshDir("ledger-home");
    const ledgerDir = join(home, ".cursor", "token-events-raw");
    mkdirSync(ledgerDir, { recursive: true });
    const ledger = join(ledgerDir, "stop.jsonl");
    writeFileSync(ledger, Buffer.alloc(4 * 1024 * 1024 + 1, "\n"));
    const store = new SessionStore(join(tmp, "ledger.db"));
    await readSource("cursor", store, { home });
    assert.ok(existsSync(ledger), "the live ledger is where Cursor left it");
    assert.equal(existsSync(join(ledgerDir, "stop.jsonl.1")), false);
    store.close();
  });
});

describe("the Cursor seat-tier lookup's answer", () => {
  let fetchStub: ReturnType<typeof stubFetch>;
  beforeEach(() => (fetchStub = stubFetch()));
  afterEach(() => fetchStub.restore());

  it("records an error kind outside the closed set as PARSE", async () => {
    const cursorDb = join(tmp, "lookup-kind.vscdb");
    buildCursorDb(cursorDb);
    const store = new SessionStore(join(tmp, "lookup-kind.db"));
    const lookup: SeatTierLookup = () =>
      Promise.resolve({ outcome: "error", errorKind: "vendor said: token abc123 is bad" as never, status: 500 });
    const result = await readSource("cursor", store, { home: freshDir("lookup-kind-home"), paths: { CURSOR_DB_PATH: cursorDb }, cursor: { lookup } });
    assert.deepEqual(result.seatTier, { outcome: "error", errorKind: "PARSE" });
    assert.ok(!(store.getMeta(SEAT_TIER_META_KEY) ?? "").includes("abc123"));
    store.close();
  });

  it("logs a lookup that throws by its error class, never its message", async () => {
    const cursorDb = join(tmp, "lookup-throws.vscdb");
    buildCursorDb(cursorDb);
    const store = new SessionStore(join(tmp, "lookup-throws.db"));
    const { logger, lines } = recordingLogger();
    const lookup: SeatTierLookup = () => Promise.reject(new Error("request failed with token secret-abc123"));
    const result = await readSource("cursor", store, {
      home: freshDir("lookup-throws-home"),
      paths: { CURSOR_DB_PATH: cursorDb },
      cursor: { lookup },
      logger,
    });
    assert.equal(result.seatTier?.outcome, "error");
    const failed = lines.filter((l) => l.line.endsWith(" resolver_failed"));
    assert.equal(failed.length, 1, lines.map((l) => l.line).join("\n"));
    assert.deepEqual(failed[0]?.data, { errorClass: "Error" });
    assert.ok(!JSON.stringify(lines).includes("secret-abc123"));
    store.close();
  });
});
