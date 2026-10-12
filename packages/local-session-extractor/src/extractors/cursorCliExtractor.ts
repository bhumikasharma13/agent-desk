// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Cursor terminal-CLI (`cursor-agent`) extractor.
 *
 * Reads the CLI's own native store — ~/.cursor/chats/<wsHash>/<uuid>/ — which no
 * other extractor touches. Each session dir has:
 *   - meta.json : { hasConversation, title, cwd, createdAtMs, updatedAtMs }
 *     — top-level sessions only. A Task-spawned child has no sidecar.
 *   - store.db  : a content-addressed blob store (a plain SQLite file):
 *       · meta table, single row key "0" = hex-encoded JSON
 *         { agentId, name, mode, lastUsedModel, createdAt, latestRootBlobId,
 *           subagentInfo? } — present iff this store is a Task-spawned child
 *         ({ parentAgentId, rootParentAgentId, toolCallId, typeName }).
 *       · blobs table: JSON message blobs (role user/assistant/tool/system) +
 *         protobuf root/checkpoint blobs (non-UTF8 → not JSON-parsed).
 *
 * This is the same *pattern* as the Claude Code / Codex extractors (stat dedup,
 * skip-if-no-user-prompts, cost-unknown, precedence dedup via `seen`) but with
 * Cursor-native parsing. Prompts, tools, git/PR attribution, and real
 * per-message timestamps come out.
 *
 * Tokens: the store records a per-turn context-token composition on its protobuf
 * root/checkpoint blobs (field 5 → total context tokens + window + a per-segment
 * breakdown; the INPUT side of the context). We decode it for three things:
 *   - the session's real context-saturation % (peak total / window; char estimate
 *     fallback only when no field-5 block exists),
 *   - per-turn INPUT tokens: each turn's full re-sent context total is emitted on
 *     the first assistant prompt of that turn (text + tool placeholders from one
 *     blob share one total), so a consumer derives an input-only cost
 *     (a lower bound), and
 *   - the peak turn's per-segment composition → SessionMeta.context_composition.
 * OUTPUT tokens and cost are still absent — the store logs neither — so the cost
 * is input-only, never full billing (see cursorSessionRow.ts).
 *
 * Blobs are content-addressed and unordered in the table. Conversation order is
 * recovered from the protobuf root (meta.latestRootBlobId): top-level field 1 is
 * the SHA-256 of each child blob (32 raw bytes = blobs.id), and field 13 points
 * at prior-era roots after a context summarization. User turns still carry a
 * <timestamp> tag for user_message_timestamps; assistant/tool content is emitted
 * in that recovered order rather than aggregated after every user turn.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  MAX_CONTEXT_SEGMENTS,
  MAX_SEGMENT_ID_CHARS,
  type ContextSegment,
  type ConversationPrompt,
  type InstallationMetadata,
  type PromptMetadata,
  type SessionLineagePayload,
} from "../types/session";
import type { SessionSink } from "../types/store";
import { conversationId, sumPromptTokens } from "../store/ids";
import { SQLiteReader } from "./sqliteReader";
import { getCursorCliChatsPath, getCursorCliChatsRoots, getCursorCliConfigPath, getCursorStatsigCachePath } from "./pathResolver";
import { resolveProjectAndRepo, getFullSessionDiffStats, getSessionPRLink, canonicalRepoKey } from "./gitUtils";
import {
  collectCursorAttribution,
  isAuthoringPRCommand,
  type AttributionEvent,
  type PRRef,
} from "./cursorAttributionSignals";
import { findAllPRUrlsInText } from "./prUrlParser";
import { deriveLanguages } from "./languageMap";
import { writtenLineCount } from "./lineCount";
import { buildCursorSessionRow } from "./cursorSessionRow";
import type { SessionEvent, EventCoverage } from "./sessionEvents";
import { buildCliSessionEvents } from "./cursorCliSessionEvents";
import { readCursorMcpServerNames, toolArgPreview } from "./cursorShared";
import { extractCursorStatsigAccount } from "./planTierDetector";
import { readCachedSeatTierStamp, type SeatTierMetaReader } from "../seams/seatTier";
import { logger } from "../seams/logger";
import { reportRecordError } from "../seams/scanScope";
import { loadCursorStopLedger, mergeStopHookTokens, type MeasuredGeneration } from "./cursorStopHook";

// ── store.db shapes ──────────────────────────────────────────────────────────

/** Task-spawned child's own identity, from the store.db `meta` row. Field names
 *  are Cursor's (`typeName`, not `subagentType`) — grounded against live stores. */
interface CliSubagentInfo {
  parentAgentId?: string;
  rootParentAgentId?: string;
  toolCallId?: string;
  typeName?: string;
}

interface CliChildLink {
  parentId: string;
  origin_agent_type?: string;
  tool_use_id?: string;
}

/** store.db mtime+size+wal plus sidecar mtime of dirs we opened and rejected
 *  (orphan / incomplete / empty). Not a tracking row — those dirs never persist —
 *  so without this they reopen every cycle once captureLineage drops the
 *  no-sidecar skip. Parent-missing children are not stored here: their bytes
 *  may be unchanged when the parent appears. Sidecar mtime is in the key
 *  because Cursor rewrites meta.json without touching store.db. */
const cliStoreNegativeSkip = new Map<
  string,
  { mtimeMs: number; size: number; walSize: number; sidecarMtimeMs: number }
>();

function cliStoreNegativeSkipHit(
  storeDbPath: string,
  mtimeMs: number,
  size: number,
  walSize: number,
  sidecarMtimeMs: number,
): boolean {
  const prev = cliStoreNegativeSkip.get(storeDbPath);
  return (
    !!prev &&
    prev.mtimeMs === mtimeMs &&
    prev.size === size &&
    prev.walSize === walSize &&
    prev.sidecarMtimeMs === sidecarMtimeMs
  );
}

interface CliMetaRow {
  agentId?: string;
  name?: string;
  mode?: string;
  lastUsedModel?: string;
  createdAt?: number;
  latestRootBlobId?: string;
  subagentInfo?: CliSubagentInfo;
}

interface CliMetaJson {
  hasConversation?: boolean;
  title?: string;
  cwd?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
}

// One assistant content block: text | tool-call | (redacted-)reasoning.
interface AssistantBlock {
  type?: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
}

// One tool-result block inside a role=tool blob.
interface ToolResultBlock {
  type?: string;
  toolName?: string;
  toolCallId?: string;
  result?: unknown;
}

interface MessageBlob {
  role?: string;
  /** Tool blobs carry `call-<uuid>-<N>`; N is the per-session ordinal the timeline sorts on. */
  id?: unknown;
  content?: unknown;
  providerOptions?: {
    cursor?: {
      highLevelToolCallResult?: { output?: { error?: unknown } };
      // The generation id Cursor assigns the response this user turn triggered — the same
      // id the stop-hook ledger carries as generation_id. It is the exact join key that
      // attaches a measured stop event to this turn (see cursorStopHook mergeStopHookTokens).
      requestId?: string;
    };
  };
}

// Arg keys whose value is an EDIT target — a file the agent modified. Only
// these become tracked_file_paths, which holds edited files only.
const CLI_EDIT_ARG_KEYS = ["target_file", "file_path"] as const;
// Arg keys whose value is a READ-only path (Read.path, Grep.path, Glob dir).
// Useful for repo resolution + language derivation, but NOT edited files, so
// they stay out of tracked_file_paths.
const CLI_READ_ARG_KEYS = ["path", "target_directory"] as const;
// All path-bearing keys — the union feeds project resolution + languages.
const CLI_FILE_ARG_KEYS = [...CLI_EDIT_ARG_KEYS, ...CLI_READ_ARG_KEYS] as const;

// Per-message edit signal for the CLI store's file-mutating tools, all keyed on
// the `path` arg — grounded on real ~/.cursor/chats stores.
//
// A file the tool touched is always reported (filesEdited); the LOC delta is
// reported only when the tool call carries the text to count it from:
//   - Write      { path, contents }              → all-added, 0 removed
//   - StrReplace { path, old_string, new_string} → +new / -old lines
//   - Delete     { path }                        → file touched, lines UNCOUNTABLE
// linesAdded/linesRemoved are left undefined for an uncountable edit (Delete
// here, and a blob-pointer edit like the IDE's edit_file_v2 would be the same):
// the PromptMetadata contract reads ABSENT line fields as "uncountable", a state
// distinct from a real zero. A non-edit tool (Read/Grep, whose `path` is a browse
// reference) returns null so it never lands in filesEdited.
const CLI_EDIT_TOOL_NAMES = new Set(["Write", "StrReplace", "Delete"]);

interface CliEditCounts {
  filePath: string;
  linesAdded?: number;
  linesRemoved?: number;
}

export function cliEditCounts(
  toolName: string,
  args: Record<string, unknown>
): CliEditCounts | null {
  if (!CLI_EDIT_TOOL_NAMES.has(toolName)) return null;
  const path = typeof args["path"] === "string" ? (args["path"] as string) : "";
  if (!path) return null;
  if (toolName === "Write") {
    // A write replaces the whole file with `contents`: all-added, nothing removed
    // (matches Claude Code's create case, which counts the written content). A blob
    // missing `contents` (or carrying a non-string) is a countable file but an
    // UNCOUNTABLE delta — leave the lines absent rather than fabricate a zero, which
    // would read as a real "wrote an empty file".
    const contents = args["contents"];
    if (typeof contents !== "string") return { filePath: path };
    return { filePath: path, linesAdded: writtenLineCount(contents), linesRemoved: 0 };
  }
  if (toolName === "StrReplace") {
    const oldStr = args["old_string"];
    const newStr = args["new_string"];
    // Both sides of the swap are needed for the delta; if either is missing/non-string
    // the count is unknown, so report the file with the lines left absent (uncountable)
    // rather than treat a missing side as zero.
    if (typeof oldStr !== "string" || typeof newStr !== "string") return { filePath: path };
    // `replace_all` can apply the swap at several sites; the store logs neither the
    // occurrence count nor a diff, so this counts one occurrence — a lower bound,
    // matching this extractor's input-only/lower-bound stance elsewhere.
    return { filePath: path, linesAdded: writtenLineCount(newStr), linesRemoved: writtenLineCount(oldStr) };
  }
  // Delete: the file was removed — a real edit, but the call carries no line text,
  // so the delta stays uncountable (line fields left undefined).
  return { filePath: path };
}

// Per-tool "primary subject" arg for the placeholder synopsis.
const CLI_TOOL_ARG_KEY: Record<string, string> = {
  Read: "path",
  Grep: "pattern",
  Glob: "glob_pattern",
  Shell: "command",
};

// Saturation FALLBACK inputs. Used only for sessions whose store carries no
// field-5 token composition (older/edge sessions). Then context-window
// utilization can only be approximated: total conversation size / ~4 chars per
// token / the model's context window. 200k matches a consumer's default window
// for the "default"/Auto model the CLI reports. This is a heuristic — the real
// per-turn token composition (below) is preferred whenever it is present.
const CLI_CHARS_PER_TOKEN = 4;
const CLI_ESTIMATE_CONTEXT_WINDOW = 200_000;

/** Estimated context utilization as 0–100 (the Cursor-field scale), or undefined. */
export function estimateContextUsagePercent(totalChars: number): number | undefined {
  if (totalChars <= 0) return undefined;
  const estTokens = totalChars / CLI_CHARS_PER_TOKEN;
  const pct = Math.min(100, Math.round((estTokens / CLI_ESTIMATE_CONTEXT_WINDOW) * 100));
  return pct > 0 ? pct : undefined;
}

/**
 * REAL context utilization as 0–100 from decoded per-turn token counts:
 * totalContextTokens / contextWindow. Same 0–100 scale + clamp as the estimate,
 * so the 0–100 scale of `cursor_context_usage_percent` is unchanged.
 */
export function contextUsagePercentFromTokens(
  totalTokens: number,
  windowTokens: number
): number | undefined {
  if (totalTokens <= 0 || windowTokens <= 0) return undefined;
  const pct = Math.min(100, Math.round((totalTokens / windowTokens) * 100));
  return pct > 0 ? pct : undefined;
}

/**
 * Resolves the session's context-saturation %: the REAL per-turn token
 * composition when the store recorded one (field 5, the max/latest turn since it
 * grows cumulatively), else the char-based estimate. This is exactly the
 * "real-if-present, estimate-if-absent" rule — kept as one pure function so both
 * arms are unit-testable.
 */
export function resolveCliContextUsagePercent(parsed: ParsedCliSession): number | undefined {
  if (parsed.maxContextTokens && parsed.contextWindowTokens) {
    return contextUsagePercentFromTokens(parsed.maxContextTokens, parsed.contextWindowTokens);
  }
  return estimateContextUsagePercent(parsed.estimatedContextChars);
}

// ── minimal protobuf wire-format reader ───────────────────────────────────────
//
// The CLI store's root/checkpoint blobs are protobuf, not JSON. No Cursor .proto
// schema exists, so we walk the raw wire format and decode only:
//   5 → 1  total context tokens (this turn's full re-sent input)
//   5 → 2  context window (e.g. 200000 / 272000)
//   5 → 3 → 3[]  per-segment breakdown (system_prompt/tools/rules/…), each:
//                1=id(string) 2=label(string) 3=tokens(varint) 4=chars(varint)
//   1      32-byte SHA-256 of a child blob (hex = blobs.id) — conversation order
//   13     32-byte SHA-256 of a prior-era root after summarization
// Checkpoint token sequences still sort by field-1 *count* (monotonic per turn);
// field 26 is a session-level constant, not a per-checkpoint timestamp, and
// field-1 count is unsafe for conversation order after summarization (it shrinks).
// Any non-protobuf/short/malformed blob yields undefined (never throws).
// Wire types: 0=varint, 1=64-bit, 2=length-delimited, 5=32-bit; 3/4 (groups) bail.

// Context windows are always large; a "field 5 → 2" below this is a false match
// on some other protobuf message that happens to have a field 5, so reject it.
const MIN_PLAUSIBLE_CONTEXT_WINDOW = 1_000;
// Bound the per-turn checkpoints collected from one (untrusted) store, so a
// corrupted/adversarially large blobs table can't grow these arrays without
// limit. Real sessions have tens of turns; this ceiling is far above any real one.
// Exported so the truncation-fallback regression pins the walk against the real
// cap rather than a hand-copied number.
export const MAX_CHECKPOINTS = 10_000;

/** One decoded protobuf field: a varint value, or the raw bytes of a length-delimited field. */
interface PbField {
  field: number;
  wire: number;
  varint?: number;
  bytes?: Buffer;
}

/** Reads a base-128 varint at `offset`; returns [value, nextOffset] or null if truncated/malformed. */
function readVarint(buf: Buffer, offset: number): [number, number] | null {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos]!;
    result += (byte & 0x7f) * Math.pow(2, shift);
    pos++;
    if ((byte & 0x80) === 0) {
      // Reject a value past 2^53: JS Number can't represent it exactly, and no
      // real token/window/ref count comes close — a varint this large is
      // corrupt/adversarial, not a legitimate field we want propagating.
      return result > Number.MAX_SAFE_INTEGER ? null : [result, pos];
    }
    shift += 7;
    if (shift > 63) return null; // more than a 10-byte varint — not real
  }
  return null; // ran off the end
}

/**
 * Iterates the top-level fields of a protobuf message, yielding each field's
 * number + value. Stops at the first malformed/unhandleable byte. The
 * generator's return value is `true` only when `offset` reached `buf.length`
 * — a silent prefix decode is not a complete message.
 */
function* iterFields(buf: Buffer): Generator<PbField, boolean, void> {
  let offset = 0;
  while (offset < buf.length) {
    const tagR = readVarint(buf, offset);
    if (!tagR) return false;
    const [tag, afterTag] = tagR;
    const field = Math.floor(tag / 8); // tag >> 3
    const wire = tag % 8; // tag & 7
    if (wire === 0) {
      const r = readVarint(buf, afterTag);
      if (!r) return false;
      yield { field, wire, varint: r[0] };
      offset = r[1];
    } else if (wire === 2) {
      const r = readVarint(buf, afterTag);
      if (!r) return false;
      const end = r[1] + r[0];
      if (end > buf.length) return false;
      yield { field, wire, bytes: buf.subarray(r[1], end) };
      offset = end;
    } else if (wire === 1) {
      if (afterTag + 8 > buf.length) return false;
      yield { field, wire };
      offset = afterTag + 8;
    } else if (wire === 5) {
      if (afterTag + 4 > buf.length) return false;
      yield { field, wire };
      offset = afterTag + 4;
    } else {
      return false; // group (3/4) or garbage
    }
  }
  return true;
}

function topLevelDecodeComplete(buf: Buffer): boolean {
  const it = iterFields(buf);
  let step = it.next();
  while (!step.done) step = it.next();
  return step.value === true;
}

/** Full decode of a field-5 context-window composition on one root/checkpoint blob. */
interface CliContextComposition {
  /** Total tokens occupying the context window this turn (field 5 → 1). */
  totalTokens: number;
  /** The model's context window in tokens (field 5 → 2). */
  windowTokens: number;
  /** Count of top-level field-1 child references — the chronological order key. */
  refCount: number;
  /** Per-segment breakdown (field 5 → 3 → 3[]), capped + id-truncated. */
  segments: ContextSegment[];
}

/**
 * Parses the per-segment breakdown out of a field-5 composition's field-3
 * entries. Real data nests them one level (5 → 3 is the inner composition whose
 * field-3 entries are the segments); we also accept segments sitting directly at
 * 5 → 3. A segment message has a STRING field 1 (its id) — the inner composition
 * has a VARINT field 1 (the total) — so the wire type of field 1 disambiguates.
 */
function parseContextSegments(field3Entries: Buffer[]): ContextSegment[] {
  if (field3Entries.length === 0) return [];
  // Decide the layout from the first entry whose field-1 wire type is
  // determinable — a malformed/empty leading entry must not misclassify the rest.
  let f1Wire: number | undefined;
  for (const entry of field3Entries) {
    const f1 = [...iterFields(entry)].find((f) => f.field === 1);
    if (f1) {
      f1Wire = f1.wire;
      break;
    }
  }
  let segEntries: Buffer[];
  if (f1Wire === 2) {
    segEntries = field3Entries; // segments sit directly at 5 → 3
  } else {
    // 5 → 3 is the inner composition; its field-3 entries are the segments.
    segEntries = [];
    for (const f of iterFields(field3Entries[0]!)) {
      if (f.field === 3 && f.wire === 2 && f.bytes) segEntries.push(f.bytes);
    }
  }
  const out: ContextSegment[] = [];
  let capped = false;
  let idTruncations = 0;
  for (const e of segEntries) {
    if (out.length >= MAX_CONTEXT_SEGMENTS) {
      capped = true;
      break;
    }
    let id: string | undefined;
    let tokens = 0;
    let chars = 0;
    for (const f of iterFields(e)) {
      if (f.field === 1 && f.wire === 2 && f.bytes) id = f.bytes.toString("utf8");
      else if (f.field === 3 && f.wire === 0) tokens = f.varint!; // absent → stays 0
      else if (f.field === 4 && f.wire === 0) chars = f.varint!;
    }
    if (id) {
      if (id.length > MAX_SEGMENT_ID_CHARS) idTruncations++;
      out.push({ segment: id.slice(0, MAX_SEGMENT_ID_CHARS), tokens, chars });
    }
  }
  if (capped) {
    logger.warn("extraction.cursor.cli", "context_segments_capped", { cap: MAX_CONTEXT_SEGMENTS });
  }
  if (idTruncations > 0) {
    logger.warn("extraction.cursor.cli", "segment_ids_truncated", {
      cap: MAX_SEGMENT_ID_CHARS,
      count: idTruncations,
    });
  }
  return out;
}

/**
 * If `buf` is a protobuf blob carrying a top-level field-5 context-window
 * composition, returns its total + window + refCount + segments; otherwise
 * undefined. Only the top level is inspected (file-snapshot blobs nest an
 * unrelated `5` deep inside a different field, which this scan ignores).
 */
export function readContextComposition(buf: Buffer): CliContextComposition | undefined {
  let refCount = 0;
  let compBytes: Buffer | undefined;
  for (const f of iterFields(buf)) {
    if (f.field === 1 && f.wire === 2) refCount++; // child-blob reference
    else if (f.field === 5 && f.wire === 2 && f.bytes) compBytes = f.bytes;
  }
  if (!compBytes) return undefined;

  let total: number | undefined;
  let window: number | undefined;
  const field3: Buffer[] = [];
  for (const f of iterFields(compBytes)) {
    if (f.field === 1 && f.wire === 0) total = f.varint;
    else if (f.field === 2 && f.wire === 0) window = f.varint;
    else if (f.field === 3 && f.wire === 2 && f.bytes) field3.push(f.bytes);
  }
  // Require total, a plausibly-large window, AND a field-3 breakdown. A real
  // composition always carries the segment sub-message at 5 → 3; demanding it
  // (on top of the window floor) rejects an unrelated protobuf blob that merely
  // happens to have a top-level field 5 with two varints.
  if (
    total === undefined ||
    window === undefined ||
    window < MIN_PLAUSIBLE_CONTEXT_WINDOW ||
    field3.length === 0
  ) {
    return undefined;
  }
  return { totalTokens: total, windowTokens: window, refCount, segments: parseContextSegments(field3) };
}

/**
 * SHA-256 blob ids stored as top-level length-delimited fields (32 raw bytes).
 * Field 1 on a root is its child list (hex = blobs.id); field 13 is prior-era
 * roots kept after a context summarization. `ids` are the 32-byte values only —
 * a length other than 32 is a wire-2 field-1/13 that is not an id, so the width
 * is what marks one. `malformed` counts present-but-wrong-width entries for this
 * field: on a walked root that is Cursor having changed its id width (format
 * drift), which the caller treats as an incomplete chain rather than silently
 * dropping the era the pointer named.
 */
function readSha256BlobRefs(buf: Buffer, fieldNum: number): { ids: string[]; malformed: number } {
  const ids: string[] = [];
  let malformed = 0;
  for (const f of iterFields(buf)) {
    if (f.field === fieldNum && f.wire === 2 && f.bytes) {
      if (f.bytes.length === 32) ids.push(f.bytes.toString("hex"));
      else malformed++;
    }
  }
  return { ids, malformed };
}

/**
 * Recovers conversation blob order from `latestRootBlobId`: walk field-13
 * ancestors (oldest first), then emit each root's field-1 children first-seen.
 * Iterative — a linked field-13 chain of thousands of checkpoints would overflow
 * a recursive walk before MAX_CHECKPOINTS could stop it. `truncated` is true
 * when the cap cut the walk short. `missingPriorIds` are field-13 ancestors
 * absent from the blob map; `malformed` is true when a walked root carried a
 * wrong-width field-1/13 ref (format drift). On any of the three the caller must
 * not treat the walk as the full transcript.
 */
function orderCliConversationBlobIds(
  dataById: Map<string, Buffer>,
  latestRootBlobId: string,
): { ids: string[]; truncated: boolean; missingPriorIds: string[]; malformed: boolean } {
  const ordered: string[] = [];
  const seenChildren = new Set<string>();
  const visitedRoots = new Set<string>();
  const missingPriorIds: string[] = [];
  const missingPriorSeen = new Set<string>();
  let rootsVisited = 0;
  let truncated = false;
  let malformed = false;
  const stack: Array<{ id: string; phase: "enter" | "emit" }> = [{ id: latestRootBlobId, phase: "enter" }];

  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.phase === "enter") {
      if (visitedRoots.has(frame.id)) continue;
      if (rootsVisited >= MAX_CHECKPOINTS) {
        truncated = true;
        continue;
      }
      const buf = dataById.get(frame.id);
      if (!buf || buf.length === 0 || !topLevelDecodeComplete(buf)) {
        if (!missingPriorSeen.has(frame.id)) {
          missingPriorSeen.add(frame.id);
          missingPriorIds.push(frame.id);
        }
        continue;
      }
      visitedRoots.add(frame.id);
      rootsVisited++;
      const priors = readSha256BlobRefs(buf, 13);
      if (priors.malformed > 0) malformed = true;
      stack.push({ id: frame.id, phase: "emit" });
      for (let i = priors.ids.length - 1; i >= 0; i--) {
        stack.push({ id: priors.ids[i]!, phase: "enter" });
      }
      continue;
    }
    const buf = dataById.get(frame.id);
    if (!buf) continue;
    const children = readSha256BlobRefs(buf, 1);
    if (children.malformed > 0) malformed = true;
    for (const child of children.ids) {
      if (seenChildren.has(child)) continue;
      seenChildren.add(child);
      ordered.push(child);
    }
  }

  return { ids: ordered, truncated, missingPriorIds, malformed };
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface ExtractCursorCliOptions {
  /**
   * The same gate the IDE resolver reads: true exactly when the host supplied a
   * seat-tier lookup. Anything other than `true` means this surface stamps no
   * seat tier either. The gate governs the vendor-derived *value*, not just the
   * call that produced it: a cache row survives the lookup's withdrawal for the
   * rest of its 24h TTL, so a CLI path that only stopped making calls would keep
   * stamping tiers out of it.
   */
  cursorSeatTierLookupEnabled?: boolean;
  /**
   * Gates Task-spawned child capture. Same policy as Claude Code's CLI: off
   * leaves child stores unread; on extracts each as a SUBAGENT tagged to its
   * parent so a consumer prices the child and folds tokens/cost onto the parent.
   */
  captureLineage?: boolean;
}

/**
 * Extracts all Cursor CLI sessions into the local DB.
 *
 * @param seen  Precedence-dedup set: uuids already ingested by a
 *   higher-precedence surface (composerData). Seeded by the dispatcher BEFORE
 *   this runs so a session that also exists in the IDE store is skipped here.
 *   CLI uuids it does ingest are added to the set for any lower-precedence reader.
 */
export function extractCursorCli(
  db: SessionSink,
  seen: Set<string> = new Set(),
  opts: ExtractCursorCliOptions = {},
): number {
  // Scan both CLI store roots — current `chats` and legacy `cli-chats` —
  // so a machine that ran the CLI across the vendor's dir rename has its
  // pre-rename sessions read, not silently dropped. The cycle still runs (and
  // consults the seat-tier cache below) whenever any root dir exists, even empty.
  const roots = getCursorCliChatsRoots().filter((p) => existsSync(p));
  if (roots.length === 0) {
    logger.info("extraction.cursor.cli", "chats_dir_not_found", { chatsPath: getCursorCliChatsPath() });
    return 0;
  }

  // Withholding the reader is how the gate is enforced, rather than a branch
  // inside the read: with no `meta` there is provably no cache access at all, and
  // the read-only contract holds in both states — `db` is passed as the seat-tier
  // cache READER only (readCachedSeatTierStamp).
  const installMeta = detectCursorCliTier(
    opts.cursorSeatTierLookupEnabled === true ? db : undefined,
  );
  // MCP server names are installation-global (~/.cursor/mcp.json) — read once
  // per cycle rather than per session.
  const mcpServerNames = readCursorMcpServerNames();
  // The global stop-hook ledger, read once per run: measured per-generation tokens keyed
  // by conversation_id, which equals the CLI session uuid.
  const stopLedger = loadCursorStopLedger();
  const captureLineage = opts.captureLineage === true;
  const childToParent = new Map<string, CliChildLink>();
  let extracted = 0;

  // Flatten to (root, wsHash) pairs across both roots; an empty root yields none.
  const wsEntries: Array<{ chatsPath: string; wsHash: string }> = [];
  for (const chatsPath of roots) {
    try {
      for (const wsHash of readdirSync(chatsPath)) wsEntries.push({ chatsPath, wsHash });
    } catch (err) {
      // Skip an unreadable root, but never silently — a permission/IO error here
      // drops that root's whole session set.
      logger.warn("extraction.cursor.cli", "chats_root_unreadable", {
        chatsPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const { chatsPath, wsHash } of wsEntries) {
    const wsDir = join(chatsPath, wsHash);
    let sessionDirs: string[];
    try {
      if (!statSync(wsDir).isDirectory()) continue;
      sessionDirs = readdirSync(wsDir);
      // Sidecar sessions are parents; process them first so a child that
      // sorts earlier still sees the parent row in this cycle.
      if (captureLineage && sessionDirs.length > 1) {
        sessionDirs.sort((a, b) => {
          const aHas = existsSync(join(wsDir, a, "meta.json"));
          const bHas = existsSync(join(wsDir, b, "meta.json"));
          if (aHas === bHas) return 0;
          return aHas ? -1 : 1;
        });
      }
    } catch {
      continue;
    }

    for (const sid of sessionDirs) {
      try {
        if (processCliSession(db, join(wsDir, sid), sid, installMeta, mcpServerNames, seen, stopLedger, captureLineage, childToParent)) {
          extracted++;
        }
      } catch (err) {
        logger.error("extraction.cursor.cli", "session_processing_error", {
          sessionDir: sid,
          error: err instanceof Error ? err.message : String(err),
        });
        reportRecordError(sid, join(wsDir, sid), err);
      }
    }
  }

  // A child whose store was unchanged may have been skipped before the parent
  // row existed this cycle; stamp now. Skip if the parent never persisted — a
  // dangling SUBAGENT is hidden from Sessions and not folded into anyone.
  if (captureLineage) {
    for (const [childId, link] of childToParent) {
      if (!db.getTracking("cursor", link.parentId)) continue;
      db.stampPendingSubagentLineage(
        "cursor",
        childId,
        conversationId("cursor", link.parentId),
        { origin_agent_type: link.origin_agent_type, tool_use_id: link.tool_use_id },
      );
    }
  }

  logger.info("extraction.cursor.cli", "extraction_complete", { extracted });
  return extracted;
}

// ── Per-session processing ────────────────────────────────────────────────────

function processCliSession(
  db: SessionSink,
  sessionDir: string,
  dirUuid: string,
  installMeta: InstallationMetadata | undefined,
  mcpServerNames: string[],
  seen: Set<string>,
  // The run's stop-hook ledger; this session's measured generations are looked up by its
  // uuid (== conversation_id). Undefined-safe: an absent ledger merges nothing.
  stopLedger: Map<string, MeasuredGeneration[]> | undefined,
  captureLineage: boolean,
  childToParent: Map<string, CliChildLink>,
): boolean {
  const metaJsonPath = join(sessionDir, "meta.json");
  const storeDbPath = join(sessionDir, "store.db");
  if (!existsSync(storeDbPath)) return false;
  const hasSidecar = existsSync(metaJsonPath);
  // Children have no sidecar; skip without opening store.db when the flag is off.
  if (!hasSidecar && !captureLineage) return false;

  const metaJson = hasSidecar ? readJson<CliMetaJson>(metaJsonPath) : undefined;
  // Incomplete parent sidecar: skip without opening store.db when we will not
  // consult subagentInfo. Flag-on must open — store.db is the authority, so a
  // stub sidecar on a Task child still takes the child path.
  if (
    !captureLineage &&
    hasSidecar &&
    (!metaJson || metaJson.hasConversation === false)
  ) {
    return false;
  }

  // Dedup token: the store.db file mutates as the session grows.
  const st = statSync(storeDbPath);
  // Under WAL mode a committed write lands in the `-wal` sidecar and need not
  // touch the main file until checkpoint (same reasoning as sqliteReader.ts's
  // sqliteStatKey, used by the sibling usage parser) — SQLite reads both files
  // to serve uncheckpointed data, so both are corpus this extractor parses and
  // holds in memory. Missing sidecar (checkpointed, or never entered WAL mode)
  // contributes nothing.
  let walSize = 0;
  let walMtimeMs = 0;
  try {
    const wal = statSync(`${storeDbPath}-wal`);
    walSize = wal.size;
    walMtimeMs = wal.mtimeMs;
  } catch {
    // No -wal sidecar — normal.
  }
  // The change token spans both files: a turn committed into the -wal alone
  // leaves store.db's mtime and size as they were.
  const skipMtimeMs = Math.floor(Math.max(st.mtimeMs, walMtimeMs));
  const trackedSize = st.size + walSize;
  let sidecarMtimeMs = 0;
  if (hasSidecar) {
    try {
      sidecarMtimeMs = Math.floor(statSync(metaJsonPath).mtimeMs);
    } catch {
      // Sidecar disappeared between existsSync and stat — treat as absent.
    }
  }
  if (cliStoreNegativeSkipHit(storeDbPath, skipMtimeMs, st.size, walSize, sidecarMtimeMs)) return false;

  const reader = new SQLiteReader(storeDbPath);
  let rememberNegativeSkip = false;
  try {
    reader.open();
    const metaRow = readCliMetaRow(reader);
    const uuid = metaRow?.agentId ?? dirUuid;
    const parentAgentId = parentAgentIdFromCliSubagentInfo({
      agentId: uuid,
      subagentInfo: metaRow?.subagentInfo,
    });
    // store.db subagentInfo is the authority, not the missing sidecar — a future
    // Cursor that writes meta.json on children must still take the child path.
    if (parentAgentId) {
      if (!captureLineage) return false;
    } else if (!metaJson || metaJson.hasConversation === false) {
      rememberNegativeSkip = true;
      return false;
    }

    // Precedence dedup: composerData already won this session.
    if (seen.has(uuid)) return false;

    if (captureLineage && parentAgentId) {
      childToParent.set(uuid, { parentId: parentAgentId, ...cliLineageExtras(metaRow) });
    }

    // Idempotency: unchanged store.db (same mtime + size) → skip re-extraction.
    const tracking = db.getTracking("cursor", uuid);
    if (tracking && tracking.last_mtime_ms === skipMtimeMs && tracking.last_size === trackedSize) {
      if (captureLineage && parentAgentId && db.getTracking("cursor", parentAgentId)) {
        return db.stampPendingSubagentLineage(
          "cursor",
          uuid,
          conversationId("cursor", parentAgentId),
          cliLineageExtras(metaRow),
        );
      }
      return false;
    }

    // Don't persist a child while the parent row is missing — a sync in
    // that window would freeze it as PRIMARY (stamp no-ops once synced_at is set).
    if (parentAgentId && !db.getTracking("cursor", parentAgentId)) {
      return false;
    }

    const parsed = parseCliBlobs(
      reader.query<{ id: string; data: string | Buffer }>("SELECT id, data FROM blobs"),
      { latestRootBlobId: metaRow?.latestRootBlobId, sessionId: uuid },
    );
    if (parsed.userTurns.length === 0) {
      rememberNegativeSkip = true;
      return false;
    }

    const model = metaRow?.lastUsedModel; // "default" = Auto; pass through, don't fabricate.
    const prompts = buildPrompts(parsed, model);

    // Merge the stop-hook ledger's MEASURED per-generation tokens onto this session's
    // assistant turns (keyed by uuid == conversation_id). Done in place so the const
    // array stays valid; a session Cursor's stop hook did not record merges nothing.
    const stopGenerations = stopLedger?.get(uuid);
    if (stopGenerations && stopGenerations.length > 0) {
      const merged = mergeStopHookTokens(prompts, stopGenerations);
      prompts.length = 0;
      prompts.push(...merged);
    }

    // A child has no meta.json; inherit cwd from the parent (then root-parent)
    // sidecar so project/repo resolution still has a launch dir.
    const cwd =
      metaJson?.cwd ??
      cliInheritedCwd(sessionDir, parentAgentId, metaRow?.subagentInfo?.rootParentAgentId);
    const createdAtMs = metaJson?.createdAtMs ?? cliCreatedAtMs(metaRow?.createdAt);
    const updatedAtMs = metaJson?.updatedAtMs;

    // Project + repo. A CLI agent is often launched in one repo (cwd) but edits
    // and raises PRs in another; attribute the session to where the WORK landed,
    // not just the launch dir. Base = cwd-then-tools; but prefer the dominant
    // touched-files repo when it disagrees with the cwd repo (and the PR repo
    // overrides both, below, since reads can bias the touched-files heuristic).
    let resolved = resolveProjectAndRepo(cwd, parsed.toolFilePaths);
    const cwdRepo = resolveProjectAndRepo(cwd, [])?.repoName;
    const touched = resolveProjectAndRepo(undefined, parsed.toolFilePaths);
    if (
      touched?.repoName && cwdRepo &&
      canonicalRepoKey(touched.repoName) !== canonicalRepoKey(cwdRepo)
    ) {
      resolved = touched;
    }
    let finalProjectPath = resolved?.projectPath ?? cwd;
    let repoName = resolved?.repoName;

    // Git/PR attribution from the session's own Shell commands. Pass repo=undefined:
    // a CLI agent routinely works in a different repo than its cwd (cwd=example-repo
    // while the PRs are raised in other-repo), so scoping to the cwd repo
    // would wrongly drop them. Unscoped, add() still keeps only PR URLs from an
    // *authoring* command's output; a consumer merged-set gate is the backstop.
    // PR refs come from the parser's own multi-path scan (Shell authoring output +
    // MCP create results, all PRs, cross-repo). collectCursorAttribution is used
    // only for the branch — its Shell-only, single-PR, repo-scoped PR logic is
    // superseded here for the cross-repo CLI case.
    let prReferences: PRRef[] = [...parsed.prReferences];
    const attribution = collectCursorAttribution(parsed.attributionEvents, undefined);
    if (prReferences.length === 0 && finalProjectPath) {
      const fromCommits = getSessionPRLink(finalProjectPath, createdAtMs, updatedAtMs ?? st.mtimeMs, {
        urlOnly: true,
      });
      if (fromCommits && (!repoName || canonicalRepoKey(fromCommits.prRepository) === canonicalRepoKey(repoName))) {
        prReferences = [
          { pr_url: fromCommits.prUrl, pr_number: fromCommits.prNumber, pr_repository: fromCommits.prRepository },
        ];
      }
    }

    // A recovered branch must look like a real ref — the attribution parser can
    // lift an unresolved shell variable ("$BRANCH") or quoted token out of a
    // `git checkout -b` inside a loop, which is not a branch.
    const gitBranches: string[] = [];
    if (attribution.branch && isCleanBranchName(attribution.branch)) {
      gitBranches.push(attribution.branch);
    }

    // The raised PR's repo is the authoritative "work landed here" signal (reads
    // can bias the touched-files heuristic toward the cwd repo). When it differs
    // from the resolved repo, attribute repo_name to it — and if that repo's
    // local clone is among the touched files, diff THERE so LOC reflects the real
    // churn (the cwd-repo diff would be empty for cross-repo work).
    if (prReferences.length > 0) {
      const prRepo = prReferences[0]!.pr_repository;
      if (!repoName || canonicalRepoKey(prRepo) !== canonicalRepoKey(repoName)) {
        repoName = prRepo;
        const prLocalRoot = localRootForRepo(parsed.toolFilePaths, prRepo);
        if (prLocalRoot) finalProjectPath = prLocalRoot;
      }
    }

    let gitCommits: number | undefined;
    let linesAdded: number | undefined;
    let linesRemoved: number | undefined;
    let filesModified: number | undefined;
    if (finalProjectPath) {
      const diff = getFullSessionDiffStats(finalProjectPath, createdAtMs, updatedAtMs ?? st.mtimeMs);
      if (diff.gitCommits > 0) gitCommits = diff.gitCommits;
      if (diff.linesAdded > 0) linesAdded = diff.linesAdded;
      if (diff.linesRemoved > 0) linesRemoved = diff.linesRemoved;
      if (diff.filesModified > 0) filesModified = diff.filesModified;
    }

    const languages = deriveLanguages(parsed.toolFilePaths);
    const durationSec =
      createdAtMs && updatedAtMs && updatedAtMs > createdAtMs
        ? Math.round((updatedAtMs - createdAtMs) / 1000)
        : undefined;

    const taskCount = parsed.toolCounts["Task"] ?? 0;
    // uses_mcp means this SESSION invoked an MCP tool (ListMcpResources or an
    // MCP PR-create) — not merely that ~/.cursor/mcp.json configures a server.
    const usesMcp = parsed.mcpToolUsed;
    const usesWebSearch = (parsed.toolCounts["WebSearch"] ?? 0) > 0;
    const gitPushes = parsed.attributionEvents.filter(
      (e) => e.command && /\bgit\s+push\b/.test(e.command)
    ).length;
    // When the protobuf chain is complete, prompts[] is on-chain only — count
    // the same users and assistant texts, not leftover JSON still in the table.
    const transcriptUsers =
      parsed.conversationEntries.length > 0
        ? parsed.conversationEntries.flatMap((e) => (e.kind === "user" ? [e.turn] : []))
        : parsed.userTurns;
    const transcriptAssistantCount = countCliAssistantTexts(parsed);

    const row = buildCursorSessionRow({
      source: "cli",
      sessionId: uuid,
      prompts,
      projectPath: finalProjectPath,
      repoName,
      lastMtimeMs: skipMtimeMs,
      lastSize: trackedSize,
      conversationSourceCreatedAtMs: createdAtMs,
      sessionTitle: metaJson?.title ?? metaRow?.name,
      languages,
      // Only edit targets — read-only paths (Read/Grep/Glob) would inflate the
      // consumer's files_edited. Read paths still feed languages + repo resolution.
      trackedFilePaths: parsed.editedFilePaths.length > 0 ? parsed.editedFilePaths : undefined,
      toolCounts: parsed.toolCounts,
      toolErrors: parsed.toolErrors,
      toolErrorCategories: parsed.toolErrorCategories,
      // Grounded on the Task tool actually firing — not blanket-true for every CLI session.
      usesTaskAgent: taskCount > 0 ? true : undefined,
      spawnedAgentNames: parsed.spawnedAgentNames.length > 0 ? parsed.spawnedAgentNames : undefined,
      subAgentCount: taskCount > 0 ? taskCount : undefined,
      usesMcp: usesMcp ? true : undefined,
      usesWebSearch: usesWebSearch ? true : undefined,
      usesExtendedThinking: parsed.usesExtendedThinking ? true : undefined,
      userMessageCount: transcriptUsers.length > 0 ? transcriptUsers.length : undefined,
      assistantMessageCount: transcriptAssistantCount > 0 ? transcriptAssistantCount : undefined,
      gitPushes: gitPushes > 0 ? gitPushes : undefined,
      cursorContextUsagePercent: resolveCliContextUsagePercent(parsed),
      contextComposition: parsed.contextComposition.length > 0 ? parsed.contextComposition : undefined,
      compactionCount: parsed.compactionCount > 0 ? parsed.compactionCount : undefined,
      userMessageTimestamps: [...transcriptUsers]
        .filter((t): t is CliUserTurn & { iso: string } => !!t.iso)
        .sort((a, b) => a.sortKey - b.sortKey)
        .map((t) => t.iso),
      sessionDurationSeconds: durationSec,
      gitBranches: gitBranches.length > 0 ? gitBranches : undefined,
      gitCommits,
      linesAdded,
      linesRemoved,
      filesModified,
      mcpServerNames: mcpServerNames.length > 0 ? mcpServerNames : undefined,
      prReferences: prReferences.length > 0 ? prReferences : undefined,
      installMeta,
      lineage:
        captureLineage && parentAgentId && db.getTracking("cursor", parentAgentId)
          ? cliSubagentLineage(parentAgentId, metaRow, prompts)
          : undefined,
    });

    // The loop timeline rides on the row rather than in SessionMeta, so it stays outside the
    // pure meta transform above. Omitted when empty for the same reason the IDE path omits it:
    // an empty array reads as coverage NONE either way and would put a dead field on every row.
    db.upsert({
      ...row,
      sessionEvents:
        parsed.sessionEvents.length > 0 ? JSON.stringify(parsed.sessionEvents) : undefined,
      eventCoverage: parsed.eventCoverage,
    });
    cliStoreNegativeSkip.delete(storeDbPath);
    seen.add(uuid);
    return true;
  } finally {
    reader.close();
    if (rememberNegativeSkip) {
      cliStoreNegativeSkip.set(storeDbPath, {
        mtimeMs: skipMtimeMs,
        size: st.size,
        walSize,
        sidecarMtimeMs,
      });
    }
  }
}

// ── store.db parsing (pure — exported for tests) ──────────────────────────────

export interface CliUserTurn {
  query: string;
  /** Parsed <timestamp> as ISO 8601, or undefined when unparseable. */
  iso?: string;
  /** Epoch ms used only for ordering; Infinity sorts unparseable turns last. */
  sortKey: number;
  /**
   * The generation id Cursor assigned the response this turn triggered
   * (providerOptions.cursor.requestId) — the exact join key to the stop-hook ledger's
   * generation_id. Undefined on older sessions that predate the field.
   */
  requestId?: string;
}

/** One transcript item in recovered conversation order (root field-1 chain). */
export type CliConversationEntry =
  | { kind: "user"; turn: CliUserTurn }
  | {
      kind: "assistant";
      content: string;
      /** Same blobs.id groups text + tool placeholders as one turn for inputTokens. */
      blobId?: string;
      /** "text" counts in assistantMessageCount; tool placeholders do not. */
      block: "text" | "tool";
      /**
       * Set on a countable edit tool-call block (Write/StrReplace) — the file it
       * touched and its line delta, stamped onto this message's prompt. Absent on
       * text blocks and uncountable tool calls.
       */
      edit?: CliEditCounts;
    };

export interface ParsedCliSession {
  /** The normalized loop timeline, ordered by the tool ids' per-session ordinal. */
  sessionEvents: SessionEvent[];
  eventCoverage: EventCoverage;
  userTurns: CliUserTurn[];
  /**
   * User/assistant/tool prompt items in protobuf-root order when a
   * `latestRootBlobId` was supplied and the field-13 chain is complete.
   * Empty → `buildPrompts` falls back to users-then-assistants.
   */
  conversationEntries: CliConversationEntry[];
  assistantTexts: string[];
  toolPlaceholders: string[];
  toolCounts: Record<string, number>;
  toolErrors: number;
  toolErrorCategories: Record<string, number>;
  toolFilePaths: string[];
  /** Edit-target paths only (target_file/file_path) — the files actually modified. */
  editedFilePaths: string[];
  attributionEvents: AttributionEvent[];
  /** Sub-agent types spawned via the Task tool (args.subagent_type), first-seen order. */
  spawnedAgentNames: string[];
  /**
   * Every PR raised by the session, recovered from any authoring path:
   *   - a Shell authoring command's output (`gh pr create`, `glab mr create`,
   *     a Bitbucket curl POST) — including a loop that raises several at once, and
   *   - an MCP PR-create tool's result (e.g. the GitHub MCP `create_pull_request`).
   * Cross-repo — the PR's own repo is kept; a consumer merged-set gate validates.
   */
  prReferences: PRRef[];
  /** Total chars across all message blobs — input to the saturation FALLBACK estimate. */
  estimatedContextChars: number;
  /**
   * Max total context tokens seen across the store's protobuf root/checkpoint
   * blobs (field 5 → 1). It grows cumulatively per turn, so the max is the
   * session's real peak context usage. Undefined when no field-5 block exists.
   */
  maxContextTokens?: number;
  /** Context window (tokens) paired with maxContextTokens (field 5 → 2), e.g. 200000. */
  contextWindowTokens?: number;
  /**
   * Per-turn full context totals (field 5 → 1) in chronological order — each is
   * the FULL context Cursor re-sent that turn, not a delta. Ordered by the root
   * blob's child-reference count (monotonic per turn; field 26 is a session-level
   * constant and unusable for ordering) and deduped by value (the store double-
   * writes each checkpoint). Emitted as per-assistant-turn inputTokens so the
   * consumer can cache-split the re-sent context. Empty when no field-5 blocks.
   */
  perTurnInputTokens: number[];
  /**
   * Per-segment context composition of the session's PEAK turn (the same root we
   * take maxContextTokens from), for SessionMeta.context_composition. Empty when
   * no field-5 block exists.
   */
  contextComposition: ContextSegment[];
  /** Count of context compactions in this session — `summarized_conversation` rising
   *  0→non-zero across the per-turn field-5 series. */
  compactionCount: number;
  /** True if any assistant turn produced (redacted-)reasoning / chain-of-thought. */
  usesExtendedThinking: boolean;
  /** True if the session invoked an MCP tool (ListMcpResources or an MCP PR-create). */
  mcpToolUsed: boolean;
}

/**
 * True for a tool name that creates a PR (MCP server tools like
 * create_pull_request / github_create_pull_request / open_pull_request). Used to
 * treat the tool's result as PR authoring evidence. Excludes list/get/view tools.
 */
// Finds the local git-root among the touched file paths whose repo matches
// targetRepo — lets a cross-repo session diff the correct clone for LOC when the
// PR landed in a repo other than the cwd repo.
function localRootForRepo(filePaths: string[], targetRepo: string): string | undefined {
  const key = canonicalRepoKey(targetRepo);
  for (const fp of filePaths) {
    const r = resolveProjectAndRepo(fp, []);
    if (r?.repoName && canonicalRepoKey(r.repoName) === key) return r.projectPath;
  }
  return undefined;
}

export function isPrCreateToolName(name: string): boolean {
  const n = name.toLowerCase();
  // Reject PR-review / comment / thread tools first — e.g. the GitHub MCP
  // `create_pull_request_review` CREATES a review on an existing PR, not a PR,
  // and its result carries the reviewed PR's URL (would mis-attribute a merely
  // reviewed PR as authored).
  if (/review|comment|thread/.test(n)) return false;
  return /(?:create|open)_?(?:pull_?requests?|prs?)\b/.test(n) || /create.*pull.?request/.test(n);
}

/**
 * Parses the JSON blobs of a CLI store.db into normalized session signals.
 * Non-JSON (protobuf) blobs contribute field-5 token composition and, when
 * `latestRootBlobId` is set, the field-1 / field-13 conversation order.
 * User turns are still collected (and timestamp-sorted) for metadata; transcript
 * `prompts[]` follow the recovered root order when that chain is complete.
 * A missing field-13 ancestor or a cap cut leaves `conversationEntries` empty
 * so `buildPrompts` falls back to every parsed user/assistant.
 */
export function parseCliBlobs(
  blobRows: Array<{ id?: string; data: string | Buffer }>,
  opts: { latestRootBlobId?: string; sessionId?: string } = {},
): ParsedCliSession {
  const userTurns: CliUserTurn[] = [];
  const assistantTexts: string[] = [];
  const toolPlaceholders: string[] = [];
  const toolCounts: Record<string, number> = {};
  const toolErrorCategories: Record<string, number> = {};
  const toolFilePaths = new Set<string>();
  const editedFilePaths = new Set<string>();
  const attributionEvents: AttributionEvent[] = [];
  const spawnedAgents = new Set<string>();
  const prReferences: PRRef[] = [];
  let toolErrors = 0;
  let contextChars = 0;
  let usesExtendedThinking = false;
  let mcpToolUsed = false;
  // Every protobuf root/checkpoint blob with a field-5 composition, collected for
  // per-turn token accounting after the pass (needs global refCount ordering).
  const checkpoints: CliContextComposition[] = [];
  const dataById = new Map<string, Buffer>();
  const indexed: Array<{ id?: string; blob: MessageBlob }> = [];
  const blobs: MessageBlob[] = [];

  // Pass 1: index tool-results by toolCallId (result text + error flag), so a
  // Shell tool-call can be paired with its outcome for attribution + error stats.
  const resultsById = new Map<string, { text: string; errored: boolean }>();
  for (const row of blobRows) {
    const { data } = row;
    // A NULL / non-string / non-Buffer data cell is a corrupt row — skip just it,
    // never let it throw out of the loop and abandon the whole session's prompts.
    if (data == null) continue;
    let buf: Buffer;
    try {
      // Blobs are stored with BLOB storage class, so the shared vendor reader
      // hands them back as Buffers; tolerate a string too.
      buf = Buffer.isBuffer(data) ? data : Buffer.from(data as string);
    } catch {
      continue;
    }
    let obj: unknown;
    try {
      // JSON message blobs decode as UTF-8 JSON; protobuf root/checkpoint blobs
      // do not (→ the catch, where we read the field-5 token composition).
      obj = JSON.parse(buf.toString("utf8"));
    } catch {
      // Protobuf root/checkpoint blob. The order walk only ever looks a blob up
      // in dataById by id, and every id it looks up is a root/checkpoint reached
      // via latestRootBlobId/field-13 — a JSON message blob is reached through
      // entriesById, never here — so only these buffers need retaining. (A JSON
      // blob's buffer still lives for the parse via `blobRows`; keeping it in the
      // map too would just grow the map for nothing.)
      if (typeof row.id === "string" && row.id.length > 0) dataById.set(row.id, buf);
      // Collect its field-5 composition (if any); the peak + per-turn sequence
      // are derived after the loop. Bounded so a pathological store can't grow
      // `checkpoints` without limit.
      if (checkpoints.length < MAX_CHECKPOINTS) {
        const comp = readContextComposition(buf);
        if (comp) {
          checkpoints.push(comp);
          if (checkpoints.length === MAX_CHECKPOINTS) {
            logger.warn("extraction.cursor.cli", "checkpoint_cap_reached", { cap: MAX_CHECKPOINTS });
          }
        }
      }
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const blob = obj as MessageBlob;
    blobs.push(blob);
    indexed.push({ id: typeof row.id === "string" ? row.id : undefined, blob });
    // Every message blob (system/user/assistant/tool — incl. tool-result file
    // contents) occupies the context window. Its raw length feeds the saturation
    // FALLBACK estimate used only when no field-5 token composition was found.
    if (typeof blob.role === "string") contextChars += buf.length;
    if (blob.role === "tool" && Array.isArray(blob.content)) {
      const structuredError = blob.providerOptions?.cursor?.highLevelToolCallResult?.output?.error != null;
      for (const b of blob.content as ToolResultBlock[]) {
        if (b?.type === "tool-result" && typeof b.toolCallId === "string") {
          const text = typeof b.result === "string" ? b.result : JSON.stringify(b.result ?? "");
          resultsById.set(b.toolCallId, { text, errored: structuredError });
        }
      }
    }
  }

  // Pass 2: build user turns, assistant text, tool aggregates + attribution.
  const entriesById = new Map<string, CliConversationEntry[]>();
  const addEntry = (id: string | undefined, entry: CliConversationEntry): void => {
    if (!id) return;
    const arr = entriesById.get(id) ?? [];
    arr.push(entry);
    entriesById.set(id, arr);
  };
  for (const { id, blob } of indexed) {
    if (blob.role === "user") {
      const turn = parseUserBlob(blob.content);
      if (turn) {
        // The join key to the stop-hook ledger: this user turn's requestId == the
        // generation_id of the response it triggered.
        turn.requestId = blob.providerOptions?.cursor?.requestId;
        userTurns.push(turn);
        addEntry(id, { kind: "user", turn });
      }
    } else if (blob.role === "assistant" && Array.isArray(blob.content)) {
      for (const b of blob.content as AssistantBlock[]) {
        if (b?.type === "reasoning" || b?.type === "redacted-reasoning") {
          usesExtendedThinking = true; // the model produced chain-of-thought this turn
        } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
          assistantTexts.push(b.text);
          attributionEvents.push({ role: "assistant", text: b.text });
          addEntry(id, { kind: "assistant", content: b.text, blobId: id, block: "text" });
        } else if (b?.type === "tool-call" && typeof b.toolName === "string") {
          // MCP interaction: ListMcpResources, or an MCP tool call the reader
          // recognises (PR-create). Broader than ListMcpResources alone so an
          // MCP-authoring session without a ListMcpResources call still counts.
          if (b.toolName === "ListMcpResources" || isPrCreateToolName(b.toolName)) mcpToolUsed = true;
          const edit = recordToolCall(b, resultsById, {
            toolCounts,
            toolErrorCategories,
            toolFilePaths,
            attributionEvents,
            toolPlaceholders,
            spawnedAgents,
            prReferences,
            editedFilePaths,
            addError: () => { toolErrors++; },
          });
          addEntry(id, {
            kind: "assistant",
            content: formatToolPlaceholder(b.toolName, b.args ?? {}),
            blobId: id,
            block: "tool",
            ...(edit ? { edit } : {}),
          });
        }
      }
    }
    // role=system and role=tool contribute no conversation prompt.
  }

  let conversationEntries: CliConversationEntry[] = [];
  const rootId = opts.latestRootBlobId;
  const orderLog = {
    cap: MAX_CHECKPOINTS,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  };
  if (rootId && dataById.has(rootId)) {
    try {
      const walk = orderCliConversationBlobIds(dataById, rootId);
      // A cap cut, a missing field-13 ancestor, or a wrong-width ref (format
      // drift) all mean this is not the full conversation. Do not store the
      // suffix as if it were. Empty entries fall through to users-then-assistants
      // so on-disk JSON is not dropped. `reason` separates the causes in logs.
      if (walk.truncated || walk.missingPriorIds.length > 0 || walk.malformed) {
        logger.warn("extraction.cursor.cli", "conversation_order_incomplete", {
          ...orderLog,
          // reason is the primary label; the raw signals ride along so a rare
          // co-occurrence (cap cut AND drift) is not hidden behind one label.
          reason: walk.truncated ? "truncated" : walk.malformed ? "malformed_ref" : "missing_prior",
          truncated: walk.truncated,
          malformed: walk.malformed,
          missingPriorCount: walk.missingPriorIds.length,
        });
      } else {
        for (const childId of walk.ids) {
          const entries = entriesById.get(childId);
          if (!entries?.length) continue;
          conversationEntries.push(...entries);
        }
      }
    } catch (err) {
      logger.warn("extraction.cursor.cli", "conversation_order_walk_failed", {
        ...orderLog,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  } else if (rootId) {
    logger.warn("extraction.cursor.cli", "conversation_order_incomplete", {
      ...orderLog,
      reason: "root_blob_absent",
    });
  }

  if (
    conversationEntries.length > 0 &&
    userTurns.length > 0 &&
    !conversationEntries.some((e) => e.kind === "user")
  ) {
    // On-chain blobs had no parseable user turn, but the table still has some.
    // Keep those prompts rather than storing an assistant-only transcript.
    logger.warn("extraction.cursor.cli", "conversation_order_incomplete", {
      ...orderLog,
      reason: "no_user_on_chain",
    });
    conversationEntries = [];
  }

  userTurns.sort((a, b) => a.sortKey - b.sortKey);

  // Derive the peak turn (drives saturation + context_composition) and the
  // chronological per-turn input-token sequence from the collected checkpoints.
  // Order by refCount (monotonic per turn) then total.
  //
  // Dedup only collapses a CONSECUTIVE run of equal totals, NOT every equal total.
  // A single checkpoint is double-written by the store (same total, different
  // refCount); refCount is monotonic per turn, so both writes of one checkpoint
  // land adjacent after this sort and collapse. But a legitimate later turn whose
  // full-context total happens to EQUAL an earlier turn's (it added nothing, or a
  // post-summarization re-hit) is separated by intervening different-total turns,
  // so it survives — a global Set keyed on the value alone would silently drop it
  // and break the claimed 1:1. TRADEOFF: with only the decoded fields there is no
  // per-turn identity that separates a double-write from a real turn that is BOTH
  // immediately adjacent AND byte-equal in total; that degenerate case still
  // collapses. We accept it (rare) rather than over-suppress real turns, and log
  // the collapse count so a divergence is observable. Since the derived cost is a
  // lower bound, keeping a real turn is the safer error direction.
  const ordered = [...checkpoints].sort((a, b) => a.refCount - b.refCount || a.totalTokens - b.totalTokens);
  const perTurnInputTokens: number[] = [];
  let collapsed = 0;
  let prevTotal: number | undefined; // the PREVIOUS checkpoint's total (incl. 0), for adjacency
  let peak: CliContextComposition | undefined;
  // Compaction count: Cursor writes no discrete compaction event, but a compaction folds
  // older turns into the `summarized_conversation` context category — so that category
  // rising from 0 to non-zero across the per-turn field-5 series marks one compaction.
  // Emitted as the session-grain scalar only (as Claude Code and Codex do); a
  // per-turn positional COMPACTION timeline event is not wired for Cursor.
  let compactions = 0;
  let prevSummarized = 0;
  for (const c of ordered) {
    // Adjacency is judged against the previous checkpoint's total, NOT the last
    // pushed value: a checkpoint whose total decodes to 0 (only emitted checkpoints
    // are skipped from the sequence) must still break a run so two equal non-zero
    // turns straddling it are BOTH kept.
    if (c.totalTokens > 0 && c.totalTokens === prevTotal) {
      collapsed++; // consecutive equal total → the store's double-write of one checkpoint
    } else if (c.totalTokens > 0) {
      perTurnInputTokens.push(c.totalTokens);
    }
    prevTotal = c.totalTokens;
    if (!peak || c.totalTokens > peak.totalTokens) peak = c;
    // Only real turns move the summarized run — skip emitted-but-empty (0-total)
    // checkpoints, matching the perTurnInputTokens accounting above. A 0-total snapshot's
    // summarized reads 0 and would otherwise reset the run between two genuine summarized
    // turns, mis-counting the next one as a fresh compaction.
    if (c.totalTokens > 0) {
      const summarized = c.segments.find((s) => s.segment === "summarized_conversation")?.tokens ?? 0;
      if (prevSummarized === 0 && summarized > 0) compactions++;
      prevSummarized = summarized;
    }
  }
  if (collapsed > 0) {
    logger.debug("extraction.cursor.cli", "per_turn_double_writes_collapsed", {
      collapsed,
      turns: perTurnInputTokens.length,
    });
  }

  // The tool timeline, recovered from the blob ids' ordinals — see cursorCliSessionEvents.
  const timeline = buildCliSessionEvents(blobs);

  return {
    sessionEvents: timeline.events,
    eventCoverage: timeline.coverage,
    userTurns,
    conversationEntries,
    assistantTexts,
    toolPlaceholders,
    toolCounts,
    toolErrors,
    toolErrorCategories,
    toolFilePaths: Array.from(toolFilePaths),
    editedFilePaths: Array.from(editedFilePaths),
    attributionEvents,
    spawnedAgentNames: Array.from(spawnedAgents),
    prReferences,
    estimatedContextChars: contextChars,
    maxContextTokens: peak?.totalTokens,
    contextWindowTokens: peak?.windowTokens,
    perTurnInputTokens,
    contextComposition: peak?.segments ?? [],
    compactionCount: compactions,
    usesExtendedThinking,
    mcpToolUsed,
  };
}

function recordToolCall(
  b: AssistantBlock,
  resultsById: Map<string, { text: string; errored: boolean }>,
  acc: {
    toolCounts: Record<string, number>;
    toolErrorCategories: Record<string, number>;
    toolFilePaths: Set<string>;
    attributionEvents: AttributionEvent[];
    toolPlaceholders: string[];
    spawnedAgents: Set<string>;
    prReferences: PRRef[];
    editedFilePaths: Set<string>;
    addError: () => void;
  }
): CliEditCounts | null {
  const name = b.toolName!;
  const args = (b.args && typeof b.args === "object" ? b.args : {}) as Record<string, unknown>;
  acc.toolCounts[name] = (acc.toolCounts[name] ?? 0) + 1;

  // Task tool spawns a sub-agent — the type (e.g. "bugbot", "security-review")
  // is recorded on the parent; the child's own transcript is a sibling store.db.
  if (name === "Task" && typeof args["subagent_type"] === "string" && args["subagent_type"]) {
    acc.spawnedAgents.add(args["subagent_type"] as string);
  }

  const outcome = typeof b.toolCallId === "string" ? resultsById.get(b.toolCallId) : undefined;
  const command = name === "Shell" && typeof args["command"] === "string" ? (args["command"] as string) : "";

  // PR authoring evidence from EITHER path, scanned for ALL PR URLs (one loop can
  // raise several). Only a completed authoring action counts:
  //   - Shell: command is `gh pr create` / `glab mr create` / a Bitbucket curl POST
  //   - MCP:   tool name is a PR-create tool (create_pull_request, …)
  // Read/list/view are excluded by isAuthoringPRCommand / the name test. Cross-repo —
  // the PR's own repo is kept; a consumer merged-set gate is the backstop.
  if (((command && isAuthoringPRCommand(command)) || isPrCreateToolName(name)) && !outcome?.errored && outcome?.text) {
    for (const ref of findAllPRUrlsInText(outcome.text)) {
      if (!acc.prReferences.some((r) => r.pr_url === ref.pr_url)) acc.prReferences.push(ref);
    }
  }
  if (outcome?.errored) {
    acc.addError();
    acc.toolErrorCategories["errored"] = (acc.toolErrorCategories["errored"] ?? 0) + 1;
  }

  // All path args → repo resolution + language derivation. Edit-target args
  // (target_file/file_path) additionally → editedFilePaths, the only set sent as
  // tracked_file_paths so read-only files/dirs don't inflate files-edited.
  for (const key of CLI_FILE_ARG_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) acc.toolFilePaths.add(v);
  }
  for (const key of CLI_EDIT_ARG_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) acc.editedFilePaths.add(v);
  }

  acc.toolPlaceholders.push(formatToolPlaceholder(name, args));

  // Shell commands are attribution evidence (git push / gh pr create / curl POST).
  if (name === "Shell" && typeof args["command"] === "string") {
    acc.attributionEvents.push({
      role: "assistant",
      text: "",
      command: args["command"],
      status: outcome?.errored ? "errored" : "completed",
      output: outcome?.text,
    });
  }

  // Attribute an edit's file (Write/StrReplace/Delete — the CLI names the target under
  // `path`, which the arg-key loop above skips so a Read.path never counts). Two
  // consumers, two strictness levels, deliberately:
  //   - the session `editedFilePaths` set → tracked_file_paths is a recall-oriented
  //     attribution signal: add the file whenever the call did not error, treating a
  //     missing tool-result as "ran" — the same default the Shell-status line above
  //     uses. An over-included file barely moves a PR-overlap score; a dropped one
  //     loses the signal outright.
  //   - the per-message line delta must not be a guess: hand it back only when a result
  //     CONFIRMS the edit ran (present AND non-errored), so a turn cut off mid-edit with
  //     no persisted result carries no confident count.
  const edit = cliEditCounts(name, args);
  if (edit && !outcome?.errored) acc.editedFilePaths.add(edit.filePath);
  return edit && outcome && !outcome.errored ? edit : null;
}

/**
 * Parses a role=user blob. Returns null for the leading <user_info> context blob
 * (content is a string) and for empty turns. Real turns carry a text-part list
 * with <timestamp> + <user_query> tags.
 */
export function parseUserBlob(content: unknown): CliUserTurn | null {
  if (typeof content === "string") return null; // <user_info> / <git_status> context blob
  if (!Array.isArray(content)) return null;

  let text = "";
  for (const part of content) {
    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      text += (part as { text: string }).text;
    }
  }
  const query = extractTag(text, "user_query") ?? text;
  if (!query.trim()) return null;

  const tsRaw = extractTag(text, "timestamp");
  const epoch = tsRaw ? parseCursorTimestamp(tsRaw) : undefined;
  return {
    query: query.trim(),
    iso: epoch !== undefined ? new Date(epoch).toISOString() : undefined,
    sortKey: epoch ?? Number.POSITIVE_INFINITY,
  };
}

function extractTag(text: string, tag: string): string | undefined {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1]!.trim() : undefined;
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * Parses Cursor's human-readable timestamp, e.g.
 *   "Wednesday, Jul 8, 2026, 7:04 PM (UTC+5:30)"
 * into epoch ms. Returns undefined on any shape mismatch (caller drops just that
 * timestamp, never the session).
 */
export function parseCursorTimestamp(s: string): number | undefined {
  // The offset minutes are optional: a whole-hour zone renders as "(UTC+8)",
  // a half-hour zone as "(UTC+5:30)" — accept both (missing minutes → 0).
  const m = s.match(
    /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2})\s*(AM|PM)\s*\(UTC([+-])(\d{1,2})(?::(\d{2}))?\)/
  );
  if (!m) return undefined;
  const [, mon, day, year, hourS, minS, ampm, sign, offH, offM] = m;
  const month = MONTHS[mon!];
  if (month === undefined) return undefined;
  let hour = Number(hourS) % 12;
  if (ampm === "PM") hour += 12;
  const utcMs = Date.UTC(Number(year), month, Number(day), hour, Number(minS));
  const offsetMs = (sign === "-" ? -1 : 1) * (Number(offH) * 60 + Number(offM ?? 0)) * 60_000;
  return utcMs - offsetMs;
}

function formatToolPlaceholder(name: string, args: Record<string, unknown>): string {
  const argKey = CLI_TOOL_ARG_KEY[name];
  const argVal = argKey ? args[argKey] : undefined;
  let preview = "";
  if (typeof argVal === "string" && argVal.length > 0) {
    preview = ` ${argKey}=${toolArgPreview(argVal)}`;
  }
  return `[Tool: ${name}${preview}]`;
}

/** Assistant text blocks in the emitted transcript. A Set would collapse identical repeats. */
export function countCliAssistantTexts(parsed: ParsedCliSession): number {
  if (parsed.conversationEntries.length > 0) {
    return parsed.conversationEntries.filter((e) => e.kind === "assistant" && e.block === "text").length;
  }
  return parsed.assistantTexts.length;
}

/**
 * Assembles the conversation. Non-empty `conversationEntries` are emitted in
 * that recovered protobuf-root order. Empty means the legacy path: timestamp-
 * sorted user turns, then aggregated assistant text and tool-call placeholders.
 *
 * Per-turn INPUT tokens: the CLI store records one full re-sent context total per
 * assistant turn (parsed.perTurnInputTokens, chronological). These are attached to
 * assistant *blobs* in transcript order so that, read in array order, the inputTokens
 * form the per-turn full-context-total sequence — which is what a consumer
 * consumes: it SUMS them (ExtractMetrics) and cache-splits the re-sent context.
 * The sequence is per-turn totals, NOT monotonic: it can DROP after summarization.
 * outputTokens stay UNSET (the store logs none).
 *
 * One assistant blob can expand to a text block plus several tool-call placeholders.
 * Those prompts share one turn: the total lands on the first prompt of the group,
 * later prompts in the group get none. The legacy users-then-assistants path has
 * no blob grouping (each text/placeholder is its own turn).
 *
 * Per-MESSAGE attribution is best-effort, NOT exact: CLI blobs are content-
 * addressed and unordered, so a turn's total cannot be tied to its specific text
 * or tool-call block. A turn that produced ONLY (redacted-)reasoning — or was
 * interrupted — emits a context total but NO assistant content block, so totals
 * can OUTNUMBER turns; the surplus trailing totals (the largest/latest) are folded
 * onto the last group's first prompt so a consumer's SUM never silently under-counts
 * the input-only cost. The ordered value SEQUENCE (or its sum) — all a summing/
 * cache-splitting consumer needs — is preserved; do NOT rely on any single prompt's
 * inputTokens being the tokens for that exact message.
 */
export function buildPrompts(parsed: ParsedCliSession, model: string | undefined): ConversationPrompt[] {
  const entries: CliConversationEntry[] =
    parsed.conversationEntries.length > 0
      ? parsed.conversationEntries
      : [
          ...parsed.userTurns.map((turn): CliConversationEntry => ({ kind: "user", turn })),
          ...parsed.assistantTexts.map(
            (content): CliConversationEntry => ({ kind: "assistant", content, block: "text" }),
          ),
          // The fallback rebuilds assistant entries from flattened toolPlaceholders
          // (bare strings), which carry no per-message edit payload — so filesEdited +
          // line counts are dropped here, the same reliability limit as the messageId
          // stamp below (both need the recovered per-turn structure). The session still
          // reports the same files via editedFilePaths → tracked_file_paths.
          ...parsed.toolPlaceholders.map(
            (content): CliConversationEntry => ({ kind: "assistant", content, block: "tool" }),
          ),
        ];
  // The join key is reliable only in recovered protobuf-root order (user turn then its
  // response run); the users-then-assistants fallback cannot associate a turn with its run.
  const usingOrderedEntries = parsed.conversationEntries.length > 0;
  const prompts: ConversationPrompt[] = [];
  let currentRequestId: string | undefined;
  let stampedThisRun = false;
  for (const e of entries) {
    if (e.kind === "user") {
      const p: ConversationPrompt = { role: "user", content: e.turn.query };
      if (e.turn.iso) p.timestamp = e.turn.iso;
      prompts.push(p);
      currentRequestId = e.turn.requestId;
      stampedThisRun = false;
    } else {
      const p: ConversationPrompt = { role: "assistant", content: e.content };
      // Stamp the turn's generation id onto the FIRST assistant prompt of its response run,
      // so the stop-hook merge overlays this generation's measured tokens by exact id.
      if (usingOrderedEntries && currentRequestId && !stampedThisRun) {
        p.metadata = { messageId: currentRequestId };
        stampedThisRun = true;
      }
      // Per-message files_edited + line counts for an edit tool call. The touched file
      // is always recorded; the LOC delta only when countable (present, incl. 0) — an
      // uncountable edit (Delete / blob-pointer) leaves the line fields absent. Merged so
      // an already-stamped messageId survives, and stampAssistantTokens later spreads its
      // token fields on top of these.
      if (e.edit) {
        const meta: PromptMetadata = { ...p.metadata, filesEdited: [e.edit.filePath] };
        if (e.edit.linesAdded !== undefined) meta.linesAdded = e.edit.linesAdded;
        if (e.edit.linesRemoved !== undefined) meta.linesRemoved = e.edit.linesRemoved;
        p.metadata = meta;
      }
      prompts.push(p);
    }
  }
  return stampAssistantTokens(prompts, entries, parsed.perTurnInputTokens, model);
}

/** Attach per-turn input totals onto the first prompt of each assistant blob/turn. */
function stampAssistantTokens(
  prompts: ConversationPrompt[],
  entries: CliConversationEntry[],
  totals: number[],
  model: string | undefined,
): ConversationPrompt[] {
  const out = prompts.slice();
  const groups = groupAssistantTurns(out, entries);
  if (groups.length === 0 && totals.length > 0) {
    const carrier: ConversationPrompt = { role: "assistant", content: "" };
    // A session with token totals but no emitted assistant text/tool block (e.g. a
    // reasoning-only response) still deserves its measured split. Carry the generation id
    // onto the synthetic prompt when the whole session is one generation, so the stop-hook
    // merge can overlay it; leave it unstamped when several ids collapse here (ambiguous).
    const requestIds = [
      ...new Set(entries.flatMap((e) => (e.kind === "user" && e.turn.requestId ? [e.turn.requestId] : []))),
    ];
    if (requestIds.length === 1) carrier.metadata = { messageId: requestIds[0] };
    out.push(carrier);
    groups.push([out.length - 1]);
  }
  if (totals.length !== groups.length) {
    logger.debug("extraction.cursor.cli", "per_turn_token_count_mismatch", {
      perTurnTotals: totals.length,
      assistantTurns: groups.length,
    });
  }
  groups.forEach((promptIndices, i) => {
    let input = totals[i] ?? 0;
    if (i === groups.length - 1 && totals.length > groups.length) {
      for (let j = groups.length; j < totals.length; j++) input += totals[j] ?? 0;
    }
    promptIndices.forEach((promptIdx, k) => {
      const meta: PromptMetadata = {};
      if (model) meta.model = model;
      if (k === 0 && input > 0) meta.inputTokens = input;
      const p = out[promptIdx]!;
      // The CLI store's per-turn total is Cursor's own decoded context-composition
      // count (readContextComposition) — a natively reported input with no output or
      // cache split (outputTokens stay unset here). That is NATIVE_PARTIAL, not a
      // text-length ESTIMATE — stamp it on the billable prompt so a token-bearing CLI
      // turn is never left UNSPECIFIED, mirroring the IDE applyTokenCount choke point.
      // The stop-hook ledger later upgrades an id-matched turn to MEASURED; the
      // guard keeps this from clobbering an already-stamped stronger tier.
      if (meta.inputTokens !== undefined && !p.metadata?.tokenFidelity) {
        meta.tokenFidelity = "TOKEN_FIDELITY_NATIVE_PARTIAL";
      }
      if (Object.keys(meta).length > 0) p.metadata = { ...p.metadata, ...meta };
    });
  });
  return out;
}

/**
 * Consecutive assistant prompts that share a blobId are one turn. Unset blobId
 * (legacy users-then-assistants) keeps each prompt as its own turn.
 */
function groupAssistantTurns(prompts: ConversationPrompt[], entries: CliConversationEntry[]): number[][] {
  const assistantPromptIdx: number[] = [];
  for (let i = 0; i < prompts.length; i++) {
    if (prompts[i]!.role === "assistant") assistantPromptIdx.push(i);
  }
  const assistantEntries = entries.filter((e): e is Extract<CliConversationEntry, { kind: "assistant" }> => e.kind === "assistant");
  if (assistantEntries.length !== assistantPromptIdx.length) {
    return assistantPromptIdx.map((idx) => [idx]);
  }
  const groups: number[][] = [];
  for (let i = 0; i < assistantEntries.length; i++) {
    const blobId = assistantEntries[i]!.blobId;
    const prev = i > 0 ? assistantEntries[i - 1] : undefined;
    if (blobId && prev?.blobId === blobId && groups.length > 0) {
      groups[groups.length - 1]!.push(assistantPromptIdx[i]!);
    } else {
      groups.push([assistantPromptIdx[i]!]);
    }
  }
  return groups;
}

// ── meta / config readers ─────────────────────────────────────────────────────

function readCliMetaRow(reader: SQLiteReader): CliMetaRow | undefined {
  const row = reader.queryOne<{ value: string }>("SELECT value FROM meta WHERE key = ?", ["0"]);
  if (!row?.value) return undefined;
  try {
    return JSON.parse(Buffer.from(row.value, "hex").toString("utf8")) as CliMetaRow;
  } catch {
    return undefined;
  }
}

/** Vendor agent ids are sibling directory names under the chats workspace. */
function isSafeCliAgentDirName(id: string): boolean {
  if (!id || id === "." || id === "..") return false;
  if (id.includes("\0") || id.includes("/") || id.includes("\\")) return false;
  if (isAbsolute(id)) return false;
  return true;
}

/**
 * Immediate parent agent id from a Task-spawned child's store.db meta.
 * Undefined when the field is absent, empty, self-referential, or not a
 * single path segment (so it cannot be joined as a sibling dir).
 */
export function parentAgentIdFromCliSubagentInfo(meta: {
  agentId?: string;
  subagentInfo?: { parentAgentId?: unknown };
}): string | undefined {
  const parent = meta.subagentInfo?.parentAgentId;
  if (typeof parent !== "string" || parent === "" || parent === meta.agentId) {
    return undefined;
  }
  if (!isSafeCliAgentDirName(parent)) return undefined;
  return parent;
}

/** store.db `createdAt` is epoch ms on current Cursor builds; tolerate seconds. */
function cliCreatedAtMs(createdAt: number | undefined): number | undefined {
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt <= 0) {
    return undefined;
  }
  if (createdAt > 1e12) return Math.floor(createdAt);
  if (createdAt > 1e9) return Math.floor(createdAt * 1000);
  return undefined;
}

function cliLineageExtras(metaRow: CliMetaRow | undefined): Pick<SessionLineagePayload, "origin_agent_type" | "tool_use_id"> {
  const extras: Pick<SessionLineagePayload, "origin_agent_type" | "tool_use_id"> = {};
  const typeName = metaRow?.subagentInfo?.typeName;
  if (typeof typeName === "string" && typeName) extras.origin_agent_type = typeName;
  const toolUseId = metaRow?.subagentInfo?.toolCallId;
  if (typeof toolUseId === "string" && toolUseId) extras.tool_use_id = toolUseId;
  return extras;
}

function cliInheritedCwd(
  sessionDir: string,
  parentAgentId: string | undefined,
  rootParentAgentId: string | undefined,
): string | undefined {
  const ids: string[] = [];
  if (parentAgentId) ids.push(parentAgentId);
  if (rootParentAgentId && rootParentAgentId !== parentAgentId) ids.push(rootParentAgentId);
  for (const id of ids) {
    if (!isSafeCliAgentDirName(id)) continue;
    const cwd = readJson<CliMetaJson>(join(sessionDir, "..", id, "meta.json"))?.cwd;
    if (cwd) return cwd;
  }
  return undefined;
}

function cliSubagentLineage(
  parentAgentId: string | undefined,
  metaRow: CliMetaRow | undefined,
  prompts: ConversationPrompt[],
): SessionLineagePayload | undefined {
  if (!parentAgentId) return undefined;
  const childTokens = sumPromptTokens(prompts);
  const lineage: SessionLineagePayload = {
    relation_type: "SUBAGENT",
    parent_record_key: conversationId("cursor", parentAgentId),
    linkage_confidence: "STRONG",
    ...cliLineageExtras(metaRow),
  };
  if (childTokens > 0) lineage.tokens = childTokens;
  return lineage;
}

/**
 * Rejects a "branch" the attribution parser lifted from a shell command that
 * isn't a literal ref: an unresolved variable (`$BRANCH`, `${x}`), a quoted or
 * whitespaced token, or an over-long string. Git branch names never contain
 * these, so filtering them removes false positives without dropping real heads.
 */
export function isCleanBranchName(name: string): boolean {
  if (!name || name.length > 128) return false;
  return !/[\s$"'`\\]/.test(name);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Reads the Cursor Statsig account record from ~/.cursor/statsig-cache.json.
 *
 * The cache stores a `data` blob — stringified JSON in the Statsig SDK's own
 * cache shape, tolerated as an already-parsed object for a future format —
 * whose `user.custom` is the identical object the IDE exposes under
 * state.vscdb's `workbench.experiments.statsigBootstrap`. Both surfaces
 * therefore ship the same raw team/enterprise fields and a consumer derives
 * one canonical tier — but *only* these fields: the Standard-versus-Premium seat
 * tier needs the access token, which only the IDE store holds, so on that value
 * the IDE surface writes and this one reads (detectCursorCliTier).
 *
 * `stripeMembershipStatus` rides along as plan_tier, but it is the INDIVIDUAL
 * Stripe subscription, not the effective seat: an account on a paid Teams seat
 * reports "free" there while the IDE reports "enterprise" in
 * `stripeMembershipType` at the same instant. It is therefore only meaningful
 * when the account has no team, which is exactly how a consumer consumes it —
 * a team id outranks the membership string, so the misleading "free" is never
 * what prices a team seat. Withholding it instead would leave a genuine
 * individual CLI subscriber with no tier at all.
 *
 * Set here rather than in the shared extractor because the IDE path already
 * holds the better value (the effective `stripeMembershipType`) and must not
 * have it overwritten by the individual-subscription one.
 *
 * Returns an empty object when the cache is absent, unparseable, or carries
 * none of the fields; never throws.
 */
function readCursorCliStatsigAccount(): Partial<InstallationMetadata> {
  const cachePath = getCursorStatsigCachePath();
  // Absence is the normal case on a machine without the Cursor CLI — not a
  // failure, so it is not logged.
  if (!existsSync(cachePath)) return {};

  let root: unknown;
  try {
    root = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch (err) {
    logger.warn("extraction.cursor.cli", "statsig_cache_parse_failed", {
      path: cachePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }

  let data = root !== null && typeof root === "object" ? (root as { data?: unknown }).data : undefined;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (err) {
      logger.warn("extraction.cursor.cli", "statsig_cache_data_parse_failed", {
        path: cachePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  const account = extractCursorStatsigAccount(data);

  const custom =
    data !== null && typeof data === "object"
      ? (data as { user?: { custom?: Record<string, unknown> } }).user?.custom
      : undefined;
  const membership = custom?.["stripeMembershipStatus"];
  if (typeof membership === "string" && membership.length > 0) {
    account.plan_tier = membership;
  }

  return account;
}

/**
 * Reads install metadata for a Cursor CLI session. The login email and privacy
 * mode come from ~/.cursor/cli-config.json; the account's team/enterprise fields
 * come from the CLI's Statsig cache (readCursorCliStatsigAccount), which
 * cli-config.json carries nothing equivalent to. plan_tier_source distinguishes
 * the two so a session with no Statsig cache is still traceable to the CLI
 * config read.
 *
 * plan_tier on this path is only what the Statsig cache's `stripeMembershipStatus`
 * says (see readCursorCliStatsigAccount); no CLI-local file carries a trustworthy
 * per-seat tier string, so a consumer derives the canonical tier from the raw
 * account fields, and a surface with no Statsig cache emits no tier at all.
 *
 * `meta`, when supplied, is the seat-tier cache row as a strict reader: this
 * surface stamps the vendor seat tier only from a row that already belongs to the
 * account it is signed into, and never writes (`readCachedSeatTierStamp`). A
 * CLI-only machine therefore reports no seat tier at all, by design.
 */
export function detectCursorCliTier(meta?: SeatTierMetaReader): InstallationMetadata | undefined {
  const cfg = readJson<{
    authInfo?: { email?: string };
    privacyCache?: { privacyMode?: number; ghostMode?: boolean };
  }>(getCursorCliConfigPath());

  const statsigAccount = readCursorCliStatsigAccount();
  const hasStatsigAccount = Object.keys(statsigAccount).length > 0;
  // Nothing to attach if neither source produced anything.
  if (!cfg && !hasStatsigAccount) return undefined;

  const seatTier =
    meta === undefined
      ? {}
      : readCachedSeatTierStamp({ meta, accountSubject: statsigAccount.cursor_user_id });

  const cliMeta: InstallationMetadata = {
    plan_tier_source: hasStatsigAccount ? "cursor_cli_statsig" : "cursor_cli_config",
    ...statsigAccount,
    ...seatTier,
  };
  if (typeof cfg?.authInfo?.email === "string" && cfg.authInfo.email) {
    cliMeta.login_email = cfg.authInfo.email;
  }
  // privacyMode: 0 = off, ≥1 = on (privacy/ghost). ghostMode is the newer flag.
  if (typeof cfg?.privacyCache?.privacyMode === "number") {
    cliMeta.cursor_privacy_mode = cfg.privacyCache.privacyMode > 0;
  } else if (typeof cfg?.privacyCache?.ghostMode === "boolean") {
    cliMeta.cursor_privacy_mode = cfg.privacyCache.ghostMode;
  }
  return Object.keys(cliMeta).length > 1 ? cliMeta : undefined; // more than just the source
}
