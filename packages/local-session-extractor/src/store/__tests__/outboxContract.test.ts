// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The store's outbox surface, for a host that syncs rows elsewhere: rows start
 * `pending`, a sync moves them `syncing` → `synced` or `failed`, a failed or
 * interrupted sync can be re-queued, and a scope filter parks rows outside the
 * host's projects. The package itself never syncs; these pin the contract.
 */
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SessionStore } from "../SessionStore";
import { conversationId } from "../ids";

const tmp = mkdtempSync(join(tmpdir(), "lse-outbox-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function freshStore(): SessionStore {
  return openStore(join(tmp, `s${++n}.db`));
}
const base = { lastMtimeMs: 1, lastSize: 1, lastOffset: 0 };
const status = (store: SessionStore, id: string) => store.getConversation("codex", id)?.sync_status;

describe("SessionStore outbox", () => {
  let store: SessionStore;
  beforeEach(() => {
    store?.close();
    store = freshStore();
    for (const [id, project] of [["a", "/repo/one"], ["b", "/repo/two"], ["c", "/repo/one"]] as const) {
      store.upsert({ ideType: "codex", sessionId: id, conversation: [{ role: "user", content: id }], projectPath: project, ...base });
    }
  });
  after(() => store?.close());

  it("markFailed fails only a row that is syncing", () => {
    store.markFailed(conversationId("codex", "a"));
    assert.equal(status(store, "a"), "pending", "a pending row is not failed");
    store.markSyncing([conversationId("codex", "a")]);
    store.markFailed(conversationId("codex", "a"));
    assert.equal(status(store, "a"), "failed");
    assert.equal(store.getPendingConversations(10).some((r) => r.session_id === "a"), false, "a failed row is not re-offered");
  });

  it("resetToPending re-queues the given rows", () => {
    store.markSyncing([conversationId("codex", "a"), conversationId("codex", "b")]);
    store.resetToPending([conversationId("codex", "a")]);
    assert.equal(status(store, "a"), "pending");
    assert.equal(status(store, "b"), "syncing");
    store.resetToPending([]);
  });

  it("getDistinctProjectPaths lists each stored project once", () => {
    assert.deepEqual(store.getDistinctProjectPaths().sort(), ["/repo/one", "/repo/two"]);
  });

  it("countByIdeAndProject counts primary sessions per source and project, largest first", () => {
    assert.deepEqual(store.countByIdeAndProject(), [
      { ide_type: "codex", project_path: "/repo/one", count: 2 },
      { ide_type: "codex", project_path: "/repo/two", count: 1 },
    ]);
  });

  it("listDetectedProjects lists each project once with its latest activity", () => {
    const projects = store.listDetectedProjects();
    assert.deepEqual(projects.map((p) => p.project_path).sort(), ["/repo/one", "/repo/two"]);
    assert.ok(projects.every((p) => Number.isFinite(p.last_seen_ms) && p.last_seen_ms > 0));
  });
});

describe("export — installation metadata", () => {
  it("is exported as stored, account identifiers included (the author's design choice)", async () => {
    const { exportSessions } = await import("../../export");
    const store = freshStore();
    try {
      const account = { login_email: "jane.doe@example.com", account_uuid: "00000000-0000-4000-8000-000000000001", device_id: "device-1" };
      store.upsert({ ideType: "codex", sessionId: "acct", conversation: [], installationMetadata: JSON.stringify(account), ...base });
      let out = "";
      const sink = { write: (chunk: string, cb?: (err?: Error | null) => void) => { out += chunk; cb?.(null); return true; }, on: () => sink, removeListener: () => sink };
      await exportSessions(store, { format: "jsonl", shape: "row", out: sink as unknown as NodeJS.WritableStream });
      assert.deepEqual((JSON.parse(out.trim()) as { installation_metadata: unknown }).installation_metadata, account);
      out = "";
      await exportSessions(store, { format: "jsonl", out: sink as unknown as NodeJS.WritableStream });
      assert.deepEqual((JSON.parse(out.trim()) as { installationMetadata: unknown }).installationMetadata, {
        loginEmail: account.login_email,
        accountUuid: account.account_uuid,
        deviceId: account.device_id,
      });
    } finally {
      store.close();
    }
  });
});
