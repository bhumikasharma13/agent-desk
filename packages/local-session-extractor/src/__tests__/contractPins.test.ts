// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Contract edges no other suite pins: the markSynced guard, `--limit 0`, a
 * symlink planted while an export is being written, and what the store keeps
 * at rest that only export, list and show hash.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { main } from "../cli/main";
import { writeExport } from "../export";
import { hashUsername } from "../redaction/anonymizer";
import { exportSessions, openStore, readAll } from "../index";

const tmp = mkdtempSync(join(tmpdir(), "lse-pins-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const base = { lastMtimeMs: 1, lastSize: 1, lastOffset: 0 };

describe("markSynced", () => {
  it("leaves a row pending when its content changed during the sync", () => {
    const store = openStore(join(tmp, "outbox.db"));
    try {
      store.upsert({ ideType: "codex", sessionId: "c1", conversation: [{ role: "user", content: "one" }], ...base });
      const id = store.getConversation("codex", "c1")!.id;
      store.markSyncing([id]);
      store.upsert({ ideType: "codex", sessionId: "c1", conversation: [{ role: "user", content: "two" }], ...base, lastSize: 2 });
      store.markSynced(id);
      assert.equal(store.getConversation("codex", "c1")!.sync_status, "pending");
    } finally {
      store.close();
    }
  });
});

describe("list --limit", () => {
  it("refuses 0 as a usage error", async () => {
    const db = join(tmp, "limit.db");
    openStore(db).close();
    const stderr = new PassThrough();
    let err = "";
    stderr.on("data", (c: Buffer) => (err += c.toString()));
    const code = await main(["list", "--limit", "0", "--db", db], { stdout: new PassThrough(), stderr, stdin: new PassThrough() });
    assert.equal(code, 1);
    assert.match(err, /--limit needs a whole number from 1/);
  });
});

describe("export to a file", () => {
  it("refuses a symlink planted at the target while the rows are written, and leaves no temp file", () => {
    const dir = join(tmp, "race");
    mkdirSync(dir);
    const store = openStore(join(tmp, "race.db"));
    try {
      store.upsert({ ideType: "codex", sessionId: "c1", conversation: [], ...base });
      store.upsert({ ideType: "codex", sessionId: "c2", conversation: [], ...base });
      const victim = join(dir, "victim.txt");
      writeFileSync(victim, "keep me");
      const out = join(dir, "export.jsonl");
      assert.throws(() =>
        writeExport(store, { format: "jsonl", out }, { pageSize: 1, afterPage: () => existsSync(out) || symlinkSync(victim, out) }),
      );
      assert.equal(readFileSync(victim, "utf8"), "keep me");
      assert.deepEqual(readdirSync(dir).sort(), ["export.jsonl", "victim.txt"]);
    } finally {
      store.close();
    }
  });
});

describe("the store at rest", () => {
  it("keeps Claude Code session ids raw and records the scanned home's owner, which export hashes", async () => {
    const home = join(tmp, "Users", "alice");
    const project = join(home, ".claude", "projects", "-Users-alice-app");
    mkdirSync(project, { recursive: true });
    const line = { type: "user", uuid: "u1", timestamp: "2026-04-01T10:00:00.000Z", sessionId: "s1", cwd: "/Users/alice/app", message: { role: "user", content: "hi" } };
    writeFileSync(join(project, "s1.jsonl"), JSON.stringify(line) + "\n");
    const dbPath = join(tmp, "at-rest.db");
    const store = openStore(dbPath);
    try {
      await readAll(store, { home, sources: ["claude-code"] });
      const ids = store.raw().prepare("SELECT session_id FROM conversations").all() as Array<{ session_id: string }>;
      assert.deepEqual(ids.map((r) => r.session_id), ["-Users-alice-app::s1"]);
      assert.match(String((store.raw().prepare("SELECT value FROM meta WHERE key = 'scanned_home_owners'").get() as { value: string }).value), /"alice"/);
      const file = join(tmp, "at-rest.jsonl");
      await exportSessions(store, { format: "jsonl", out: file });
      const exported = readFileSync(file, "utf8");
      assert.ok(!exported.includes("alice"), exported.slice(0, 200));
      assert.ok(exported.includes(`-Users-${hashUsername("alice")}-app::s1`));
    } finally {
      store.close();
    }
  });
});

describe("readAll's home", () => {
  it("throws a TypeError when it is not a directory, before any source runs", async () => {
    const store = openStore(join(tmp, "home-check.db"));
    try {
      await assert.rejects(readAll(store, { home: join(tmp, "no-such-home") }), TypeError);
      const file = join(tmp, "a-file");
      writeFileSync(file, "");
      await assert.rejects(readAll(store, { home: file }), TypeError);
      assert.equal(store.getMeta("scanned_home_owners"), null, "nothing is recorded");
    } finally {
      store.close();
    }
  });
});

describe("the host seams' defaults", () => {
  it("setLogger(null) and setMetricsSink(null) stop calling the previous logger and sink", async () => {
    const { setLogger, setMetricsSink } = await import("../host");
    const calls: string[] = [];
    setLogger({ info: () => calls.push("log"), warn: () => calls.push("log"), error: () => calls.push("log"), debug: () => {} });
    setMetricsSink({ inc: () => calls.push("metric"), observe: () => {} });
    setLogger(null);
    setMetricsSink(null);
    const home = join(tmp, "seams-home");
    const dir = join(home, ".claude", "projects", "-Users-you-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s1.jsonl"), JSON.stringify({ type: "hologram", uuid: "h1", sessionId: "s1" }) + "\n");
    const store = openStore(join(tmp, "seams.db"));
    try {
      await readAll(store, { home, sources: ["claude-code"] });
    } finally {
      store.close();
    }
    assert.deepEqual(calls, []);
  });
});

describe("the outbox", () => {
  it("does not hand back a row that has been syncing for under 30 minutes", () => {
    const store = openStore(join(tmp, "young-syncing.db"));
    try {
      store.upsert({ ideType: "codex", sessionId: "c1", conversation: [], ...base });
      store.markSyncing([store.getConversation("codex", "c1")!.id]);
      store.raw().prepare("UPDATE conversations SET updated_at = datetime('now', '-29 minutes')").run();
      assert.equal(store.getPendingConversations(10).length, 0);
      store.raw().prepare("UPDATE conversations SET updated_at = datetime('now', '-31 minutes')").run();
      assert.equal(store.getPendingConversations(10).length, 1);
    } finally {
      store.close();
    }
  });

  it("applyScope parks a pending row with no project_path", () => {
    const store = openStore(join(tmp, "scope-null.db"));
    try {
      store.upsert({ ideType: "codex", sessionId: "c1", conversation: [], ...base });
      store.upsert({ ideType: "codex", sessionId: "c2", conversation: [], projectPath: "/src/a", ...base });
      store.applyScope(["/src/a"], "filtered");
      assert.equal(store.getConversation("codex", "c1")!.sync_status, "skipped_out_of_scope");
      assert.equal(store.getConversation("codex", "c2")!.sync_status, "pending");
    } finally {
      store.close();
    }
  });
});

describe("readAll's home, through a symlink", () => {
  it("follows a symlinked home and records the real folder's owner", async () => {
    const { symlinkSync } = await import("node:fs");
    const real = join(tmp, "Users", "carol");
    mkdirSync(join(real, ".claude", "projects"), { recursive: true });
    const link = join(tmp, "carol-link");
    symlinkSync(real, link);
    const store = openStore(join(tmp, "symlink-home.db"));
    try {
      await readAll(store, { home: link, sources: ["claude-code"] });
      assert.match(String(store.getMeta("scanned_home_owners")), /"carol"/);
    } finally {
      store.close();
    }
  });

  it("throws a TypeError for a dangling symlink", async () => {
    const { symlinkSync } = await import("node:fs");
    const link = join(tmp, "dangling-home");
    symlinkSync(join(tmp, "nowhere"), link);
    const store = openStore(join(tmp, "dangling.db"));
    try {
      await assert.rejects(readAll(store, { home: link }), TypeError);
    } finally {
      store.close();
    }
  });
});
