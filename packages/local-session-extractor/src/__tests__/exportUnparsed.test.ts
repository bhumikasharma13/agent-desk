// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A JSON column that does not parse, or parses to an unexpected shape, is
 * still redacted on the way out.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashUsername, setRunningUsernameForTests } from "../redaction/anonymizer";
import { exportSessions, openStore } from "../index";

const tmp = mkdtempSync(join(tmpdir(), "lse-export-unparsed-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

describe("exportSessions — JSON columns that are not what the store writes", () => {
  it("redacts an unparseable conversation and an array session_meta", async () => {
    const restore = setRunningUsernameForTests("alice");
    const store = openStore(join(tmp, "s.db"));
    try {
      store.upsert({ ideType: "codex", sessionId: "c1", conversation: [], lastMtimeMs: 1, lastSize: 1, lastOffset: 0 });
      store.raw().prepare("UPDATE conversations SET conversation = ?, session_meta = ?, session_events = ? WHERE session_id = 'c1'")
        .run(`not json ${TOKEN} /Users/alice/x`, JSON.stringify([TOKEN, "/Users/alice/y"]), JSON.stringify({ odd: TOKEN }));
      const file = join(tmp, "out.jsonl");
      await exportSessions(store, { format: "jsonl", shape: "row", out: file });
      const out = readFileSync(file, "utf8");
      assert.ok(!out.includes(TOKEN), out);
      assert.ok(!out.includes("/Users/alice/"), out);
      const row = JSON.parse(out.trim()) as Record<string, unknown>;
      const h = hashUsername("alice");
      assert.equal(row["conversation"], `not json ████████ /Users/${h}/x`);
      assert.deepEqual(row["session_meta"], ["████████", `/Users/${h}/y`]);
      assert.deepEqual(row["session_events"], { odd: "████████" });
    } finally {
      store.close();
      restore();
    }
  });
});
