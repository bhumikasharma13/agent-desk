// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The CLI as a user runs it: the `stage` script, then the binary as a child
 * process, from source through the package's loader, against staged homes and
 * temp stores only. Every child gets an empty temp HOME as well.
 */
import { after, before, describe, it } from "node:test";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { comparableConversations, goldenLines, readGolden } from "../../../scripts/golden";
import { capabilities } from "../../capabilities";
import { hashUsername } from "../../redaction/anonymizer";
import { openStore } from "../../store/SessionStore";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const NODE_FLAGS = ["--no-warnings=ExperimentalWarning", "--import", "./test-register.mjs"];

const tmp = mkdtempSync(join(tmpdir(), "local-session-extractor-cli-"));
const emptyHome = join(tmp, "empty-home");
mkdirSync(emptyHome);
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

function node(script: string, args: readonly string[], input?: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [...NODE_FLAGS, script, ...args], {
    cwd: PACKAGE_ROOT,
    encoding: "utf8",
    env: { ...process.env, HOME: emptyHome, USERPROFILE: emptyHome, INIT_CWD: PACKAGE_ROOT },
    input: input ?? "",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function cli(...args: string[]): SpawnSyncReturns<string> {
  return node("src/cli/bin.ts", args);
}

function assertExit(run: SpawnSyncReturns<string>, code: number): void {
  assert.equal(run.status, code, `exit ${String(run.status)}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
}

describe("a staged scan", () => {
  const out = join(tmp, "staged");
  const db = join(tmp, "staged.db");

  before(() => {
    assertExit(node("scripts/stage.ts", [out]), 0);
    assertExit(cli("scan", "--home", join(out, "home"), "--db", db), 0);
    assertExit(cli("scan", "--home", join(out, "codex-sqlite-home"), "--sources", "codex", "--db", db), 0);
  });

  it("exports the golden rows to stdout with --raw, apart from the bookkeeping columns", () => {
    const run = cli("export", "--raw", "--format", "jsonl", "--include-sync-state", "--db", db);
    assertExit(run, 0);
    const exported = run.stdout.split("\n").filter((l) => l.length > 0);
    // goldenLines applies the golden's order and drops the same four columns.
    const lines = goldenLines(exported.map((l) => JSON.parse(l) as Record<string, unknown>));
    const golden = readGolden();
    assert.equal(lines.length, golden.length, "row count");
    for (let i = 0; i < golden.length; i++) {
      const want = JSON.parse(golden[i]!) as { ide_type: string; session_id: string };
      assert.deepEqual(JSON.parse(lines[i]!), want, `${want.ide_type}/${want.session_id}`);
    }
  });

  it("exports the conversation golden by default, one per line or as one array", () => {
    for (const format of ["jsonl", "json"]) {
      const run = cli("export", "--format", format, "--db", db);
      assertExit(run, 0);
      const parsed = (format === "json" ? JSON.parse(run.stdout) : run.stdout.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l))) as Record<string, unknown>[];
      const { got, want } = comparableConversations(parsed);
      assert.equal(got.length, want.length, `${format} count`);
      for (let i = 0; i < want.length; i++) assert.deepEqual(got[i], want[i], `${format} ${String(want[i]!["ideType"])}/${String(want[i]!["sessionId"])}`);
    }
  });

  it("gives parseable --json output", () => {
    const status = cli("status", "--json", "--db", db);
    assertExit(status, 0);
    const parsed = JSON.parse(status.stdout) as { sessions: Record<string, number>; syncStatus: Record<string, number> };
    assert.equal(parsed.sessions["total"], 33);
    assert.deepEqual(parsed.syncStatus, { pending: readGolden().length });

    const list = cli("list", "--json", "--limit", "5", "--sources", "codex", "--db", db);
    assertExit(list, 0);
    const rows = JSON.parse(list.stdout) as Array<{ ide_type: string }>;
    assert.equal(rows.length, 5);
    assert.ok(rows.every((r) => r.ide_type === "codex"));

    const show = cli("show", "codex", "thread-fixture-001", "--json", "--db", db);
    assertExit(show, 0);
    const shown = JSON.parse(show.stdout) as { ideType: string; sessionId: string; prompts: unknown[] };
    assert.equal(shown.ideType, "IDE_TYPE_CODEX");
    assert.equal(shown.sessionId, "thread-fixture-001");
    assert.ok(shown.prompts.length > 0);
    const raw = cli("show", "codex", "thread-fixture-001", "--raw", "--json", "--db", db);
    assertExit(raw, 0);
    assert.equal((JSON.parse(raw.stdout) as { session_id: string }).session_id, "thread-fixture-001");

    const rescan = cli("scan", "--json", "--home", join(out, "home"), "--sources", "kiro", "--db", db);
    assertExit(rescan, 0);
    assert.deepEqual((JSON.parse(rescan.stdout) as { partial: object }).partial, { kiro: false });
  });

  it("refuses to prompt on a non-interactive input, and empties the store with --yes", () => {
    const copy = join(tmp, "reset.db");
    copyFileSync(db, copy);
    const refused = node("src/cli/bin.ts", ["reset", "--db", copy], "y\n");
    assertExit(refused, 1);
    assert.match(refused.stderr, /refusing to prompt on a non-interactive input; pass --yes/);
    const kept = JSON.parse(cli("status", "--json", "--db", copy).stdout) as { sessions: { total: number } };
    assert.equal(kept.sessions.total, 33);

    const reset = cli("reset", "--yes", "--db", copy);
    assertExit(reset, 0);
    assert.match(reset.stdout, /Deleted 33 session\(s\), with their sub-agent, plugin and hook runs/);
    const emptied = cli("export", "--db", copy);
    assertExit(emptied, 0);
    assert.equal(emptied.stdout, "");
    const emptiedJson = cli("export", "--format", "json", "--db", copy);
    assertExit(emptiedJson, 0);
    assert.equal(emptiedJson.stdout, "[]\n");
  });
});

describe("a scan of another person's home", () => {
  // Shaped like a home directory, so its owner's name is redacted like the running user's.
  const home = join(tmp, "Users", "alice");
  const db = join(tmp, "alice.db");
  const rawId = "-Users-alice-proj::abc123def456";

  before(() => {
    const project = join(home, ".claude", "projects", "-Users-alice-proj");
    mkdirSync(project, { recursive: true });
    const fixture = readFileSync(join(PACKAGE_ROOT, "fixtures/extraction/claude-code/project_happy/abc123def456.jsonl"), "utf8");
    writeFileSync(join(project, "abc123def456.jsonl"), fixture.replaceAll("/home/user/project", "/Users/alice/proj"));
    assertExit(cli("scan", "--home", home, "--sources", "claude-code", "--db", db), 0);
  });

  it("exports no trace of the owner's name, in a later process with no home root", () => {
    for (const args of [[], ["--raw", "--include-sync-state"]]) {
      const run = cli("export", ...args, "--db", db);
      assertExit(run, 0);
      assert.ok(run.stdout.includes(`-Users-${hashUsername("alice")}-proj::abc123def456`), run.stdout);
      assert.ok(!run.stdout.includes("alice"), run.stdout);
    }
  });

  it("lists the redacted id, and shows a session by the redacted or the stored id", () => {
    const list = cli("list", "--json", "--db", db);
    assertExit(list, 0);
    const [listed] = JSON.parse(list.stdout) as Array<{ session_id: string }>;
    assert.equal(listed!.session_id, `-Users-${hashUsername("alice")}-proj::abc123def456`);
    assert.ok(!list.stdout.includes("alice"), list.stdout);
    for (const id of [listed!.session_id, rawId]) {
      const show = cli("show", "claude-code", "--json", "--db", db, "--", id);
      assertExit(show, 0);
      assert.equal((JSON.parse(show.stdout) as { sessionId: string }).sessionId, listed!.session_id);
      assert.ok(!show.stdout.includes("alice"), show.stdout);
    }
  });
});

describe("a closed pipe", () => {
  it("exits 0 with no stack trace when show's reader closes early", async () => {
    const db = join(tmp, "big.db");
    const store = openStore(db);
    store.upsert({
      ideType: "claude-code",
      sessionId: "big",
      conversation: [{ role: "user", content: "a line of prose\\n".repeat(16 * 1024), timestamp: "2026-01-01T00:00:00.000Z" }],
      lastMtimeMs: 1,
      lastSize: 2,
      lastOffset: 3,
    } as Parameters<typeof store.upsert>[0]);
    store.close();
    const child = spawn(process.execPath, [...NODE_FLAGS, "src/cli/bin.ts", "show", "claude-code", "big", "--db", db], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, HOME: emptyHome, USERPROFILE: emptyHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout.once("data", () => child.stdout.destroy());
    const code = await new Promise<number | null>((done) => child.on("close", (c) => done(c)));
    assert.equal(code, 0, stderr);
    assert.doesNotMatch(stderr, /\bat |Error/, stderr);
  });
});

describe("a file that is not a store", () => {
  it("is refused by every command that opens one, and left byte-identical", () => {
    const foreign = join(tmp, "other-app.db");
    const other = new DatabaseSync(foreign);
    other.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('keep me');");
    other.close();
    const before = readFileSync(foreign);
    for (const args of [["scan", "--home", emptyHome], ["status"], ["list"], ["show", "codex", "x"], ["export"], ["reset", "--yes"]]) {
      const run = cli(...args, "--db", foreign);
      assertExit(run, 1);
      assert.match(run.stderr, /not a local-session-extractor store/, args.join(" "));
    }
    assert.deepEqual(readFileSync(foreign), before);
    assert.equal(existsSync(`${foreign}-wal`), false);
  });

  it("is never migrated by a read command or reset", () => {
    const old = join(tmp, "old-schema.db");
    openStore(old).close();
    const version = (): number => {
      const db = new DatabaseSync(old);
      try {
        return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      } finally {
        db.close();
      }
    };
    const current = version();
    const db = new DatabaseSync(old);
    db.exec(`PRAGMA user_version = ${current - 1}`);
    db.close();
    for (const args of [["status"], ["list"], ["show", "codex", "x"], ["export"], ["reset", "--yes"]]) {
      const run = cli(...args, "--db", old);
      assertExit(run, 1);
      assert.match(run.stderr, /older than this package/, args.join(" "));
    }
    assert.equal(version(), current - 1);
  });
});

describe("exit codes", () => {
  it("exits 2 when a source failed as a whole", () => {
    const home = join(tmp, "garbage-cursor-home");
    // Cursor's macOS and Linux locations; the scan reads the one for this platform.
    for (const root of [join(home, "Library", "Application Support"), join(home, ".config")]) {
      const dir = join(root, "Cursor", "User", "globalStorage");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "state.vscdb"), "not a database");
    }
    const run = cli("scan", "--home", home, "--db", join(tmp, "garbage.db"));
    assertExit(run, 2);
    assert.match(run.stdout, /cursor\s+0\s+partial/);
    assert.match(run.stderr, /cursor failed as a whole/);
  });

  for (const [name, args, message] of [
    ["an unknown flag", ["scan", "--no-such-flag"], /Unknown option '--no-such-flag'/],
    ["an unknown source", ["scan", "--sources", "claude-code,vim"], /unknown source: vim/],
    ["an empty --home", ["scan", "--home", ""], /--home needs a directory/],
    ["a flag the command does not take", ["status", "--home", "x"], /status does not take --home/],
    ["an unknown command", ["frobnicate"], /unknown command: frobnicate/],
    ["a comma-separated show source", ["show", "codex,kiro", "x"], /show's <source> argument is one source/],
    ["an empty show source", ["show", "", "x"], /show's <source> argument is one source/],
    ["a --limit past the maximum", ["list", "--limit", "1000001"], /--limit needs a whole number from 1 to 1000000/],
    ["an unsafe --limit", ["list", "--limit", "99999999999999999999"], /--limit needs a whole number/],
    ["a repeated string flag", ["export", "--format", "jsonl", "--format", "jsonl"], /--format was given more than once/],
    ["--include-sync-state without --raw", ["export", "--include-sync-state"], /--include-sync-state applies only with --raw/],
    ["an unknown export format", ["export", "--format", "csv"], /unknown export format: csv; formats are jsonl, json/],
  ] as const) {
    it(`exits 1 on ${name}, creating no store`, () => {
      const db = join(tmp, `usage-${name.replace(/\W+/g, "-")}.db`);
      const run = cli(...args, ...(args[0] === "frobnicate" ? [] : ["--db", db]));
      assertExit(run, 1);
      assert.match(run.stderr, message);
      assert.match(run.stderr, /--help/);
      assert.equal(existsSync(db), false);
    });
  }
});

describe("capabilities, help and version", () => {
  it("prints capabilities() as --json", () => {
    const run = cli("capabilities", "--json");
    assertExit(run, 0);
    assert.deepEqual(JSON.parse(run.stdout), JSON.parse(JSON.stringify(capabilities())));
  });

  it("prints the usage and the version", () => {
    const help = cli("--help");
    assertExit(help, 0);
    for (const command of ["scan", "status", "list", "show", "export", "capabilities", "reset"]) {
      assert.match(help.stdout, new RegExp(`^  ${command}\\b`, "m"));
    }
    const version = cli("--version");
    assertExit(version, 0);
    assert.equal(version.stdout.trim(), capabilities().packageVersion);
  });
});
