// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../../store/SessionStore";
import { conversationId } from "../../internal";
import { extractCodex, parseRolloutContent, classifyCodexLineage } from "../../internal";
import type { SessionLineagePayload } from "../../index";
import { DatabaseSync } from "node:sqlite";

// ESM-compatible __dirname
const __dirname = dirname(fileURLToPath(import.meta.url));

const fixtureDir = join(__dirname, "../../../fixtures/extraction", "codex");

// ── Fixture mode ─────────────────────────────────────────────────────────────

describe("codexExtractor — fixture", () => {
  let tmpDir: string;
  let db: SessionStore;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-codex-smoke-"));
    db = new SessionStore(join(tmpDir, "test.db"));

    // Copy fixture SQLite to tmpDir so we can patch rollout_path without modifying
    // the committed fixture. The fixture has rollout_path=null for portability.
    const srcSqlite = join(fixtureDir, "state_5.sqlite");
    const dstSqlite = join(tmpDir, "state_5.sqlite");
    copyFileSync(srcSqlite, dstSqlite);

    // Patch rollout_path to the committed JSONL fixture using an absolute path.
    // Safe — the copy lives in tmpDir and is cleaned up in after().
    const sqliteDb = new DatabaseSync(dstSqlite);
    sqliteDb
      .prepare("UPDATE threads SET rollout_path = ? WHERE id = ?")
      .run(join(fixtureDir, "rollout-fixture.jsonl"), "thread-fixture-001");
    sqliteDb.close();

    process.env["CODEX_SQLITE_HOME"] = tmpDir;
  });

  after(() => {
    delete process.env["CODEX_SQLITE_HOME"];
    delete process.env["CODEX_HOME"];
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("happy path: does not throw and returns a positive count", async () => {
    const count = await extractCodex(db);
    assert.ok(typeof count === "number", "count must be a number");
    assert.ok(count > 0, "fixture has a thread with rollout JSONL, count must be > 0");
  });

  it("does not throw on missing sqlite path", async () => {
    const savedSqliteHome = process.env["CODEX_SQLITE_HOME"];
    process.env["CODEX_SQLITE_HOME"] = join(tmpDir, "nonexistent");
    process.env["CODEX_HOME"] = join(tmpDir, "nonexistent-home");
    const emptyDb = new SessionStore(join(tmpDir, "empty.db"));
    try {
      const count = await extractCodex(emptyDb);
      assert.equal(count, 0, "should return 0 when SQLite and sessions not found");
    } finally {
      if (savedSqliteHome !== undefined) process.env["CODEX_SQLITE_HOME"] = savedSqliteHome;
      else delete process.env["CODEX_SQLITE_HOME"];
      delete process.env["CODEX_HOME"];
    }
  });

  it("signals: session_meta git_branch from threads table", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { git_branch?: string };
    assert.equal(meta.git_branch, "feat/sort", "git_branch must come from threads.git_branch");
  });

  it("signals: session_meta session_title from threads.title", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { session_title?: string };
    assert.equal(meta.session_title, "Write sort function", "session_title must match threads.title");
  });

  it("signals: session_meta first_prompt from threads.first_user_message", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { first_prompt?: string };
    assert.equal(meta.first_prompt, "Write a sort function", "first_prompt must match threads.first_user_message");
  });

  it("signals: session_meta reasoning_effort, memory_mode, approval_mode, sandbox_policy, uses_extended_thinking", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as {
      reasoning_effort?: string;
      memory_mode?: string;
      approval_mode?: string;
      sandbox_policy?: string;
      uses_extended_thinking?: boolean;
    };
    assert.equal(meta.reasoning_effort, "medium");
    assert.equal(meta.memory_mode, "enabled");
    assert.equal(meta.approval_mode, "suggest");
    assert.equal(meta.sandbox_policy, "sandbox-all");
    assert.equal(meta.uses_extended_thinking, true, "reasoning_effort present → uses_extended_thinking=true");
  });

  it("signals: session_meta source from session_meta JSONL event", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { source?: string };
    assert.equal(meta.source, "cli", "source must be cli from session_meta payload");
  });

  it("signals: session_meta user_interruptions from turn_aborted events", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { user_interruptions?: number };
    assert.equal(meta.user_interruptions, 1, "1 turn_aborted event in JSONL");
  });

  it("signals: session_meta compaction_count from context_compacted events", () => {
    // End-to-end through the extractor's row assembly + serialization (not just
    // parseRolloutContent), so the session_meta assignment and its survival through
    // sanitizeSessionMeta are both exercised.
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { compaction_count?: number };
    assert.equal(meta.compaction_count, 1, "1 context_compacted event in JSONL");
  });

  it("signals: session_meta user_message_count from conversation array", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const messages = JSON.parse(rows[0]!.conversation) as { role: string }[];
    const userCount = messages.filter((m) => m.role === "user").length;
    const asstCount = messages.filter((m) => m.role === "assistant").length;
    assert.equal(userCount, 1, "1 user_message event → 1 user prompt");
    assert.equal(asstCount, 1, "1 task_complete event → 1 assistant prompt");
  });

  it("signals: session_meta uses_mcp and tool_counts from mcp_tool_call_end events", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as {
      tool_counts?: Record<string, number>;
      uses_mcp?: boolean;
    };
    assert.equal(meta.uses_mcp, true, "mcp_tool_call_end present → uses_mcp=true");
    assert.ok(typeof meta.tool_counts === "object" && meta.tool_counts !== null, "tool_counts must be object");
    assert.equal(meta.tool_counts!["github/list_repos"], 1, "github/list_repos must have count 1");
  });

  it("signals: session_meta files_edited from patch_apply_end events", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { files_edited?: string[] };
    assert.ok(Array.isArray(meta.files_edited), "files_edited must be array");
    assert.ok(meta.files_edited!.includes("src/sort.ts"), "must include src/sort.ts");
  });

  it("signals: session_meta tracked_file_paths from exec_command_end read commands", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { tracked_file_paths?: string[] };
    assert.ok(Array.isArray(meta.tracked_file_paths), "tracked_file_paths must be array");
    assert.ok(meta.tracked_file_paths!.some((p) => p.includes("src/sort.ts")), "must include src/sort.ts");
  });

  it("signals: per-prompt model from threads.model override", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const messages = JSON.parse(rows[0]!.conversation) as { role: string; metadata?: { model?: string } }[];
    const asst = messages.find((m) => m.role === "assistant");
    assert.equal(asst?.metadata?.model, "o3", "model must be o3 from threads.model override");
  });

  it("signals: per-prompt inputTokens and outputTokens from token_count event", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const messages = JSON.parse(rows[0]!.conversation) as { role: string; metadata?: { inputTokens?: number; outputTokens?: number } }[];
    const asst = messages.find((m) => m.role === "assistant");
    assert.equal(asst?.metadata?.inputTokens, 20, "inputTokens must be 20");
    assert.equal(asst?.metadata?.outputTokens, 50, "outputTokens must be 50");
  });

  it("signals: session_meta user_message_timestamps from user_message event timestamps", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { user_message_timestamps?: string[] };
    assert.ok(Array.isArray(meta.user_message_timestamps), "user_message_timestamps must be array");
    assert.equal(meta.user_message_timestamps!.length, 1, "1 user_message event → 1 timestamp");
    assert.ok(!isNaN(Date.parse(meta.user_message_timestamps![0]!)), "timestamp must be valid ISO 8601");
    assert.ok(
      meta.user_message_timestamps![0]!.startsWith("2026-04-01"),
      "timestamp must match fixture date 2026-04-01"
    );
  });
});

// ── Mid-turn steering (regression: dropped user message) ───────────────────────

describe("parseRolloutContent — mid-turn steering", () => {
  it("keeps both user messages when a second arrives before task_complete", () => {
    // Codex injects a second user_message into the same in-flight turn when the
    // user presses Enter while it is running. Both must survive — not just the last.
    const jsonl = [
      `{"type":"session_meta","payload":{"id":"t1","cwd":"/x","source":"cli"}}`,
      `{"type":"event_msg","timestamp":"2026-04-01T10:00:00Z","payload":{"type":"user_message","message":"A"}}`,
      `{"type":"event_msg","timestamp":"2026-04-01T10:00:05Z","payload":{"type":"user_message","message":"B"}}`,
      `{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done"}}`,
    ].join("\n");

    const result = parseRolloutContent(jsonl, "t1");
    if (!result) assert.fail("parseRolloutContent returned null");
    const userPrompts = result.prompts
      .filter((p) => p.role === "user")
      .map((p) => p.content);
    assert.deepEqual(userPrompts, ["A", "B"], "both steered user messages kept");
    assert.equal(result.userTurns, 2);
    assert.equal(result.userTimestampsMs.length, 2);
  });
});

describe("parseRolloutContent — a JSON line that is not an object", () => {
  const NOT_OBJECTS = ["null", "42", `"x"`, "[]", "true"];

  it("skips it as it skips a malformed line, and keeps the session", () => {
    const jsonl = [
      `{"type":"session_meta","payload":{"id":"t1","cwd":"/x","source":"cli"}}`,
      ...NOT_OBJECTS,
      `{"type":"event_msg","timestamp":"2026-04-01T10:00:00Z","payload":{"type":"user_message","message":"A"}}`,
      ...NOT_OBJECTS,
      `{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done"}}`,
    ].join("\n");
    const result = parseRolloutContent(jsonl, "t1");
    if (!result) assert.fail("parseRolloutContent returned null");
    assert.deepEqual(result.prompts.map((p) => [p.role, p.content]), [["user", "A"], ["assistant", "done"]]);
  });

  it("reads no session from a first line that is not an object, as from a malformed one", () => {
    for (const first of [...NOT_OBJECTS, "{not json"]) {
      assert.equal(parseRolloutContent(`${first}\n{"type":"event_msg","payload":{"type":"user_message","message":"A"}}`, "t1"), null, first);
    }
  });
});

describe("parseRolloutContent — compaction", () => {
  it("counts each context_compacted for the session scalar and emits no per-turn COMPACTION event", () => {
    // Codex records compaction as a bare event_msg — payload.type "context_compacted",
    // timestamp + type only, no trigger or pre-compaction token detail (shape confirmed
    // against captured ~/.codex/sessions rollouts). It feeds the session-level
    // compaction_count only. It is deliberately NOT emitted as a positional COMPACTION
    // timeline event: Codex emits its prompt reference buffered at turn-end, and the engine
    // advances the current turn on PROMPT_REFERENCE, so a mid-turn boundary would be
    // mis-attributed to the previous turn. Two compactions here pin that the count
    // accumulates rather than sets.
    const jsonl = [
      `{"type":"session_meta","payload":{"id":"t1","cwd":"/x","source":"cli"}}`,
      `{"type":"event_msg","timestamp":"2026-04-01T10:00:00Z","payload":{"type":"task_started"}}`,
      `{"type":"event_msg","timestamp":"2026-04-01T10:00:01Z","payload":{"type":"user_message","message":"go"}}`,
      `{"type":"event_msg","timestamp":"2026-04-01T10:00:20Z","payload":{"type":"context_compacted"}}`,
      `{"type":"event_msg","timestamp":"2026-04-01T10:00:30Z","payload":{"type":"context_compacted"}}`,
      `{"type":"event_msg","timestamp":"2026-04-01T10:01:00Z","payload":{"type":"task_complete","last_agent_message":"done"}}`,
    ].join("\n");

    const result = parseRolloutContent(jsonl, "t1");
    if (!result) assert.fail("parseRolloutContent returned null");
    assert.equal(result.compactionCount, 2, "counts each context_compacted (accumulates, not sets)");
    assert.ok(
      !result.sessionEvents.some((e) => e.kind === "SESSION_EVENT_KIND_COMPACTION"),
      "no positional COMPACTION event for Codex — the engine would mis-attribute a buffered-prompt turn",
    );
  });

  it("leaves compactionCount at 0 when the session never compacts", () => {
    const jsonl = [
      `{"type":"session_meta","payload":{"id":"t1","cwd":"/x","source":"cli"}}`,
      `{"type":"event_msg","timestamp":"2026-04-01T10:00:00Z","payload":{"type":"user_message","message":"go"}}`,
      `{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done"}}`,
    ].join("\n");
    const result = parseRolloutContent(jsonl, "t1");
    if (!result) assert.fail("parseRolloutContent returned null");
    assert.equal(result.compactionCount, 0);
  });
});

describe("parseRolloutContent — per-turn HITL gate", () => {
  it("stamps each turn's approval_policy from its preceding turn_context", () => {
    // Real Codex rollouts emit a `turn_context` (carrying payload.approval_policy) right before
    // each turn's user_message, and re-emit it per turn — so a policy change lands on the turn it
    // precedes. Shape confirmed against captured ~/.codex/sessions rollouts (approval_policy under
    // turn_context.payload; interspersed per turn).
    const jsonl = [
      `{"type":"session_meta","payload":{"id":"t1","cwd":"/x","source":"cli"}}`,
      `{"type":"turn_context","payload":{"turn_id":"1","approval_policy":"on-request"}}`,
      `{"type":"event_msg","timestamp":"2026-04-01T10:00:00Z","payload":{"type":"user_message","message":"first"}}`,
      `{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done-1"}}`,
      `{"type":"turn_context","payload":{"turn_id":"2","approval_policy":"never"}}`,
      `{"type":"event_msg","timestamp":"2026-04-01T10:05:00Z","payload":{"type":"user_message","message":"second"}}`,
      `{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done-2"}}`,
    ].join("\n");

    const result = parseRolloutContent(jsonl, "t1");
    if (!result) assert.fail("parseRolloutContent returned null");
    const userPrompts = result.prompts.filter((p) => p.role === "user");
    assert.equal(userPrompts.length, 2);
    assert.equal(userPrompts[0]?.metadata?.permission_mode, "on-request", "turn 1 carries its own gate");
    assert.equal(userPrompts[1]?.metadata?.permission_mode, "never", "turn 2's policy change lands on turn 2");
  });

  it("leaves permission_mode unset when no turn_context is present", () => {
    const jsonl = [
      `{"type":"session_meta","payload":{"id":"t1","cwd":"/x","source":"cli"}}`,
      `{"type":"event_msg","timestamp":"2026-04-01T10:00:00Z","payload":{"type":"user_message","message":"only"}}`,
      `{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done"}}`,
    ].join("\n");
    const result = parseRolloutContent(jsonl, "t1");
    if (!result) assert.fail("parseRolloutContent returned null");
    const user = result.prompts.find((p) => p.role === "user");
    assert.equal(user?.metadata?.permission_mode, undefined, "no per-turn mode → field absent (consumer forward-fills)");
  });

  it("snapshots the gate at user-message time, so a retry's later turn_context can't contaminate it", () => {
    // The buffered user text survives a second task_started (an abandoned/retried turn). If the gate
    // were read at FLUSH time, a turn_context that arrives during the retry would rewrite it. The
    // snapshot taken when the user_message arrived must win.
    const jsonl = [
      `{"type":"session_meta","payload":{"id":"t1","cwd":"/x","source":"cli"}}`,
      `{"type":"turn_context","payload":{"turn_id":"1","approval_policy":"on-request"}}`,
      `{"type":"event_msg","timestamp":"2026-04-01T10:00:00Z","payload":{"type":"user_message","message":"do it"}}`,
      `{"type":"event_msg","payload":{"type":"task_started"}}`,
      `{"type":"event_msg","payload":{"type":"task_started"}}`,
      `{"type":"turn_context","payload":{"turn_id":"2","approval_policy":"never"}}`,
      `{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done"}}`,
    ].join("\n");
    const result = parseRolloutContent(jsonl, "t1");
    if (!result) assert.fail("parseRolloutContent returned null");
    const user = result.prompts.find((p) => p.role === "user");
    assert.equal(user?.metadata?.permission_mode, "on-request", "flush uses the message-time gate, not the retry's later one");
  });

  it("drops an unknown approval_policy value (allow-list)", () => {
    const jsonl = [
      `{"type":"session_meta","payload":{"id":"t1","cwd":"/x","source":"cli"}}`,
      `{"type":"turn_context","payload":{"turn_id":"1","approval_policy":"yolo-mode"}}`,
      `{"type":"event_msg","timestamp":"2026-04-01T10:00:00Z","payload":{"type":"user_message","message":"go"}}`,
      `{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done"}}`,
    ].join("\n");
    const result = parseRolloutContent(jsonl, "t1");
    if (!result) assert.fail("parseRolloutContent returned null");
    const user = result.prompts.find((p) => p.role === "user");
    assert.equal(user?.metadata?.permission_mode, undefined, "an unvetted vendor string is never stamped");
  });

  it("clears a stale gate when a later turn_context carries an unrecognized policy", () => {
    // Regression: the forward-fill covers turns with NO policy; it must not carry a known gate across
    // a turn whose turn_context explicitly reports a value we can't vet (e.g. a vendor-added policy).
    // Turn 2's real gate is unknowable, so it is unset — never stamped with turn 1's "on-request".
    const jsonl = [
      `{"type":"session_meta","payload":{"id":"t1","cwd":"/x","source":"cli"}}`,
      `{"type":"turn_context","payload":{"turn_id":"1","approval_policy":"on-request"}}`,
      `{"type":"event_msg","timestamp":"2026-04-01T10:00:00Z","payload":{"type":"user_message","message":"first"}}`,
      `{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done-1"}}`,
      `{"type":"turn_context","payload":{"turn_id":"2","approval_policy":"yolo-mode"}}`,
      `{"type":"event_msg","timestamp":"2026-04-01T10:05:00Z","payload":{"type":"user_message","message":"second"}}`,
      `{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done-2"}}`,
    ].join("\n");
    const result = parseRolloutContent(jsonl, "t1");
    if (!result) assert.fail("parseRolloutContent returned null");
    const userPrompts = result.prompts.filter((p) => p.role === "user");
    assert.equal(userPrompts.length, 2);
    assert.equal(userPrompts[0]?.metadata?.permission_mode, "on-request", "turn 1 carries its known gate");
    assert.equal(userPrompts[1]?.metadata?.permission_mode, undefined, "turn 2's unvetted policy clears the gate, not forward-fill turn 1's");
  });
});

// ── Lineage (spawn edge) ─────────────────────────────────────────────────────

describe("classifyCodexLineage", () => {
  const parent = conversationId("codex", "codex-parent-001");

  it("tags a spawn-edge child as SUBAGENT/STRONG", () => {
    const lin = classifyCodexLineage({
      isChildThread: true,
      parentThreadId: "codex-parent-001",
      rawSource: '{"subagent":{"thread_spawn":{"parent_thread_id":"codex-parent-001"}}}',
      originator: "codex_vscode",
      tokens: 500,
    });
    assert.deepEqual(lin, { relation_type: "SUBAGENT", parent_record_key: parent, linkage_confidence: "STRONG", tokens: 500 });
  });

  it("tags a self-declaring {subagent:{other}} source as SUBAGENT/NONE even with no spawn edge (guardian)", () => {
    const lin = classifyCodexLineage({
      isChildThread: false,
      parentThreadId: undefined,
      rawSource: '{"subagent":{"other":"guardian"}}',
      originator: "codex_vscode",
      tokens: 42,
    });
    assert.deepEqual(lin, { relation_type: "SUBAGENT", parent_record_key: undefined, linkage_confidence: "NONE", tokens: 42 });
  });

  // Grounded in real ~/.codex output: auto-review threads carry a STRING-valued subagent
  // key ({"subagent":"review"}), the dominant subagent shape on real machines (the "why"
  // lives on parseCodexSubagentSource).
  it("tags a string-valued {subagent:\"review\"} source as SUBAGENT/NONE (auto-review)", () => {
    const lin = classifyCodexLineage({
      isChildThread: false,
      parentThreadId: undefined,
      rawSource: '{"subagent":"review"}',
      originator: "codex_vscode",
      tokens: 8,
    });
    assert.deepEqual(lin, { relation_type: "SUBAGENT", parent_record_key: undefined, linkage_confidence: "NONE", tokens: 8 });
  });

  // A `subagent` key whose value is neither string nor object (e.g. a bare `false`) is not a
  // subagent marker — it must NOT flip the thread to SUBAGENT. Locks the shape contract so the
  // widened guard can't drift back to presence-only.
  it("keeps a non-string/non-object subagent value ({subagent:false}) as PRIMARY", () => {
    const lin = classifyCodexLineage({
      isChildThread: false,
      parentThreadId: undefined,
      rawSource: '{"subagent":false}',
      originator: "codex_vscode",
      tokens: 3,
    });
    assert.equal(lin, undefined);
  });

  it("tags a nested `codex exec` (originator codex_vscode) as HOOK/NONE", () => {
    const lin = classifyCodexLineage({
      isChildThread: false,
      parentThreadId: undefined,
      rawSource: "exec",
      originator: "codex_vscode",
      tokens: 10,
    });
    assert.deepEqual(lin, { relation_type: "HOOK", linkage_confidence: "NONE", tokens: 10 });
  });

  it("tags a nested `codex exec` fired from a TUI session (originator codex-tui) as HOOK/NONE", () => {
    const lin = classifyCodexLineage({
      isChildThread: false,
      parentThreadId: undefined,
      rawSource: "exec",
      originator: "codex-tui",
      tokens: 7,
    });
    assert.deepEqual(lin, { relation_type: "HOOK", linkage_confidence: "NONE", tokens: 7 });
  });

  it("keeps a bare-terminal `codex exec` (originator codex_exec) as PRIMARY", () => {
    const lin = classifyCodexLineage({
      isChildThread: false,
      parentThreadId: undefined,
      rawSource: "exec",
      originator: "codex_exec",
      tokens: 10,
    });
    assert.equal(lin, undefined);
  });

  it("keeps exec with an unknown/absent originator as PRIMARY (fail-safe)", () => {
    assert.equal(
      classifyCodexLineage({ isChildThread: false, parentThreadId: undefined, rawSource: "exec", originator: undefined, tokens: 1 }),
      undefined
    );
  });

  it("keeps an interactive session (source vscode) as PRIMARY", () => {
    assert.equal(
      classifyCodexLineage({ isChildThread: false, parentThreadId: undefined, rawSource: "vscode", originator: "codex_vscode", tokens: 1 }),
      undefined
    );
  });
});

describe("codexExtractor — lineage", () => {
  let tmpDir: string;
  let db: SessionStore;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-codex-lineage-"));
    db = new SessionStore(join(tmpDir, "test.db"));

    const dstSqlite = join(tmpDir, "state_5.sqlite");
    copyFileSync(join(fixtureDir, "state_5.sqlite"), dstSqlite);

    const sqliteDb = new DatabaseSync(dstSqlite);
    sqliteDb
      .prepare("UPDATE threads SET rollout_path = ? WHERE id = ?")
      .run(join(fixtureDir, "rollout-fixture.jsonl"), "thread-fixture-001");
    // The committed fixture omits thread_spawn_edges; create it and mark the
    // fixture thread as a child spawned by a parent so lineage is exercised.
    sqliteDb.exec(
      "CREATE TABLE IF NOT EXISTS thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT)"
    );
    sqliteDb
      .prepare("INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id) VALUES (?, ?)")
      .run("codex-parent-001", "thread-fixture-001");
    sqliteDb.close();

    process.env["CODEX_SQLITE_HOME"] = tmpDir;
    await extractCodex(db, true); // captureLineage on
  });

  after(() => {
    delete process.env["CODEX_SQLITE_HOME"];
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("tags a spawned child thread with SUBAGENT lineage pointing at its parent", () => {
    const rows = db.getPendingConversations(100);
    const child = rows.find((r) => r.session_id === "thread-fixture-001");
    assert.ok(child?.session_meta, "child thread must carry session_meta");
    const lin = (JSON.parse(child.session_meta) as { lineage?: SessionLineagePayload }).lineage;
    assert.ok(lin, "child must carry lineage");
    assert.equal(lin.relation_type, "SUBAGENT");
    assert.equal(lin.linkage_confidence, "STRONG");
    // parent_record_key must equal the parent's conversationId (same transform).
    assert.equal(lin.parent_record_key, conversationId("codex", "codex-parent-001"));
    assert.equal(lin.tokens, 500);
  });
});

// ── session_title resolution: user rename (threads.name) over AI title ────────
// Grounds the fix against the real state_5.sqlite shape: `name` is the user's
// rename (UPDATE threads SET name=?), `title` is the AI summary. Priority is
// name → title, with a blank-name guard so an empty rename can't shadow the title.

describe("codexExtractor — session_title = name (rename) over title (AI)", () => {
  const dirs: string[] = [];
  const savedSqliteHome = process.env["CODEX_SQLITE_HOME"];
  const savedHome = process.env["CODEX_HOME"];

  after(() => {
    if (savedSqliteHome === undefined) delete process.env["CODEX_SQLITE_HOME"];
    else process.env["CODEX_SQLITE_HOME"] = savedSqliteHome;
    if (savedHome === undefined) delete process.env["CODEX_HOME"];
    else process.env["CODEX_HOME"] = savedHome;
    for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // Build a hermetic ~/.codex with one thread carrying the given title/name, run
  // extractCodex, and return that thread's parsed session_meta.
  async function extractOne(opts: {
    title: string | null;
    name: string | null;
    firstMsg?: string;
    omitNameColumn?: boolean; // simulate an older Codex schema with no `name` column
  }): Promise<Record<string, unknown> | undefined> {
    const dir = mkdtempSync(join(tmpdir(), "lse-codex-title-"));
    dirs.push(dir);
    const id = "thread-title-001";
    const firstMsg = opts.firstMsg ?? "hello world";
    const rollout = join(dir, "rollout.jsonl");
    writeFileSync(
      rollout,
      [
        JSON.stringify({ type: "session_meta", payload: { id, cwd: dir, source: "vscode" } }),
        JSON.stringify({ type: "event_msg", timestamp: "2026-01-01T00:00:00Z", payload: { type: "user_message", message: firstMsg } }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_complete", last_agent_message: "done" } }),
      ].join("\n") + "\n",
    );
    const sdb = new DatabaseSync(join(dir, "state_5.sqlite"));
    // Column set the extractor's SELECT reads (real threads-table columns).
    // omitNameColumn drops `name` entirely to model a pre-rename-feature schema.
    const nameCol = opts.omitNameColumn ? "" : "name TEXT,";
    sdb.exec(
      `CREATE TABLE threads (
         id TEXT, rollout_path TEXT, source TEXT, model TEXT, model_provider TEXT, cwd TEXT,
         git_branch TEXT, title TEXT, ${nameCol} created_at INTEGER, updated_at INTEGER, tokens_used INTEGER,
         git_sha TEXT, git_origin_url TEXT, cli_version TEXT, first_user_message TEXT,
         reasoning_effort TEXT, memory_mode TEXT, approval_mode TEXT, sandbox_policy TEXT)`,
    );
    if (opts.omitNameColumn) {
      sdb
        .prepare(
          `INSERT INTO threads (id, rollout_path, source, cwd, title, created_at, updated_at, tokens_used, first_user_message)
           VALUES (?, ?, 'vscode', ?, ?, 1000, 2000, 0, ?)`,
        )
        .run(id, rollout, dir, opts.title, firstMsg);
    } else {
      sdb
        .prepare(
          `INSERT INTO threads (id, rollout_path, source, cwd, title, name, created_at, updated_at, tokens_used, first_user_message)
           VALUES (?, ?, 'vscode', ?, ?, ?, 1000, 2000, 0, ?)`,
        )
        .run(id, rollout, dir, opts.title, opts.name, firstMsg);
    }
    sdb.close();

    // Pin both the sqlite override and CODEX_HOME so nothing reads the real ~/.codex.
    process.env["CODEX_SQLITE_HOME"] = dir;
    process.env["CODEX_HOME"] = dir;
    const db = new SessionStore(join(dir, "local.db"));
    await extractCodex(db);
    const row = db.getPendingConversations(100).find((r) => r.session_id === id);
    return row?.session_meta ? (JSON.parse(row.session_meta) as Record<string, unknown>) : undefined;
  }

  it("prefers the user rename (name) over the AI title", async () => {
    const meta = await extractOne({ title: "Refactor the sort function", name: "my-sort-fix" });
    assert.equal(meta?.["session_title"], "my-sort-fix");
  });

  it("falls back to the AI title when name is blank", async () => {
    const meta = await extractOne({ title: "Refactor the sort function", name: "   " });
    assert.equal(meta?.["session_title"], "Refactor the sort function");
  });

  it("uses the AI title when name is null (no rename)", async () => {
    const meta = await extractOne({ title: "Refactor the sort function", name: null });
    assert.equal(meta?.["session_title"], "Refactor the sort function");
  });

  // Regression: an older Codex DB predating the `name` column must still extract
  // (title-only), not throw "no such column: name" and halt all Codex extraction.
  it("still extracts (title-only) on an older schema with no name column", async () => {
    const meta = await extractOne({ title: "Refactor the sort function", name: null, omitNameColumn: true });
    assert.ok(meta, "session must still extract when the name column is absent");
    assert.equal(meta?.["session_title"], "Refactor the sort function");
  });

  it("omits session_title when both name and title are absent", async () => {
    const meta = await extractOne({ title: null, name: null });
    assert.equal(meta?.["session_title"], undefined);
  });

  // Leak regression (session_meta is stored unredacted): a secret planted in the
  // rename must be scrubbed by the sanitizeSessionMeta choke point, not shipped raw.
  it("redacts a secret carried in the rename before it reaches session_meta", async () => {
    const meta = await extractOne({
      title: "safe title",
      name: "prod key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
    });
    const serialized = JSON.stringify(meta);
    assert.ok(!serialized.includes("sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345"), "raw key must not appear in session_meta");
    assert.ok(String(meta?.["session_title"]).includes("████████"), "secret must be redacted to ████████");
  });
});
