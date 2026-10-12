// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A Cursor CLI store in WAL mode holds new turns in `store.db-wal` until a
 * checkpoint, without touching `store.db`. The change check must see them.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../../store/SessionStore";
import { extractCursorCli } from "../../internal";
import { setPathOverrides } from "../pathResolver";

const AGENT_ID = "0b6a1c2d-wal0-4aaa-bbbb-cccccccccccc";

function userBlob(query: string): string {
  return JSON.stringify({ role: "user", content: [{ type: "text", text: `<user_query>${query}</user_query>` }] });
}

describe("cursorCliExtractor — a turn held only in the -wal file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lse-cli-wal-"));
  after(() => {
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: undefined, CURSOR_CLI_CONFIG_PATH: undefined, CURSOR_STATSIG_CACHE_PATH: undefined });
    rmSync(tmp, { recursive: true, force: true });
  });

  it("re-reads the session when only store.db-wal grew", () => {
    const cwd = join(tmp, "repo");
    mkdirSync(cwd, { recursive: true });
    const dir = join(tmp, "chats", "ws1", AGENT_ID);
    mkdirSync(dir, { recursive: true });
    setPathOverrides({
      CURSOR_CLI_CHATS_PATH: join(tmp, "chats"),
      CURSOR_CLI_CONFIG_PATH: join(tmp, "no-cli-config.json"),
      CURSOR_STATSIG_CACHE_PATH: join(tmp, "no-statsig-cache.json"),
    });
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({ hasConversation: true, createdAtMs: Date.now() - 120_000, updatedAtMs: Date.now() - 60_000, cwd }),
    );
    const writer = new DatabaseSync(join(dir, "store.db"));
    try {
      writer.exec("PRAGMA journal_mode = WAL");
      writer.exec("PRAGMA wal_autocheckpoint = 0");
      writer.exec("CREATE TABLE blobs (id INTEGER PRIMARY KEY, data TEXT)");
      writer.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
      writer.prepare("INSERT INTO blobs (data) VALUES (?)").run(userBlob("first question"));
      const meta = { agentId: AGENT_ID, name: "Parent", mode: "default", createdAt: Date.now() - 120_000 };
      writer.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(Buffer.from(JSON.stringify(meta)).toString("hex"));
      writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");

      const store = new SessionStore(join(tmp, "sessions.db"));
      try {
        assert.equal(extractCursorCli(store), 1, "first scan writes the session");
        // The next turn lands in the WAL; the connection stays open so no checkpoint runs.
        writer.prepare("INSERT INTO blobs (data) VALUES (?)").run(userBlob("second question"));
        assert.equal(extractCursorCli(store), 1, "the second scan must re-read the session");
        const row = store.getConversation("cursor", AGENT_ID);
        const texts = (JSON.parse(row!.conversation) as Array<{ content: string }>).map((p) => p.content);
        assert.ok(texts.some((t) => t.includes("second question")), JSON.stringify(texts));

        // On a filesystem with coarse timestamps a write can leave the -wal's mtime
        // unchanged; its size still moves, and that alone must trigger a re-read.
        const wal = `${join(dir, "store.db")}-wal`;
        const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 + 5000);
        utimesSync(wal, pinned, pinned);
        extractCursorCli(store);
        writer.prepare("INSERT INTO blobs (data) VALUES (?)").run(userBlob("third question"));
        utimesSync(wal, pinned, pinned);
        assert.equal(extractCursorCli(store), 1, "a -wal that only grew must be re-read");
      } finally {
        store.close();
      }
    } finally {
      writer.close();
    }
  });
});
