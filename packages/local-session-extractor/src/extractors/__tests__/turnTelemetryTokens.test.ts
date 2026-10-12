// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseRolloutContent } from "../../internal";
import { parseIdeMessages } from "../../internal";
import { extractClaudeCode } from "../../internal";
import { SessionStore } from "../../store/SessionStore";
import { before, after } from "node:test";
import type { ConversationPrompt } from "../../index";
import { setPathOverrides } from "../pathResolver";

const FIXROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/turn-telemetry");

function kiroLines(caseName: string): string[] {
  const caseDir = join(FIXROOT, "kiro", caseName);
  const sess = readdirSync(caseDir).find((n) => n.startsWith("sess_"))!;
  return readFileSync(join(caseDir, sess, "messages.jsonl"), "utf8").split("\n").filter((l) => l.trim());
}

/**
 * Per-message token/fidelity emission. These pin the emission with a
 * minimal valid rollout whose token_count record uses the VERIFIED real field
 * shapes — info.model_context_window and last_token_usage.{reasoning_output_tokens,
 * total_tokens} (confirmed against the on-disk fixtures), not invented names.
 */

function codexRollout(tokenInfo: Record<string, unknown>): string {
  return [
    { type: "session_meta", payload: { id: "s", timestamp: "2026-07-22T13:33:42.382Z", cwd: "/x", git: { branch: "main" }, model_provider: "openai" } },
    { timestamp: "2026-07-22T14:07:31.903Z", type: "event_msg", payload: { type: "task_started" } },
    { timestamp: "2026-07-22T14:07:33.000Z", type: "event_msg", payload: { type: "user_message", message: "hi" } },
    { timestamp: "2026-07-22T14:07:40.000Z", type: "event_msg", payload: { type: "token_count", info: tokenInfo } },
    { timestamp: "2026-07-22T14:07:41.000Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "done" } },
  ]
    .map((o) => JSON.stringify(o))
    .join("\n");
}

describe("Codex per-message token fields", () => {
  it("re-plumbs reasoning_output_tokens, computes context-percent, and stamps MEASURED", () => {
    const content = codexRollout({
      model_context_window: 258400,
      last_token_usage: { input_tokens: 25817, cached_input_tokens: 6528, output_tokens: 177, reasoning_output_tokens: 56, total_tokens: 25994 },
    });
    const result = parseRolloutContent(content, "t");
    assert.ok(result, "rollout must parse");
    const meta = result.prompts.find((p) => p.role === "assistant")?.metadata;
    assert.ok(meta, "assistant message must carry metadata");
    assert.equal(meta.reasoningTokens, 56, "reasoning_output_tokens → reasoningTokens");
    // Per-message contextUsagePercent is a 0.0-1.0 fraction (conversation.proto
    // PromptMetadata.context_usage_percent). 25994 / 258400 = 0.1006… → rounded to
    // 0.1% granularity = 0.101.
    assert.equal(meta.contextUsagePercent, 0.101, "total_tokens ÷ model_context_window");
    assert.equal(meta.tokenFidelity, "TOKEN_FIDELITY_MEASURED");
    // reasoning is a subset of output — never folded in.
    assert.equal(meta.outputTokens, 177, "output_tokens must not absorb the reasoning bucket");
  });

  it("preserves a reported reasoning_output_tokens of 0 as a measured zero, not absent", () => {
    // reasoningTokens is optional to distinguish an unsupported split (absent) from
    // a measured zero. A vendor that reports 0 must reach the wire as 0, not dropped.
    const content = codexRollout({
      model_context_window: 258400,
      last_token_usage: { input_tokens: 100, output_tokens: 40, reasoning_output_tokens: 0, total_tokens: 140 },
    });
    const meta = parseRolloutContent(content, "t")?.prompts.find((p) => p.role === "assistant")?.metadata;
    assert.ok(meta);
    assert.equal(meta.reasoningTokens, 0, "a reported reasoning zero must be preserved, not treated as unreported");
  });

  it("omits context-percent when the window is absent (no divide), still MEASURED", () => {
    const content = codexRollout({ last_token_usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
    const meta = parseRolloutContent(content, "t")?.prompts.find((p) => p.role === "assistant")?.metadata;
    assert.ok(meta);
    assert.equal(meta.contextUsagePercent, undefined, "no window → no percent");
    assert.equal(meta.tokenFidelity, "TOKEN_FIDELITY_MEASURED");
  });

  it("resets per-turn edit buffers on a new task_started, so an abandoned turn does not bleed into the next", () => {
    // Turn 1 opens and edits abandoned.ts, then a second task_started arrives with
    // no intervening task_complete — turn 1 is abandoned (retried/truncated). Turn 2
    // edits real.ts and completes. The closing assistant message must carry ONLY
    // turn 2's edits, not turn 1's leftover files/lines.
    const lines = [
      { type: "session_meta", payload: { id: "s", timestamp: "2026-07-22T13:33:42.382Z", cwd: "/x", git: { branch: "main" }, model_provider: "openai" } },
      { timestamp: "2026-07-22T14:00:00.000Z", type: "event_msg", payload: { type: "task_started" } },
      { timestamp: "2026-07-22T14:00:01.000Z", type: "event_msg", payload: { type: "patch_apply_end", success: true, changes: { "abandoned.ts": { unified_diff: "@@ -0,0 +1,3 @@\n+a\n+b\n+c\n" } } } },
      { timestamp: "2026-07-22T14:00:02.000Z", type: "event_msg", payload: { type: "task_started" } },
      { timestamp: "2026-07-22T14:00:03.000Z", type: "event_msg", payload: { type: "patch_apply_end", success: true, changes: { "real.ts": { unified_diff: "@@ -0,0 +1,1 @@\n+x\n" } } } },
      { timestamp: "2026-07-22T14:00:04.000Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "turn 2 done" } },
    ].map((o) => JSON.stringify(o)).join("\n");
    const asst = parseRolloutContent(lines, "t")?.prompts.find((p) => p.role === "assistant" && p.content === "turn 2 done");
    assert.ok(asst?.metadata, "turn 2's assistant message must carry metadata");
    assert.deepEqual(asst.metadata.filesEdited, ["real.ts"], "the abandoned turn's file must not bleed into turn 2");
    assert.equal(asst.metadata.linesAdded, 1, "only turn 2's added line, not turn 1's");
  });
});

describe("Kiro per-execution credit/context stamping", () => {
  it("per-turn-credits: stamps native_billing_units + context_usage_percent (0.0-1.0) + ESTIMATE on closing assistant messages", () => {
    const parsed = parseIdeMessages(kiroLines("per-turn-credits"));
    const stamped = parsed.prompts.filter(
      (p) => p.role === "assistant" && (p.metadata?.nativeBillingUnits !== undefined || p.metadata?.contextUsagePercent !== undefined)
    );
    assert.ok(stamped.length > 0, "at least one assistant message must carry credits/context");
    for (const p of stamped) {
      assert.equal(p.metadata!.tokenFidelity, "TOKEN_FIDELITY_ESTIMATE");
      if (p.metadata!.contextUsagePercent !== undefined) {
        // Kiro's native usagePercentage is 0-100, but the per-message wire field is
        // a 0.0-1.0 fraction (conversation.proto), so the extractor divides by 100.
        // Bound at <= 1, not <= 100 — a loose 0-100 bound passes under the old bug too.
        assert.ok(p.metadata!.contextUsagePercent > 0 && p.metadata!.contextUsagePercent <= 1, "context percent is a 0.0-1.0 fraction");
      }
    }
  });

  it("a usage_summary metered at exactly 0 credits stamps a MEASURED zero, not absent", () => {
    // Presence-of-source, not value > 0: the closing assistant message of an
    // execution with a usage_summary present must carry native_billing_units = 0.
    const lines = [
      { id: "1", timestamp: "2026-01-01T00:00:00.000Z", payload: { type: "user", content: "hi" } },
      { id: "2", timestamp: "2026-01-01T00:00:01.000Z", payload: { type: "assistant", content: "ok", executionId: "e1" } },
      { id: "3", timestamp: "2026-01-01T00:00:02.000Z", payload: { type: "usage_summary", executionId: "e1", promptTurnSummaries: [{ usage: 0 }] } },
      { id: "4", timestamp: "2026-01-01T00:00:03.000Z", payload: { type: "turn_end", executionId: "e1", stopReason: "end_turn" } },
    ].map((o) => JSON.stringify(o));
    const parsed = parseIdeMessages(lines);
    const asst = parsed.prompts.find((p) => p.role === "assistant");
    assert.equal(asst?.metadata?.nativeBillingUnits, 0, "a measured-zero credit total must be present, not dropped");
  });

  it("a tool-only turn (no assistant message) keeps its cost at the turn level", () => {
    // An interrupted/tool-only execution has no assistant message to stamp, so
    // there is no per-message row for it — by design. Its cost is not
    // lost: the turn-level turn_usage still carries the credits and context.
    const lines = [
      { id: "u", timestamp: "2026-01-01T00:00:00.000Z", payload: { type: "user", content: "do it" } },
      { id: "ts", timestamp: "2026-01-01T00:00:01.000Z", payload: { type: "turn_start", executionId: "e1" } },
      { id: "tc", timestamp: "2026-01-01T00:00:02.000Z", payload: { type: "tool_call", toolCallId: "k1", toolName: "fs_write", args: { path: "/tmp/x.ts", text: "a\n" }, executionId: "e1" } },
      { id: "tr", timestamp: "2026-01-01T00:00:03.000Z", payload: { type: "tool_result", toolCallId: "k1", success: true, executionId: "e1" } },
      { id: "ctx", timestamp: "2026-01-01T00:00:04.000Z", payload: { type: "session_metadata", key: "contextUsage", value: { usagePercentage: 42 }, executionId: "e1" } },
      { id: "us", timestamp: "2026-01-01T00:00:05.000Z", payload: { type: "usage_summary", executionId: "e1", promptTurnSummaries: [{ usage: 0.5 }] } },
      { id: "te", timestamp: "2026-01-01T00:00:06.000Z", payload: { type: "turn_end", executionId: "e1", stopReason: "cancelled" } },
    ].map((o) => JSON.stringify(o));
    const parsed = parseIdeMessages(lines);
    // No assistant message exists, so nothing carries a per-message stamp — and no crash.
    assert.equal(parsed.prompts.filter((p) => p.role === "assistant").length, 0, "a tool-only turn produces no assistant message");
    assert.ok(!parsed.prompts.some((p) => p.metadata?.nativeBillingUnits !== undefined), "no per-message credit stamp without a message");
    // Turn-level accounting is the authoritative home and must survive.
    assert.equal(parsed.turnUsage.length, 1, "the tool-only turn still records a turn_usage entry");
    assert.equal(parsed.turnUsage[0]!.credits, 0.5, "turn-level credits preserved");
    assert.equal(parsed.turnUsage[0]!.context_usage_percent, 42, "turn-level context (0-100) preserved");
  });
});

// Token fidelity AND edit accounting, both grounded on a REAL captured session
// from the corpus (fixtures/turn-telemetry):
// the compaction fixture carries a genuine Edit toolUseResult (structuredPatch,
// no `type` field — the common real Edit shape), so this is the one edit case
// anchored to captured evidence rather than a hand-authored shape. The other edit
// shapes (Claude Code Write `type:"create"`, Kiro str_replace, Codex
// patch_apply_end with a unified_diff) are exercised by the synthetic describes
// below: each matches real on-disk vendor output (confirmed against live ~/.claude,
// Kiro and ~/.codex sessions), but no committed corpus fixture exercises them.
describe("Claude Code per-message telemetry on a real captured session", () => {
  let tmpDir: string;
  let db: SessionStore;
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-t3-cc-"));
    const projects = join(tmpDir, "projects");
    mkdirSync(join(projects, "proj"), { recursive: true });
    const src = join(FIXROOT, "claude-code", "compaction");
    const jsonl = readdirSync(src).find((n) => n.endsWith(".jsonl"))!;
    writeFileSync(join(projects, "proj", "s.jsonl"), readFileSync(join(src, jsonl), "utf8"));
    setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: projects });
    db = new SessionStore(join(tmpDir, "t.db"));
  });
  after(() => {
    setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  it("stamps MEASURED tokens and attributes the Edit's structuredPatch lines to the issuing turn", () => {
    extractClaudeCode(db);
    const prompts = db
      .getPendingConversations(1000)
      .flatMap((r) => JSON.parse((r as { conversation?: string }).conversation ?? "[]") as ConversationPrompt[]);
    // Token fidelity: a token-bearing message from the capture is MEASURED.
    assert.ok(
      prompts.some((p) => p.metadata?.tokenFidelity === "TOKEN_FIDELITY_MEASURED" && (p.metadata.inputTokens || p.metadata.outputTokens)),
      "a token-bearing Claude Code message must be MEASURED",
    );
    // Edit accounting: the capture's one real Edit lands on the assistant turn that
    // issued it, with the hunk's real +/- counts.
    const editTurns = prompts.filter((p) => p.role === "assistant" && (p.metadata?.filesEdited?.length ?? 0) > 0);
    assert.equal(editTurns.length, 1, "the captured session has exactly one edit-bearing turn");
    const md = editTurns[0]!.metadata!;
    assert.deepEqual(md.filesEdited, ["/Users/example-user/src/example-repo/example/file.txt"], "the real edited file path");
    assert.equal(md.linesAdded, 6, "the captured hunk adds six lines");
    assert.equal(md.linesRemoved, 0, "the captured hunk removes none");
  });
});

describe("Claude Code per-message files_edited + line counts", () => {
  // The edit/write result is a top-level `toolUseResult` on the FOLLOWING user line
  // (grounded on real ~/.claude sessions): an Edit is {type:"update", structuredPatch}
  // whose hunk `lines` are " "/"+"/"-" prefixed; a Write is {type:"create", content}
  // with an empty patch. Verified real shape, not invented.
  let tmpDir: string;
  let db: SessionStore;
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-t3-ccfiles-"));
    const projects = join(tmpDir, "projects");
    mkdirSync(join(projects, "proj"), { recursive: true });
    const lines = [
      { type: "user", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/x", sessionId: "s", message: { role: "user", content: "edit and create" } },
      { type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "editing" }, { type: "tool_use", id: "tu1", name: "Edit" }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "user", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1" }] }, toolUseResult: { type: "update", filePath: "/f.ts", structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [" ctx", "-old", "+new1", "+new2"] }] } },
      { type: "assistant", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "creating" }, { type: "tool_use", id: "tu2", name: "Write" }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "user", timestamp: "2026-01-01T00:00:04.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu2" }] }, toolUseResult: { type: "create", filePath: "/g.ts", content: "x\ny\nz", structuredPatch: [] } },
    ].map((o) => JSON.stringify(o)).join("\n");
    writeFileSync(join(projects, "proj", "s.jsonl"), lines);
    setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: projects });
    db = new SessionStore(join(tmpDir, "t.db"));
  });
  after(() => {
    setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  it("counts an Edit's structuredPatch and a Write's content onto the issuing assistant turns", () => {
    extractClaudeCode(db);
    const rows = db.getPendingConversations(1000);
    const prompts = rows.flatMap((r) => JSON.parse((r as { conversation?: string }).conversation ?? "[]") as ConversationPrompt[]);
    const editTurn = prompts.find((p) => p.role === "assistant" && p.content.includes("editing"));
    assert.deepEqual(editTurn?.metadata?.filesEdited, ["/f.ts"]);
    assert.equal(editTurn?.metadata?.linesAdded, 2, "two + lines");
    assert.equal(editTurn?.metadata?.linesRemoved, 1, "one - line (excl. context)");
    const createTurn = prompts.find((p) => p.role === "assistant" && p.content.includes("creating"));
    assert.deepEqual(createTurn?.metadata?.filesEdited, ["/g.ts"]);
    assert.equal(createTurn?.metadata?.linesAdded, 3, "created content is 3 lines");
    assert.equal(createTurn?.metadata?.linesRemoved ?? 0, 0, "a creation removes nothing");
  });
});

describe("Kiro per-message files_edited + line counts", () => {
  // No committed Kiro fixture contains edit tool_calls, so these pin the per-
  // execution accounting with the SAME field names the extractor reads
  // (str_replace newStr/oldStr, executionId, toolCallId; see the KiroIdeToolCall /
  // KiroIdeToolResult payload interfaces) — grounded in the parser's own contract,
  // not invented. (No corpus fixture covers it; see the real-session describe above.)
  it("stamps filesEdited + gross str_replace line counts on the closing assistant message", () => {
    const lines = [
      { id: "1", timestamp: "2026-01-01T00:00:00.000Z", payload: { type: "user", content: "edit it" } },
      { id: "2", timestamp: "2026-01-01T00:00:01.000Z", payload: { type: "assistant", content: "editing", executionId: "e1" } },
      { id: "3", timestamp: "2026-01-01T00:00:02.000Z", payload: { type: "tool_call", toolName: "str_replace", executionId: "e1", args: { path: "/f.ts", newStr: "a\nb\nc", oldStr: "x" } } },
      { id: "4", timestamp: "2026-01-01T00:00:03.000Z", payload: { type: "usage_summary", executionId: "e1", promptTurnSummaries: [{ usage: 1 }] } },
      { id: "5", timestamp: "2026-01-01T00:00:04.000Z", payload: { type: "turn_end", executionId: "e1", stopReason: "end_turn" } },
    ].map((o) => JSON.stringify(o));
    const asst = parseIdeMessages(lines).prompts.find((p) => p.role === "assistant");
    assert.deepEqual(asst?.metadata?.filesEdited, ["/f.ts"]);
    assert.equal(asst?.metadata?.linesAdded, 3, "newStr has 3 lines");
    assert.equal(asst?.metadata?.linesRemoved, 1, "oldStr has 1 line (gross, not net)");
  });

  it("a str_replace whose tool_result reports success:false contributes no files or lines", () => {
    // An edit's attribution is buffered by toolCallId and committed only once its
    // tool_result confirms it did not fail — a rejected/failed fs_write/str_replace
    // must not inflate the change count. Unlike the case above (no toolCallId, so it
    // commits at once), this call carries a toolCallId and so is gated on its result.
    const lines = [
      { id: "1", timestamp: "2026-01-01T00:00:00.000Z", payload: { type: "user", content: "edit it" } },
      { id: "2", timestamp: "2026-01-01T00:00:01.000Z", payload: { type: "assistant", content: "editing", executionId: "e1" } },
      { id: "3", timestamp: "2026-01-01T00:00:02.000Z", payload: { type: "tool_call", toolCallId: "k1", toolName: "str_replace", executionId: "e1", args: { path: "/f.ts", newStr: "a\nb\nc", oldStr: "x" } } },
      { id: "4", timestamp: "2026-01-01T00:00:03.000Z", payload: { type: "tool_result", toolCallId: "k1", success: false, executionId: "e1" } },
      { id: "5", timestamp: "2026-01-01T00:00:04.000Z", payload: { type: "usage_summary", executionId: "e1", promptTurnSummaries: [{ usage: 1 }] } },
      { id: "6", timestamp: "2026-01-01T00:00:05.000Z", payload: { type: "turn_end", executionId: "e1", stopReason: "end_turn" } },
    ].map((o) => JSON.stringify(o));
    const asst = parseIdeMessages(lines).prompts.find((p) => p.role === "assistant");
    assert.ok(asst, "the turn still produces an assistant message");
    assert.equal(asst.metadata?.filesEdited, undefined, "a failed edit adds no file");
    assert.equal(asst.metadata?.linesAdded ?? 0, 0, "a failed edit adds no lines");
    assert.equal(asst.metadata?.linesRemoved ?? 0, 0, "a failed edit removes no lines");
  });
});

describe("Codex per-message files_edited + line counts", () => {
  // No committed codex fixture carries a patch_apply_end with a unified_diff — the
  // one that has patch_apply_end (fixtures/codex/rollout-fixture.jsonl) records an
  // empty change ({}), so it exercises file collection but not line counting. These
  // pin the counting with the VERIFIED real shape (changes[file] = {type,
  // unified_diff, move_path}), confirmed against real ~/.codex sessions. (Corpus-
  // fixture; see the real-session describe above.)
  it("counts unified_diff +/- and collects the changed files on the turn's assistant message", () => {
    const diff = "@@ -1,2 +1,3 @@\n-old line\n+new line 1\n+new line 2\n context";
    const content = [
      { type: "session_meta", payload: { id: "s", timestamp: "2026-07-22T13:33:42.382Z", cwd: "/x", git: { branch: "main" }, model_provider: "openai" } },
      { timestamp: "2026-07-22T14:07:31.903Z", type: "event_msg", payload: { type: "task_started" } },
      { timestamp: "2026-07-22T14:07:33.000Z", type: "event_msg", payload: { type: "user_message", message: "hi" } },
      { timestamp: "2026-07-22T14:07:39.000Z", type: "event_msg", payload: { type: "patch_apply_end", success: true, changes: { "/f.ts": { type: "update", unified_diff: diff, move_path: null } } } },
      { timestamp: "2026-07-22T14:07:41.000Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "done" } },
    ].map((o) => JSON.stringify(o)).join("\n");
    const meta = parseRolloutContent(content, "t")?.prompts.find((p) => p.role === "assistant")?.metadata;
    assert.deepEqual(meta?.filesEdited, ["/f.ts"]);
    assert.equal(meta?.linesAdded, 2, "two + lines (excluding the +++ header)");
    assert.equal(meta?.linesRemoved, 1, "one - line");
  });

  it("a failed patch_apply_end contributes no files or lines", () => {
    const content = [
      { type: "session_meta", payload: { id: "s", timestamp: "2026-07-22T13:33:42.382Z", cwd: "/x", git: { branch: "main" }, model_provider: "openai" } },
      { timestamp: "2026-07-22T14:07:31.903Z", type: "event_msg", payload: { type: "task_started" } },
      { timestamp: "2026-07-22T14:07:33.000Z", type: "event_msg", payload: { type: "user_message", message: "hi" } },
      { timestamp: "2026-07-22T14:07:39.000Z", type: "event_msg", payload: { type: "patch_apply_end", success: false, changes: { "/f.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n+b" } } } },
      { timestamp: "2026-07-22T14:07:41.000Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: "done" } },
    ].map((o) => JSON.stringify(o)).join("\n");
    const meta = parseRolloutContent(content, "t")?.prompts.find((p) => p.role === "assistant")?.metadata;
    assert.equal(meta?.filesEdited, undefined, "a failed apply edits nothing");
  });
});
