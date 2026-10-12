// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Export redacts every string and every object key in a JSON column, whatever
 * shape the column holds. A structured value such as an id or a timestamp comes
 * out unchanged. `installation_metadata` is the one column kept as stored.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashUsername, setRunningUsernameForTests } from "../redaction/anonymizer";
import { exportSessions, openStore } from "../index";

const tmp = mkdtempSync(join(tmpdir(), "lse-export-deny-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const GH = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const ANT = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
const M = "████████";
let n = 0;

/** Exports one codex row whose columns are set to `columns` (each JSON-encoded unless a string is given raw). */
async function exportWith(columns: Record<string, unknown>): Promise<Record<string, unknown>> {
  const restore = setRunningUsernameForTests("alice");
  const store = openStore(join(tmp, `s${++n}.db`));
  try {
    store.upsert({ ideType: "codex", sessionId: "c1", conversation: [], lastMtimeMs: 1, lastSize: 1, lastOffset: 0 });
    for (const [column, value] of Object.entries(columns)) {
      const raw = typeof value === "string" && column.endsWith("!") ? value : JSON.stringify(value);
      store.raw().prepare(`UPDATE conversations SET ${column.replace("!", "")} = ? WHERE session_id = 'c1'`).run(raw);
    }
    const file = join(tmp, `out${n}.jsonl`);
    await exportSessions(store, { format: "jsonl", shape: "row", out: file });
    return JSON.parse(readFileSync(file, "utf8").trim()) as Record<string, unknown>;
  } finally {
    store.close();
    restore();
  }
}

describe("exportSessions — whatever the shape", () => {
  it("redacts an unknown string field on an event, and leaves the event's ids and timestamps readable", async () => {
    const row = await exportWith({ session_events: [{ sequence: 1, kind: "tool", call_id: "call-1", occurred_at: "2026-04-01T10:00:00.000Z", note: GH }] });
    assert.deepEqual(row["session_events"], [{ sequence: 1, kind: "tool", call_id: "call-1", occurred_at: "2026-04-01T10:00:00.000Z", note: M }]);
  });

  it("redacts an unknown string field on a prompt, and keeps role, timestamp and messageId", async () => {
    const row = await exportWith({ conversation: [{ role: "assistant", content: "ok", timestamp: "2026-04-01T10:00:00.000Z", tool_output: ANT, metadata: { messageId: "m1", model: "claude-sonnet-4-6" } }] });
    assert.deepEqual(row["conversation"], [{ role: "assistant", content: "ok", timestamp: "2026-04-01T10:00:00.000Z", tool_output: M, metadata: { messageId: "m1", model: "claude-sonnet-4-6" } }]);
  });

  it("redacts every session_meta kind holding a value of the wrong type", async () => {
    const h = hashUsername("alice");
    const row = await exportWith({
      session_meta: {
        first_prompt: ["DB_PASSWORD=hunter2"],
        session_title: { t: GH },
        project_path: { p: "/Users/alice/app" },
        tracked_file_paths: "/Users/alice/a.ts",
        mcp_server_names: "/Users/alice/mcp",
        bridge_session_url: ["https://bridge.example.com/s/tok"],
        git_branch: { leaked: GH },
        languages: 3,
        source: null,
      },
    });
    const meta = row["session_meta"] as Record<string, unknown>;
    assert.deepEqual(meta["first_prompt"], [M]);
    assert.deepEqual(meta["session_title"], { t: M });
    assert.deepEqual(meta["project_path"], { p: `/Users/${h}/app` });
    assert.equal(meta["tracked_file_paths"], `/Users/${h}/a.ts`);
    assert.equal(meta["mcp_server_names"], `/Users/${h}/mcp`);
    assert.ok(!JSON.stringify(meta["bridge_session_url"]).includes("tok"), JSON.stringify(meta["bridge_session_url"]));
    assert.deepEqual(meta["git_branch"], { leaked: M });
    assert.equal(meta["languages"], 3);
    assert.equal(meta["source"], null);
  });

  it("redacts session_meta stored as a bare string, and keeps a number or null", async () => {
    assert.equal((await exportWith({ session_meta: `note ${GH}` }))["session_meta"], `note ${M}`);
    assert.equal((await exportWith({ session_meta: 7 }))["session_meta"], 7);
    assert.equal((await exportWith({ session_meta: null }))["session_meta"], null);
  });

  it("redacts object keys that hold a path", async () => {
    const h = hashUsername("alice");
    const row = await exportWith({ session_meta: { tool_counts: { "/Users/alice/bin/tool": 2 } }, session_facets: { goal_categories: { "/Users/alice/x": 1 } } });
    assert.deepEqual((row["session_meta"] as Record<string, unknown>)["tool_counts"], { [`/Users/${h}/bin/tool`]: 2 });
    assert.deepEqual((row["session_facets"] as Record<string, unknown>)["goal_categories"], { [`/Users/${h}/x`]: 1 });
  });

  it("fully redacts a stats_cache or ai_attribution value that does not parse", async () => {
    const h = hashUsername("alice");
    const row = await exportWith({ "stats_cache!": `not json ${GH} /Users/alice/x`, "ai_attribution!": `{broken ${ANT}` });
    assert.equal(row["stats_cache"], `not json ${M} /Users/${h}/x`);
    assert.equal(row["ai_attribution"], `{broken ${M}`);
  });

  it("keeps installation_metadata as stored", async () => {
    const row = await exportWith({ installation_metadata: { login_email: "jane@example.com" } });
    assert.deepEqual(row["installation_metadata"], { login_email: "jane@example.com" });
  });
});
