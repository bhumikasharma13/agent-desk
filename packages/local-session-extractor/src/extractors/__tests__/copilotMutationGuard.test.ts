// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A VS Code chat-session file is untrusted input: its mutation paths must never
 * reach an object's prototype, and a malformed index must not allocate without
 * bound or drop the session.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAll } from "../../scan";
import { openStore } from "../../store/SessionStore";

const tmp = mkdtempSync(join(tmpdir(), "lse-copilot-guard-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A home with one workspace chat session holding `lines`, scanned for Copilot only. */
async function scanSession(name: string, lines: unknown[]): Promise<{ count: number; conversation: Array<{ content: string }> }> {
  const home = join(tmp, name, "Users", "probe");
  const dir = join(home, "Library", "Application Support", "Code", "User", "workspaceStorage", "ws1", "chatSessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const store = openStore(join(tmp, name, "sessions.db"));
  try {
    const result = await readAll(store, { home, sources: ["copilot"] });
    const row = store.listConversations({ ideType: "copilot" })[0];
    return { count: result.counts.copilot ?? 0, conversation: row ? (JSON.parse(row.conversation) as Array<{ content: string }>) : [] };
  } finally {
    store.close();
  }
}

const snapshot = { kind: 0, v: { requests: [] } };
const request = { kind: 2, k: ["requests"], v: [{ message: { text: "hello" }, timestamp: 1767225600000 }] };

describe("Copilot chat-session mutation guard", { skip: process.platform !== "darwin" }, () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    it(`ignores a mutation path through ${key}`, async () => {
      const { count } = await scanSession(`proto-${key}`, [snapshot, request, { kind: 1, k: ["requests", 0, key, "polluted"], v: "yes" }]);
      assert.equal(count, 1);
      assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
      assert.equal((Object.prototype as unknown as Record<string, unknown>)["polluted"], undefined);
    });
  }

  it("ignores an index that is huge, negative or not a whole number, and keeps the session", async () => {
    const { count, conversation } = await scanSession("bad-index", [
      snapshot,
      request,
      { kind: 1, k: ["requests", 200000, "message", "text"], v: "x" },
      { kind: 1, k: ["requests", -1, "message", "text"], v: "x" },
      { kind: 1, k: ["requests", 0.5, "message", "text"], v: "x" },
    ]);
    assert.equal(count, 1);
    assert.deepEqual(conversation.map((p) => p.content), ["hello"]);
  });
});
