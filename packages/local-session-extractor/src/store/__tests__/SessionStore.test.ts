// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS } from "../migrations";
import { LIST_DEFAULT_LIMIT, STORE_APPLICATION_ID, SessionStore, StoreOpenError, openStore } from "../SessionStore";
import * as publicApi from "../../index";
import type { UpsertParams } from "../../types/store";

const PACKAGE_ROOT = resolve(import.meta.dirname, "../../..");

function row(over: Partial<UpsertParams> = {}): UpsertParams {
  return {
    ideType: "claude-code",
    sessionId: "s-1",
    conversation: [{ role: "user", content: "hello", timestamp: "2026-01-01T00:00:00.000Z" }],
    lastMtimeMs: 1,
    lastSize: 2,
    lastOffset: 3,
    ...over,
  } as UpsertParams;
}

function syncStatus(store: SessionStore, sessionId = "s-1", ideType = "claude-code"): string {
  return (store.raw().prepare("SELECT sync_status FROM conversations WHERE ide_type = ? AND session_id = ?").get(ideType, sessionId) as { sync_status: string }).sync_status;
}

describe("SessionStore", () => {
  let dir = "";
  let path = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "session-store-"));
    path = join(dir, "nested", "sessions.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates the directory 0700 and the file 0600, in WAL with a five-second busy timeout", () => {
    const store = openStore(path);
    try {
      assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700);
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal((store.raw().prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
      assert.equal((store.raw().prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5000);
      assert.equal((store.raw().prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
    } finally {
      store.close();
    }
  });

  it("serialises two processes migrating a fresh file", async () => {
    const script = `
      const { openStore } = await import(${JSON.stringify(join(PACKAGE_ROOT, "src/store/SessionStore.ts"))});
      const s = openStore(process.argv[1]); s.close(); process.stdout.write("ok");`;
    const run = () =>
      new Promise<{ code: number | null; out: string; err: string }>((done) => {
        const child = spawn(process.execPath, [
          "--no-warnings",
          "--import", join(PACKAGE_ROOT, "test-register.mjs"),
          "--import", join(PACKAGE_ROOT, "test-setup.mjs"),
          "--input-type=module", "-e", script, path,
        ]);
        let out = "";
        let err = "";
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (err += c));
        child.on("close", (code) => done({ code, out, err }));
      });
    const results = await Promise.all([run(), run()]);
    for (const r of results) assert.ok(r.code === 0 && r.out === "ok", `child exited ${r.code}, stdout ${JSON.stringify(r.out)}, stderr: ${r.err}`);
    const store = openStore(path);
    try {
      assert.equal((store.raw().prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
    } finally {
      store.close();
    }
  });

  it("waits for another process's write lock before switching to WAL", async () => {
    openStore(path).close();
    const reset = new DatabaseSync(path);
    reset.exec("PRAGMA journal_mode = DELETE");
    reset.close();
    const holder = spawn(process.execPath, [
      "--no-warnings",
      "--input-type=module",
      "-e",
      `const { DatabaseSync } = await import("node:sqlite");
       const { writeSync } = await import("node:fs");
       const db = new DatabaseSync(process.argv[1]);
       db.exec("BEGIN IMMEDIATE");
       writeSync(1, "held");
       const end = Date.now() + 300;
       while (Date.now() < end) {}
       db.exec("COMMIT");
       db.close();`,
      path,
    ]);
    const exited = new Promise((done) => holder.on("close", done));
    await new Promise((held) => holder.stdout.once("data", held));
    const store = openStore(path);
    try {
      assert.equal((store.raw().prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
    } finally {
      store.close();
      await exited;
    }
  });

  it("keeps the three-arm sync rule on re-upsert", () => {
    const store = openStore(path);
    try {
      store.upsert(row());
      store.markSyncing([store.getConversation("claude-code", "s-1")!.id]);
      store.upsert(row());
      assert.equal(syncStatus(store), "pending", "a non-Cursor re-extract always goes back to pending");

      store.upsert(row({ ideType: "cursor", sessionId: "c-1" }));
      const cursorId = store.getConversation("cursor", "c-1")!.id;
      store.markSyncing([cursorId]);
      store.markSynced(cursorId);
      store.upsert(row({ ideType: "cursor", sessionId: "c-1" }));
      assert.equal(syncStatus(store, "c-1", "cursor"), "synced", "an unchanged Cursor hash keeps its state");
      store.upsert(row({ ideType: "cursor", sessionId: "c-1", conversation: [{ role: "user", content: "changed", timestamp: "2026-01-01T00:00:00.000Z" }] as UpsertParams["conversation"] }));
      assert.equal(syncStatus(store, "c-1", "cursor"), "pending", "a changed Cursor hash re-queues");

      store.applyScope([], "filtered");
      store.upsert(row());
      assert.equal(syncStatus(store), "skipped_out_of_scope", "an out-of-scope park survives re-extract");
    } finally {
      store.close();
    }
  });

  it("stamps the extractor version it is given, and null when absent", () => {
    const store = openStore(path);
    try {
      store.upsert(row({ extractorVersion: 7 }));
      store.upsert(row({ sessionId: "s-2" }));
      assert.equal(store.getConversation("claude-code", "s-1")!.extractor_version, 7);
      assert.equal(store.getConversation("claude-code", "s-2")!.extractor_version, null);
    } finally {
      store.close();
    }
  });

  it("reclaims a stale syncing claim and skips out-of-scope rows", () => {
    const store = openStore(path);
    try {
      store.upsert(row());
      store.upsert(row({ sessionId: "s-2" }));
      store.upsert(row({ sessionId: "s-3", projectPath: "/elsewhere" }));
      const [a, b] = ["s-1", "s-2"].map((s) => store.getConversation("claude-code", s)!.id);
      store.markSyncing([a!, b!]);
      store.raw().prepare("UPDATE conversations SET updated_at = datetime('now', '-31 minutes') WHERE id = ?").run(a!);
      store.applyScope(["/in-scope"], "filtered");
      const pending = store.getPendingConversations(10).map((r) => r.session_id);
      assert.deepEqual(pending, ["s-1"], "only the stale claim is reclaimed; the fresh claim and the parked row are not");
      assert.equal(syncStatus(store, "s-3"), "skipped_out_of_scope");
      assert.deepEqual(store.applyScope(["/elsewhere"], "filtered"), { requeued: 1 });
      assert.equal(syncStatus(store, "s-3"), "pending");
    } finally {
      store.close();
    }
  });

  it("lists by filter, most recently updated first", () => {
    const store = openStore(path);
    try {
      store.upsert(row({ sessionId: "a", repoName: "org/one" }));
      store.upsert(row({ sessionId: "b", repoName: "org/two" }));
      store.upsert(row({ ideType: "codex", sessionId: "c", repoName: "org/one" }));
      store.raw().prepare("UPDATE conversations SET updated_at = datetime('now', '-1 hour') WHERE session_id = 'a'").run();
      assert.deepEqual(store.listConversations({ repoName: "org/one" }).map((r) => r.session_id), ["c", "a"]);
      assert.deepEqual(store.listConversations({ ideType: "claude-code", limit: 1 }).map((r) => r.session_id), ["b"]);
      assert.equal(store.getConversation("codex", "absent"), null);
    } finally {
      store.close();
    }
  });

  it("bounds a list by default and pages with an offset", () => {
    const store = openStore(path);
    try {
      for (let i = 0; i < LIST_DEFAULT_LIMIT + 3; i++) store.upsert(row({ sessionId: `p-${i}` }));
      assert.equal(store.listConversations().length, LIST_DEFAULT_LIMIT);
      assert.equal(store.listConversations({ offset: LIST_DEFAULT_LIMIT }).length, 3);
      assert.throws(() => store.listConversations({ limit: -1 }), /limit must be a positive integer/);
    } finally {
      store.close();
    }
  });

  it("surfaces the original error when a transaction fails", () => {
    const store = openStore(path);
    try {
      store.raw().exec("DROP TABLE meta");
      assert.throws(() => store.clearAll(), /no such table: meta/);
      assert.doesNotThrow(() => store.upsert(row()), "the connection is usable after the rollback");
    } finally {
      store.close();
    }
  });

  it("is reachable through the package's public entry", () => {
    assert.equal(publicApi.openStore, openStore);
    assert.equal(publicApi.SessionStore, SessionStore);
  });

  it("clears every row and meta entry", () => {
    const store = openStore(path);
    try {
      store.upsert(row());
      store.setMeta("cursor_seat_tier_lookup", "{}");
      store.clearAll();
      assert.equal(store.getConversation("claude-code", "s-1"), null);
      assert.equal(store.getMeta("cursor_seat_tier_lookup"), null);
    } finally {
      store.close();
    }
  });

  it("opens a newer additive schema", () => {
    openStore(path).close();
    const db = new DatabaseSync(path);
    db.exec("ALTER TABLE conversations ADD COLUMN future_field TEXT");
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 3}`);
    db.close();
    const store = openStore(path);
    try {
      store.upsert(row());
      assert.ok(store.getConversation("claude-code", "s-1"));
    } finally {
      store.close();
    }
  });

  it("refuses a newer schema that lacks a column it reads", () => {
    openStore(path).close();
    const db = new DatabaseSync(path);
    db.exec("ALTER TABLE conversations DROP COLUMN event_coverage");
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    db.close();
    assert.throws(() => openStore(path), (err: unknown) => err instanceof StoreOpenError && /event_coverage/.test(err.message));
  });

  it("marks a store it creates, and initialises a zero-byte file", () => {
    openStore(path).close();
    mkdirSync(join(dir, "empty"));
    const empty = join(dir, "empty", "sessions.db");
    writeFileSync(empty, "");
    openStore(empty).close();
    for (const file of [path, empty]) {
      const db = new DatabaseSync(file);
      try {
        assert.equal((db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id, STORE_APPLICATION_ID);
        assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length);
      } finally {
        db.close();
      }
    }
  });

  it("refuses another program's SQLite file before writing anything to it", () => {
    mkdirSync(join(dir, "nested"));
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('keep me');");
    db.close();
    const before = readFileSync(path);
    for (const opts of [{}, { mustExist: true }]) {
      assert.throws(
        () => openStore(path, opts),
        (err: unknown) => err instanceof StoreOpenError && /not a local-session-extractor store/.test(err.message),
      );
    }
    assert.deepEqual(readFileSync(path), before, "the file is byte-identical");
    assert.equal(existsSync(`${path}-wal`), false, "WAL was not switched on");
  });

  it("refuses a WAL-mode database without replaying or checkpointing its log", () => {
    mkdirSync(join(dir, "nested"));
    // The writer stays open, so its log is neither checkpointed nor removed.
    const writer = new DatabaseSync(path);
    try {
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
      writer.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('keep me');");
      const snapshot = (): Buffer[] => [path, `${path}-wal`, `${path}-shm`].map((p) => readFileSync(p));
      const before = snapshot();
      assert.ok(before[1]!.length > 0, "the log holds frames the main file does not");
      for (const opts of [{}, { mustExist: true }]) {
        assert.throws(
          () => openStore(path, opts),
          (err: unknown) => err instanceof StoreOpenError && /not a local-session-extractor store/.test(err.message),
        );
      }
      assert.deepEqual(snapshot(), before, "the database, its log and its shared-memory file are byte-identical");
    } finally {
      writer.close();
    }
  });

  it("refuses a file that is not SQLite at all", () => {
    mkdirSync(join(dir, "nested"));
    writeFileSync(path, "plain text, not a database\n".repeat(200));
    const before = readFileSync(path);
    assert.throws(() => openStore(path), (err: unknown) => err instanceof StoreOpenError && /not a local-session-extractor store/.test(err.message));
    assert.deepEqual(readFileSync(path), before);
  });

  it("with mustExist, creates and migrates nothing", () => {
    assert.throws(() => openStore(path, { mustExist: true }), StoreOpenError);
    assert.equal(existsSync(join(dir, "nested")), false);
    openStore(path).close();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
    db.close();
    assert.throws(() => openStore(path, { mustExist: true }), (err: unknown) => err instanceof StoreOpenError && /older/.test(err.message));
    const check = new DatabaseSync(path);
    assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, MIGRATIONS.length - 1);
    check.close();
  });
});
