// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
// The CLI billable-token path must stamp token_fidelity. A Cursor CLI turn carries
// an input total decoded from the store's native context composition (no output/cache
// split), so it is NATIVE_PARTIAL — never left UNSPECIFIED, never a text-length ESTIMATE.
// Mirrors the IDE applyTokenCount discipline (see cursorExtractor.test.ts).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPrompts, type ParsedCliSession } from "../../internal";
import { mergeStopHookTokens, type MeasuredGeneration } from "../../internal";

// A minimal ParsedCliSession in recovered-order mode (conversationEntries set), so the
// user turn's requestId is stamped as the assistant prompt's messageId (the stop-hook join key).
function mkParsed(overrides: Partial<ParsedCliSession> = {}): ParsedCliSession {
  return {
    sessionEvents: [],
    eventCoverage: "EVENT_COVERAGE_NONE",
    userTurns: [{ query: "do a thing", sortKey: 1, requestId: "gen-1" }],
    conversationEntries: [
      { kind: "user", turn: { query: "do a thing", sortKey: 1, requestId: "gen-1" } },
      { kind: "assistant", content: "did the thing", block: "text" },
    ],
    assistantTexts: ["did the thing"],
    toolPlaceholders: [],
    toolCounts: {},
    toolErrors: 0,
    toolErrorCategories: {},
    toolFilePaths: [],
    editedFilePaths: [],
    attributionEvents: [],
    spawnedAgentNames: [],
    prReferences: [],
    estimatedContextChars: 0,
    perTurnInputTokens: [191286],
    contextComposition: [],
    compactionCount: 0,
    usesExtendedThinking: false,
    mcpToolUsed: false,
    ...overrides,
  };
}

describe("cursorCliExtractor — CLI billable-token fidelity", () => {
  it("stamps NATIVE_PARTIAL on a token-bearing CLI turn (native input, no output split)", () => {
    const prompts = buildPrompts(mkParsed(), "composer-2.5");
    const billable = prompts.find((p) => (p.metadata?.inputTokens ?? 0) > 0);
    assert.ok(billable, "expected an assistant prompt carrying the per-turn input total");
    assert.equal(billable!.metadata!.inputTokens, 191286);
    assert.equal(billable!.metadata!.tokenFidelity, "TOKEN_FIDELITY_NATIVE_PARTIAL");
    // Output stays unset on the CLI path — the store logs none.
    assert.equal(billable!.metadata!.outputTokens ?? 0, 0);
  });

  it("leaves a non-billable turn's fidelity absent (only token-bearing turns are stamped)", () => {
    const prompts = buildPrompts(mkParsed({ perTurnInputTokens: [] }), "composer-2.5");
    for (const p of prompts) {
      if ((p.metadata?.inputTokens ?? 0) === 0) {
        assert.equal(p.metadata?.tokenFidelity, undefined);
      }
    }
  });

  it("stop-hook MEASURED still wins — the merge upgrades and never downgrades the baseline", () => {
    const prompts = buildPrompts(mkParsed(), "composer-2.5");
    // Baseline is NATIVE_PARTIAL before the ledger merge.
    const before = prompts.find((p) => (p.metadata?.inputTokens ?? 0) > 0);
    assert.equal(before!.metadata!.tokenFidelity, "TOKEN_FIDELITY_NATIVE_PARTIAL");

    const generations: MeasuredGeneration[] = [
      { generationId: "gen-1", inputTokens: 5000, outputTokens: 1200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ];
    const merged = mergeStopHookTokens(prompts, generations);
    const measured = merged.find((p) => p.metadata?.messageId === "gen-1");
    assert.ok(measured, "expected the id-matched assistant turn");
    assert.equal(measured!.metadata!.tokenFidelity, "TOKEN_FIDELITY_MEASURED");
    assert.equal(measured!.metadata!.inputTokens, 5000);
    assert.equal(measured!.metadata!.outputTokens, 1200);
  });
});
