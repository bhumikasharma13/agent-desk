// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "./pathResolver";

import { logger } from "../seams/logger";
import type { ConversationPrompt, PromptMetadata } from "../types/session";

/**
 * The single global ledger a user-installed Cursor stop hook writes across every
 * session (IDE and CLI). Cursor itself writes no such file.
 * Relative to the Cursor home so a test can point at a fixture root.
 */
export function cursorStopLedgerPath(cursorDir: string = join(homeDir(), ".cursor")): string {
  return join(cursorDir, "token-events-raw", "stop.jsonl");
}

/**
 * The single previous generation of the stop ledger. loadCursorStopLedger reads it
 * alongside the live file, and rotateCursorStopLedgerIfLarge renames the live file
 * onto it once the live file grows past the cap (see that function).
 */
export function cursorStopLedgerRotatedPath(cursorDir: string = join(homeDir(), ".cursor")): string {
  return join(cursorDir, "token-events-raw", "stop.jsonl.1");
}

/** Live-file size that triggers a rotation. See rotateCursorStopLedgerIfLarge for why this is a byte cap. */
const CURSOR_STOP_LEDGER_MAX_BYTES = 4 * 1024 * 1024;

/**
 * loadCursorStopLedger reads and parses the global stop ledger once per extraction run,
 * returning the per-conversation measured generations. A missing ledger (no such hook
 * is installed) is the normal no-op — an empty map, not an error.
 *
 * It reads BOTH the live file and its one rotated generation (stop.jsonl.1). The rotated
 * file holds the OLDER lines, so it is parsed first: a conversation's generations stay in
 * ledger (turn) order across the split, and parseCursorStopLedger's keep-first dedup
 * collapses any single generation that straddles a rotation to one record — a line already
 * read in a prior cycle is never double-counted.
 */
export function loadCursorStopLedger(cursorDir?: string): Map<string, MeasuredGeneration[]> {
  const path = cursorStopLedgerPath(cursorDir);
  const rotatedPath = cursorStopLedgerRotatedPath(cursorDir);
  if (!existsSync(path) && !existsSync(rotatedPath)) return new Map();
  try {
    const rotated = existsSync(rotatedPath) ? readFileSync(rotatedPath, "utf8") : "";
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    // A stray blank line between the two halves is skipped by the parser's trim.
    const combined = rotated && current ? `${rotated}\n${current}` : rotated || current;
    return parseCursorStopLedger(combined);
  } catch (err) {
    // A read fault must not fail the whole Cursor extraction — measured tokens are an
    // enrichment; without the ledger the session still extracts with estimated tokens.
    logger.warn("extraction.cursor", "stop_ledger_read_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }
}

/**
 * The live stop ledger is append-only: the capture hook adds one line per generation and
 * never trims, so without rotation it grows without bound and is re-read whole every
 * extraction cycle. rotateCursorStopLedgerIfLarge bounds both — once the live file passes
 * `maxBytes` it is atomically renamed onto the single rotated generation (replacing the
 * prior one); the hook's next O_APPEND|O_CREAT starts a fresh live file. Live + rotated is
 * therefore capped at ~2×maxBytes on disk and per read.
 *
 * Rename, not truncate-after-copy: it is atomic against the hook's concurrent O_APPEND
 * writes (possibly from several Cursor windows) — a line appended during rotation lands in
 * exactly one of the two files and is read next cycle, never lost.
 *
 * Retention window, not a consumed-offset: a still-active or settle-window conversation
 * (up to CURSOR_REEXTRACT_SETTLE_WINDOW_MS, 3 days) is re-read WHOLE on a later cycle and
 * re-merged against the ledger, so dropping a line merely because a prior cycle read it
 * would downgrade an already-measured turn back to ESTIMATE. A byte cap comfortably above 3 days of
 * appends keeps that recent history readable while still bounding growth; only history
 * older than the window is dropped.
 *
 * Call once per extraction cycle, AFTER both the IDE and CLI passes have consumed the
 * ledger, so the two reads in one cycle see one consistent snapshot. Fail-open: a rotation
 * fault must never fail Cursor extraction. Returns whether it rotated.
 */
export function rotateCursorStopLedgerIfLarge(
  cursorDir?: string,
  maxBytes: number = CURSOR_STOP_LEDGER_MAX_BYTES,
): boolean {
  const path = cursorStopLedgerPath(cursorDir);
  try {
    if (!existsSync(path)) return false;
    if (statSync(path).size < maxBytes) return false;
    renameSync(path, cursorStopLedgerRotatedPath(cursorDir));
    logger.info("extraction.cursor", "stop_ledger_rotated", { maxBytes });
    return true;
  } catch (err) {
    logger.warn("extraction.cursor", "stop_ledger_rotate_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * A user-installed Cursor stop hook appends one event per generation to a single
 * global ledger, ~/.cursor/token-events-raw/stop.jsonl, each line a JSON object. A completed
 * generation carries measured token counts; an aborted/error generation carries a
 * status but no token fields. The same generation can fire more than once (observed:
 * `aborted` then `error` on one generation_id). Fields read: conversation_id, generation_id, status, input_tokens, output_tokens,
 * cache_read_tokens, cache_write_tokens, model.
 *
 * input_tokens is the FULL prompt count — cache_read_tokens and cache_write_tokens are
 * subsets of it, not disjoint buckets (the Cursor/OpenAI convention, unlike Claude's
 * disjoint input/cache split). The uncached input is input_tokens minus both.
 */
export interface CursorStopEvent {
  conversation_id?: string;
  generation_id?: string;
  status?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  model?: string;
}

/** A generation's measured token counts, ready to merge onto one assistant turn. */
export interface MeasuredGeneration {
  generationId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model?: string;
}

function hasTokens(e: CursorStopEvent): boolean {
  return (
    (e.input_tokens ?? 0) > 0 ||
    (e.output_tokens ?? 0) > 0 ||
    (e.cache_read_tokens ?? 0) > 0 ||
    (e.cache_write_tokens ?? 0) > 0
  );
}

/**
 * parseCursorStopLedger reads the global stop.jsonl and returns, per conversation_id,
 * the token-bearing generations IN LEDGER ORDER — the order the assistant turns fired.
 *
 * Two merge rules, from the recorded hook data: DEDUP by generation_id keeping the token-bearing record (a generation that
 * fired `aborted` then `error` and later `completed` collapses to its completed counts),
 * and SKIP a generation that only ever fired token-less (aborted/error) — never record a
 * zero, so a cancelled turn does not dilute the measured total. A malformed line, or a
 * line with no conversation_id/generation_id, is skipped.
 */
export function parseCursorStopLedger(content: string): Map<string, MeasuredGeneration[]> {
  // Per conversation, keep insertion order of first sighting and dedup by generation_id.
  const byConversation = new Map<string, Map<string, MeasuredGeneration>>();
  let malformed = 0;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e: CursorStopEvent;
    try {
      e = JSON.parse(trimmed) as CursorStopEvent;
    } catch {
      malformed++; // a malformed line is not a reason to drop the whole ledger, but count it
      continue;
    }
    const convId = e.conversation_id;
    const genId = e.generation_id;
    if (!convId || !genId) continue;
    if (!hasTokens(e)) continue; // token-less aborted/error — skip, never zero

    let gens = byConversation.get(convId);
    if (!gens) {
      gens = new Map<string, MeasuredGeneration>();
      byConversation.set(convId, gens);
    }
    // Keep-first among token-bearing records for one generation_id (a generation is one
    // billed response; a repeat token-bearing sighting is the same response re-reported).
    if (!gens.has(genId)) {
      const cacheRead = e.cache_read_tokens ?? 0;
      const cacheWrite = e.cache_write_tokens ?? 0;
      gens.set(genId, {
        generationId: genId,
        // input_tokens is the full prompt and the cache buckets are subsets of it, so the
        // uncached input is the remainder — the measured metadata fields are disjoint, and
        // storing the raw total here would count the cached tokens twice.
        inputTokens: Math.max(0, (e.input_tokens ?? 0) - cacheRead - cacheWrite),
        outputTokens: e.output_tokens ?? 0,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        model: e.model,
      });
    }
  }

  if (malformed > 0) {
    // Bounded to the count: a dropped measured generation is reported without echoing
    // the malformed line's content.
    logger.warn("extraction.cursor", "stop_ledger_malformed_lines", { count: malformed });
  }

  const out = new Map<string, MeasuredGeneration[]>();
  for (const [convId, gens] of byConversation) {
    out.set(convId, [...gens.values()]);
  }
  return out;
}

/**
 * mergeStopHookTokens overlays a session's measured generations onto its assistant turns
 * by an EXACT id join, upgrading each matched turn to MEASURED fidelity.
 *
 * The join key is the generation id: Cursor's store keys each turn by the same id the
 * stop event carries as generation_id (the CLI user blob's providerOptions.cursor.requestId
 * and the IDE bubble's requestId), and the extractor stamps it onto the turn's assistant
 * prompt as `metadata.messageId` before this runs. So a generation attaches to the turn
 * with the same id — never by position, which drifts on retries and cancelled turns. A
 * turn whose generation was cancelled (no token-bearing stop event) has no match and keeps
 * its estimate; a prompt with no stamped id (e.g. an older session with no id) is left
 * untouched. Returns a new array; the input is not mutated.
 */
export function mergeStopHookTokens(
  prompts: ConversationPrompt[],
  generations: MeasuredGeneration[],
): ConversationPrompt[] {
  if (generations.length === 0) return prompts;

  const byId = new Map(generations.map((g) => [g.generationId, g]));
  return prompts.map((p) => {
    if (p.role !== "assistant") return p;
    const genId = p.metadata?.messageId;
    if (!genId) return p;
    const gen = byId.get(genId);
    if (!gen) return p; // no completed stop event for this turn → keep the estimate
    const metadata: PromptMetadata = {
      ...(p.metadata ?? {}),
      messageId: gen.generationId,
      inputTokens: gen.inputTokens,
      outputTokens: gen.outputTokens,
      cacheReadInputTokens: gen.cacheReadTokens,
      cacheCreationInputTokens: gen.cacheWriteTokens,
      tokenFidelity: "TOKEN_FIDELITY_MEASURED",
    };
    // A measured stop event names the model authoritatively; keep an existing model only
    // when the ledger did not report one.
    if (gen.model) metadata.model = gen.model;
    return { ...p, metadata };
  });
}
