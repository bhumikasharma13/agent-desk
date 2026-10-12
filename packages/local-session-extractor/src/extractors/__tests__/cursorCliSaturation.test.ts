// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Cursor CLI context-token extraction (saturation, per-turn input tokens,
 * per-segment composition).
 *
 * The CLI store.db records a per-turn context-token composition on its protobuf
 * root/checkpoint blobs: field 5 → 1 (total context tokens, the full re-sent
 * input that turn), 5 → 2 (window), 5 → 3 → 3[] (per-segment breakdown). Top-level
 * field-1 entries (child references) grow monotonically per turn and are the
 * chronological order key (field 26 is a session-level constant).
 *
 * These tests pin the wire-format reader + the derived signals against BOTH a
 * real captured blob and synthetic ones: saturation = peak/window, the
 * "real-if-present / char-estimate-if-absent" resolver, the ordered per-turn
 * input-token sequence landing on assistant prompts, and context_composition
 * from the peak turn.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readContextComposition, contextUsagePercentFromTokens, estimateContextUsagePercent, resolveCliContextUsagePercent, parseCliBlobs, buildPrompts, type ParsedCliSession } from "../../internal";

// A root/checkpoint blob captured from a live `cursor-agent` store.db, with its
// home path and time zone replaced by same-length placeholders — the session's
// PEAK turn. field 5 → 1 = 6652 (== the segment-token sum), 5 → 2 =
// 200000, and 8 segments (conversation dominates). Base64 so the exact bytes
// survive in-repo.
const REAL_COMPOSITION_BLOB_B64 =
  "CiChRAoYpwGzO6z2V6DAYbX9G+yHkunMl6Lg/GiGDvqSRwogAhqbXRN2bUIJsjGnCA/Q4ShhPShxqfos7EctG9wx/xsKIO0rtGM5tG6uCB7kl5DgCzRSwk5yXQ2kRQoVBHTAHuNnCiDokoj1XRao0GMExbUazlxh1niqodL8YjgagZVfM004XwogQHSf+kLSAd2cN3owlowFXPT8oFe+GbcbbjMtBTxAJBEKINPaIcGqbF7sYgyG9lzXu1oesgrDhGctw/t9Cu3ra1s6CiBgsCG5EVlHTuQYjILCa3FOrYgGJHSa7/aGk1VFsjhsmwogVyKEZOfSW37uAU3/bOfvxMCtSSb9/gU0TIgrozDcmgEqowII/DMQwJoMGpkCCPwzEMCaDBokCg1zeXN0ZW1fcHJvbXB0Eg1TeXN0ZW0gcHJvbXB0GPEDILAQGh8KBXRvb2xzEhBUb29sIGRlZmluaXRpb25zGJsIIMsiGhQKBXJ1bGVzEgVSdWxlcxj1FiDGYBoWCgZza2lsbHMSBlNraWxscxjXCSDkKBocCgNtY3ASE01DUCAmIGR5bmFtaWMgdG9vbHMgABojCglzdWJhZ2VudHMSFFN1YmFnZW50IGRlZmluaXRpb25zIAAaNAoXc3VtbWFyaXplZF9jb252ZXJzYXRpb24SF1N1bW1hcml6ZWQgY29udmVyc2F0aW9uIAAaIgoMY29udmVyc2F0aW9uEgxDb252ZXJzYXRpb24YpAcg1B5CIITI2IILmhF/atD6hpXUg8HO3onvPn4KGWCgRVs0zezRShdmaWxlOi8vL1VzZXJzL2pkb2UxL3BvY1ACsgEDY2xp0AG5ir7X9DPaAQ1FdGMvR3JlZW53aWNo";

const realCompositionBlob = (): Buffer => Buffer.from(REAL_COMPOSITION_BLOB_B64, "base64");

// ── synthetic protobuf helpers ────────────────────────────────────────────────

function encodeVarint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return out;
}

function lenDelim(field: number, payload: number[]): number[] {
  return [(field << 3) | 2, ...encodeVarint(payload.length), ...payload];
}

function segment(id: string, tokens: number, chars: number): number[] {
  const idBytes = [...Buffer.from(id, "utf8")];
  const body = [
    ...lenDelim(1, idBytes), // field 1: id (string)
    (3 << 3) | 0, ...encodeVarint(tokens), // field 3: tokens
    (4 << 3) | 0, ...encodeVarint(chars), // field 4: chars
  ];
  return lenDelim(3, body); // a segment is a field-3 entry of the inner composition
}

/**
 * Builds a root/checkpoint protobuf blob:
 *  - `refs` top-level field-1 child references (the chronological order key),
 *  - field 5 = { 1: total, 2: window, 3: { 1: total, 2: window, 3[]: segments } }.
 */
function synthCompositionBlob(
  total: number,
  window: number,
  opts: { refs?: number; segments?: Array<[string, number, number]> } = {}
): Buffer {
  const refs = opts.refs ?? 1;
  const parts: number[] = [];
  for (let i = 0; i < refs; i++) parts.push(...lenDelim(1, [i & 0xff])); // field 1 refs
  const inner = [
    (1 << 3) | 0, ...encodeVarint(total),
    (2 << 3) | 0, ...encodeVarint(window),
    ...(opts.segments ?? []).flatMap(([id, t, c]) => segment(id, t, c)),
  ];
  const comp = [
    (1 << 3) | 0, ...encodeVarint(total),
    (2 << 3) | 0, ...encodeVarint(window),
    ...lenDelim(3, inner), // 5 → 3 = inner composition holding the segments at 5 → 3 → 3
  ];
  parts.push(...lenDelim(5, comp));
  return Buffer.from(parts);
}

/** A role=user JSON message blob buffer with a <user_query> + <timestamp>. */
function jsonUserBlob(query: string, ts: string): Buffer {
  const text = `<timestamp>${ts}</timestamp>\n<user_query>\n${query}\n</user_query>`;
  return Buffer.from(
    JSON.stringify({ role: "user", content: [{ type: "text", text }] }),
    "utf8"
  );
}

// ── readContextComposition / readContextTokensFromBlob ────────────────────────

describe("readContextComposition", () => {
  it("reads total, window, refCount, and 8 segments from a real captured blob", () => {
    const comp = readContextComposition(realCompositionBlob());
    assert.ok(comp);
    assert.equal(comp.totalTokens, 6652);
    assert.equal(comp.windowTokens, 200000);
    assert.equal(comp.segments.length, 8);
    // Segment token counts sum exactly to the total.
    assert.equal(comp.segments.reduce((s, x) => s + x.tokens, 0), 6652);
    assert.deepEqual(comp.segments.map((s) => s.segment), [
      "system_prompt", "tools", "rules", "skills",
      "mcp", "subagents", "summarized_conversation", "conversation",
    ]);
    assert.deepEqual(comp.segments[0], { segment: "system_prompt", tokens: 497, chars: 2096 });
    // A zero-token segment keeps tokens=0 (field 3 absent in wire).
    assert.equal(comp.segments.find((s) => s.segment === "mcp")!.tokens, 0);
  });

  it("reads a synthetic blob's segments (5 → 3 → 3 layout)", () => {
    const comp = readContextComposition(
      synthCompositionBlob(100, 200000, {
        refs: 3,
        segments: [["system_prompt", 40, 160], ["conversation", 60, 240]],
      })
    );
    assert.ok(comp);
    assert.equal(comp.totalTokens, 100);
    assert.equal(comp.refCount, 3);
    assert.deepEqual(comp.segments, [
      { segment: "system_prompt", tokens: 40, chars: 160 },
      { segment: "conversation", tokens: 60, chars: 240 },
    ]);
  });

  it("truncates an over-long segment id and caps segment count", () => {
    const many: Array<[string, number, number]> = [];
    for (let i = 0; i < 100; i++) many.push(["x".repeat(200), 1, 1]);
    const comp = readContextComposition(synthCompositionBlob(100, 200000, { segments: many }));
    assert.ok(comp);
    assert.equal(comp.segments.length, 64); // MAX_CONTEXT_SEGMENTS
    assert.equal(comp.segments[0]!.segment.length, 64); // MAX_SEGMENT_ID_CHARS
  });

  it("returns undefined for JSON / random / small-window / empty blobs", () => {
    assert.equal(readContextComposition(jsonUserBlob("hi", "x")), undefined);
    assert.equal(readContextComposition(Buffer.from([0xff, 0xff, 0xff, 0x07])), undefined);
    assert.equal(readContextComposition(Buffer.alloc(0)), undefined);
    assert.equal(readContextComposition(synthCompositionBlob(10, 42)), undefined); // window < 1000
  });

  it("rejects a top-level field 5 with two varints but NO segment breakdown", () => {
    // A false-positive shape: field 5 = { 1: 500000, 2: 5000 } and no field 3.
    // window >= 1000 passes, but the missing field-3 breakdown rejects it.
    const comp = [(1 << 3) | 0, ...encodeVarint(500000), (2 << 3) | 0, ...encodeVarint(5000)];
    const blob = Buffer.from([(5 << 3) | 2, ...encodeVarint(comp.length), ...comp]);
    assert.equal(readContextComposition(blob), undefined);
  });

  it("rejects an overflow (>2^53) varint total rather than propagating a bogus number", () => {
    // 10 continuation bytes → a value far past Number.MAX_SAFE_INTEGER.
    const bigVarint = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f];
    const comp = [(1 << 3) | 0, ...bigVarint, (2 << 3) | 0, ...encodeVarint(200000), ...segment("x", 1, 1)];
    const blob = Buffer.from([(5 << 3) | 2, ...encodeVarint(comp.length), ...comp]);
    assert.equal(readContextComposition(blob), undefined);
  });
});

// ── percent computation ───────────────────────────────────────────────────────

describe("contextUsagePercentFromTokens", () => {
  it("computes total/window as a 0-100 int (real captured values → 3%)", () => {
    assert.equal(contextUsagePercentFromTokens(6652, 200000), 3);
  });
  it("clamps to 100 when the context overflowed the window", () => {
    assert.equal(contextUsagePercentFromTokens(250000, 200000), 100);
  });
  it("returns undefined for non-positive inputs", () => {
    assert.equal(contextUsagePercentFromTokens(0, 200000), undefined);
    assert.equal(contextUsagePercentFromTokens(6652, 0), undefined);
  });
});

// ── resolver: real-if-present, estimate-if-absent ─────────────────────────────

const baseParsed = (over: Partial<ParsedCliSession>): ParsedCliSession => ({
  sessionEvents: [],
  eventCoverage: "EVENT_COVERAGE_NONE",
  userTurns: [],
  conversationEntries: [],
  assistantTexts: [],
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
  perTurnInputTokens: [],
  contextComposition: [],
  compactionCount: 0,
  usesExtendedThinking: false,
  mcpToolUsed: false,
  ...over,
});

describe("resolveCliContextUsagePercent", () => {
  it("uses the REAL token composition when present (ignores the char estimate)", () => {
    const parsed = baseParsed({
      maxContextTokens: 6652,
      contextWindowTokens: 200000,
      estimatedContextChars: 8_000_000,
    });
    assert.equal(resolveCliContextUsagePercent(parsed), 3);
  });
  it("falls back to the char estimate when no field-5 block was found", () => {
    const chars = 400_000; // 400k / 4 / 200k = 50%
    const parsed = baseParsed({ estimatedContextChars: chars });
    assert.equal(resolveCliContextUsagePercent(parsed), estimateContextUsagePercent(chars));
    assert.equal(resolveCliContextUsagePercent(parsed), 50);
  });
});

// ── parseCliBlobs end-to-end (saturation + per-turn tokens + composition) ─────

describe("parseCliBlobs emits the loop timeline", () => {
  // The builder has its own tests; this one guards the WIRING. A timeline that is built
  // and never returned costs a full parse per session and reports every CLI session as
  // having observed nothing — the failure is silent, so only an end-to-end assert catches it.
  it("returns the tool timeline for a session that ran a tool", () => {
    const call = {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "t1", toolName: "Shell", args: { command: "go build ./..." } }],
    };
    const result = {
      role: "tool",
      id: "call-9f8e7d6c-0\nfc_msg_0",
      content: [{ type: "tool-result", toolCallId: "t1", result: "Exit code: 0" }],
    };
    const parsed = parseCliBlobs([
      { data: Buffer.from(JSON.stringify(call), "utf8") },
      { data: Buffer.from(JSON.stringify(result), "utf8") },
    ]);

    assert.equal(parsed.sessionEvents.length, 2, "one call + one result reach the row");
    assert.equal(parsed.sessionEvents[0]?.kind, "SESSION_EVENT_KIND_TOOL_CALL");
    assert.equal(parsed.sessionEvents[1]?.outcome, "SESSION_EVENT_OUTCOME_SUCCEEDED");
    assert.equal(parsed.eventCoverage, "EVENT_COVERAGE_COMPLETE");
  });

  it("reports NONE for a session that ran no tools, rather than omitting the field", () => {
    const parsed = parseCliBlobs([
      { data: jsonUserBlob("just a question", "Fri, Jul 10, 2026, 1:00 PM (UTC+5:30)") },
    ]);
    assert.deepEqual(parsed.sessionEvents, []);
    assert.equal(parsed.eventCoverage, "EVENT_COVERAGE_NONE");
  });
});

describe("parseCliBlobs context extraction", () => {
  it("derives peak, per-turn sequence (ordered by refs, deduped), and composition", () => {
    const parsed = parseCliBlobs([
      { data: jsonUserBlob("q", "Fri, Jul 10, 2026, 1:00 PM (UTC+5:30)") },
      // Two checkpoints per turn (the store double-writes) + growth, rows out of
      // order — refCount (not total, not row order) is the chronological key.
      { data: synthCompositionBlob(30776, 200000, { refs: 20, segments: [["conversation", 30776, 1]] }) },
      { data: synthCompositionBlob(6652, 200000, { refs: 8 }) },
      { data: synthCompositionBlob(6652, 200000, { refs: 8 }) }, // duplicate total
      { data: synthCompositionBlob(12479, 200000, { refs: 14 }) },
      { data: synthCompositionBlob(30776, 200000, { refs: 21 }) }, // dup total, higher refs
    ]);
    // Ordered by refCount, deduped by total value → chronological per-turn inputs.
    assert.deepEqual(parsed.perTurnInputTokens, [6652, 12479, 30776]);
    // Peak drives saturation + composition.
    assert.equal(parsed.maxContextTokens, 30776);
    assert.equal(parsed.contextWindowTokens, 200000);
    assert.deepEqual(parsed.contextComposition, [{ segment: "conversation", tokens: 30776, chars: 1 }]);
    assert.equal(resolveCliContextUsagePercent(parsed), 15); // 30776/200000
  });

  it("keeps two REAL turns with an equal total (non-adjacent), not just the first", () => {
    // 1000 recurs at refs 7 AFTER a different-total turn (2000) — a real later turn
    // that re-hit the same total, NOT a double-write. Both 1000s must survive.
    const parsed = parseCliBlobs([
      { data: synthCompositionBlob(1000, 200000, { refs: 5 }) },
      { data: synthCompositionBlob(2000, 200000, { refs: 6 }) },
      { data: synthCompositionBlob(1000, 200000, { refs: 7 }) },
    ]);
    assert.deepEqual(parsed.perTurnInputTokens, [1000, 2000, 1000]);
  });

  it("collapses a double-write (adjacent equal total, different refCount)", () => {
    // One checkpoint double-written: same total 1000 at adjacent refCounts 5 and 6.
    // Only ONE 1000 survives; the later distinct turn (2000) is kept.
    const parsed = parseCliBlobs([
      { data: synthCompositionBlob(1000, 200000, { refs: 5 }) },
      { data: synthCompositionBlob(1000, 200000, { refs: 6 }) },
      { data: synthCompositionBlob(2000, 200000, { refs: 7 }) },
    ]);
    assert.deepEqual(parsed.perTurnInputTokens, [1000, 2000]);
  });

  it("keeps two equal-total turns straddling a zero-total checkpoint (adjacency break)", () => {
    // A zero-total checkpoint at refs 6 sits between two 1000-total turns. It is not
    // emitted (only totals > 0 are), but it must still break the consecutive run so
    // BOTH 1000s survive — adjacency is judged against the previous checkpoint, not
    // the last emitted value.
    const parsed = parseCliBlobs([
      { data: synthCompositionBlob(1000, 200000, { refs: 5 }) },
      { data: synthCompositionBlob(0, 200000, { refs: 6 }) },
      { data: synthCompositionBlob(1000, 200000, { refs: 7 }) },
    ]);
    assert.deepEqual(parsed.perTurnInputTokens, [1000, 1000]);
  });

  it("preserves a real drop (summarization) in per-turn order, not by sorting totals", () => {
    const parsed = parseCliBlobs([
      { data: synthCompositionBlob(169340, 272000, { refs: 133 }) },
      { data: synthCompositionBlob(167271, 272000, { refs: 136 }) }, // drop AFTER, higher refs
      { data: synthCompositionBlob(171058, 272000, { refs: 137 }) },
    ]);
    assert.deepEqual(parsed.perTurnInputTokens, [169340, 167271, 171058]);
    assert.equal(parsed.maxContextTokens, 171058);
  });

  it("leaves token fields empty (char fallback) for a JSON-only session", () => {
    const parsed = parseCliBlobs([
      { data: jsonUserBlob("only prompt", "Fri, Jul 10, 2026, 1:00 PM (UTC+5:30)") },
    ]);
    assert.equal(parsed.maxContextTokens, undefined);
    assert.deepEqual(parsed.perTurnInputTokens, []);
    assert.deepEqual(parsed.contextComposition, []);
    assert.equal(
      resolveCliContextUsagePercent(parsed),
      estimateContextUsagePercent(parsed.estimatedContextChars)
    );
  });

  it("reads the real captured blob end-to-end", () => {
    const parsed = parseCliBlobs([
      { data: jsonUserBlob("q", "Fri, Jul 10, 2026, 1:00 PM (UTC+5:30)") },
      { data: realCompositionBlob() },
    ]);
    assert.equal(parsed.maxContextTokens, 6652);
    assert.deepEqual(parsed.perTurnInputTokens, [6652]);
    assert.equal(parsed.contextComposition.length, 8);
    assert.equal(resolveCliContextUsagePercent(parsed), 3);
  });
});

// ── buildPrompts: per-turn input tokens land on assistant prompts, in order ───

describe("buildPrompts per-turn input tokens", () => {
  it("attaches the chronological per-turn totals to assistant prompts in order; output unset", () => {
    const parsed = baseParsed({
      userTurns: [{ query: "do it", sortKey: 1, iso: "2026-07-10T07:30:00.000Z" }],
      assistantTexts: ["thinking..."],
      toolPlaceholders: ["[Tool: Read]", "[Tool: Grep]"],
      perTurnInputTokens: [6652, 12479, 30776],
    });
    const prompts = buildPrompts(parsed, "default");
    const assistants = prompts.filter((p) => p.role === "assistant");
    assert.deepEqual(
      assistants.map((p) => p.metadata?.inputTokens),
      [6652, 12479, 30776]
    );
    // outputTokens never set on any prompt.
    assert.ok(prompts.every((p) => p.metadata?.outputTokens === undefined));
    assert.equal(assistants[0]!.metadata?.model, "default");
  });

  it("leaves inputTokens unset when there are no per-turn totals", () => {
    const parsed = baseParsed({ assistantTexts: ["hi"], perTurnInputTokens: [] });
    const prompts = buildPrompts(parsed, undefined);
    const asst = prompts.find((p) => p.role === "assistant")!;
    assert.equal(asst.metadata?.inputTokens, undefined);
  });

  it("folds surplus totals onto the last prompt when contents < totals (no drop)", () => {
    // Reasoning-only / interrupted turns produced fewer content blocks than the
    // number of per-turn context totals. The trailing (largest) totals must NOT be
    // dropped: the summed input tokens must equal the sum of all per-turn totals.
    const parsed = baseParsed({
      assistantTexts: ["only text"],
      toolPlaceholders: [],
      perTurnInputTokens: [100, 200, 300],
    });
    const prompts = buildPrompts(parsed, undefined);
    const assistants = prompts.filter((p) => p.role === "assistant");
    assert.equal(assistants.length, 1);
    const summed = assistants.reduce((s, p) => s + (p.metadata?.inputTokens ?? 0), 0);
    assert.equal(summed, 600); // 100 + 200 + 300 — nothing dropped
  });

  it("emits a carrier prompt for totals when there are zero content blocks", () => {
    const parsed = baseParsed({
      assistantTexts: [],
      toolPlaceholders: [],
      perTurnInputTokens: [100, 200],
    });
    const prompts = buildPrompts(parsed, undefined);
    const assistants = prompts.filter((p) => p.role === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0]!.metadata?.inputTokens, 300); // both totals carried, none dropped
  });

  it("stamps one total per on-chain assistant blob, not per prompt", () => {
    // One blob expanded to text + two tool placeholders; the next blob is text-only.
    // Pinning per-prompt would put 6652/12479/0 on the first three prompts and 0 on "done".
    const parsed = baseParsed({
      conversationEntries: [
        { kind: "user", turn: { query: "do it", sortKey: 1 } },
        { kind: "assistant", content: "thinking...", blobId: "a1", block: "text" },
        { kind: "assistant", content: "[Tool: Read]", blobId: "a1", block: "tool" },
        { kind: "assistant", content: "[Tool: Grep]", blobId: "a1", block: "tool" },
        { kind: "user", turn: { query: "and then", sortKey: 2 } },
        { kind: "assistant", content: "done", blobId: "a2", block: "text" },
      ],
      perTurnInputTokens: [6652, 12479],
    });
    const prompts = buildPrompts(parsed, undefined);
    const assistants = prompts.filter((p) => p.role === "assistant");
    assert.deepEqual(
      assistants.map((p) => p.metadata?.inputTokens),
      [6652, undefined, undefined, 12479],
    );
    const summed = assistants.reduce((s, p) => s + (p.metadata?.inputTokens ?? 0), 0);
    assert.equal(summed, 6652 + 12479);
  });

  it("keeps model on every prompt of a grouped blob, not only the first", () => {
    const parsed = baseParsed({
      conversationEntries: [
        { kind: "assistant", content: "thinking...", blobId: "a1", block: "text" },
        { kind: "assistant", content: "[Tool: Read]", blobId: "a1", block: "tool" },
      ],
      perTurnInputTokens: [6652],
    });
    const prompts = buildPrompts(parsed, "default");
    const assistants = prompts.filter((p) => p.role === "assistant");
    assert.deepEqual(
      assistants.map((p) => p.metadata?.model),
      ["default", "default"],
    );
    assert.deepEqual(
      assistants.map((p) => p.metadata?.inputTokens),
      [6652, undefined],
    );
  });

  it("folds surplus totals onto the last blob group, not the last placeholder", () => {
    const parsed = baseParsed({
      conversationEntries: [
        { kind: "assistant", content: "a", blobId: "a1", block: "text" },
        { kind: "assistant", content: "[Tool: Read]", blobId: "a1", block: "tool" },
        { kind: "assistant", content: "b", blobId: "a2", block: "text" },
      ],
      perTurnInputTokens: [100, 200, 300],
    });
    const prompts = buildPrompts(parsed, undefined);
    const assistants = prompts.filter((p) => p.role === "assistant");
    assert.deepEqual(
      assistants.map((p) => p.metadata?.inputTokens),
      [100, undefined, 500],
    );
    const summed = assistants.reduce((s, p) => s + (p.metadata?.inputTokens ?? 0), 0);
    assert.equal(summed, 600);
  });
});
