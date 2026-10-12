// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Shared per-scan parse cache for Claude Code JSONL transcripts. Every reader of
 * a changed transcript in one scan gets the same parsed lines, parsed once per
 * (path, mtime, size).
 *
 * Readers tolerate lines identically — trim, skip empty, skip a line that fails
 * JSON.parse or is not an object — so this returns exactly the non-empty lines
 * that parse to an object, and each reader casts them to its own shape.
 *
 * Lifetime: resetTranscriptCache() is called at the start of the Claude Code
 * extraction pass so parsed lines never persist past their scan; an LRU cap
 * additionally bounds a first scan where thousands of transcripts change at
 * once. Populated lazily — only a file a reader actually reads is cached.
 *
 * Pure fs.
 */
import { statSync, readFileSync } from "node:fs";
import { logger } from "../seams/logger";
import { lruSet } from "../util/lruMap";

const SUB = "extraction.transcript_cache";

// Pathological-file fuse: skips a runaway file that would otherwise dominate a
// scan's latency and memory. A skipped file logs and yields null; the reader
// skips it. The Codex reader holds its rollouts to the same limit, before and
// after decompression, and reports a file past it.
export const MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024;

// Distinct transcripts held at once. Steady state changes a handful per cycle;
// the cap only bites on a first-run backfill, trading some re-parsing for a
// hard memory bound.
const MAX_ENTRIES = 256;

export interface ParsedTranscript {
  stat: { mtimeMs: number; size: number };
  /** JSON.parse of each non-empty, trimmed line that is an object; any other line is skipped. */
  lines: unknown[];
  /** How many non-empty lines failed to parse or are not an object. */
  malformedLines: number;
}

const cache = new Map<string, { key: string; parsed: ParsedTranscript }>();

/**
 * Drop all cached transcripts. Called at the start of each Claude Code
 * extraction cycle so parsed lines live only for the cycle that reads them.
 */
export function resetTranscriptCache(): void {
  cache.clear();
}

/**
 * Parse a transcript once per (path, mtime, size), shared across its readers. Returns null for a stat/read failure or a file past the fuse
 * (logged) — the caller treats null as "skip this file".
 *
 * `knownStat` lets a caller that already stat'd the path (to check a memo of
 * its own before deciding whether to call in here at all) hand the result
 * down instead of paying for a second `statSync` on the same file.
 */
export function getParsedTranscript(
  path: string,
  knownStat?: { mtimeMs: number; size: number },
): ParsedTranscript | null {
  // A caller that has already stat'd this path — to test a memo of its own —
  // passes the result rather than making us repeat the syscall. Every file on
  // this walk is stat'd exactly once either way; without this, adding a memo
  // upstream would double the syscall count on the hot path.
  let st: { mtimeMs: number; size: number };
  if (knownStat !== undefined) {
    st = knownStat;
  } else {
    try {
      st = statSync(path);
    } catch (err) {
      logger.warn(SUB, "transcript_stat_failed", {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
  if (st.size > MAX_TRANSCRIPT_BYTES) {
    logger.warn(SUB, "transcript_too_large_skipped", { path, size: st.size });
    return null;
  }
  const key = `${Math.floor(st.mtimeMs)}:${st.size}`;
  const hit = cache.get(path);
  if (hit && hit.key === key) return hit.parsed;

  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (err) {
    logger.warn(SUB, "transcript_read_failed", {
      path,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const lines: unknown[] = [];
  let malformedLines = 0;
  for (const rawLine of content.split("\n")) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;
    let line: unknown;
    try {
      line = JSON.parse(trimmed);
    } catch {
      // A corrupt line degrades that line only — both consumers skip it.
      malformedLines++;
      continue;
    }
    // A record is an object; `null`, `42`, `"x"` or `[]` is skipped like a corrupt line.
    if (line === null || typeof line !== "object" || Array.isArray(line)) malformedLines++;
    else lines.push(line);
  }
  const parsed: ParsedTranscript = { stat: { mtimeMs: Math.floor(st.mtimeMs), size: st.size }, lines, malformedLines };
  // lruSet evicts the oldest entry once MAX_ENTRIES is exceeded (the first
  // scan's backfill, which the cap exists for).
  lruSet(cache, path, { key, parsed }, MAX_ENTRIES);
  return parsed;
}
