// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Every string and every object key of every exported JSON column, and every other
 * free-text column, is redacted, structured-looking or not. `installation_metadata`
 * is the one JSON column kept as stored.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashUsername, setRunningUsernameForTests } from "../redaction/anonymizer";
import { exportSessions, openStore } from "../index";

const tmp = mkdtempSync(join(tmpdir(), "lse-export-full-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const GHS = "ghs_abcdefghijklmnopqrstuvwxyz0123456789";
const GHP = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const M = "████████";
let n = 0;

async function exportWith(columns: Record<string, unknown>): Promise<{ row: Record<string, unknown>; stored: Record<string, unknown> }> {
  const restore = setRunningUsernameForTests("alice");
  const store = openStore(join(tmp, `s${++n}.db`));
  try {
    store.upsert({ ideType: "codex", sessionId: "c1", conversation: [], lastMtimeMs: 1, lastSize: 1, lastOffset: 0 });
    // A column named with a trailing `!` is set to its string as given, not JSON-encoded.
    for (const [column, value] of Object.entries(columns)) {
      const raw = column.endsWith("!") ? String(value) : JSON.stringify(value);
      store.raw().prepare(`UPDATE conversations SET ${column.replace("!", "")} = ? WHERE session_id = 'c1'`).run(raw);
    }
    const file = join(tmp, `out${n}.jsonl`);
    await exportSessions(store, { format: "jsonl", shape: "row", out: file });
    const stored = store.raw().prepare("SELECT * FROM conversations WHERE session_id = 'c1'").get() as Record<string, unknown>;
    return { row: JSON.parse(readFileSync(file, "utf8").trim()) as Record<string, unknown>, stored };
  } finally {
    store.close();
    restore();
  }
}

describe("exportSessions — every string redacted", () => {
  it("masks a token in a PR reference URL", async () => {
    const { row } = await exportWith({ session_meta: { pr_references: [{ pr_url: `https://bob:${GHS}@github.com/org/app/pull/7?access_token=hunter2hunter2`, pr_number: 7 }] } });
    const text = JSON.stringify(row["session_meta"]);
    assert.ok(!text.includes(GHS) && !text.includes("hunter2"), text);
  });

  it("masks a value whose dotted key looks like a structured path", async () => {
    const { row } = await exportWith({ conversation: [{ role: "user", content: "hi", "metadata.model": `DB_PASSWORD=hunter2 ${GHP}` }] });
    const text = JSON.stringify(row["conversation"]);
    assert.ok(!text.includes(GHP) && !text.includes("hunter2"), text);
  });

  it("masks free text in an event's operation_name and a path in relevantFiles", async () => {
    const { row } = await exportWith({
      session_events: [{ sequence: 1, kind: "SESSION_EVENT_KIND_GOAL", operation_name: `ship it ${GHP}` }],
      conversation: [{ role: "user", content: "hi", metadata: { relevantFiles: ["/Users/alice/app/a.ts"] } }],
    });
    assert.ok(!JSON.stringify(row["session_events"]).includes(GHP));
    assert.deepEqual((row["conversation"] as Array<{ metadata: { relevantFiles: string[] } }>)[0]!.metadata.relevantFiles, [`/Users/${hashUsername("alice")}/app/a.ts`]);
  });

  it("hashes the running user's name in a branch name on export, and keeps the stored value", async () => {
    const { row, stored } = await exportWith({ session_meta: { git_branches: ["alice/fix-login"] } });
    assert.deepEqual((row["session_meta"] as { git_branches: string[] }).git_branches, [`${hashUsername("alice")}/fix-login`]);
    assert.deepEqual((JSON.parse(String(stored["session_meta"])) as { git_branches: string[] }).git_branches, ["alice/fix-login"]);
  });

  it("keeps both entries when two keys redact to the same key", async () => {
    const h = hashUsername("alice");
    const { row } = await exportWith({ session_facets: { goal_categories: { "/Users/alice/x": 1, [`/Users/${h}/x`]: 2 } } });
    assert.deepEqual((row["session_facets"] as { goal_categories: Record<string, number> }).goal_categories, { [`/Users/${h}/x`]: 1, [`/Users/${h}/x #2`]: 2 });
  });

  it("masks the secret, then hashes the name the mask leaves at the end of its segment", async () => {
    // One pass anonymizes first ("aliceTOKEN" is a longer name, left alone) and masks
    // `TOKEN=abc`. The next pass then sees `alice` ending its segment and hashes it.
    const { row } = await exportWith({ session_facets: { note: "/Users/aliceTOKEN=abc" } });
    assert.deepEqual(row["session_facets"], { note: `/Users/${hashUsername("alice")}${M}` });
  });

  it("hashes the name a masked token leaves in a key and in a stats_cache string", async () => {
    const h = hashUsername("alice");
    const path = `/Users/alice${GHP}/x`;
    const { row } = await exportWith({ stats_cache: { [path]: path }, session_facets: { goal_categories: { [path]: 1 } } });
    assert.deepEqual(row["stats_cache"], { [`/Users/${h}${M}/x`]: `/Users/${h}${M}/x` });
    assert.deepEqual(row["session_facets"], { goal_categories: { [`/Users/${h}${M}/x`]: 1 } });
  });

  it("redacts every free-text column, not only the JSON ones", async () => {
    const { row } = await exportWith({
      "repo_name!": "alice/dotfiles",
      "project_path!": `/Users/alice/x/jane@example.com/${GHP}`,
      "event_coverage!": `cov ${GHP}`,
    });
    const text = JSON.stringify(row);
    for (const leak of ["alice", "jane@example.com", GHP]) assert.ok(!text.includes(leak), `${leak} in ${text}`);
  });

  it("keeps a `__proto__` key as an entry, redacted", async () => {
    const { row } = await exportWith({ session_facets: JSON.parse(`{"__proto__":{"note":"${GHP}"},"a":1}`) as unknown });
    assert.equal(JSON.stringify(row["session_facets"]), `{"__proto__":{"note":"${M}"},"a":1}`);
  });

  it("redacts a relation_type that the lineage filled with free text", async () => {
    const restore = setRunningUsernameForTests("alice");
    const store = openStore(join(tmp, `s${++n}.db`));
    try {
      const free = `jane@example.com /Users/alice/x ${GHP}`;
      store.upsert({ ideType: "codex", sessionId: "c1", conversation: [], lastMtimeMs: 1, lastSize: 1, lastOffset: 0, sessionMeta: JSON.stringify({ lineage: { relation_type: free } }) });
      const file = join(tmp, `out${n}.jsonl`);
      await exportSessions(store, { format: "jsonl", shape: "row", out: file });
      const text = readFileSync(file, "utf8");
      for (const leak of ["alice", "jane@example.com", GHP]) assert.ok(!text.includes(leak), `${leak} in ${text}`);
    } finally {
      store.close();
      restore();
    }
  });

  it("redacts free text in content_hash and updated_at, and keeps values of the stored shape", async () => {
    const free = `jane@example.com /Users/alice/x ${GHP}`;
    const { row, stored } = await exportWith({ "content_hash!": free, "updated_at!": free });
    const text = JSON.stringify(row);
    for (const leak of ["alice", "jane@example.com", GHP]) assert.ok(!text.includes(leak), `${leak} in ${text}`);
    for (const column of ["id", "ide_type", "relation_type", "created_at"]) assert.equal(row[column], stored[column], column);
  });

  it("decodes and redacts a column stored as a BLOB, as the same text would be", async () => {
    const free = `/Users/alice/x jane@example.com ${GHP}`;
    const restore = setRunningUsernameForTests("alice");
    const store = openStore(join(tmp, `s${++n}.db`));
    try {
      store.upsert({ ideType: "codex", sessionId: "c1", conversation: [], lastMtimeMs: 1, lastSize: 1, lastOffset: 0 });
      const bytes = (t: string): Uint8Array => new TextEncoder().encode(t);
      store.raw().prepare("UPDATE conversations SET project_path = ?, conversation = ? WHERE session_id = 'c1'")
        .run(bytes(free), bytes(JSON.stringify([{ role: "user", content: free }])));
      const file = join(tmp, `out${n}.jsonl`);
      await exportSessions(store, { format: "jsonl", shape: "row", out: file });
      const text = readFileSync(file, "utf8");
      const row = JSON.parse(text) as Record<string, unknown>;
      assert.equal(typeof row["project_path"], "string");
      assert.ok(Array.isArray(row["conversation"]), text);
      assert.ok(!/"0":\d/.test(text), text);
      for (const leak of ["alice", "jane@example.com", GHP, Buffer.from(GHP).toString("hex"), Buffer.from(GHP).toString("base64")]) {
        assert.ok(!text.includes(leak), `${leak} in ${text}`);
      }
    } finally {
      store.close();
      restore();
    }
  });

  it("keeps installation_metadata as stored", async () => {
    const { row } = await exportWith({ installation_metadata: { login_email: "jane@example.com", note: GHP } });
    assert.deepEqual(row["installation_metadata"], { login_email: "jane@example.com", note: GHP });
  });
});
