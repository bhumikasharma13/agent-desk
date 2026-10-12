// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Public-contract cases the other suites leave open: export filters and the
 * sync-state columns, `readSource` validation, `unredactPath`, the host's
 * `resetPathOverrides`, and a store whose directory cannot be written.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  DuplicateSourceError,
  UnsupportedSourceError,
  exportSessions,
  openStore,
  readSource,
  redactPath,
  unredactPath,
  type ExportFilter,
} from "../index";
import { getPathOverride, resetPathOverrides, setPathOverrides } from "../host";

const tmp = mkdtempSync(join(tmpdir(), "lse-contract-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const base = { lastMtimeMs: 1, lastSize: 1, lastOffset: 0 };

/** Every exported row, parsed. */
async function exported(store: ReturnType<typeof openStore>, opts: { filter?: ExportFilter; includeSyncState?: boolean } = {}) {
  let out = "";
  const sink = {
    write: (chunk: string, cb?: (err?: Error | null) => void) => {
      out += chunk;
      cb?.(null);
      return true;
    },
    on: () => sink,
    removeListener: () => sink,
  };
  await exportSessions(store, { format: "jsonl", shape: "row", out: sink as unknown as NodeJS.WritableStream, ...opts });
  return out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("exportSessions — filters and sync state", () => {
  const store = openStore(join(tmp, "filters.db"));
  store.upsert({ ideType: "codex", sessionId: "c1", conversation: [], projectPath: "/src/a", repoName: "org/a", ...base });
  store.upsert({ ideType: "kiro", sessionId: "k1", conversation: [], projectPath: "/src/b", repoName: "org/b", ...base });
  store.raw().prepare("UPDATE conversations SET updated_at = '2020-01-01 00:00:00' WHERE session_id = 'k1'").run();
  store.markSyncing([store.getConversation("codex", "c1")!.id]);
  after(() => store.close());

  const ids = (rows: Record<string, unknown>[]) => rows.map((r) => r["session_id"]).sort();

  it("filters by every ExportFilter field", async () => {
    assert.deepEqual(ids(await exported(store, { filter: { ideType: "kiro" } })), ["k1"]);
    assert.deepEqual(ids(await exported(store, { filter: { projectPath: "/src/a" } })), ["c1"]);
    assert.deepEqual(ids(await exported(store, { filter: { repoName: "org/b" } })), ["k1"]);
    assert.deepEqual(ids(await exported(store, { filter: { updatedSince: "2021-01-01 00:00:00" } })), ["c1"]);
    assert.deepEqual(ids(await exported(store, { filter: { syncStatus: "pending" } })), ["k1"]);
    assert.deepEqual(ids(await exported(store, { filter: { ideType: "codex", syncStatus: "pending" } })), []);
  });

  it("drops sync_status and synced_at unless includeSyncState is set", async () => {
    const plain = await exported(store);
    assert.ok(plain.every((r) => !("sync_status" in r) && !("synced_at" in r)));
    const withState = await exported(store, { includeSyncState: true });
    assert.ok(withState.every((r) => "sync_status" in r && "synced_at" in r));
  });

  it("refuses includeSyncState without shape row, and an unknown shape, before writing", async () => {
    const out = join(tmp, "refused.jsonl");
    await assert.rejects(exportSessions(store, { format: "jsonl", out, includeSyncState: true }), /includeSyncState applies only to shape "row"/);
    await assert.rejects(exportSessions(store, { format: "jsonl", shape: "table" as never, out }), /unsupported export shape: table/);
    assert.equal(existsSync(out), false);
  });
});

describe("readSource", () => {
  const store = openStore(join(tmp, "read-source.db"));
  after(() => store.close());

  it("rejects an unsupported source before reading anything", async () => {
    await assert.rejects(readSource("vim" as never, store), UnsupportedSourceError);
  });

  it("rejects a source listed twice", async () => {
    const { readAll } = await import("../index");
    await assert.rejects(readAll(store, { sources: ["codex", "codex"] }), DuplicateSourceError);
  });
});

describe("unredactPath", () => {
  it("restores a path this machine redacted, and passes any other path through", () => {
    const own = `/Users/${userInfo().username}/projects/app`;
    const redacted = redactPath(own);
    assert.notEqual(redacted, own, "the running user's name is hashed");
    assert.equal(unredactPath(redacted), own);
    assert.equal(unredactPath("/Users/user_00000000/app"), "/Users/user_00000000/app");
    assert.equal(unredactPath("/opt/tool"), "/opt/tool");
  });
});

describe("host resetPathOverrides", () => {
  it("clears every override", () => {
    setPathOverrides({ CODEX_HOME: "/tmp/a", KIRO_DB_PATH: "/tmp/b" });
    resetPathOverrides();
    assert.equal(getPathOverride("CODEX_HOME"), undefined);
    assert.equal(getPathOverride("KIRO_DB_PATH"), undefined);
  });
});

describe("openStore — a directory that cannot be written", { skip: process.getuid?.() === 0 }, () => {
  it("throws, and creates no file", () => {
    const dir = join(tmp, "read-only");
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    try {
      assert.throws(() => openStore(join(dir, "sessions.db")), Error);
      assert.equal(existsSync(join(dir, "sessions.db")), false);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
