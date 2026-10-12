// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Cursor's per-message timing: when every user bubble carries Cursor's own
 * `createdAt`, the session's user timestamps are those; only a store that does
 * not stamp its bubbles falls back to times spread evenly over the session.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../../store/SessionStore";
import { extractCursor } from "../../internal";
import { setPathOverrides } from "../pathResolver";

const T0 = Date.parse("2026-01-05T10:00:00.000Z");

type Bubble = { role: "user" | "assistant"; text: string; createdAt?: string };

describe("cursorExtractor — per-message timing", () => {
  let tmp: string;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "lse-cursor-timing-"));
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: join(tmp, "no-cli-chats") });
  });
  after(() => {
    setPathOverrides({ CURSOR_DB_PATH: undefined, CURSOR_CLI_CHATS_PATH: undefined });
    rmSync(tmp, { recursive: true, force: true });
  });

  async function metaFor(composerId: string, bubbles: Bubble[]): Promise<Record<string, unknown>> {
    const dbPath = join(tmp, `${composerId}.vscdb`);
    const raw = new DatabaseSync(dbPath);
    raw.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    const composer = {
      composerId,
      createdAt: T0,
      lastUpdatedAt: T0 + 60_000,
      name: "Timing",
      fullConversationHeadersOnly: bubbles.map((b, i) => ({ bubbleId: `b${i}`, type: b.role === "user" ? 1 : 2 })),
      modelConfig: { modelName: "claude-sonnet-4-6" },
    };
    const ins = raw.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    ins.run(`composerData:${composerId}`, JSON.stringify(composer));
    bubbles.forEach((b, i) => {
      const bubble: Record<string, unknown> = { bubbleId: `b${i}`, type: b.role === "user" ? 1 : 2, text: b.text };
      if (b.createdAt) bubble["createdAt"] = b.createdAt;
      ins.run(`bubbleId:${composerId}:b${i}`, JSON.stringify(bubble));
    });
    raw.close();
    const store = new SessionStore(join(tmp, `${composerId}.db`));
    try {
      setPathOverrides({ CURSOR_DB_PATH: dbPath });
      assert.equal(await extractCursor(store), 1);
      return JSON.parse(store.getConversation("cursor", composerId)!.session_meta!) as Record<string, unknown>;
    } finally {
      store.close();
    }
  }

  it("uses the bubbles' own createdAt when every user bubble has one", async () => {
    const first = new Date(T0 + 5_000).toISOString();
    const second = new Date(T0 + 50_000).toISOString();
    const meta = await metaFor("timed", [
      { role: "user", text: "first question", createdAt: first },
      { role: "assistant", text: "answer", createdAt: new Date(T0 + 8_000).toISOString() },
      { role: "user", text: "second question", createdAt: second },
      { role: "assistant", text: "answer" },
    ]);
    assert.deepEqual(meta["user_message_timestamps"], [first, second]);
    assert.deepEqual(meta["user_response_times"], [45]);
  });

  it("falls back to evenly spread times when a user bubble has no createdAt", async () => {
    const meta = await metaFor("partly-timed", [
      { role: "user", text: "first question" },
      { role: "assistant", text: "answer" },
      { role: "user", text: "second question", createdAt: new Date(T0 + 50_000).toISOString() },
    ]);
    assert.deepEqual(meta["user_message_timestamps"], [new Date(T0).toISOString(), new Date(T0 + 60_000).toISOString()]);
    assert.deepEqual(meta["user_response_times"], [60]);
  });
});
