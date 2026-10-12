// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * `list` reports a stored conversation it cannot parse as an unknown prompt
 * count, never as a silent 0.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { main } from "../main";
import { openStore } from "../../store/SessionStore";

const tmp = mkdtempSync(join(tmpdir(), "lse-cli-list-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

async function run(args: string[]): Promise<{ code: number; stdout: string }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  stdout.on("data", (c: Buffer) => (out += c.toString()));
  const code = await main(args, { stdout, stderr, stdin: new PassThrough() });
  return { code, stdout: out };
}

describe("list — the prompt count", () => {
  const db = join(tmp, "sessions.db");
  const store = openStore(db);
  const base = { lastMtimeMs: 1, lastSize: 1, lastOffset: 0 };
  store.upsert({ ideType: "codex", sessionId: "good", conversation: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }], ...base });
  store.upsert({ ideType: "codex", sessionId: "bad", conversation: [], ...base });
  store.raw().prepare("UPDATE conversations SET conversation = 'not json' WHERE session_id = 'bad'").run();
  store.close();

  it("is null in --json for an unparseable conversation, and a number otherwise", async () => {
    const { code, stdout } = await run(["list", "--json", "--db", db]);
    assert.equal(code, 0);
    const rows = JSON.parse(stdout) as Array<{ session_id: string; prompts: number | null }>;
    assert.equal(rows.find((r) => r.session_id === "good")?.prompts, 2);
    assert.equal(rows.find((r) => r.session_id === "bad")?.prompts, null);
  });

  it("is shown as ? in the table", async () => {
    const { stdout } = await run(["list", "--db", db]);
    const line = stdout.split("\n").find((l) => l.includes(" bad "));
    assert.match(line ?? "", /\s\?\s/);
  });
});
