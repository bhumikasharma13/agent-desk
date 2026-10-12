// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * CLI behaviour the process-level suite does not cover, run in-process through
 * `main`: `export --out` and its file mode, `export --split`, `reset --all` and `--dedup`, the
 * interactive confirmation, `show` of a missing id, and the human-readable
 * `status` and `list` output.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { main } from "../main";
import { openStore } from "../../store/SessionStore";

const tmp = mkdtempSync(join(tmpdir(), "lse-cli-commands-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

async function run(args: string[], input?: { tty: boolean; line?: string }) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = Object.assign(new PassThrough(), { isTTY: input?.tty });
  let out = "";
  let err = "";
  stdout.on("data", (c: Buffer) => (out += c.toString()));
  stderr.on("data", (c: Buffer) => (err += c.toString()));
  if (input?.line !== undefined) stdin.end(`${input.line}\n`);
  const code = await main(args, { stdout, stderr, stdin });
  return { code, out, err };
}

let n = 0;
function seeded(): string {
  const db = join(tmp, `s${++n}.db`);
  const store = openStore(db);
  const base = { lastMtimeMs: 5, lastSize: 5, lastOffset: 0 };
  store.upsert({ ideType: "codex", sessionId: "c1", conversation: [{ role: "user", content: "hi" }], projectPath: "/src/app", ...base });
  store.upsert({ ideType: "kiro", sessionId: "k1", conversation: [{ role: "user", content: "yo" }], ...base });
  store.close();
  return db;
}

describe("export --out", () => {
  it("writes the rows to the file at mode 0600 and reports the count on stderr", async () => {
    const db = seeded();
    const file = join(tmp, "out.jsonl");
    const { code, out, err } = await run(["export", "--db", db, "--out", file]);
    assert.equal(code, 0);
    assert.equal(out, "");
    assert.match(err, /Wrote 2 session\(s\) to /);
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 2);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

describe("export --split", () => {
  it("writes one Conversation per file under <source>/ and reports the count on stderr", async () => {
    const db = seeded();
    const dir = join(tmp, "split");
    const { code, out, err } = await run(["export", "--db", db, "--split", dir]);
    assert.equal(code, 0, err);
    assert.equal(out, "");
    assert.match(err, /Wrote 2 session\(s\) to /);
    assert.deepEqual(readdirSync(dir).sort(), ["codex", "kiro"]);
    for (const source of ["codex", "kiro"]) {
      const [file] = readdirSync(join(dir, source));
      assert.match(file!, /^[0-9a-f]{32}\.json$/);
      assert.equal(statSync(join(dir, source, file!)).mode & 0o777, 0o600);
      assert.equal((JSON.parse(readFileSync(join(dir, source, file!), "utf8")) as { prompts: unknown[] }).prompts.length, 1);
    }
  });

  it("refuses a folder that is not empty, and writes into it with --force", async () => {
    const db = seeded();
    const dir = join(tmp, "split-nonempty");
    mkdirSync(dir);
    writeFileSync(join(dir, "keep.txt"), "x");
    const refused = await run(["export", "--db", db, "--split", dir]);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /it is not empty; pass force/);
    assert.deepEqual(readdirSync(dir), ["keep.txt"]);
    const forced = await run(["export", "--db", db, "--split", dir, "--force"]);
    assert.equal(forced.code, 0, forced.err);
    assert.deepEqual(readdirSync(dir).sort(), ["codex", "keep.txt", "kiro"]);
  });

  for (const [name, args, message] of [
    ["--out", ["--out", join(tmp, "x.jsonl")], /--split writes one Conversation per file; it does not take --out/],
    ["--format json", ["--format", "json"], /--split writes one Conversation per file; it does not take --format/],
    ["--raw", ["--raw"], /--split writes one Conversation per file; it does not take --raw/],
    ["an empty folder", [], /--split needs a folder path/],
  ] as const) {
    it(`exits 1 on --split with ${name}, writing nothing`, async () => {
      const db = seeded();
      const dir = join(tmp, `split-usage-${name.replace(/\W+/g, "-")}`);
      const { code, err } = await run(["export", "--db", db, "--split", name === "an empty folder" ? "" : dir, ...args]);
      assert.equal(code, 1);
      assert.match(err, message);
      assert.match(err, /--help/);
      assert.equal(existsSync(dir), false);
      assert.equal(existsSync(join(tmp, "x.jsonl")), false);
    });
  }

  it("exits 1 on --force without --split", async () => {
    const { code, err } = await run(["export", "--db", seeded(), "--force"]);
    assert.equal(code, 1);
    assert.match(err, /--force applies only with --split/);
  });
});

describe("reset", () => {
  it("--all --yes deletes every stored session", async () => {
    const db = seeded();
    const { code, out } = await run(["reset", "--all", "--yes", "--db", db]);
    assert.equal(code, 0);
    assert.match(out, /Deleted 2 session\(s\)/);
    const store = openStore(db, { mustExist: true });
    assert.equal(store.listConversations().length, 0);
    store.close();
  });

  it("--dedup --yes clears only the listed sources' change tracking", async () => {
    const db = seeded();
    const { code } = await run(["reset", "--dedup", "--sources", "codex", "--yes", "--db", db]);
    assert.equal(code, 0);
    const store = openStore(db, { mustExist: true });
    assert.equal(store.getTracking("codex", "c1")?.last_mtime_ms, 0);
    assert.equal(store.getTracking("kiro", "k1")?.last_mtime_ms, 5);
    assert.equal(store.listConversations().length, 2, "no row is deleted");
    store.close();
  });

  it("asks on an interactive input, and a yes proceeds", async () => {
    const db = seeded();
    const { code, err } = await run(["reset", "--db", db], { tty: true, line: "y" });
    assert.equal(code, 0);
    assert.match(err, /\[y\/N\]/);
    const store = openStore(db, { mustExist: true });
    assert.equal(store.listConversations().length, 0);
    store.close();
  });

  it("asks on an interactive input, and anything but yes changes nothing", async () => {
    const db = seeded();
    const { code, err } = await run(["reset", "--db", db], { tty: true, line: "nope" });
    assert.equal(code, 1);
    assert.match(err, /Aborted; nothing changed\./);
    const store = openStore(db, { mustExist: true });
    assert.equal(store.listConversations().length, 2);
    store.close();
  });

  it("--sources without --dedup is a usage error", async () => {
    const { code, err } = await run(["reset", "--sources", "codex", "--yes", "--db", seeded()]);
    assert.equal(code, 1);
    assert.match(err, /--sources applies only to reset --dedup/);
  });
});

describe("show", () => {
  it("fails with the reason for an id that is not stored", async () => {
    const { code, err } = await run(["show", "codex", "missing", "--db", seeded()]);
    assert.equal(code, 1);
    assert.match(err, /no codex session missing in /);
  });
});

describe("status and list, human-readable", () => {
  it("status lists sessions per source and every sync state", async () => {
    const { code, out } = await run(["status", "--db", seeded()]);
    assert.equal(code, 0);
    assert.match(out, /Store: .* \(schema \d+\)/);
    assert.match(out, /^\s+codex\s+1$/m);
    assert.match(out, /^\s+kiro\s+1$/m);
    assert.match(out, /^\s+total\s+2$/m);
    assert.match(out, /Sync state of every row: pending 2/);
  });

  it("list prints a header and one line per session", async () => {
    const { code, out } = await run(["list", "--db", seeded()]);
    assert.equal(code, 0);
    const lines = out.trim().split("\n");
    assert.match(lines[0]!, /UPDATED\s+SOURCE\s+SESSION\s+PROMPTS\s+PROJECT/);
    assert.equal(lines.length, 3);
    assert.ok(lines.some((l) => /\bcodex\b.*\bc1\b.*\b1\b.*\/src\/app/.test(l)));
  });

  it("list says so when the store is empty", async () => {
    const db = join(tmp, "empty.db");
    openStore(db).close();
    const { out } = await run(["list", "--db", db]);
    assert.equal(out, "No sessions stored.\n");
  });
});
