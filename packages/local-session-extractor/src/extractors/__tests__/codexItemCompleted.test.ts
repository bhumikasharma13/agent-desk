// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Codex 0.118 and later write the user's turn as an `item_completed` UserMessage instead of a
 * `user_message` event. Such a rollout is read as a session, by both the directory scan and the
 * `state_5.sqlite` path, and a rollout that writes one turn in both forms yields one turn.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { readAll } from "../../index";
import { parseRolloutContent } from "../../internal";
import { SessionStore } from "../../store/SessionStore";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/extraction/codex");
const ITEM_ROLLOUT = join(fixtureDir, "item-completed-rollout.jsonl");
const MIXED_ROLLOUT = join(fixtureDir, "item-completed-mixed-rollout.jsonl");
const THREAD_UUID = "0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e";

interface StoredPrompt {
  role: string;
  content: string;
  timestamp?: string;
  metadata?: { permission_mode?: string; model?: string; inputTokens?: number };
}

let tmp: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "lse-codex-items-"));
});
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe("parseRolloutContent — item_completed UserMessage", () => {
  it("reads each UserMessage item as the turn's user prompt", () => {
    const content = readFileSync(ITEM_ROLLOUT, "utf8");
    assert.equal(content.includes('"user_message"'), false, "the fixture must carry no user_message");

    const result = parseRolloutContent(content, THREAD_UUID);
    if (!result) assert.fail("parseRolloutContent returned null");

    assert.equal(result.userTurns, 2);
    assert.deepEqual(
      result.prompts.map((p) => [p.role, p.content, p.timestamp]),
      [
        ["user", "List the source files", "2026-05-01T09:00:01.300Z"],
        ["assistant", "There is one file, src/index.ts.", undefined],
        // Two text entries, joined with no separator.
        ["user", "Thanks, that is all", "2026-05-01T09:01:00.300Z"],
        ["assistant", "You are welcome.", undefined],
      ],
    );
    assert.equal(result.prompts[0]?.metadata?.permission_mode, "on-request");
    assert.equal(result.prompts[0]?.metadata?.model, "gpt-5.5");
    assert.equal(result.prompts[1]?.metadata?.inputTokens, 1200);
    assert.deepEqual(result.userTimestampsMs, [Date.parse("2026-05-01T09:00:01.300Z"), Date.parse("2026-05-01T09:01:00.300Z")]);
    assert.equal(result.lastPrompt, "Thanks, that is all");
    // The timeline holds both turns' prompts and the command's call and result, once each.
    const kinds = result.sessionEvents.map((e) => e.kind);
    assert.equal(kinds.filter((k) => k === "SESSION_EVENT_KIND_PROMPT_REFERENCE").length, 4);
    assert.equal(kinds.filter((k) => k === "SESSION_EVENT_KIND_TOOL_CALL").length, 1);
    assert.equal(kinds.filter((k) => k === "SESSION_EVENT_KIND_TOOL_RESULT").length, 1);
  });

  it("counts a turn written in both forms once, in either order", () => {
    const result = parseRolloutContent(readFileSync(MIXED_ROLLOUT, "utf8"), "t-mixed");
    if (!result) assert.fail("parseRolloutContent returned null");

    // Turn 1 writes user_message then the item; turn 2 the item then user_message, with the
    // same text as turn 1, so a twin is matched only within its own turn.
    assert.equal(result.userTurns, 2);
    assert.deepEqual(
      result.prompts.map((p) => [p.role, p.content, p.timestamp]),
      [
        ["user", "Run the tests", "2026-05-02T09:00:01.200Z"],
        ["assistant", "The tests pass.", undefined],
        ["user", "Run the tests", "2026-05-02T09:01:00.100Z"],
        ["assistant", "They still pass.", undefined],
      ],
    );
    assert.equal(result.userTimestampsMs.length, 2);
  });
});

describe("readAll — a new-format Codex rollout", () => {
  it("stores it from the sessions folder and counts no handled item kind as unknown", async () => {
    const home = join(tmp, "dir-home");
    const day = join(home, ".codex", "sessions", "2026", "05", "01");
    mkdirSync(day, { recursive: true });
    copyFileSync(ITEM_ROLLOUT, join(day, `rollout-2026-05-01T09-00-00-${THREAD_UUID}.jsonl`));
    const store = new SessionStore(join(tmp, "dir.db"));
    try {
      const result = await readAll(store, { home, sources: ["codex"] });
      assert.deepEqual(result.counts, { codex: 1 });
      assert.deepEqual(result.unknownRecordKinds, {});
      assert.deepEqual(result.errors, []);

      const rows = store.getPendingConversations(10);
      assert.equal(rows.length, 1);
      const prompts = JSON.parse(rows[0]!.conversation) as StoredPrompt[];
      assert.deepEqual(prompts.map((p) => p.role), ["user", "assistant", "user", "assistant"]);
      const meta = JSON.parse(rows[0]!.session_meta!) as { user_message_timestamps?: string[]; last_prompt?: string };
      assert.deepEqual(meta.user_message_timestamps, ["2026-05-01T09:00:01.300Z", "2026-05-01T09:01:00.300Z"]);
      assert.equal(meta.last_prompt, "Thanks, that is all");
    } finally {
      store.close();
    }
  });

  it("stores it through the state_5.sqlite thread that names it", async () => {
    const home = join(tmp, "sqlite-home");
    const codexHome = join(home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const sqlitePath = join(codexHome, "state_5.sqlite");
    copyFileSync(join(fixtureDir, "state_5.sqlite"), sqlitePath);
    const sqlite = new DatabaseSync(sqlitePath);
    sqlite
      .prepare("UPDATE threads SET rollout_path = ?, first_user_message = ? WHERE id = ?")
      .run(ITEM_ROLLOUT, "List the source files", "thread-fixture-001");
    sqlite.close();
    const store = new SessionStore(join(tmp, "sqlite.db"));
    try {
      const result = await readAll(store, { home, sources: ["codex"] });
      assert.deepEqual(result.counts, { codex: 1 });
      assert.deepEqual(result.unknownRecordKinds, {});

      const rows = store.getPendingConversations(10);
      assert.equal(rows.length, 1);
      const prompts = JSON.parse(rows[0]!.conversation) as StoredPrompt[];
      assert.deepEqual(
        prompts.filter((p) => p.role === "user").map((p) => p.timestamp),
        ["2026-05-01T09:00:01.300Z", "2026-05-01T09:01:00.300Z"],
      );
      const meta = JSON.parse(rows[0]!.session_meta!) as { first_prompt?: string; user_message_timestamps?: string[] };
      assert.equal(meta.first_prompt, "List the source files");
      assert.equal(meta.user_message_timestamps?.length, 2);
    } finally {
      store.close();
    }
  });

  it("still counts an item type it does not know", async () => {
    const home = join(tmp, "unknown-item-home");
    const day = join(home, ".codex", "sessions", "2026", "05", "01");
    mkdirSync(day, { recursive: true });
    const novel = JSON.stringify({
      timestamp: "2026-05-01T09:00:03.700Z",
      type: "event_msg",
      payload: { type: "item_completed", turn_id: "turn-1", item: { type: "SomeFutureItem", id: "x" } },
    });
    const lines = readFileSync(ITEM_ROLLOUT, "utf8").trimEnd().split("\n");
    lines.splice(10, 0, novel);
    writeFileSync(join(day, `rollout-2026-05-01T09-00-00-${THREAD_UUID}.jsonl`), `${lines.join("\n")}\n`);
    const store = new SessionStore(join(tmp, "unknown.db"));
    try {
      const result = await readAll(store, { home, sources: ["codex"] });
      assert.deepEqual(result.counts, { codex: 1 });
      assert.deepEqual(result.unknownRecordKinds, { "codex:event_msg/item_completed/SomeFutureItem": 1 });
    } finally {
      store.close();
    }
  });
});
