// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * One malformed field in a vendor file costs that field, never the session: a
 * file URI with a stray `%` and a timestamp that is not a date are read as far
 * as they can be. A percent-encoded project path is decoded.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readAll } from "../../scan";
import { SessionStore, openStore } from "../../store/SessionStore";
import { extractCursor } from "../../internal";
import { setPathOverrides } from "../pathResolver";

const tmp = mkdtempSync(join(tmpdir(), "lse-malformed-"));
after(() => {
  setPathOverrides({ CURSOR_DB_PATH: undefined, CURSOR_CLI_CHATS_PATH: undefined });
  rmSync(tmp, { recursive: true, force: true });
});

async function cursorRow(composerId: string, extra: Record<string, unknown>) {
  const dbPath = join(tmp, `${composerId}.vscdb`);
  const raw = new DatabaseSync(dbPath);
  raw.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
  const composer = {
    composerId,
    createdAt: 1767607200000,
    lastUpdatedAt: 1767607260000,
    name: "Paths",
    fullConversationHeadersOnly: [{ bubbleId: "b0", type: 1 }, { bubbleId: "b1", type: 2 }],
    ...extra,
  };
  const ins = raw.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
  ins.run(`composerData:${composerId}`, JSON.stringify(composer));
  ins.run(`bubbleId:${composerId}:b0`, JSON.stringify({ bubbleId: "b0", type: 1, text: "fix it" }));
  ins.run(`bubbleId:${composerId}:b1`, JSON.stringify({ bubbleId: "b1", type: 2, text: "done" }));
  raw.close();
  const store = new SessionStore(join(tmp, `${composerId}.db`));
  try {
    setPathOverrides({ CURSOR_DB_PATH: dbPath, CURSOR_CLI_CHATS_PATH: join(tmp, "no-cli-chats") });
    const count = await extractCursor(store);
    return { count, row: store.getConversation("cursor", composerId) };
  } finally {
    store.close();
  }
}

describe("Cursor — file URIs", () => {
  it("keeps the session when an attached file URI has a stray %", async () => {
    const { count, row } = await cursorRow("stray-percent", {
      allAttachedFileCodeChunksUris: ["file:///tmp/proj/50%.md"],
      codeBlockData: { "file:///tmp/proj/100%done.ts": {} },
    });
    assert.equal(count, 1);
    const meta = JSON.parse(row!.session_meta!) as { tracked_file_paths?: string[] };
    assert.deepEqual(meta.tracked_file_paths, ["/tmp/proj/100%done.ts"]);
  });

  it("decodes a percent-encoded project path", async () => {
    const { row } = await cursorRow("encoded-path", {
      allAttachedFileCodeChunksUris: ["file:///tmp/My%20Repo/src/a.ts", "file:///tmp/My%20Repo/src/b.ts"],
    });
    assert.equal(row!.project_path, "/tmp/My Repo/src");
  });
});

describe("Copilot — a request timestamp that is not a date", { skip: process.platform !== "darwin" }, () => {
  it("keeps the session and leaves that prompt's timestamp unset", async () => {
    const home = join(tmp, "copilot", "Users", "probe");
    const dir = join(home, "Library", "Application Support", "Code", "User", "workspaceStorage", "ws1", "chatSessions");
    mkdirSync(dir, { recursive: true });
    const lines = [
      { kind: 0, v: { requests: [] } },
      { kind: 2, k: ["requests"], v: [{ message: { text: "hello" }, timestamp: "not a date" }] },
      { kind: 2, k: ["requests"], v: [{ message: { text: "again" }, timestamp: 1767225600000 }] },
    ];
    writeFileSync(join(dir, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const store = openStore(join(tmp, "copilot", "sessions.db"));
    try {
      const result = await readAll(store, { home, sources: ["copilot"] });
      assert.equal(result.counts.copilot, 1);
      const prompts = JSON.parse(store.listConversations({ ideType: "copilot" })[0]!.conversation) as Array<{ content: string; timestamp?: string }>;
      assert.equal(prompts[0]?.timestamp, undefined);
      assert.equal(prompts.find((p) => p.content === "again")?.timestamp, new Date(1767225600000).toISOString());
    } finally {
      store.close();
    }
  });
});
