// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, copyFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../../store/SessionStore";
import { extractCursor, formatToolCall, mentionKeyToFileUri, resolveCursorReportedCostUsd, applyContextMeterTokenFallback, applyTokenCount, recoverModelFromUsageData, applyIdeTokenEstimationFallback, isCursorToolPlaceholderContent, estimateTextTokens, fixedContextOverhead, conversationTokenBudget, contextCompositionFromBreakdown, promptsHaveBillableTokens, resolveContextMeterTokens, shouldForceCursorReextract, buildChildToParentFromAgentTranscripts, parentComposerIdFromSubagentInfo } from "../../internal";
import { mergeStopHookTokens } from "../../internal";
import { detectCursorCliTier } from "../../internal";
import { conversationId } from "../../internal";
import type { ConversationPrompt, PromptMetadata } from "../../index";
import { DatabaseSync } from "node:sqlite";
import { setPathOverrides } from "../pathResolver";
import { userInfo } from "node:os";

// ESM-compatible __dirname
const __dirname = dirname(fileURLToPath(import.meta.url));

const fixtureDb = join(__dirname, "../../../fixtures/extraction", "cursor", "state_happy.vscdb");

// ── Unit tests: formatToolCall ────────────────────────────────────────────────

// Tests cover only formatToolCall — the tool-synopsis helper. The rest of the
// extractor (loadBubbles, processComposer) is driven by the Cursor SQLite DB
// and is covered by end-to-end verification against a real state.vscdb.

describe("formatToolCall", () => {
  it("emits target_file for edit_file and harvests it into files", () => {
    const result = formatToolCall({
      name: "edit_file",
      status: "completed",
      rawArgs: JSON.stringify({ target_file: "src/auth/session.test.ts" }),
    });
    assert.equal(
      result.content,
      "[Tool: edit_file target_file=src/auth/session.test.ts]"
    );
    assert.deepEqual(result.files, ["src/auth/session.test.ts"]);
  });

  it("emits query for grep_search without files", () => {
    const result = formatToolCall({
      name: "grep_search",
      status: "completed",
      rawArgs: JSON.stringify({ query: "getLoginUrl" }),
    });
    assert.equal(result.content, "[Tool: grep_search query=getLoginUrl]");
    assert.deepEqual(result.files, []);
  });

  it("omits status suffix when status is completed", () => {
    const result = formatToolCall({
      name: "codebase_search",
      status: "completed",
      rawArgs: JSON.stringify({ query: "foo" }),
    });
    assert.ok(!result.content.includes("status="));
  });

  it("adds status=cancelled for user-interrupted tool calls", () => {
    const result = formatToolCall({
      name: "edit_file",
      status: "cancelled",
      rawArgs: JSON.stringify({ target_file: "foo.go" }),
    });
    assert.equal(
      result.content,
      "[Tool: edit_file target_file=foo.go status=cancelled]"
    );
    // File harvested even when cancelled — the user may have reviewed the diff.
    assert.deepEqual(result.files, ["foo.go"]);
  });

  it("adds status=error for failed tool calls", () => {
    // `error` is Cursor's spelling; `errored` occurs zero times on a real store. The placeholder
    // echoes whatever status arrives, so a fictional value would pass just as happily.
    const result = formatToolCall({
      name: "run_terminal_cmd",
      status: "error",
      rawArgs: JSON.stringify({ command: "ls /nonexistent" }),
    });
    assert.equal(result.content, "[Tool: run_terminal_cmd command=ls /nonexistent status=error]");
  });

  it("truncates long arg values with an ellipsis", () => {
    const longCommand = "a".repeat(200);
    const result = formatToolCall({
      name: "run_terminal_cmd",
      status: "completed",
      rawArgs: JSON.stringify({ command: longCommand }),
    });
    assert.ok(result.content.endsWith("…]"));
    // 160-char cap plus "…"
    assert.ok(result.content.includes("command=" + "a".repeat(160) + "…"));
  });

  it("returns bare placeholder for unknown tools", () => {
    const result = formatToolCall({
      name: "some_new_tool",
      status: "completed",
      rawArgs: JSON.stringify({ foo: "bar" }),
    });
    assert.equal(result.content, "[Tool: some_new_tool]");
    assert.deepEqual(result.files, []);
  });

  it("tolerates malformed rawArgs without crashing", () => {
    const result = formatToolCall({
      name: "edit_file",
      status: "completed",
      rawArgs: "{not valid json",
    });
    // Falls back to bare placeholder — no args preview, no file.
    assert.equal(result.content, "[Tool: edit_file]");
    assert.deepEqual(result.files, []);
  });

  it("tolerates missing rawArgs", () => {
    const result = formatToolCall({ name: "list_dir", status: "completed" });
    assert.equal(result.content, "[Tool: list_dir]");
    assert.deepEqual(result.files, []);
  });

  it("falls back to 'unknown' when name is missing", () => {
    const result = formatToolCall({ status: "completed" });
    assert.equal(result.content, "[Tool: unknown]");
  });

  it("falls back to 'unknown' when name is empty string", () => {
    const result = formatToolCall({ name: "", status: "completed" });
    assert.equal(result.content, "[Tool: unknown]");
  });

  it("ignores non-string arg values", () => {
    const result = formatToolCall({
      name: "edit_file",
      status: "completed",
      // target_file is supposed to be a string; guard against upstream shape drift.
      rawArgs: JSON.stringify({ target_file: 42 }),
    });
    assert.equal(result.content, "[Tool: edit_file]");
    assert.deepEqual(result.files, []);
  });

  it("ignores arrays at the top level of rawArgs", () => {
    const result = formatToolCall({
      name: "edit_file",
      status: "completed",
      rawArgs: JSON.stringify(["target_file", "foo.go"]),
    });
    assert.equal(result.content, "[Tool: edit_file]");
    assert.deepEqual(result.files, []);
  });

  // Cursor versions its tools (read_file → read_file_v2, edit_file →
  // search_replace / write / MultiEdit). The file path moved to the `path` /
  // `file_path` arg key. Harvest by arg name, not tool name.
  it("harvests `path` arg from read_file_v2 (absolute path)", () => {
    const abs = "/Users/dev/src/example-repo/pkg/audit.go";
    const result = formatToolCall({
      name: "read_file_v2",
      status: "completed",
      rawArgs: JSON.stringify({ path: abs }),
    });
    assert.deepEqual(result.files, [abs]);
  });

  it("harvests `file_path` arg from search_replace", () => {
    const result = formatToolCall({
      name: "search_replace",
      status: "completed",
      rawArgs: JSON.stringify({
        file_path: "/repo/main.go",
        old_string: "a",
        new_string: "b",
      }),
    });
    // Only the file path is harvested — not old_string/new_string code content.
    assert.deepEqual(result.files, ["/repo/main.go"]);
  });

  it("harvests `file_path` from write tool", () => {
    const result = formatToolCall({
      name: "write",
      status: "completed",
      rawArgs: JSON.stringify({ file_path: "/repo/new.ts", contents: "x" }),
    });
    assert.deepEqual(result.files, ["/repo/new.ts"]);
  });
});

// ── Unit tests: mentionKeyToFileUri ───────────────────────────────────────────

describe("mentionKeyToFileUri", () => {
  it("returns the key directly when it is a bare file:/// URI (newer Cursor)", () => {
    const uri = "file:///Users/dev/repo/consumer/audit.go";
    assert.equal(mentionKeyToFileUri(uri), uri);
  });

  it("extracts the uri field from a JSON-string key (older Cursor)", () => {
    const key = JSON.stringify({ uri: "file:///Users/dev/repo/main.go", line: 1 });
    assert.equal(mentionKeyToFileUri(key), "file:///Users/dev/repo/main.go");
  });

  it("returns undefined for keys with no file URI", () => {
    assert.equal(mentionKeyToFileUri('{"terminal":"zsh"}'), undefined);
    assert.equal(mentionKeyToFileUri("not-a-uri"), undefined);
  });
});

// ── Unit tests: resolveCursorReportedCostUsd ──────────────────────────────────

describe("resolveCursorReportedCostUsd", () => {
  it("reads Auto-routed cost from the default bucket", () => {
    assert.equal(
      resolveCursorReportedCostUsd({ default: { costInCents: 56 } }),
      0.56
    );
  });

  it("reads explicit model buckets (e.g. composer-2.5), not only default", () => {
    assert.equal(
      resolveCursorReportedCostUsd({ "composer-2.5": { costInCents: 42 } }),
      0.42
    );
  });

  it("prefers default over per-model buckets to avoid double-counting", () => {
    assert.equal(
      resolveCursorReportedCostUsd({
        default: { costInCents: 186 },
        "claude-sonnet-4-6": { costInCents: 98 },
      }),
      1.86
    );
  });

  it("sums per-model buckets only when default is absent (mixed session)", () => {
    assert.equal(
      resolveCursorReportedCostUsd({
        "composer-2.5": { costInCents: 30 },
        "claude-sonnet-4-6": { costInCents: 26 },
      }),
      0.56
    );
  });

  it("sums all per-model buckets when default is absent, whichever model the session names", () => {
    assert.equal(
      resolveCursorReportedCostUsd({
        "composer-2.5": { costInCents: 30 },
        "claude-sonnet-4-6": { costInCents: 26 },
      }),
      0.56
    );
  });

  it("returns undefined when usageData is absent or all costs are zero", () => {
    assert.equal(resolveCursorReportedCostUsd(undefined), undefined);
    assert.equal(resolveCursorReportedCostUsd({}), undefined);
    assert.equal(resolveCursorReportedCostUsd({ default: { costInCents: 0 } }), undefined);
  });
});

describe("applyContextMeterTokenFallback", () => {
  it("sets inputTokens on the last assistant when bubbles have no tokens", () => {
    const prompts: ConversationPrompt[] = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    applyContextMeterTokenFallback(
      prompts,
      { composerId: "c1", createdAt: 1, lastUpdatedAt: 2, name: "t", contextTokensUsed: 120_000, fullConversationHeadersOnly: [] },
      "composer-2.5"
    );
    assert.equal(prompts[1]?.metadata?.inputTokens, 120_000);
    assert.equal(prompts[1]?.metadata?.model, "composer-2.5");
    assert.equal(promptsHaveBillableTokens(prompts), true);
  });

  it("does not override when bubbles already carry token counts", () => {
    const prompts: ConversationPrompt[] = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello", metadata: { inputTokens: 50, outputTokens: 90 } },
    ];
    applyContextMeterTokenFallback(
      prompts,
      { composerId: "c1", createdAt: 1, lastUpdatedAt: 2, name: "t", contextTokensUsed: 120_000, fullConversationHeadersOnly: [] },
      "composer-2.5"
    );
    assert.equal(prompts[1]?.metadata?.inputTokens, 50);
  });

  it("prefers promptTokenBreakdown.totalUsedTokens over contextTokensUsed", () => {
    assert.equal(
      resolveContextMeterTokens({
        composerId: "c1",
        createdAt: 1,
        lastUpdatedAt: 2,
        name: "t",
        contextTokensUsed: 80_000,
        promptTokenBreakdown: { totalUsedTokens: 150_000 },
        fullConversationHeadersOnly: [],
      }),
      150_000
    );
  });

  it("anchors the meter on the last non-tool assistant turn", () => {
    const prompts: ConversationPrompt[] = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
      { role: "assistant" as const, content: "[Tool: read_file_v2 path=/foo.ts]" },
    ];
    applyContextMeterTokenFallback(
      prompts,
      { composerId: "c1", createdAt: 1, lastUpdatedAt: 2, name: "t", contextTokensUsed: 120_000, fullConversationHeadersOnly: [] },
      "composer-2.5"
    );
    assert.equal(prompts[1]?.metadata?.inputTokens, 120_000);
    assert.equal(prompts[2]?.metadata?.inputTokens, undefined);
  });

  it("falls back to a tool-only placeholder carrier when no real assistant turn exists", () => {
    const prompts: ConversationPrompt[] = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "[Tool: read_file_v2 path=/foo.ts]" },
      { role: "assistant" as const, content: "[Tool: edit_file path=/bar.ts]" },
    ];
    applyContextMeterTokenFallback(
      prompts,
      { composerId: "c1", createdAt: 1, lastUpdatedAt: 2, name: "t", contextTokensUsed: 120_000, fullConversationHeadersOnly: [] },
      "composer-2.5"
    );
    assert.equal(prompts[2]?.metadata?.inputTokens, 120_000, "input meter credited to last tool turn");
    assert.equal(prompts[2]?.metadata?.model, "composer-2.5");
    assert.equal(prompts[2]?.metadata?.outputTokens, undefined, "no synthesized output on placeholder");
    assert.equal(promptsHaveBillableTokens(prompts), true);
  });

  it("stamps NATIVE_PARTIAL fidelity on the meter-credited turn (native context total, no output split)", () => {
    const prompts: ConversationPrompt[] = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    applyContextMeterTokenFallback(
      prompts,
      { composerId: "c1", createdAt: 1, lastUpdatedAt: 2, name: "t", contextTokensUsed: 120_000, fullConversationHeadersOnly: [] },
      "composer-2.5"
    );
    assert.equal(prompts[1]?.metadata?.tokenFidelity, "TOKEN_FIDELITY_NATIVE_PARTIAL");
  });
});

describe("applyIdeTokenEstimationFallback", () => {
  const breakdownComposer = {
    composerId: "c1",
    createdAt: 1,
    lastUpdatedAt: 2,
    name: "t",
    promptTokenBreakdown: {
      totalUsedTokens: 100_000,
      categories: [
        { id: "tools", estimatedTokens: 10_000 },
        { id: "rules", estimatedTokens: 5_000 },
        { id: "conversation", estimatedTokens: 85_000 },
      ],
    },
    fullConversationHeadersOnly: [],
  };

  it("assigns per-turn input/output from text and breakdown overhead", () => {
    const prompts: ConversationPrompt[] = [
      { role: "user" as const, content: "aaaa" }, // 1 token
      { role: "assistant" as const, content: "bbbbbbbb" }, // 2 out
      { role: "user" as const, content: "cccccccc" }, // 2 tokens
      { role: "assistant" as const, content: "dd" }, // 1 out
    ];
    applyIdeTokenEstimationFallback(prompts, breakdownComposer, "composer-2.5");
    assert.equal(prompts[1]?.metadata?.outputTokens, 2);
    assert.equal(
      prompts[1]?.metadata?.inputTokens,
      15_000 + Math.round(85_000 * (1 / 6))
    );
    assert.equal(prompts[3]?.metadata?.outputTokens, 1);
    assert.equal(prompts[3]?.metadata?.inputTokens, 100_000, "last turn anchored to meter peak");
  });

  it("does not override real bubble token counts", () => {
    const prompts: ConversationPrompt[] = [
      { role: "user" as const, content: "hi" },
      {
        role: "assistant" as const,
        content: "hello",
        metadata: { inputTokens: 50, outputTokens: 90 },
      },
    ];
    applyIdeTokenEstimationFallback(prompts, breakdownComposer, "composer-2.5");
    assert.equal(prompts[1]?.metadata?.inputTokens, 50);
    assert.equal(prompts[1]?.metadata?.outputTokens, 90);
  });

  it("maps promptTokenBreakdown categories to context composition", () => {
    const comp = contextCompositionFromBreakdown(breakdownComposer);
    assert.equal(comp.length, 3);
    assert.equal(comp[0]?.segment, "tools");
    assert.equal(comp[0]?.tokens, 10_000);
  });

  it("skips [Tool: …] placeholder turns when synthesizing tokens", () => {
    const prompts: ConversationPrompt[] = [
      { role: "user" as const, content: "aaaa" },
      {
        role: "assistant" as const,
        content: "[Tool: read_file_v2 path=/foo.ts]",
      },
      { role: "assistant" as const, content: "bbbbbbbb" },
    ];
    applyIdeTokenEstimationFallback(prompts, breakdownComposer, "composer-2.5");
    assert.equal(prompts[1]?.metadata?.inputTokens, undefined);
    assert.equal(prompts[1]?.metadata?.outputTokens, undefined);
    assert.equal(prompts[2]?.metadata?.outputTokens, 2);
    assert.equal(prompts[2]?.metadata?.inputTokens, 100_000);
  });

  it("stamps ESTIMATE fidelity on every synthesized turn, but not on skipped placeholders", () => {
    const prompts: ConversationPrompt[] = [
      { role: "user" as const, content: "aaaa" },
      { role: "assistant" as const, content: "bbbbbbbb" },
      { role: "assistant" as const, content: "[Tool: read_file_v2 path=/foo.ts]" },
      { role: "user" as const, content: "cccccccc" },
      { role: "assistant" as const, content: "dd" },
    ];
    applyIdeTokenEstimationFallback(prompts, breakdownComposer, "composer-2.5");
    assert.equal(prompts[1]?.metadata?.tokenFidelity, "TOKEN_FIDELITY_ESTIMATE");
    assert.equal(prompts[4]?.metadata?.tokenFidelity, "TOKEN_FIDELITY_ESTIMATE");
    // A tool-only placeholder is skipped for synthesis, so it carries no fidelity stamp.
    assert.equal(prompts[2]?.metadata?.tokenFidelity, undefined);
  });

  it("does not stamp ESTIMATE over a turn that already carries bubble token counts", () => {
    const prompts: ConversationPrompt[] = [
      { role: "user" as const, content: "hi" },
      {
        role: "assistant" as const,
        content: "hello",
        metadata: { inputTokens: 50, outputTokens: 90 },
      },
    ];
    applyIdeTokenEstimationFallback(prompts, breakdownComposer, "composer-2.5");
    // Estimation early-returns on billable tokens, so it neither overwrites the
    // counts nor stamps a fidelity — the pre-existing tier (here none) is left as-is.
    assert.equal(prompts[1]?.metadata?.tokenFidelity, undefined);
  });

  it("stamps NATIVE_PARTIAL on a turn credited only by the meter-peak anchor (no output)", () => {
    // Empty content → the per-turn loop synthesizes nothing (output=0, no overhead),
    // so only the meter-peak backward scan credits inputTokens. The turn's only count
    // is the native context meter with no output → NATIVE_PARTIAL, not an estimate.
    const prompts: ConversationPrompt[] = [
      { role: "user" as const, content: "" },
      { role: "assistant" as const, content: "" },
    ];
    applyIdeTokenEstimationFallback(
      prompts,
      { composerId: "c1", createdAt: 1, lastUpdatedAt: 2, name: "t", contextTokensUsed: 120_000, fullConversationHeadersOnly: [] },
      "composer-2.5"
    );
    assert.equal(prompts[1]?.metadata?.inputTokens, 120_000);
    assert.equal(prompts[1]?.metadata?.outputTokens, undefined);
    assert.equal(prompts[1]?.metadata?.tokenFidelity, "TOKEN_FIDELITY_NATIVE_PARTIAL");
  });

  it("keeps ESTIMATE when the meter-peak anchor lands on a turn that also has an estimated output", () => {
    // A turn with assistant text gets a text-estimated output from the per-turn loop,
    // then the meter-peak anchor overrides its input. The flat per-turn tier takes the
    // weaker source so the estimated output is never trusted as native → ESTIMATE.
    const prompts: ConversationPrompt[] = [
      { role: "user" as const, content: "aaaa" },
      { role: "assistant" as const, content: "bbbbbbbb" },
    ];
    applyIdeTokenEstimationFallback(
      prompts,
      { composerId: "c1", createdAt: 1, lastUpdatedAt: 2, name: "t", contextTokensUsed: 120_000, fullConversationHeadersOnly: [] },
      "composer-2.5"
    );
    assert.equal(prompts[1]?.metadata?.inputTokens, 120_000, "input anchored to the meter peak");
    assert.ok((prompts[1]?.metadata?.outputTokens ?? 0) > 0, "carries a text-estimated output");
    assert.equal(prompts[1]?.metadata?.tokenFidelity, "TOKEN_FIDELITY_ESTIMATE");
  });
});

describe("applyTokenCount — billable-path fidelity choke point", () => {
  it("stamps NATIVE_PARTIAL when a bubble carries an input-only native count", () => {
    const metadata: PromptMetadata = {};
    applyTokenCount(metadata, { inputTokens: 31_745, outputTokens: 0 });
    assert.equal(metadata.inputTokens, 31_745);
    assert.equal(metadata.outputTokens, undefined, "no output split → output stays absent");
    assert.equal(metadata.tokenFidelity, "TOKEN_FIDELITY_NATIVE_PARTIAL");
  });

  it("leaves a {0,0} bubble unstamped (no measured-zero from an absent count)", () => {
    const metadata: PromptMetadata = {};
    applyTokenCount(metadata, { inputTokens: 0, outputTokens: 0 });
    assert.equal(metadata.inputTokens, undefined);
    assert.equal(metadata.tokenFidelity, undefined);
  });

  it("does not clobber an already-stamped stronger tier on a second application", () => {
    // The choke-point guard is what lets any future caller reuse this on a
    // partly-processed turn without downgrading a MEASURED (or any) prior tier.
    const metadata: PromptMetadata = { tokenFidelity: "TOKEN_FIDELITY_MEASURED" };
    applyTokenCount(metadata, { inputTokens: 500, outputTokens: 0 });
    assert.equal(metadata.inputTokens, 500, "counts still applied");
    assert.equal(metadata.tokenFidelity, "TOKEN_FIDELITY_MEASURED", "existing tier preserved");
  });
});

describe("stop-hook MEASURED upgrade over the NATIVE_PARTIAL baseline", () => {
  const gen = (over: Partial<import("../../internal").MeasuredGeneration>) => ({
    generationId: "gen-1",
    inputTokens: 100,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  });

  it("upgrades an id-matched billable turn from NATIVE_PARTIAL to MEASURED", () => {
    const prompts: ConversationPrompt[] = [
      { role: "user" as const, content: "hi" },
      {
        role: "assistant" as const,
        content: "hello",
        metadata: { messageId: "gen-1", inputTokens: 31_745, tokenFidelity: "TOKEN_FIDELITY_NATIVE_PARTIAL" },
      },
    ];
    const merged = mergeStopHookTokens(prompts, [gen({ model: "composer-2.5" })]);
    assert.equal(merged[1]?.metadata?.tokenFidelity, "TOKEN_FIDELITY_MEASURED", "exact-id match wins over the baseline");
    assert.equal(merged[1]?.metadata?.inputTokens, 100);
    assert.equal(merged[1]?.metadata?.outputTokens, 200);
  });

  it("leaves an unmatched billable turn at NATIVE_PARTIAL", () => {
    const prompts: ConversationPrompt[] = [
      { role: "user" as const, content: "hi" },
      {
        role: "assistant" as const,
        content: "hello",
        metadata: { messageId: "gen-1", inputTokens: 31_745, tokenFidelity: "TOKEN_FIDELITY_NATIVE_PARTIAL" },
      },
    ];
    const merged = mergeStopHookTokens(prompts, [gen({ generationId: "gen-OTHER" })]);
    assert.equal(merged[1]?.metadata?.tokenFidelity, "TOKEN_FIDELITY_NATIVE_PARTIAL", "no ledger match → baseline stays");
    assert.equal(merged[1]?.metadata?.inputTokens, 31_745);
  });
});

describe("isCursorToolPlaceholderContent", () => {
  it("detects loadBubbles tool placeholders", () => {
    assert.equal(isCursorToolPlaceholderContent("[Tool: edit_file]"), true);
    assert.equal(isCursorToolPlaceholderContent("  [Tool: grep]"), true);
    assert.equal(isCursorToolPlaceholderContent("Here is the fix"), false);
  });
});

describe("estimateTextTokens / overhead helpers", () => {
  it("estimateTextTokens uses ceil(len/4)", () => {
    assert.equal(estimateTextTokens(""), 0);
    assert.equal(estimateTextTokens("abcd"), 1);
    assert.equal(estimateTextTokens("abcde"), 2);
  });

  it("fixedContextOverhead sums non-conversation categories", () => {
    assert.equal(
      fixedContextOverhead({
        composerId: "c",
        createdAt: 0,
        lastUpdatedAt: 1,
        name: "n",
        promptTokenBreakdown: {
          categories: [
            { id: "tools", estimatedTokens: 100 },
            { id: "conversation", estimatedTokens: 900 },
          ],
        },
        fullConversationHeadersOnly: [],
      }),
      100
    );
  });

  it("conversationTokenBudget prefers conversation category", () => {
    const composer = {
      composerId: "c",
      createdAt: 0,
      lastUpdatedAt: 1,
      name: "n",
      promptTokenBreakdown: {
        totalUsedTokens: 1000,
        categories: [{ id: "conversation", estimatedTokens: 700 }],
      },
      fullConversationHeadersOnly: [],
    };
    assert.equal(conversationTokenBudget(composer, 200), 700);
  });

  it("conversationTokenBudget sums conversation and summarized_conversation buckets", () => {
    const composer = {
      composerId: "c",
      createdAt: 0,
      lastUpdatedAt: 1,
      name: "n",
      promptTokenBreakdown: {
        totalUsedTokens: 1000,
        categories: [
          { id: "conversation", estimatedTokens: 700 },
          { id: "summarized_conversation", estimatedTokens: 250 },
        ],
      },
      fullConversationHeadersOnly: [],
    };
    assert.equal(conversationTokenBudget(composer, 200), 950);
  });
});

// ── Unit tests: shouldForceCursorReextract ────────────────────────────────────
//
// The forced-re-read gate that catches Cursor's post-completion token backfill:
// re-read a recently-active composer even when lastUpdatedAt is unchanged, but only
// within the settle window, before tokens land, and no more than once per throttle.

describe("shouldForceCursorReextract", () => {
  const NOW = 1_800_000_000_000; // fixed clock for determinism
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;

  it("forces a re-read for a young, zero-token composer past the throttle", () => {
    assert.equal(
      shouldForceCursorReextract(
        { last_reextract_at: NOW - 10 * HOUR, tokens_observed: 0 },
        NOW - HOUR, // active 1h ago → well within settle window
        NOW
      ),
      true
    );
  });

  it("stops once nonzero tokens have been observed (terminal)", () => {
    assert.equal(
      shouldForceCursorReextract(
        { last_reextract_at: NOW - 10 * HOUR, tokens_observed: 1 },
        NOW - HOUR,
        NOW
      ),
      false
    );
  });

  it("does not re-read a composer quiescent past the settle window", () => {
    assert.equal(
      shouldForceCursorReextract(
        { last_reextract_at: 0, tokens_observed: 0 },
        NOW - 4 * DAY, // last active 4 days ago → past the 3-day window
        NOW
      ),
      false
    );
  });

  it("throttles: no second forced re-read within the throttle interval", () => {
    assert.equal(
      shouldForceCursorReextract(
        { last_reextract_at: NOW - HOUR, tokens_observed: 0 }, // read 1h ago
        NOW - 2 * HOUR,
        NOW
      ),
      false
    );
  });

  it("treats a null last_reextract_at (pre-v16 row) as immediately eligible", () => {
    assert.equal(
      shouldForceCursorReextract(
        { last_reextract_at: null, tokens_observed: 0 },
        NOW - HOUR,
        NOW
      ),
      true
    );
  });

  it("allows a re-read when the clock moved backward (negative elapsed, not throttled forever)", () => {
    assert.equal(
      shouldForceCursorReextract(
        { last_reextract_at: NOW + 2 * HOUR, tokens_observed: 0 }, // recorded in the "future"
        NOW - HOUR,
        NOW
      ),
      true
    );
  });
});

// ── Integration: token-settle re-extraction end-to-end ────────────────────────
//
// Drives extractCursor twice against a Cursor state.vscdb, simulating Cursor's
// post-completion token backfill (tokenCount written to a bubble WITHOUT bumping
// composerData.lastUpdatedAt). Proves (1) a young zero-token composer is re-read
// and picks up the late tokens, and (2) an unchanged forced re-read does not
// re-queue the row for a redundant sync.

describe("cursorExtractor — token-settle re-extraction", () => {

  const buildCursorDb = (
    path: string,
    composerId: string,
    lastUpdatedAt: number,
    asstTokens: { inputTokens: number; outputTokens: number } | null
  ): void => {
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);");
    const composerData = {
      composerId,
      createdAt: lastUpdatedAt - 60_000,
      lastUpdatedAt,
      name: "Recent session",
      fullConversationHeadersOnly: [
        { bubbleId: "u1", type: 1 },
        { bubbleId: "a1", type: 2 },
      ],
      modelConfig: { modelName: "claude-sonnet-4-6" },
    };
    const userBubble = { bubbleId: "u1", type: 1, text: "do the thing" };
    const asstBubble = {
      bubbleId: "a1",
      type: 2,
      text: "done",
      ...(asstTokens ? { tokenCount: asstTokens } : {}),
    };
    const ins = raw.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)");
    ins.run(`composerData:${composerId}`, JSON.stringify(composerData));
    ins.run(`bubbleId:${composerId}:u1`, JSON.stringify(userBubble));
    ins.run(`bubbleId:${composerId}:a1`, JSON.stringify(asstBubble));
    raw.close();
  };

  // Multi-turn composer: turn 1 (u1 + a1) already has tokens, turn 2 (u2 + a2) does
  // not yet — the exact case this feature targets (an earlier turn is settled but the
  // FINAL turn's tokens backfill after the last lastUpdatedAt bump). a2 is the last
  // assistant bubble in header order.
  const buildMultiTurnCursorDb = (path: string, composerId: string, lastUpdatedAt: number): void => {
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);");
    const composerData = {
      composerId,
      createdAt: lastUpdatedAt - 120_000,
      lastUpdatedAt,
      name: "Multi-turn session",
      fullConversationHeadersOnly: [
        { bubbleId: "u1", type: 1 },
        { bubbleId: "a1", type: 2 },
        { bubbleId: "u2", type: 1 },
        { bubbleId: "a2", type: 2 },
      ],
      modelConfig: { modelName: "claude-sonnet-4-6" },
    };
    const ins = raw.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)");
    ins.run(`composerData:${composerId}`, JSON.stringify(composerData));
    ins.run(`bubbleId:${composerId}:u1`, JSON.stringify({ bubbleId: "u1", type: 1, text: "first ask" }));
    ins.run(
      `bubbleId:${composerId}:a1`,
      JSON.stringify({ bubbleId: "a1", type: 2, text: "first answer", tokenCount: { inputTokens: 50, outputTokens: 90 } })
    );
    ins.run(`bubbleId:${composerId}:u2`, JSON.stringify({ bubbleId: "u2", type: 1, text: "second ask" }));
    // a2 has NO tokenCount yet (final turn's backfill hasn't landed).
    ins.run(`bubbleId:${composerId}:a2`, JSON.stringify({ bubbleId: "a2", type: 2, text: "second answer" }));
    raw.close();
  };

  // Backfill tokenCount into a bubble WITHOUT touching composerData — exactly what
  // Cursor does post-completion, leaving lastUpdatedAt unchanged. Defaults to a1.
  const backfillTokens = (
    path: string,
    composerId: string,
    tokens: { inputTokens: number; outputTokens: number },
    bubbleId = "a1"
  ): void => {
    const raw = new DatabaseSync(path);
    const row = raw
      .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(`bubbleId:${composerId}:${bubbleId}`) as { value: string };
    const bubble = JSON.parse(row.value) as Record<string, unknown>;
    bubble["tokenCount"] = tokens;
    raw
      .prepare("UPDATE cursorDiskKV SET value = ? WHERE key = ?")
      .run(JSON.stringify(bubble), `bubbleId:${composerId}:${bubbleId}`);
    raw.close();
  };

  // Simulate the throttle interval having elapsed since the last re-read.
  const elapseThrottle = (db: SessionStore, sessionId: string): void => {
    db.raw()
      .prepare("UPDATE conversations SET last_reextract_at = 0 WHERE ide_type = 'cursor' AND session_id = ?")
      .run(sessionId);
  };

  const rowFor = (db: SessionStore, sessionId: string) =>
    db.raw()
      .prepare(
        "SELECT id, sync_status, tokens_observed, conversation FROM conversations WHERE ide_type = 'cursor' AND session_id = ?"
      )
      .get(sessionId) as {
      id: string;
      sync_status: string;
      tokens_observed: number;
      conversation: string;
    };

  type Msg = { role: string; content?: string; metadata?: { inputTokens?: number; outputTokens?: number; tokenFidelity?: string } };
  const asstTokensOf = (conversationJson: string) =>
    (JSON.parse(conversationJson) as Msg[]).find((m) => m.role === "assistant")?.metadata;
  // The LAST assistant turn (header order) — the turn the settle signal keys off.
  const lastAsstOf = (conversationJson: string): Msg | undefined => {
    const msgs = JSON.parse(conversationJson) as Msg[];
    return [...msgs].reverse().find((m) => m.role === "assistant");
  };

  let tmpDir: string;
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-cursor-settle-"));
    // Isolate the CLI delegation too (same as the fixture suite): without this,
    // a machine with real ~/.cursor/chats history leaks extra sessions into the
    // extraction counts these tests assert exactly.
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: join(tmpDir, "no-cli-chats") });
  });
  after(() => {
    setPathOverrides({ CURSOR_DB_PATH: undefined });
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("re-extracts a young zero-token composer and picks up backfilled tokens", async () => {
    const composerId = "tok-settle-picks-up";
    const cursorDbPath = join(tmpDir, "picks-up.vscdb");
    buildCursorDb(cursorDbPath, composerId, Date.now() - 60_000, null);
    const db = new SessionStore(join(tmpDir, "picks-up-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });

    // First cycle: bubble has no tokenCount yet (Cursor hasn't backfilled).
    assert.equal(await extractCursor(db), 1, "first extraction must store the composer");
    let row = rowFor(db, composerId);
    assert.ok(
      asstTokensOf(row.conversation)?.inputTokens,
      "synthetic token estimate on first extraction when bubbles lack tokenCount"
    );
    assert.equal(row.tokens_observed, 0, "tokens_observed stays 0 until real backfill");

    // Cursor backfills tokens after completion; lastUpdatedAt is NOT bumped.
    backfillTokens(cursorDbPath, composerId, { inputTokens: 120, outputTokens: 340 });
    // The forced-re-read throttle would otherwise suppress a same-cycle re-read.
    elapseThrottle(db, composerId);

    // Second cycle: forced re-read within the settle window must pick up the tokens.
    assert.equal(await extractCursor(db), 1, "forced re-read re-processes the composer");
    row = rowFor(db, composerId);
    const meta = asstTokensOf(row.conversation);
    assert.equal(meta?.inputTokens, 120, "input tokens flow after backfill");
    assert.equal(meta?.outputTokens, 340, "output tokens flow after backfill");
    assert.equal(row.tokens_observed, 1, "tokens_observed becomes 1 (terminal)");
    assert.equal(row.sync_status, "pending", "changed content re-queues for store");
  });

  it("does not flip sync_status to pending on an unchanged forced re-read", async () => {
    const composerId = "tok-settle-unchanged";
    const cursorDbPath = join(tmpDir, "unchanged.vscdb");
    buildCursorDb(cursorDbPath, composerId, Date.now() - 60_000, null);
    const db = new SessionStore(join(tmpDir, "unchanged-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });

    assert.equal(await extractCursor(db), 1, "first extraction stores the composer");
    const initial = rowFor(db, composerId);
    // Complete a sync the way a host does — pending → syncing → synced
    // (markSynced flips only 'syncing' rows; calling it on a 'pending' row is a
    // deliberate no-op, see the markSynced race guard) — so we can observe
    // whether a re-read re-queues it.
    db.markSyncing([initial.id]);
    db.markSynced(initial.id);

    // Force a re-read, but with the state.vscdb byte-for-byte unchanged.
    elapseThrottle(db, composerId);
    assert.equal(
      await extractCursor(db),
      1,
      "forced re-read still fires (tokens not yet observed, within window)"
    );

    const row = rowFor(db, composerId);
    assert.equal(
      row.sync_status,
      "synced",
      "identical re-read must NOT re-queue the row to pending (no redundant re-sync)"
    );
  });

  // Regression guard for the settle signal latching on the wrong turn: with a
  // some(...)-over-all-turns signal, turn 1's tokens close the window and the FINAL
  // turn's late backfill (the exact case this feature targets) is never picked up.
  it("picks up the FINAL turn's late tokens even when an earlier turn already had tokens", async () => {
    const composerId = "tok-settle-multi-turn";
    const cursorDbPath = join(tmpDir, "multi-turn.vscdb");
    buildMultiTurnCursorDb(cursorDbPath, composerId, Date.now() - 60_000);
    const db = new SessionStore(join(tmpDir, "multi-turn-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });

    // First cycle: turn 1 (a1) has tokens, final turn (a2) does not yet. The settle
    // signal must key off the LAST turn (a2) — so the window stays OPEN.
    assert.equal(await extractCursor(db), 1, "first extraction stores the composer");
    let row = rowFor(db, composerId);
    assert.equal(row.tokens_observed, 0, "last turn has no tokens yet → window stays open");
    assert.ok(!lastAsstOf(row.conversation)?.metadata?.outputTokens, "final turn has no tokens yet");

    // Cursor backfills the FINAL turn's tokens post-completion; lastUpdatedAt unchanged.
    backfillTokens(cursorDbPath, composerId, { inputTokens: 200, outputTokens: 450 }, "a2");
    elapseThrottle(db, composerId);

    // Second cycle: forced re-read must fire and pick up a2's tokens.
    assert.equal(await extractCursor(db), 1, "forced re-read fires for the still-unsettled final turn");
    row = rowFor(db, composerId);
    const lastMeta = lastAsstOf(row.conversation)?.metadata;
    assert.equal(lastMeta?.inputTokens, 200, "final turn input tokens flow after backfill");
    assert.equal(lastMeta?.outputTokens, 450, "final turn output tokens flow after backfill");
    assert.equal(row.tokens_observed, 1, "tokens_observed now reflects the settled final turn");
  });

  it("stamps NATIVE_PARTIAL on a billable Cursor turn (bubble tokenCount, no output split)", async () => {
    const composerId = "tok-billable-native-partial";
    const cursorDbPath = join(tmpDir, "billable.vscdb");
    // A billable bubble carries a native input count with no output split — native but
    // incomplete, so the turn must land NATIVE_PARTIAL rather than an untyped fidelity.
    buildCursorDb(cursorDbPath, composerId, Date.now() - 60_000, { inputTokens: 31_745, outputTokens: 0 });
    const db = new SessionStore(join(tmpDir, "billable-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });

    assert.equal(await extractCursor(db), 1, "extraction stores the composer");
    const meta = asstTokensOf(rowFor(db, composerId).conversation);
    assert.equal(meta?.inputTokens, 31_745, "billable input flows through");
    assert.equal(meta?.outputTokens, undefined, "no output split on a native-partial turn");
    assert.equal(
      meta?.tokenFidelity,
      "TOKEN_FIDELITY_NATIVE_PARTIAL",
      "a billable bubble turn is native-but-incomplete, never UNSPECIFIED"
    );
  });

  it("session_meta carries reported_cost_usd from a model-keyed usageData bucket", async () => {
    const composerId = "composer-25-cost";
    const cursorDbPath = join(tmpDir, "composer25-cost.vscdb");
    buildCursorDb(cursorDbPath, composerId, Date.now() - 60_000, null);
    const raw = new DatabaseSync(cursorDbPath);
    const row = raw
      .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
      .get(`composerData:${composerId}`) as { value: string };
    const composerData = JSON.parse(row.value) as Record<string, unknown>;
    composerData["modelConfig"] = { modelName: "composer-2.5" };
    composerData["usageData"] = { "composer-2.5": { costInCents: 42, amount: 10 } };
    raw
      .prepare(`UPDATE cursorDiskKV SET value = ? WHERE key = ?`)
      .run(JSON.stringify(composerData), `composerData:${composerId}`);
    raw.close();

    const db = new SessionStore(join(tmpDir, "composer25-cost-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });
    assert.equal(await extractCursor(db), 1);
    const stored = db.raw()
      .prepare(
        "SELECT session_meta FROM conversations WHERE ide_type = 'cursor' AND session_id = ?"
      )
      .get(composerId) as { session_meta: string | null };
    assert.ok(stored.session_meta, "session_meta must be populated");
    const meta = JSON.parse(stored.session_meta) as { reported_cost_usd?: number };
    assert.equal(meta.reported_cost_usd, 0.42, "composer-2.5 usageData must flow to session_meta");
  });

  it("session_meta source is stamped 'ide' for a Cursor IDE session", async () => {
    const composerId = "composer-ide-surface";
    const cursorDbPath = join(tmpDir, "composer-ide-surface.vscdb");
    buildCursorDb(cursorDbPath, composerId, Date.now() - 60_000, null);
    const db = new SessionStore(join(tmpDir, "composer-ide-surface-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });
    assert.equal(await extractCursor(db), 1);
    const stored = db.raw()
      .prepare(
        "SELECT session_meta FROM conversations WHERE ide_type = 'cursor' AND session_id = ?"
      )
      .get(composerId) as { session_meta: string | null };
    assert.ok(stored.session_meta, "session_meta must be populated");
    const meta = JSON.parse(stored.session_meta) as { source?: string };
    // The Cursor IDE store (state.vscdb) is this extractor's origin, so it stamps source=ide,
    // (the CLI path stamps "cli").
    assert.equal(meta.source, "ide", "Cursor IDE sessions stamp source=ide");
  });

  it("session_meta tracked_file_paths keep the leading slash so redactPath swaps the home segment", async () => {
    const username = userInfo().username as string;
    assert.ok(username, "need an OS username to exercise redactPath");
    const composerId = "composer-tracked-paths";
    const cursorDbPath = join(tmpDir, "composer-tracked.vscdb");
    buildCursorDb(cursorDbPath, composerId, Date.now() - 60_000, null);
    const raw = new DatabaseSync(cursorDbPath);
    const row = raw
      .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
      .get(`composerData:${composerId}`) as { value: string };
    const composerData = JSON.parse(row.value) as Record<string, unknown>;
    // codeBlockData keys are `file:///…` URIs — the three slashes are scheme + the
    // absolute path's leading slash, which must survive into tracked_file_paths so
    // redactPath's `/Users/<user>/` matcher fires.
    composerData["codeBlockData"] = { [`file:///Users/${username}/dev/repo/edited.ts`]: {} };
    raw
      .prepare(`UPDATE cursorDiskKV SET value = ? WHERE key = ?`)
      .run(JSON.stringify(composerData), `composerData:${composerId}`);
    raw.close();

    const db = new SessionStore(join(tmpDir, "composer-tracked-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });
    assert.equal(await extractCursor(db), 1);
    const stored = db.raw()
      .prepare(
        "SELECT session_meta FROM conversations WHERE ide_type = 'cursor' AND session_id = ?"
      )
      .get(composerId) as { session_meta: string | null };
    assert.ok(stored.session_meta, "session_meta must be populated");
    const meta = JSON.parse(stored.session_meta) as { tracked_file_paths?: string[] };
    assert.ok(meta.tracked_file_paths?.length, "tracked_file_paths must be populated");
    const p = meta.tracked_file_paths![0]!;
    assert.ok(p.startsWith("/Users/"), `expected a leading-slash absolute path, got ${p}`);
    assert.ok(!p.includes(`/${username}/`), `raw username leaked in ${p}`);
    assert.ok(p.endsWith("/dev/repo/edited.ts"), "path past the home segment preserved");
  });

  it("session_meta gets token estimate via context meter when bubbles lack tokenCount", async () => {
    const composerId = "composer-25-meter";
    const cursorDbPath = join(tmpDir, "composer25-meter.vscdb");
    buildCursorDb(cursorDbPath, composerId, Date.now() - 60_000, null);
    const raw = new DatabaseSync(cursorDbPath);
    const row = raw
      .prepare(`SELECT value FROM cursorDiskKV WHERE key = ?`)
      .get(`composerData:${composerId}`) as { value: string };
    const composerData = JSON.parse(row.value) as Record<string, unknown>;
    composerData["modelConfig"] = { modelName: "composer-2.5" };
    composerData["contextTokensUsed"] = 250_000;
    composerData["contextUsagePercent"] = 89;
    composerData["promptTokenBreakdown"] = {
      totalUsedTokens: 250_000,
      categories: [
        { id: "tools", estimatedTokens: 20_000 },
        { id: "conversation", estimatedTokens: 230_000 },
      ],
    };
    raw
      .prepare(`UPDATE cursorDiskKV SET value = ? WHERE key = ?`)
      .run(JSON.stringify(composerData), `composerData:${composerId}`);
    raw.close();

    const db = new SessionStore(join(tmpDir, "composer25-meter-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });
    assert.equal(await extractCursor(db), 1);
    const stored = db.raw()
      .prepare(
        "SELECT conversation, session_meta FROM conversations WHERE ide_type = 'cursor' AND session_id = ?"
      )
      .get(composerId) as { conversation: string; session_meta: string };
    const messages = JSON.parse(stored.conversation) as {
      role: string;
      metadata?: { inputTokens?: number; outputTokens?: number; model?: string };
    }[];
    const lastAsst = [...messages].reverse().find((m) => m.role === "assistant");
    assert.equal(lastAsst?.metadata?.inputTokens, 250_000);
    assert.equal(lastAsst?.metadata?.outputTokens, 1, "output from assistant text");
    assert.equal(lastAsst?.metadata?.model, "composer-2.5");
    const meta = JSON.parse(stored.session_meta) as {
      context_composition?: Array<{ segment: string; tokens: number }>;
    };
    assert.ok(meta.context_composition?.length === 2);
    assert.equal((db.raw()
      .prepare("SELECT tokens_observed FROM conversations WHERE session_id = ?")
      .get(composerId) as { tokens_observed: number } | undefined)?.tokens_observed, 0, "synthetic tokens must not close settle window");
  });
});

// ── first_prompt capture + session_meta redaction ────────────────────────────
//
// Grounded in the real state.vscdb bubble shape: a user turn is `{type:1, text}`,
// and a spawn-injected turn carries `subagentSpawnTaskToolCallId` — verified against
// a live Cursor store.

describe("cursorExtractor — first_prompt + redaction", () => {

  type Turn = {
    text: string;
    role: "user" | "assistant";
    spawnInjected?: boolean;
    // A harness-injected turn: Cursor tags it with `simulatedMessageMetadata` (a
    // `<system_notification>` task-finished message wears the user role but nobody typed it).
    simulatedInjected?: boolean;
  };

  // Build a Cursor state.vscdb with an ordered turn list. A spawn-injected user turn gets
  // `subagentSpawnTaskToolCallId`; a harness-injected one gets `simulatedMessageMetadata` — both
  // exactly as Cursor stores them.
  const buildDb = (path: string, composerId: string, name: string, turns: Turn[]): void => {
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);");
    const headers = turns.map((t, i) => ({ bubbleId: `b${i}`, type: t.role === "user" ? 1 : 2 }));
    const composerData = {
      composerId,
      createdAt: 1743494400000,
      lastUpdatedAt: 1743494460000,
      name,
      fullConversationHeadersOnly: headers,
      modelConfig: { modelName: "claude-sonnet-4-6" },
    };
    const ins = raw.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)");
    ins.run(`composerData:${composerId}`, JSON.stringify(composerData));
    turns.forEach((t, i) => {
      const bubble: Record<string, unknown> = { bubbleId: `b${i}`, type: t.role === "user" ? 1 : 2, text: t.text };
      if (t.spawnInjected) bubble["subagentSpawnTaskToolCallId"] = "tool_deadbeef-spawn";
      if (t.simulatedInjected) bubble["simulatedMessageMetadata"] = { title: "Find state.vscdb files", taskId: "232583" };
      ins.run(`bubbleId:${composerId}:b${i}`, JSON.stringify(bubble));
    });
    raw.close();
  };

  let tmpDir: string;
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-cursor-firstprompt-"));
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: join(tmpDir, "no-cli-chats") });
  });
  after(() => {
    setPathOverrides({ CURSOR_DB_PATH: undefined });
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const metaAfterExtract = async (composerId: string, name: string, turns: Turn[]) => {
    const cursorDbPath = join(tmpDir, `${composerId}.vscdb`);
    buildDb(cursorDbPath, composerId, name, turns);
    const db = new SessionStore(join(tmpDir, `${composerId}-local.db`));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });
    assert.equal(await extractCursor(db), 1, "composer must be stored");
    const rawMeta = (db.raw()
      .prepare("SELECT session_meta FROM conversations WHERE ide_type = 'cursor' AND session_id = ?")
      .get(composerId) as { session_meta: string | null }).session_meta;
    assert.ok(rawMeta, "session_meta must be populated");
    return { rawMeta, meta: JSON.parse(rawMeta) as { first_prompt?: string; session_title?: string } };
  };

  it("populates first_prompt from the first genuine user turn", async () => {
    const { meta } = await metaAfterExtract("fp-genuine", "Add retry to client", [
      { role: "user", text: "add a retry with backoff to the http client" },
      { role: "assistant", text: "done" },
    ]);
    assert.equal(meta.first_prompt, "add a retry with backoff to the http client");
  });

  it("skips a spawn-injected first turn and uses the next genuine user turn", async () => {
    const injected = "You are the code-review reviewer. Repo: /Users/x/proj. Branch: feat";
    const { meta } = await metaAfterExtract("fp-spawn-skip", "Pre-PR review panel", [
      { role: "user", text: injected, spawnInjected: true },
      { role: "assistant", text: "reviewing" },
      { role: "user", text: "also check the error handling" },
      { role: "assistant", text: "ok" },
    ]);
    assert.equal(meta.first_prompt, "also check the error handling");
    assert.ok(!meta.first_prompt!.includes("code-review"), "injected task prompt must not become first_prompt");
  });

  it("skips a simulated (harness-injected) first turn and uses the next genuine user turn", async () => {
    const injected = "<system_notification> The following task has finished.";
    const { meta } = await metaAfterExtract("fp-simulated-skip", "Background task run", [
      { role: "user", text: injected, simulatedInjected: true },
      { role: "assistant", text: "acknowledged" },
      { role: "user", text: "now run the integration tests" },
      { role: "assistant", text: "ok" },
    ]);
    assert.equal(meta.first_prompt, "now run the integration tests");
    assert.ok(!meta.first_prompt!.includes("system_notification"), "injected notification must not become first_prompt");
  });

  it("leaves first_prompt unset when every user turn is spawn-injected", async () => {
    const { meta } = await metaAfterExtract("fp-all-spawn", "Explore repo", [
      { role: "user", text: "Explore the codebase at /Users/x/repo and report", spawnInjected: true },
      { role: "assistant", text: "[Tool: list_dir]" },
    ]);
    assert.equal(meta.first_prompt, undefined, "no genuine user turn → no first_prompt");
  });

  it("caps first_prompt at FIRST_PROMPT_MAX_CHARS (500)", async () => {
    const long = "x".repeat(1200);
    const { meta } = await metaAfterExtract("fp-cap", "Long paste", [
      { role: "user", text: long },
      { role: "assistant", text: "ok" },
    ]);
    assert.equal(meta.first_prompt!.length, 500, "a large opening message is bounded");
  });

  // session_meta is stored unredacted, so a secret/path in the title or first_prompt
  // must be scrubbed at its assignment site — plant a key and assert it never lands.
  it("redacts a secret and the OS username in first_prompt and session_title", async () => {
    const secret = "sk-ant-api03-PLANTEDSECRETKEY1234567890abcdefZZZ";
    const username = userInfo().username;
    const { rawMeta, meta } = await metaAfterExtract(
      "fp-leak-guard",
      `debug ${secret} in /Users/${username}/svc`,
      [
        { role: "user", text: `my key is ${secret} and my home is /Users/${username}/go` },
        { role: "assistant", text: "noted" },
      ]
    );
    assert.ok(!rawMeta.includes(secret), "planted key must never appear in serialized session_meta");
    assert.ok(rawMeta.includes("████████"), "secret must be masked");
    assert.ok(meta.first_prompt!.includes("████████"), "first_prompt secret masked");
    if (username.length >= 3) {
      assert.ok(!rawMeta.includes(`/Users/${username}/`), "raw OS username path must not survive in session_meta");
    }
  });

  // Returns the PROMPT_REFERENCE events (ordinal → author) after extraction — the
  // session_events counterpart to metaAfterExtract, over the same fixture DB.
  const authorsByOrdinal = async (composerId: string, name: string, turns: Turn[]) => {
    const cursorDbPath = join(tmpDir, `${composerId}.vscdb`);
    buildDb(cursorDbPath, composerId, name, turns);
    const db = new SessionStore(join(tmpDir, `${composerId}-local.db`));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });
    assert.equal(await extractCursor(db), 1, "composer must be stored");
    const rawEvents = (db.raw()
      .prepare("SELECT session_events FROM conversations WHERE ide_type = 'cursor' AND session_id = ?")
      .get(composerId) as { session_events: string | null }).session_events;
    assert.ok(rawEvents, "session_events must be populated");
    const events = JSON.parse(rawEvents) as { kind: string; prompt_ordinal?: number; author?: string }[];
    const byOrdinal = new Map<number, string>();
    for (const e of events) {
      if (e.kind === "SESSION_EVENT_KIND_PROMPT_REFERENCE" && e.prompt_ordinal !== undefined) {
        byOrdinal.set(e.prompt_ordinal, e.author ?? "");
      }
    }
    return byOrdinal;
  };

  // A spawn-injected user turn carries `subagentSpawnTaskToolCallId` (authored by a spawn
  // tool call, not the person) and must be stamped DELEGATED_AGENT, not HUMAN — stamping it
  // human inflates human activity and hides the delegated work loop detection reads.
  it("stamps a spawn-injected user turn DELEGATED_AGENT and a genuine one HUMAN", async () => {
    // ordinal 1 = the spawn-injected task prompt; ordinal 3 = the person's own turn
    // (ordinal counts every prompt, and only user turns get a PROMPT_REFERENCE).
    const byOrdinal = await authorsByOrdinal("author-spawn-mix", "Pre-PR review panel", [
      { role: "user", text: "You are the code-review reviewer. Repo: /x. Branch: feat", spawnInjected: true },
      { role: "assistant", text: "reviewing" },
      { role: "user", text: "also check the error handling" },
      { role: "assistant", text: "ok" },
    ]);
    assert.equal(
      byOrdinal.get(1),
      "SESSION_EVENT_AUTHOR_DELEGATED_AGENT",
      "spawn-injected task prompt must be delegated, not human"
    );
    assert.equal(
      byOrdinal.get(3),
      "SESSION_EVENT_AUTHOR_HUMAN",
      "a genuinely typed turn stays human — the fix must not blanket-stamp every user turn"
    );
  });

  // A harness-injected user turn carries `simulatedMessageMetadata` (Cursor's `<system_notification>`
  // task-finished message wears the user role but nobody typed it). Per promptReferenceAuthor's
  // injected contract it must stamp AGENT, not HUMAN.
  it("stamps a simulatedMessageMetadata (harness-injected) user turn AGENT and a genuine one HUMAN", async () => {
    // ordinal 1 = the injected notification; ordinal 3 = the person's own turn.
    const byOrdinal = await authorsByOrdinal("author-simulated-mix", "Background task run", [
      { role: "user", text: "<system_notification> The following task has finished.", simulatedInjected: true },
      { role: "assistant", text: "acknowledged" },
      { role: "user", text: "now run the integration tests" },
      { role: "assistant", text: "ok" },
    ]);
    assert.equal(
      byOrdinal.get(1),
      "SESSION_EVENT_AUTHOR_AGENT",
      "a simulatedMessageMetadata turn is harness-injected, not human"
    );
    assert.equal(
      byOrdinal.get(3),
      "SESSION_EVENT_AUTHOR_HUMAN",
      "a genuinely typed turn stays human — the fix must not blanket-stamp every user turn"
    );
  });
});

// ── Fixture mode ─────────────────────────────────────────────────────────────

describe("cursorExtractor — fixture", () => {
  let tmpDir: string;
  let db: SessionStore;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-cursor-smoke-"));
    db = new SessionStore(join(tmpDir, "test.db"));
    setPathOverrides({ CURSOR_DB_PATH: fixtureDb });
    // extractCursor also dispatches the terminal-CLI reader; point it at
    // non-existent paths so these IDE-fixture counts stay hermetic instead of
    // drifting with whatever CLI sessions live in the developer's ~/.cursor.
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: join(tmpDir, "no-cli-chats") });
    setPathOverrides({ CURSOR_CLI_CONFIG_PATH: join(tmpDir, "no-cli-config.json") });
    setPathOverrides({ CURSOR_STATSIG_CACHE_PATH: join(tmpDir, "no-statsig-cache.json") });
  });

  after(() => {
    setPathOverrides({ CURSOR_DB_PATH: undefined });
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: undefined });
    setPathOverrides({ CURSOR_CLI_CONFIG_PATH: undefined });
    setPathOverrides({ CURSOR_STATSIG_CACHE_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("happy path: returns non-negative count", async () => {
    const count = await extractCursor(db);
    assert.ok(typeof count === "number", "count must be a number");
    assert.ok(count > 0, "fixture has seeded data, count must be > 0");
  });

  it("happy path: stored conversations have valid schema", () => {
    const rows = db.getConversationsSince(0, 1000);
    assert.ok(rows.length > 0, "expected conversations from previous extraction");
    for (const row of rows) {
      assert.equal(row.ide_type, "cursor", "ide_type must be cursor");
      assert.ok(typeof row.conversation === "string", "conversation must be JSON string");
      const messages = JSON.parse(row.conversation) as { role?: unknown }[];
      assert.ok(Array.isArray(messages), "parsed conversation must be array");
      for (const msg of messages) {
        assert.ok(typeof msg.role === "string", `message.role must be string, got ${typeof msg.role}`);
      }
    }
  });

  it("missing db path: does not throw, returns 0", async () => {
    setPathOverrides({ CURSOR_DB_PATH: "/tmp/does-not-exist-fixture.vscdb" });
    const emptyDb = new SessionStore(join(tmpDir, "empty.db"));
    const count = await extractCursor(emptyDb);
    assert.equal(count, 0, "should return 0 when DB not found");
  });

  it("signals: model and contextUsagePercent on assistant prompt", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const messages = JSON.parse(rows[0]!.conversation) as {
      role: string;
      metadata?: { model?: string; contextUsagePercent?: number };
    }[];
    const asst = messages.find((m) => m.role === "assistant");
    assert.equal(asst?.metadata?.model, "claude-sonnet-4-6", "model must match composerData.modelConfig.modelName");
    // Cursor's 0-100 percent is converted to the 0.0-1.0 wire fraction (fixture raw 5 -> 0.05),
    // so a consumer's *100 yields the correct 5% context_pct rather than an inflated 500%.
    assert.equal(asst?.metadata?.contextUsagePercent, 0.05, "contextUsagePercent must be the 0-1 fraction (5/100)");
  });

  it("signals: per-prompt inputTokens and outputTokens from bubble.tokenCount", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const messages = JSON.parse(rows[0]!.conversation) as {
      role: string;
      metadata?: { inputTokens?: number; outputTokens?: number };
    }[];
    const asst = messages.find((m) => m.role === "assistant");
    assert.equal(asst?.metadata?.inputTokens, 15, "inputTokens must be 15");
    assert.equal(asst?.metadata?.outputTokens, 60, "outputTokens must be 60");
  });

  it("signals: session_meta session_title is extracted from composerData.name", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { session_title?: string };
    assert.equal(meta.session_title, "Fixture Conversation", "session_title must match composerData.name");
  });

  it("signals: session_meta lines_added and lines_removed from composerData", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { lines_added?: number; lines_removed?: number };
    assert.equal(meta.lines_added, 50, "lines_added must be 50");
    assert.equal(meta.lines_removed, 10, "lines_removed must be 10");
  });

  it("signals: session_meta uses_task_agent is true for agentic composer", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { uses_task_agent?: boolean };
    assert.equal(meta.uses_task_agent, true, "uses_task_agent must be true when isAgentic=true");
  });

  it("signals: user_message_count and assistant_message_count from stored conversation", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const messages = JSON.parse(rows[0]!.conversation) as { role: string }[];
    const userCount = messages.filter((m) => m.role === "user").length;
    const asstCount = messages.filter((m) => m.role === "assistant").length;
    assert.equal(userCount, 1, "user_message_count must be 1");
    assert.equal(asstCount, 1, "assistant_message_count must be 1");
  });

  it("signals: session_meta session_duration_seconds derived from createdAt/lastUpdatedAt", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { session_duration_seconds?: number };
    // lastUpdatedAt(1743494460000) - createdAt(1743494400000) = 60000 ms → 60 s
    assert.equal(meta.session_duration_seconds, 60, "session_duration_seconds must be 60");
  });

  it("signals: session_meta tool_counts from toolFormerData entries", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as {
      tool_counts?: Record<string, number>;
      tool_errors?: number;
      tool_error_categories?: Record<string, number>;
    };
    assert.ok(typeof meta.tool_counts === "object" && meta.tool_counts !== null, "tool_counts must be an object");
    assert.equal(meta.tool_counts!["edit_file"], 1, "edit_file must have count 1");
    assert.equal(meta.tool_errors, 1, "tool_errors must be 1 for the error-status edit_file");
    // The category is keyed by Cursor's own status spelling (`error`; no real bubble says
    // `errored`), so a rollup keyed on the wrong spelling reports zero errors on every real session.
    assert.deepEqual(meta.tool_error_categories, { error: 1 });
  });

  it("signals: session_meta user_message_timestamps are synthetic ISO strings", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { user_message_timestamps?: string[] };
    assert.ok(Array.isArray(meta.user_message_timestamps), "user_message_timestamps must be array");
    assert.equal(meta.user_message_timestamps!.length, 1, "1 user message → 1 timestamp");
    assert.ok(!isNaN(Date.parse(meta.user_message_timestamps![0]!)), "timestamp must be valid ISO 8601");
  });
});

// ── Non-string composerData.name guard ────────────────────────────────────────
//
// parseComposerData only validates composerId/createdAt/lastUpdatedAt/
// fullConversationHeadersOnly before casting the parsed JSON to ComposerData —
// `name` is unchecked, so a malformed Cursor build writing a non-string name
// must not flow into session_title, which is a string field.

describe("cursorExtractor — non-string composerData.name", () => {
  let tmpDir: string;
  let db: SessionStore;
  let patchedFixtureDb: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-cursor-badname-"));
    patchedFixtureDb = join(tmpDir, "state_badname.vscdb");
    copyFileSync(fixtureDb, patchedFixtureDb);

    const raw = new DatabaseSync(patchedFixtureDb);
    const row = raw
      .prepare(`SELECT value FROM cursorDiskKV WHERE key = 'composerData:composer-fixture-001'`)
      .get() as { value: string };
    const composerData = JSON.parse(row.value) as Record<string, unknown>;
    composerData["name"] = 12345; // malformed: name must be a string
    raw
      .prepare(`UPDATE cursorDiskKV SET value = ? WHERE key = 'composerData:composer-fixture-001'`)
      .run(JSON.stringify(composerData));
    raw.close();

    db = new SessionStore(join(tmpDir, "test.db"));
    setPathOverrides({ CURSOR_DB_PATH: patchedFixtureDb });
    // Isolate the terminal-CLI reader extractCursor dispatches (see the fixture
    // block above) so the developer's real ~/.cursor sessions don't leak in.
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: join(tmpDir, "no-cli-chats") });
    setPathOverrides({ CURSOR_CLI_CONFIG_PATH: join(tmpDir, "no-cli-config.json") });
    setPathOverrides({ CURSOR_STATSIG_CACHE_PATH: join(tmpDir, "no-statsig-cache.json") });
  });

  after(() => {
    setPathOverrides({ CURSOR_DB_PATH: undefined });
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: undefined });
    setPathOverrides({ CURSOR_CLI_CONFIG_PATH: undefined });
    setPathOverrides({ CURSOR_STATSIG_CACHE_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("omits session_title rather than persisting a non-string value", async () => {
    const count = await extractCursor(db);
    assert.ok(count > 0, "extraction must still succeed for the rest of the session");
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { session_title?: unknown };
    assert.equal(meta.session_title, undefined, "session_title must be omitted, not a non-string value");
  });
});

// ── Cursor CLI plan-tier resolution ─────────────────────────────────────────

describe("detectCursorCliTier", () => {
  let tmpDir: string;
  let statsigPath: string;
  let cliConfigPath: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-cursor-cli-tier-"));
    statsigPath = join(tmpDir, "statsig-cache.json");
    cliConfigPath = join(tmpDir, "cli-config.json");
    setPathOverrides({ CURSOR_STATSIG_CACHE_PATH: statsigPath });
    setPathOverrides({ CURSOR_CLI_CONFIG_PATH: cliConfigPath });
  });

  after(() => {
    setPathOverrides({ CURSOR_STATSIG_CACHE_PATH: undefined });
    setPathOverrides({ CURSOR_CLI_CONFIG_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // The real statsig-cache.json stores `data` as a stringified JSON blob.
  const writeStatsig = (custom: Record<string, unknown>, asObject = false) => {
    const inner = { user: { userID: "u1", custom } };
    writeFileSync(statsigPath, JSON.stringify({ data: asObject ? inner : JSON.stringify(inner) }));
  };

  const TEAM_SEAT = {
    isEnterpriseUser: false,
    isEnterpriseTrialUser: false,
    teamID: 1234567,
    teamRole: "member",
  };

  it("reads the team account fields from the statsig cache (stringified data blob)", () => {
    writeStatsig(TEAM_SEAT);
    rmSync(cliConfigPath, { force: true });
    const meta = detectCursorCliTier();
    assert.equal(meta?.plan_tier_source, "cursor_cli_statsig");
    assert.equal(meta?.is_enterprise_user, false);
    assert.equal(meta?.is_enterprise_trial_user, false);
    assert.equal(meta?.cursor_team_role, "member");
    assert.equal(meta?.cursor_team_id, "1234567");
    assert.equal(typeof meta?.cursor_team_id, "string", "numeric teamID must ship as a string");
  });

  it("tolerates a data blob that is already a parsed object", () => {
    writeStatsig(TEAM_SEAT, /* asObject */ true);
    rmSync(cliConfigPath, { force: true });
    const meta = detectCursorCliTier();
    assert.equal(meta?.plan_tier_source, "cursor_cli_statsig");
    assert.equal(meta?.cursor_team_id, "1234567");
  });

  it("ships stripeMembershipStatus alongside the team id, never instead of it", () => {
    // A paid Teams seat reports "free" here, because the field describes the
    // INDIVIDUAL subscription. Shipping it alone priced the seat at exactly $0
    // ("free" is a valid price, not an unresolved one); withholding it entirely
    // left a genuine individual subscriber with no tier. Ship both and let the
    // consumer's precedence — team id outranks the membership string — decide.
    writeStatsig({ ...TEAM_SEAT, stripeMembershipStatus: "free" });
    rmSync(cliConfigPath, { force: true });
    const meta = detectCursorCliTier();
    assert.ok(meta);
    assert.equal(meta.plan_tier, "free");
    assert.equal(meta.cursor_team_id, "1234567", "the team id must be present to outrank it");
  });

  it("carries the individual subscription as plan_tier when there is no team", () => {
    writeStatsig({ isEnterpriseUser: false, isEnterpriseTrialUser: false, stripeMembershipStatus: "pro" });
    rmSync(cliConfigPath, { force: true });
    const meta = detectCursorCliTier();
    assert.ok(meta);
    assert.equal(meta.plan_tier, "pro");
    assert.ok(!("cursor_team_id" in meta));
  });

  it("keeps both enterprise flags for a negotiated contract", () => {
    writeStatsig({ isEnterpriseUser: true, isEnterpriseTrialUser: true, teamID: 42 });
    rmSync(cliConfigPath, { force: true });
    const meta = detectCursorCliTier();
    assert.equal(meta?.is_enterprise_user, true);
    assert.equal(meta?.is_enterprise_trial_user, true);
    assert.equal(meta?.cursor_team_id, "42");
  });

  it("omits cursor_team_id for an individual account with no teamID", () => {
    writeStatsig({ isEnterpriseUser: false, isEnterpriseTrialUser: false });
    rmSync(cliConfigPath, { force: true });
    const meta = detectCursorCliTier();
    assert.equal(meta?.plan_tier_source, "cursor_cli_statsig");
    assert.ok(meta && !("cursor_team_id" in meta), "absent teamID must not become an empty string");
  });

  it("falls back to cursor_cli_config when the statsig cache is absent", () => {
    rmSync(statsigPath, { force: true });
    writeFileSync(cliConfigPath, JSON.stringify({ authInfo: { email: "dev@example.com" } }));
    const meta = detectCursorCliTier();
    assert.equal(meta?.plan_tier, undefined);
    assert.equal(meta?.plan_tier_source, "cursor_cli_config");
    assert.equal(meta?.login_email, "dev@example.com");
  });

  it("falls back to cursor_cli_config when the statsig cache is malformed JSON", () => {
    writeFileSync(statsigPath, "{not json");
    writeFileSync(cliConfigPath, JSON.stringify({ authInfo: { email: "dev@example.com" } }));
    const meta = detectCursorCliTier();
    assert.equal(meta?.plan_tier_source, "cursor_cli_config");
    assert.equal(meta?.login_email, "dev@example.com");
  });

  it("falls back to cursor_cli_config when the inner data blob is malformed JSON", () => {
    writeFileSync(statsigPath, JSON.stringify({ data: "{not json" }));
    writeFileSync(cliConfigPath, JSON.stringify({ authInfo: { email: "dev@example.com" } }));
    const meta = detectCursorCliTier();
    assert.equal(meta?.plan_tier_source, "cursor_cli_config");
    assert.equal(meta?.login_email, "dev@example.com");
  });

  it("returns undefined when neither source exists", () => {
    rmSync(statsigPath, { force: true });
    rmSync(cliConfigPath, { force: true });
    assert.equal(detectCursorCliTier(), undefined);
  });

  it("still carries the account id when the cache has no team or tier fields", () => {
    writeStatsig({});
    rmSync(cliConfigPath, { force: true });
    // The per-member account id sits outside `user.custom`, so a cache with no
    // team/enterprise fields still identifies the seat — which is the point of
    // capturing it. Pseudonymous, and no email is read on this path.
    const meta = detectCursorCliTier();
    assert.ok(meta);
    assert.equal(meta.cursor_user_id, "u1");
    assert.ok(!("plan_tier" in meta));
    assert.ok(!("cursor_team_id" in meta));
    assert.ok(!("login_email" in meta));
  });
});

// ── Unit tests: buildChildToParentFromAgentTranscripts ────────────────────────

describe("buildChildToParentFromAgentTranscripts", () => {
  it("maps child composerId -> parent composerId from the on-disk transcript tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "lse-cursor-at-"));
    const sub = join(dir, "projects", "slug-1", "agent-transcripts", "parent-abc", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "child-xyz.jsonl"), "{}");
    writeFileSync(join(sub, "child-def.jsonl"), "{}");
    writeFileSync(join(sub, "notes.txt"), "ignored"); // non-jsonl is ignored
    const map = buildChildToParentFromAgentTranscripts(dir);
    assert.equal(map.get("child-xyz"), "parent-abc");
    assert.equal(map.get("child-def"), "parent-abc");
    assert.equal(map.has("notes"), false);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("returns an empty map when the projects directory is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "lse-cursor-empty-"));
    const map = buildChildToParentFromAgentTranscripts(dir);
    assert.equal(map.size, 0);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
});

describe("parentComposerIdFromSubagentInfo", () => {
  it("returns the parent composer id from a Task child's subagentInfo", () => {
    assert.equal(
      parentComposerIdFromSubagentInfo({
        composerId: "child-1",
        subagentInfo: { parentComposerId: "parent-1" },
      }),
      "parent-1"
    );
  });

  it("returns undefined when subagentInfo is absent (a primary composer)", () => {
    assert.equal(parentComposerIdFromSubagentInfo({ composerId: "primary-1" }), undefined);
  });

  it("returns undefined when parentComposerId is empty or self-referential", () => {
    assert.equal(
      parentComposerIdFromSubagentInfo({
        composerId: "child-1",
        subagentInfo: { parentComposerId: "" },
      }),
      undefined
    );
    assert.equal(
      parentComposerIdFromSubagentInfo({
        composerId: "child-1",
        subagentInfo: { parentComposerId: "child-1" },
      }),
      undefined
    );
  });
});

// A Task-spawned child carries subagentInfo.parentComposerId even when the
// parent has not yet listed it in subagentComposerIds. That is the Sessions
// leak: without this pointer the child is stored as a primary ("New Agent").
describe("cursorExtractor — Task child lineage from subagentInfo", () => {
  const parentId = "parent-composer-aaa";
  const childId = "child-composer-bbb";

  const seedParentAndChild = (path: string, childInfo: object | undefined): void => {
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);");
    const now = Date.now();
    const ins = raw.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)");
    const parent = {
      composerId: parentId,
      createdAt: now - 120_000,
      lastUpdatedAt: now - 60_000,
      name: "Ship Task",
      fullConversationHeadersOnly: [
        { bubbleId: "u1", type: 1 },
        { bubbleId: "a1", type: 2 },
      ],
      modelConfig: { modelName: "composer-2.5" },
      // Deliberately omitted: subagentComposerIds. The child is only linked
      // through its own subagentInfo.
    };
    const child = {
      composerId: childId,
      createdAt: now - 50_000,
      lastUpdatedAt: now - 40_000,
      name: "New Agent",
      fullConversationHeadersOnly: [
        { bubbleId: "cu1", type: 1 },
        { bubbleId: "ca1", type: 2 },
      ],
      ...(childInfo ? { subagentInfo: childInfo } : {}),
    };
    ins.run(`composerData:${parentId}`, JSON.stringify(parent));
    ins.run(`bubbleId:${parentId}:u1`, JSON.stringify({ bubbleId: "u1", type: 1, text: "ship the task" }));
    ins.run(`bubbleId:${parentId}:a1`, JSON.stringify({ bubbleId: "a1", type: 2, text: "working" }));
    ins.run(`composerData:${childId}`, JSON.stringify(child));
    ins.run(`bubbleId:${childId}:cu1`, JSON.stringify({ bubbleId: "cu1", type: 1, text: "review this PR" }));
    ins.run(
      `bubbleId:${childId}:ca1`,
      JSON.stringify({
        bubbleId: "ca1",
        type: 2,
        text: "reviewed",
        tokenCount: { inputTokens: 10, outputTokens: 20 },
      })
    );
    raw.close();
  };

  const lineageOf = (db: SessionStore, sessionId: string) => {
    const row = db
      .raw()
      .prepare("SELECT session_meta, relation_type FROM conversations WHERE ide_type = 'cursor' AND session_id = ?")
      .get(sessionId) as { session_meta: string | null; relation_type: string } | undefined;
    assert.ok(row, `expected a stored conversation for ${sessionId}`);
    const meta = row.session_meta
      ? (JSON.parse(row.session_meta) as { lineage?: { relation_type?: string; parent_record_key?: string; linkage_confidence?: string; tokens?: number } })
      : {};
    return { relation_type: row.relation_type, lineage: meta.lineage };
  };

  let tmpDir: string;
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-cursor-lineage-"));
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: join(tmpDir, "no-cli-chats") });
    setPathOverrides({ CURSOR_CLI_CONFIG_PATH: join(tmpDir, "no-cli-config.json") });
    setPathOverrides({ CURSOR_STATSIG_CACHE_PATH: join(tmpDir, "no-statsig-cache.json") });
  });
  after(() => {
    setPathOverrides({ CURSOR_DB_PATH: undefined });
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: undefined });
    setPathOverrides({ CURSOR_CLI_CONFIG_PATH: undefined });
    setPathOverrides({ CURSOR_STATSIG_CACHE_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("tags the child SUBAGENT from subagentInfo when the parent lists no subagentComposerIds", async () => {
    const cursorDbPath = join(tmpDir, "linked.vscdb");
    seedParentAndChild(cursorDbPath, { parentComposerId: parentId });
    const db = new SessionStore(join(tmpDir, "linked-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });

    assert.equal(await extractCursor(db, { captureLineage: true }), 2);

    const child = lineageOf(db, childId);
    assert.equal(child.relation_type, "SUBAGENT");
    assert.equal(child.lineage?.relation_type, "SUBAGENT");
    assert.equal(child.lineage?.parent_record_key, conversationId("cursor", parentId));
    assert.equal(child.lineage?.linkage_confidence, "STRONG");
    assert.equal(child.lineage?.tokens, 30);

    const parent = lineageOf(db, parentId);
    assert.equal(parent.relation_type, "PRIMARY");
    assert.equal(parent.lineage, undefined);
  });

  it("leaves the child untagged when lineage capture is off", async () => {
    const cursorDbPath = join(tmpDir, "flag-off.vscdb");
    seedParentAndChild(cursorDbPath, { parentComposerId: parentId });
    const db = new SessionStore(join(tmpDir, "flag-off-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });

    assert.equal(await extractCursor(db, { captureLineage: false }), 2);

    const child = lineageOf(db, childId);
    assert.equal(child.relation_type, "PRIMARY");
    assert.equal(child.lineage, undefined);
  });

  it("leaves the child PRIMARY when subagentInfo points at a composer that is not in this cycle", async () => {
    const cursorDbPath = join(tmpDir, "ghost.vscdb");
    seedParentAndChild(cursorDbPath, { parentComposerId: "ghost-composer-zzz" });
    const db = new SessionStore(join(tmpDir, "ghost-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });

    assert.equal(await extractCursor(db, { captureLineage: true }), 2);

    const child = lineageOf(db, childId);
    assert.equal(child.relation_type, "PRIMARY");
    assert.equal(child.lineage, undefined);
    db.close();
  });

  it("leaves the child PRIMARY when the parent parsed but has no user prompt to persist", async () => {
    const cursorDbPath = join(tmpDir, "no-parent-row.vscdb");
    const raw = new DatabaseSync(cursorDbPath);
    raw.exec("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);");
    const now = Date.now();
    const ins = raw.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)");
    ins.run(
      `composerData:${parentId}`,
      JSON.stringify({
        composerId: parentId,
        createdAt: now - 120_000,
        lastUpdatedAt: now - 60_000,
        name: "Ship Task",
        fullConversationHeadersOnly: [{ bubbleId: "a1", type: 2 }],
      })
    );
    ins.run(`bubbleId:${parentId}:a1`, JSON.stringify({ bubbleId: "a1", type: 2, text: "working" }));
    ins.run(
      `composerData:${childId}`,
      JSON.stringify({
        composerId: childId,
        createdAt: now - 50_000,
        lastUpdatedAt: now - 40_000,
        name: "New Agent",
        fullConversationHeadersOnly: [
          { bubbleId: "cu1", type: 1 },
          { bubbleId: "ca1", type: 2 },
        ],
        subagentInfo: { parentComposerId: parentId },
      })
    );
    ins.run(`bubbleId:${childId}:cu1`, JSON.stringify({ bubbleId: "cu1", type: 1, text: "review this PR" }));
    ins.run(
      `bubbleId:${childId}:ca1`,
      JSON.stringify({ bubbleId: "ca1", type: 2, text: "reviewed", tokenCount: { inputTokens: 10, outputTokens: 20 } })
    );
    raw.close();

    const db = new SessionStore(join(tmpDir, "no-parent-row-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });

    assert.equal(await extractCursor(db, { captureLineage: true }), 1);
    assert.equal(lineageOf(db, childId).relation_type, "PRIMARY");
    db.close();
  });

  it("re-stamps lineage on an unchanged child that was stored as PRIMARY", async () => {
    const cursorDbPath = join(tmpDir, "restamp.vscdb");
    seedParentAndChild(cursorDbPath, { parentComposerId: parentId });
    const db = new SessionStore(join(tmpDir, "restamp-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });

    assert.equal(await extractCursor(db, { captureLineage: false }), 2);
    assert.equal(lineageOf(db, childId).relation_type, "PRIMARY");

    assert.equal(await extractCursor(db, { captureLineage: true }), 1, "only the child is re-processed");
    const child = lineageOf(db, childId);
    assert.equal(child.relation_type, "SUBAGENT");
    assert.equal(child.lineage?.parent_record_key, conversationId("cursor", parentId));
    assert.equal(child.lineage?.tokens, 30);
    db.close();
  });

  it("does not restamp a PRIMARY that has already synced", async () => {
    const cursorDbPath = join(tmpDir, "synced.vscdb");
    seedParentAndChild(cursorDbPath, { parentComposerId: parentId });
    const db = new SessionStore(join(tmpDir, "synced-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });

    assert.equal(await extractCursor(db, { captureLineage: false }), 2);
    db.raw()
      .prepare("UPDATE conversations SET sync_status = 'synced', synced_at = datetime('now') WHERE session_id = ?")
      .run(childId);

    assert.equal(await extractCursor(db, { captureLineage: true }), 0);
    assert.equal(lineageOf(db, childId).relation_type, "PRIMARY");
    db.close();
  });

  it("does not restamp a previously ingested PRIMARY after a path patch re-queues it", async () => {
    const cursorDbPath = join(tmpDir, "path-patch.vscdb");
    seedParentAndChild(cursorDbPath, { parentComposerId: parentId });
    const db = new SessionStore(join(tmpDir, "path-patch-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });

    assert.equal(await extractCursor(db, { captureLineage: false }), 2);
    db.raw()
      .prepare("UPDATE conversations SET sync_status = 'synced', synced_at = datetime('now') WHERE session_id = ?")
      .run(childId);
    db.updateProjectPath("cursor", childId, "/tmp/other-repo");

    assert.equal(await extractCursor(db, { captureLineage: true }), 0);
    assert.equal(lineageOf(db, childId).relation_type, "PRIMARY");
    db.close();
  });

  it("corrects a pending child's parent_record_key when subagentInfo disagrees", async () => {
    const cursorDbPath = join(tmpDir, "stale-parent.vscdb");
    seedParentAndChild(cursorDbPath, { parentComposerId: parentId });
    const db = new SessionStore(join(tmpDir, "stale-parent-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });

    assert.equal(await extractCursor(db, { captureLineage: true }), 2);
    const staleKey = conversationId("cursor", "stale-parent-zzz");
    const expectedKey = conversationId("cursor", parentId);
    const rawMeta = db.getSessionMeta("cursor", childId);
    assert.ok(rawMeta);
    const meta = JSON.parse(rawMeta) as { lineage: { parent_record_key: string } };
    meta.lineage.parent_record_key = staleKey;
    db.raw()
      .prepare("UPDATE conversations SET session_meta = ? WHERE session_id = ?")
      .run(JSON.stringify(meta), childId);
    assert.equal(lineageOf(db, childId).lineage?.parent_record_key, staleKey);

    assert.equal(await extractCursor(db, { captureLineage: true }), 1);
    assert.equal(lineageOf(db, childId).lineage?.parent_record_key, expectedKey);
    db.close();
  });

  it("keeps an already-synced SUBAGENT tagged across a content-changing re-read", async () => {
    const cursorDbPath = join(tmpDir, "resync-subagent.vscdb");
    seedParentAndChild(cursorDbPath, { parentComposerId: parentId });
    const db = new SessionStore(join(tmpDir, "resync-subagent-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });

    // First cycle tags the child SUBAGENT; simulate the store completing.
    assert.equal(await extractCursor(db, { captureLineage: true }), 2);
    assert.equal(lineageOf(db, childId).relation_type, "SUBAGENT");
    db.raw()
      .prepare(
        "UPDATE conversations SET sync_status = 'synced', synced_at = datetime('now') WHERE session_id = ?"
      )
      .run(childId);

    // Cursor bumps the child's lastUpdatedAt + content, so the next cycle takes
    // the full re-read path (not the unchanged-skip fast path).
    const raw = new DatabaseSync(cursorDbPath);
    const stored = JSON.parse(
      (
        raw
          .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
          .get(`composerData:${childId}`) as { value: string }
      ).value
    ) as { lastUpdatedAt: number };
    stored.lastUpdatedAt = stored.lastUpdatedAt + 10_000;
    const ins = raw.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)");
    ins.run(`composerData:${childId}`, JSON.stringify(stored));
    ins.run(
      `bubbleId:${childId}:ca1`,
      JSON.stringify({
        bubbleId: "ca1",
        type: 2,
        text: "reviewed again",
        tokenCount: { inputTokens: 10, outputTokens: 20 },
      })
    );
    raw.close();

    // Regression: the ingested child must stay SUBAGENT. Before the lineage
    // freeze it fell back to PRIMARY on this re-read and re-stored as a
    // standalone primary session.
    await extractCursor(db, { captureLineage: true });
    const child = lineageOf(db, childId);
    assert.equal(child.relation_type, "SUBAGENT");
    assert.equal(child.lineage?.relation_type, "SUBAGENT");
    assert.equal(child.lineage?.parent_record_key, conversationId("cursor", parentId));
    db.close();
  });
});

// The estimate is produced whether or not a model is known. An unnamed model is
// priced by a consumer at some generic rate, which can over-state a Cursor
// session — but it keeps the session VISIBLE: a consumer can flag the cost as
// estimated, and an unknown-model counter only fires on prompts that carry billable tokens, so
// withholding the tokens would hide the cohort instead of correcting it. Token volume
// is also model-independent and feeds surfaces that never price anything.
//
// recoverModelFromUsageData below is what makes the estimate *accurate* where Cursor
// recorded the model somewhere; these cases pin that it is never *withheld*.
describe("token estimation is produced even with no model", () => {
  const composer = (contextTokensUsed: number) => ({
    composerId: "c1",
    createdAt: 1,
    lastUpdatedAt: 2,
    name: "t",
    contextTokensUsed,
    fullConversationHeadersOnly: [],
  });

  it("context meter: credits the meter with no model, leaving the model blank", () => {
    const prompts: ConversationPrompt[] = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ];
    applyContextMeterTokenFallback(prompts, composer(120_000), undefined);
    assert.equal(prompts[1]?.metadata?.inputTokens, 120_000);
    assert.equal(prompts[1]?.metadata?.model, undefined);
    assert.equal(promptsHaveBillableTokens(prompts), true);
  });

  it("ide estimation: estimates with no model, so the session stays countable", () => {
    const prompts: ConversationPrompt[] = [
      { role: "user" as const, content: "please sort this list for me" },
      { role: "assistant" as const, content: "here is the sorted list you asked for" },
    ];
    applyIdeTokenEstimationFallback(prompts, composer(50_000), undefined);
    assert.equal(promptsHaveBillableTokens(prompts), true);
    assert.equal(prompts[1]?.metadata?.model, undefined);
  });

  it("stamps the model on every estimated turn when one is known", () => {
    const prompts: ConversationPrompt[] = [
      { role: "user" as const, content: "please sort this list for me" },
      { role: "assistant" as const, content: "here is the sorted list" },
    ];
    applyIdeTokenEstimationFallback(prompts, composer(50_000), "composer-2.5");
    assert.equal(prompts[1]?.metadata?.model, "composer-2.5");
    assert.equal(promptsHaveBillableTokens(prompts), true);
  });
});


// usageData's keys are Cursor model ids, so they are a second local record of what ran.
// Reading them keeps an estimate priceable instead of forcing a choice between an
// inflated cost (unattributed, charged at a consumer's generic default) and no cost.
describe("recoverModelFromUsageData", () => {
  it("recovers the model when usageData names exactly one", () => {
    assert.equal(
      recoverModelFromUsageData({ "composer-2.5": { costInCents: 12 } }),
      "composer-2.5"
    );
  });

  it("recovers Cursor's Auto id, which a consumer prices at the Auto pool rate", () => {
    assert.equal(recoverModelFromUsageData({ default: { costInCents: 30 } }), "default");
  });

  it("declines when several models ran — the turn cannot be assigned to one of them", () => {
    assert.equal(
      recoverModelFromUsageData({ "composer-2.5": { costInCents: 5 }, "claude-4-sonnet": { costInCents: 7 } }),
      undefined
    );
  });

  it("declines on absent or empty usageData", () => {
    assert.equal(recoverModelFromUsageData(undefined), undefined);
    assert.equal(recoverModelFromUsageData({}), undefined);
  });

  it("recovers a model recorded with no cost — the key is the signal, not the cents", () => {
    assert.equal(recoverModelFromUsageData({ "composer-2.5": {} }), "composer-2.5");
  });
});
