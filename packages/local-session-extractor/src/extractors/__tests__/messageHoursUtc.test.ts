// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * `message_hours` is the hour of day in UTC for every source, so the same
 * moment lands in the same bucket whichever IDE recorded it and whatever time
 * zone the scanning machine is in.
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

describe("message_hours is UTC", () => {
  let tmp: string;
  const savedTz = process.env["TZ"];
  before(() => {
    process.env["TZ"] = "Asia/Tokyo"; // +09:00, so a local hour differs from the UTC hour
    tmp = mkdtempSync(join(tmpdir(), "lse-hours-"));
  });
  after(() => {
    if (savedTz === undefined) delete process.env["TZ"];
    else process.env["TZ"] = savedTz;
    setPathOverrides({ CURSOR_DB_PATH: undefined, CURSOR_CLI_CHATS_PATH: undefined });
    rmSync(tmp, { recursive: true, force: true });
  });

  async function hoursFor(name: string, userTurns: number): Promise<number[] | undefined> {
    const dbPath = join(tmp, `${name}.vscdb`);
    const raw = new DatabaseSync(dbPath);
    raw.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
    const headers = Array.from({ length: userTurns * 2 }, (_, i) => ({ bubbleId: `b${i}`, type: i % 2 === 0 ? 1 : 2 }));
    const composer = { composerId: name, createdAt: T0, lastUpdatedAt: T0 + 60_000, name: "Hours", fullConversationHeadersOnly: headers };
    const ins = raw.prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)");
    ins.run(`composerData:${name}`, JSON.stringify(composer));
    for (const h of headers) ins.run(`bubbleId:${name}:${h.bubbleId}`, JSON.stringify({ bubbleId: h.bubbleId, type: h.type, text: h.type === 1 ? "q" : "a" }));
    raw.close();
    setPathOverrides({ CURSOR_DB_PATH: dbPath, CURSOR_CLI_CHATS_PATH: join(tmp, "no-cli") });
    const store = new SessionStore(join(tmp, `${name}.db`));
    try {
      assert.equal(await extractCursor(store), 1);
      return (JSON.parse(store.getConversation("cursor", name)!.session_meta!) as { message_hours?: number[] }).message_hours;
    } finally {
      store.close();
    }
  }

  it("Cursor stamps the UTC hour of a single user message", async () => {
    assert.deepEqual(await hoursFor("one", 1), [10]);
  });

  it("Cursor stamps the UTC hour of each spread user message", async () => {
    assert.deepEqual(await hoursFor("two", 2), [10, 10]);
  });
});
