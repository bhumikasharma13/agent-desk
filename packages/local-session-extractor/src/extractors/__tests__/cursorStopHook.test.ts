// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { ConversationPrompt } from "../../index";
import { cursorStopLedgerPath, cursorStopLedgerRotatedPath, loadCursorStopLedger, mergeStopHookTokens, parseCursorStopLedger, rotateCursorStopLedgerIfLarge } from "../../internal";

const FIXROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/turn-telemetry");

// The requestid-merge fixture is a real captured stop ledger: 5 stop events on one
// conversation — three completed-with-tokens generations and one generation (f2eac18f)
// that fired `aborted` then `error`, both token-less.
const stopLedger = readFileSync(join(FIXROOT, "cursor/requestid-merge/stop.jsonl"), "utf8");

test("parseCursorStopLedger keeps token-bearing generations in order and skips the token-less dup", () => {
  const byConv = parseCursorStopLedger(stopLedger);

  const gens = byConv.get("82482e6c-3dcc-4e72-af62-d0276b768bd0");
  assert.ok(gens, "the conversation's generations are present");

  // f2eac18f fired only aborted+error (no tokens) → skipped; the three completed remain,
  // in ledger order.
  assert.deepEqual(
    gens!.map((g) => g.generationId),
    [
      "9b18f583-7c56-412c-a29a-b4b5fc68ac05",
      "16c662cf-3b6c-448e-a585-0b6c2922bf2e",
      "2b82cd52-ccbf-48ca-a593-6b8af51dc95e",
    ],
    "the aborted/error-only generation is skipped; the three completed stay in order",
  );

  // inputTokens is the UNCACHED remainder: the ledger's input_tokens (51247) is the full
  // prompt, of which cache_read (10304) is a subset, so 51247 - 10304 - 0 = 40943.
  assert.equal(gens![0]!.inputTokens, 40943);
  assert.equal(gens![0]!.outputTokens, 1100);
  assert.equal(gens![0]!.cacheReadTokens, 10304);
});

test("parseCursorStopLedger tolerates a malformed line and a token-less-only generation", () => {
  const ledger = [
    '{"conversation_id":"c1","generation_id":"g1","status":"completed","input_tokens":10,"output_tokens":2}',
    "not json at all",
    '{"conversation_id":"c1","generation_id":"g2","status":"aborted"}', // token-less → skipped
    '{"conversation_id":"c1","generation_id":"g2","status":"error"}', // same, still skipped
  ].join("\n");

  const gens = parseCursorStopLedger(ledger).get("c1");
  assert.deepEqual(gens!.map((g) => g.generationId), ["g1"], "only the token-bearing generation survives");
});

test("parseCursorStopLedger dedups a generation that re-reports its tokens", () => {
  const ledger = [
    '{"conversation_id":"c1","generation_id":"g1","status":"completed","input_tokens":10,"output_tokens":2}',
    '{"conversation_id":"c1","generation_id":"g1","status":"completed","input_tokens":10,"output_tokens":2}',
  ].join("\n");

  const gens = parseCursorStopLedger(ledger).get("c1");
  assert.equal(gens!.length, 1, "one billed response is one generation, however many times it re-reports");
  assert.equal(gens![0]!.inputTokens, 10);
});

// Generation ids the extractor stamps as metadata.messageId (CLI user blob's
// providerOptions.cursor.requestId / IDE bubble's requestId) key the join, NOT position.
const GEN_A = "9b18f583-7c56-412c-a29a-b4b5fc68ac05"; // input 51247, cache_read 10304 → 40943
const GEN_B = "16c662cf-3b6c-448e-a585-0b6c2922bf2e"; // input 607284, cache_read 549376 → 57908

test("mergeStopHookTokens overlays measured tokens by generation id, not by position", () => {
  const gens = parseCursorStopLedger(stopLedger).get("82482e6c-3dcc-4e72-af62-d0276b768bd0")!;
  // The first assistant turn is generation B and the third is A — reversed vs ledger order —
  // and the middle turn was cancelled (no stamped id). Positional merging would put A on the
  // first turn; the id join must put B there. This is the real retry/cancel case.
  const prompts: ConversationPrompt[] = [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1", metadata: { messageId: GEN_B, model: "old" } },
    { role: "user", content: "q2-cancelled" },
    { role: "assistant", content: "a2" }, // no id → cancelled turn, must stay unmerged
    { role: "user", content: "q3" },
    { role: "assistant", content: "a3", metadata: { messageId: GEN_A } },
  ];

  const merged = mergeStopHookTokens(prompts, gens);

  // a1 takes generation B's tokens (by id), not the ledger's first generation.
  assert.equal(merged[1]!.metadata!.tokenFidelity, "TOKEN_FIDELITY_MEASURED");
  assert.equal(merged[1]!.metadata!.inputTokens, 57908);
  assert.equal(merged[1]!.metadata!.messageId, GEN_B);
  // the cancelled middle turn is untouched.
  assert.equal(merged[3]!.metadata, undefined);
  // a3 takes generation A's tokens (by id).
  assert.equal(merged[5]!.metadata!.tokenFidelity, "TOKEN_FIDELITY_MEASURED");
  assert.equal(merged[5]!.metadata!.inputTokens, 40943);
  // user turns untouched; the input array is not mutated.
  assert.equal(merged[0]!.metadata, undefined);
  assert.equal(prompts[1]!.metadata!.tokenFidelity, undefined);
});

test("mergeStopHookTokens leaves an assistant prompt with no stamped id on its estimate", () => {
  const prompts: ConversationPrompt[] = [
    { role: "assistant", content: "a1", metadata: { inputTokens: 20, tokenFidelity: "TOKEN_FIDELITY_ESTIMATE" } },
  ];
  const gens = [{ generationId: GEN_A, inputTokens: 999, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }];

  const merged = mergeStopHookTokens(prompts, gens);
  assert.equal(merged[0]!.metadata!.inputTokens, 20, "no id → no join → estimate kept");
  assert.equal(merged[0]!.metadata!.tokenFidelity, "TOKEN_FIDELITY_ESTIMATE");
});

test("mergeStopHookTokens keeps the estimate when the turn's id has no completed generation", () => {
  // A cancelled turn: the extractor stamped its requestId, but the ledger has no token-bearing
  // generation for it, so it must keep its estimate rather than be blanked or mis-stamped.
  const prompts: ConversationPrompt[] = [
    { role: "assistant", content: "a1", metadata: { messageId: "cancelled-gen-id", inputTokens: 20, tokenFidelity: "TOKEN_FIDELITY_ESTIMATE" } },
  ];
  const gens = [{ generationId: GEN_A, inputTokens: 999, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }];

  const merged = mergeStopHookTokens(prompts, gens);
  assert.equal(merged[0]!.metadata!.inputTokens, 20, "id present but no matching generation → estimate kept");
  assert.equal(merged[0]!.metadata!.tokenFidelity, "TOKEN_FIDELITY_ESTIMATE");
});

// ── Ledger rotation (bounded growth) ─────────────────────────────────────────
// The live stop.jsonl is append-only and re-read whole every cycle, so it must be
// rotated once past a byte cap. These exercise the real fs path (loadCursorStopLedger
// / rotateCursorStopLedgerIfLarge over a temp cursorDir), not just the pure parser.
// Lines follow the real captured shape (see fixtures/turn-telemetry/cursor/*/stop.jsonl).

function mkCursorDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cursor-stop-ledger-"));
  mkdirSync(dirname(cursorStopLedgerPath(dir)), { recursive: true });
  return dir;
}

const line = (conv: string, gen: string, input: number, output: number): string =>
  JSON.stringify({
    conversation_id: conv,
    generation_id: gen,
    status: "completed",
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    model: "composer-2.5-fast",
  });

test("rotateCursorStopLedgerIfLarge rotates only past the cap, and load loses no generation", () => {
  const dir = mkCursorDir();
  try {
    const ledger = [line("c1", "g1", 100, 10), line("c1", "g2", 200, 20)].join("\n");
    writeFileSync(cursorStopLedgerPath(dir), ledger);

    // Under the cap → no rotation, live file untouched.
    assert.equal(rotateCursorStopLedgerIfLarge(dir, 1024 * 1024), false);
    assert.equal(existsSync(cursorStopLedgerRotatedPath(dir)), false);
    assert.ok(existsSync(cursorStopLedgerPath(dir)));

    // Past the cap → rotate: the live file is renamed onto the rotated generation.
    assert.equal(rotateCursorStopLedgerIfLarge(dir, 1), true);
    assert.equal(existsSync(cursorStopLedgerPath(dir)), false, "live file moved away");
    assert.ok(existsSync(cursorStopLedgerRotatedPath(dir)), "rotated file now holds the lines");

    // The reader still returns every generation — rotation prunes disk, not fidelity.
    const gens = loadCursorStopLedger(dir).get("c1");
    assert.deepEqual(gens!.map((g) => g.generationId), ["g1", "g2"]);
    assert.equal(gens![0]!.inputTokens, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCursorStopLedger reads live + rotated together and does not double-count a straddling generation", () => {
  const dir = mkCursorDir();
  try {
    // g1 already sits in the rotated (already-consumed) half; the live half re-reports
    // g1 (same billed response) and adds a new g2.
    writeFileSync(cursorStopLedgerRotatedPath(dir), line("c1", "g1", 100, 10));
    writeFileSync(cursorStopLedgerPath(dir), [line("c1", "g1", 100, 10), line("c1", "g2", 200, 20)].join("\n"));

    const gens = loadCursorStopLedger(dir).get("c1");
    assert.deepEqual(
      gens!.map((g) => g.generationId),
      ["g1", "g2"],
      "the re-reported g1 collapses to one record (rotated-first order), g2 is picked up",
    );
    assert.equal(gens!.length, 2, "a generation straddling the rotation is not double-counted");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rotation is bounded to two files: a second rotation drops the oldest history", () => {
  const dir = mkCursorDir();
  try {
    // First rotation: g1 becomes the rotated generation.
    writeFileSync(cursorStopLedgerPath(dir), line("c1", "g1", 100, 10));
    assert.equal(rotateCursorStopLedgerIfLarge(dir, 1), true);

    // The hook starts a fresh live file (g2); a second rotation replaces the rotated
    // generation with it, so the oldest history (g1) ages out — growth stays bounded.
    writeFileSync(cursorStopLedgerPath(dir), line("c1", "g2", 200, 20));
    assert.equal(rotateCursorStopLedgerIfLarge(dir, 1), true);

    const gens = loadCursorStopLedger(dir).get("c1");
    assert.deepEqual(gens!.map((g) => g.generationId), ["g2"], "only the most recent generation survives");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
