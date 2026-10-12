// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * `ConversationRow.sync_status` names every state the store writes, including
 * `skipped_out_of_scope` (from `applyScope`). The assignment below is the type
 * check (`pnpm type-check` fails without it); the run checks the store agrees.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../SessionStore";
import type { ConversationRow } from "../../types/session";

const tmp = mkdtempSync(join(tmpdir(), "lse-sync-status-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("ConversationRow.sync_status", () => {
  it("includes the out-of-scope state the store writes", () => {
    const store = openStore(join(tmp, "s.db"));
    try {
      store.upsert({ ideType: "codex", sessionId: "s1", conversation: [], projectPath: "/tmp/elsewhere", lastMtimeMs: 1, lastSize: 1, lastOffset: 0 });
      store.applyScope(["/tmp/in-scope"], "filtered");
      const status: ConversationRow["sync_status"] = store.getConversation("codex", "s1")!.sync_status;
      const expected: ConversationRow["sync_status"] = "skipped_out_of_scope";
      assert.equal(status, expected);
    } finally {
      store.close();
    }
  });
});
