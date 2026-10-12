// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Store edges: a Cursor row whose project, repo or events change goes back to
 * pending; a zero-byte file becomes a 0600 store; `reset --dedup` keeps each
 * row's updated_at.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StoreOpenError, createStoreFile, openStore, setStoreOpenSeamsForTests } from "../SessionStore";

const tmp = mkdtempSync(join(tmpdir(), "lse-store-edges-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const base = { lastMtimeMs: 1, lastSize: 1, lastOffset: 0 };
const conversation = [{ role: "user" as const, content: "same" }];

describe("a synced Cursor row", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["project_path", { projectPath: "/src/b" }],
    ["repo_name", { repoName: "org/b" }],
    ["session_events", { sessionEvents: JSON.stringify([{ kind: "x" }]) }],
    ["session_facets", { sessionFacets: JSON.stringify({ outcome: "done" }) }],
  ];
  for (const [field, change] of cases) {
    it(`goes back to pending when only ${field} changes`, () => {
      const store = openStore(join(tmp, `cursor-${field}.db`));
      try {
        store.upsert({ ideType: "cursor", sessionId: "c1", conversation, projectPath: "/src/a", repoName: "org/a", ...base });
        const id = store.getConversation("cursor", "c1")!.id;
        store.markSyncing([id]);
        store.markSynced(id);
        store.upsert({ ideType: "cursor", sessionId: "c1", conversation, projectPath: "/src/a", repoName: "org/a", ...base, ...change });
        assert.equal(store.getConversation("cursor", "c1")!.sync_status, "pending");
      } finally {
        store.close();
      }
    });
  }

  it("stays synced when nothing changed", () => {
    const store = openStore(join(tmp, "cursor-same.db"));
    try {
      const row = { ideType: "cursor" as const, sessionId: "c1", conversation, projectPath: "/src/a", repoName: "org/a", ...base };
      store.upsert(row);
      const id = store.getConversation("cursor", "c1")!.id;
      store.markSyncing([id]);
      store.markSynced(id);
      store.upsert(row);
      assert.equal(store.getConversation("cursor", "c1")!.sync_status, "synced");
    } finally {
      store.close();
    }
  });
});

describe("openStore on an empty file", { skip: process.getuid?.() === 0 }, () => {
  it("initialises it as a store at mode 0600", () => {
    const path = join(tmp, "empty.db");
    writeFileSync(path, "");
    chmodSync(path, 0o644);
    openStore(path).close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

describe("resetFileDedupTracking", () => {
  it("leaves updated_at as it was", () => {
    const store = openStore(join(tmp, "dedup.db"));
    try {
      store.upsert({ ideType: "codex", sessionId: "c1", conversation, ...base });
      store.raw().prepare("UPDATE conversations SET updated_at = '2020-01-01 00:00:00'").run();
      store.resetFileDedupTracking(["codex"]);
      const row = store.getConversation("codex", "c1")!;
      assert.equal(row.updated_at, "2020-01-01 00:00:00");
      assert.equal(row.last_mtime_ms, 0);
    } finally {
      store.close();
    }
  });
});

describe("a synced Cursor row, more fields", () => {
  for (const [field, change] of [
    ["event_coverage", { eventCoverage: "EVENT_COVERAGE_FULL" }],
    ["stats_cache", { statsCache: JSON.stringify({ total_sessions: 2 }) }],
  ] as const) {
    it(`goes back to pending when only ${field} changes`, () => {
      const store = openStore(join(tmp, `cursor2-${field}.db`));
      try {
        store.upsert({ ideType: "cursor", sessionId: "c1", conversation, ...base });
        const id = store.getConversation("cursor", "c1")!.id;
        store.markSyncing([id]);
        store.markSynced(id);
        store.upsert({ ideType: "cursor", sessionId: "c1", conversation, ...base, ...change });
        assert.equal(store.getConversation("cursor", "c1")!.sync_status, "pending");
      } finally {
        store.close();
      }
    });
  }
});

describe("creating a store file another process just created", () => {
  it("does not throw when the file appears between the check and the create", async () => {
    const { createStoreFile } = await import("../SessionStore");
    const path = join(tmp, "raced.db");
    writeFileSync(path, ""); // the other process's create, after this one saw no file
    assert.doesNotThrow(() => createStoreFile(path, () => false));
    openStore(path).close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

describe("a foreign file planted between the existence check and the create", { skip: process.getuid?.() === 0 }, () => {
  it("is refused before SQLite opens it, and left byte for byte, -wal and mode as planted", () => {
    // A WAL-mode database with application_id 0, a table and frames not yet checkpointed.
    const stage = join(tmp, "foreign-stage.db");
    const foreign = new DatabaseSync(stage);
    foreign.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x); INSERT INTO t VALUES (1);");
    const db = readFileSync(stage);
    const wal = readFileSync(`${stage}-wal`);
    foreign.close();
    assert.ok(wal.length > 0, "the planted -wal holds frames");

    const path = join(tmp, "planted.db");
    setStoreOpenSeamsForTests({ exists: (p) => {
      writeFileSync(p, db, { mode: 0o644 });
      writeFileSync(`${p}-wal`, wal, { mode: 0o644 });
      chmodSync(p, 0o644);
      return false;
    } });
    try {
      assert.throws(() => openStore(path), StoreOpenError);
    } finally {
      setStoreOpenSeamsForTests(null);
    }
    assert.ok(readFileSync(path).equals(db), "the database bytes are unchanged");
    assert.ok(existsSync(`${path}-wal`), "the -wal is still there");
    assert.ok(readFileSync(`${path}-wal`).equals(wal), "the -wal bytes are unchanged");
    assert.equal(statSync(path).mode & 0o777, 0o644);
  });
});

describe("a store file this package creates", { skip: process.getuid?.() === 0 }, () => {
  it("is mode 0600 while still empty, whatever the umask", () => {
    const path = join(tmp, "umask0.db");
    const previous = process.umask(0);
    try {
      assert.equal(createStoreFile(path), true);
    } finally {
      process.umask(previous);
    }
    assert.equal(statSync(path).size, 0);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

describe("a foreign file swapped in just before SQLite opens it", { skip: process.getuid?.() === 0 }, () => {
  it("is refused with its bytes and mode unchanged", () => {
    const stage = join(tmp, "swap-stage.db");
    const foreign = new DatabaseSync(stage);
    foreign.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1);");
    foreign.close();
    const db = readFileSync(stage);
    const path = join(tmp, "swapped.db");
    writeFileSync(path, "");
    chmodSync(path, 0o644);
    setStoreOpenSeamsForTests({ beforeOpen: (p) => {
      writeFileSync(p, db);
      chmodSync(p, 0o644);
    } });
    try {
      assert.throws(() => openStore(path), StoreOpenError);
    } finally {
      setStoreOpenSeamsForTests(null);
    }
    assert.ok(readFileSync(path).equals(db), "the database bytes are unchanged");
    assert.equal(statSync(path).mode & 0o777, 0o644);
  });
});

describe("reopening an existing store", { skip: process.getuid?.() === 0 }, () => {
  it("keeps the mode its owner gave it", () => {
    const path = join(tmp, "mode0640.db");
    openStore(path).close();
    chmodSync(path, 0o640);
    openStore(path).close();
    assert.equal(statSync(path).mode & 0o777, 0o640);
  });
});

describe("a store path that is a dangling symlink", () => {
  it("is refused with a StoreOpenError, and its target is not created", () => {
    const target = join(tmp, "dangling-target.db");
    const path = join(tmp, "dangling.db");
    symlinkSync(target, path);
    assert.throws(() => openStore(path), (err: unknown) => err instanceof StoreOpenError && /symlink/.test(err.message));
    assert.equal(existsSync(target), false);
  });
});
