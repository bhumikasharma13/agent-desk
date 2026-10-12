// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { accessSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  ContextSegment,
  ConversationPrompt,
  InstallationMetadata,
  PromptMetadata,
  SessionLineagePayload,
  SessionMetaPayload,
} from "../types/session";
import { MAX_CONTEXT_SEGMENTS, MAX_SEGMENT_ID_CHARS } from "../types/session";
import type { SessionSink } from "../types/store";
import { conversationId, sumPromptTokens } from "../store/ids";
import { redactPrompts, redactPath, redactText, sanitizeSessionMeta } from "../redaction";
import {
  SessionEventBuilder,
  promptReferenceAuthor,
  promptAuthorship,
  type SessionEvent,
  type EventCoverage,
} from "./sessionEvents";
import { cursorStatusEffect, cursorToolOutcome, cursorToolSummary } from "./cursorSessionEvents";
import { declaredArtifactOf, toolArgs as resolveToolArgs } from "./cursorUsageShared";
import { SQLiteReader, openVendorDb } from "./sqliteReader";
import { getCursorDbPath, getCursorWorkspaceStoragePath, hasPathOverride, homeDir, homeRootOverride } from "./pathResolver";
import {
  resolveProjectAndRepo,
  getFullSessionDiffStats,
  getSessionPRLink,
  canonicalRepoKey,
  resolveSessionBranch,
} from "./gitUtils";
import {
  collectCursorAttribution,
  isAuthoringPRCommand,
  type AttributionEvent,
} from "./cursorAttributionSignals";
import { detectCursorTier } from "./planTierDetector";
import { readCursorAiTracking, readCursorDailyStats } from "./cursorAiTrackingReader";
import { readAllCursorProjectSignals } from "./cursorProjectReader";
import { deriveLanguages } from "./languageMap";
import { readCursorMcpServerNames, toolArgPreview } from "./cursorShared";
import { parseRootPathFromCursorValue } from "../types/cursorVscdb";
import { extractCursorCli } from "./cursorCliExtractor";
import { loadCursorStopLedger, mergeStopHookTokens, rotateCursorStopLedgerIfLarge, type MeasuredGeneration } from "./cursorStopHook";
import { resolveCursorSeatTier, type SeatTierLookup } from "../seams/seatTier";
import type { SeatTierRunReport } from "../types/seatTier";
import { logger } from "../seams/logger";
import { reportRecordError, reportSourceError } from "../seams/scanScope";
import { fileUriPath } from "./fileUri";

// ── Cursor DB shapes ─────────────────────────────────────────────────────────

interface KVRow {
  key: string;
  value: string;
}

interface BubbleHeader {
  bubbleId: string;
  type: number; // 1 = user, 2 = assistant
}

interface ComposerData {
  composerId: string;
  createdAt: number;
  lastUpdatedAt: number;
  name: string;
  fullConversationHeadersOnly: BubbleHeader[];
  allAttachedFileCodeChunksUris?: string[];
  modelConfig?: { modelName?: string };
  contextUsagePercent?: number;
  // Absolute context-window occupancy (Cursor 3+); complements the percentage.
  contextTokensUsed?: number;
  contextTokenLimit?: number;
  // Cursor 3+ context-window meter (preferred over contextTokensUsed when present).
  promptTokenBreakdown?: {
    totalUsedTokens?: number;
    maxTokens?: number;
    categories?: Array<{ id?: string; label?: string; estimatedTokens?: number }>;
  };
  // Vendor-reported actual cost per model. Keys are Cursor model ids ("default" for
  // Auto, "composer-2.5", "claude-4-sonnet", …) — not always nested under "default".
  usageData?: CursorUsageData;
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
  isAgentic?: boolean;
  unifiedMode?: string; // "agent" | "edit"
  // Child composer ids for sub-agents this session spawned (Agent window + IDE).
  // Length is the per-session sub-agent count that drives delegation_level.
  subagentComposerIds?: string[];
  // Present on a Task-spawned *child* composer. Direct child→parent link;
  // the parent's subagentComposerIds can lag or be absent on the first read.
  subagentInfo?: { parentComposerId?: string };
  // codeBlockData keys are file:/// URIs pointing to files Cursor showed in the session
  codeBlockData?: Record<string, unknown>;
  // context.mentions.selections keys are JSON strings containing a "uri" field
  context?: {
    mentions?: {
      selections?: Record<string, unknown>;
      fileSelections?: Record<string, unknown>;
      terminalFiles?: Record<string, unknown>;
    };
  };
  // Git-branch signals captured by Cursor at various points in the session.
  // createdOnBranch is set at session creation; committedToBranch is set when
  // a commit lands from the session; activeBranch/branches reflect workspace
  // state. Collected together to drive a last-non-trunk resolution.
  createdOnBranch?: string;
  committedToBranch?: string;
  activeBranch?: { branchName?: string };
  branches?: Array<{ branchName?: string }>;
}

interface ToolFormerData {
  // Cursor tool name, e.g. "edit_file" | "read_file" | "grep_search" | "run_terminal_cmd".
  name?: string;
  // Cursor's lifecycle status: "completed" (most bubbles), absent, "error", "cancelled" or
  // "loading". The error spelling is "error", never "errored". The spelling is load-bearing,
  // since both the loop timeline and the session-meta rollup switch on it.
  //
  // It says whether the TOOL ran, not whether the work succeeded: a command that exited nonzero
  // is a "completed" terminal invocation. For a tool's verdict use cursorToolOutcome, which reads
  // the exit code below first.
  status?: string;
  // Cursor's own id for the call, present on roughly half of real tool bubbles.
  toolCallId?: string;
  // JSON-encoded args string. Parse defensively — malformed JSON must not crash extraction.
  rawArgs?: string;
  // Structured tool params; for terminal tools carries `command`. Present alongside rawArgs.
  params?: { command?: string };
  // JSON-encoded tool result. For terminal tools it carries the command's exit code beside its
  // output: `{"output":"…stdout…","exitCode":N,"exitCodeV2":N}`. Two readers, and they are
  // deliberately not the same gate: cursorToolOutcome derives the event's outcome from the exit
  // code, while PR recovery reads the OUTPUT and gates on "completed" + a URL being present —
  // a real `gh pr create` created its PR and printed the URL while exiting 1, so an exit-code
  // gate would drop it.
  result?: string;
  // Internal Cursor tool ID; unused.
  tool?: number;
}

interface BubbleData {
  /** ISO timestamp Cursor stamps on a bubble; absent on older rows. */
  createdAt?: string;
  bubbleId: string;
  /**
   * The generation id Cursor assigns the bubble's response — the same id the stop-hook
   * ledger carries as generation_id. The exact join key that attaches a measured stop
   * event to this turn (see cursorStopHook mergeStopHookTokens).
   */
  requestId?: string;
  text: string;
  rawText: string;
  tokenCount?: { inputTokens: number; outputTokens: number };
  relevantFiles?: string[];
  codeBlocks?: unknown[];
  // Populated on agent-mode assistant bubbles that invoked a tool. When present
  // with empty text/rawText, the extractor falls back to a "[Tool: name]" placeholder.
  toolFormerData?: ToolFormerData;
  // Cursor's non-user-authored marker: set when a spawn tool call authored the turn
  // (an injected task prompt), not the human. Used to skip such turns — see the
  // first-user-turn capture in loadBubbles.
  subagentSpawnTaskToolCallId?: string;
  // Cursor's harness-injection marker: present on a `<system_notification>` turn Cursor injects
  // when a background task finishes. It wears the user role but nobody typed it, so its presence
  // stamps the turn's author AGENT rather than HUMAN. Distinct from and disjoint with the spawn
  // marker above (spawn = a delegated agent's turn; this = the harness's) — grounded by a
  // real-store test. Only its presence is read (the object's fields — a title, a taskId — are not).
  simulatedMessageMetadata?: Record<string, unknown>;
}

export interface CursorUsageDataEntry {
  costInCents?: number;
  /** Cursor-internal usage counter (not USD); ignored for cost reporting. */
  amount?: number;
}

/** Per-model usage/cost rollup on composerData (keys are Cursor model ids). */
export type CursorUsageData = Record<string, CursorUsageDataEntry>;

/**
 * Resolves vendor-reported session cost from composerData.usageData.
 *
 * Cursor keys usageData by model id ("default" for Auto, "composer-2.5", …).
 * When `default` is populated it is the session aggregate — do NOT add per-model
 * buckets on top (Cursor can write both after a model switch, which double-counts
 * and inflates seat-allocated cost). When `default` is absent, sum all per-model
 * buckets (mixed sessions after a model switch).
 */
export function resolveCursorReportedCostUsd(usageData: CursorUsageData | undefined): number | undefined {
  if (!usageData || typeof usageData !== "object") return undefined;

  const centsFor = (key: string): number => {
    const cents = usageData[key]?.costInCents;
    return typeof cents === "number" && cents > 0 ? cents : 0;
  };

  const defaultCents = centsFor("default");
  if (defaultCents > 0) return defaultCents / 100;

  let totalCents = 0;
  let sawCost = false;
  for (const [key, entry] of Object.entries(usageData)) {
    if (key === "default") continue;
    if (!entry || typeof entry !== "object") continue;
    const cents = entry.costInCents;
    if (typeof cents === "number" && cents > 0) {
      totalCents += cents;
      sawCost = true;
    }
  }
  return sawCost ? totalCents / 100 : undefined;
}

/**
 * Recovers the session's model id from usageData's KEYS when modelConfig does not
 * name one. Cursor keys usageData by model id, so the keys are a second, independent
 * record of what ran — resolveCursorReportedCostUsd above already walks them for cost
 * and discards the key itself.
 *
 * It matters for accuracy, not for whether an estimate is emitted. The fallbacks below
 * always estimate; a consumer that prices tokens must price an unnamed model at some
 * generic rate, which can be an order of magnitude off Cursor's own models. Recovering
 * the id here lets it use the real rate.
 *
 * Returns undefined when usageData names several models: a session that switched
 * models cannot have its unattributed turns assigned to one of them, and guessing
 * would misprice every turn that ran the other. "default" is Cursor's Auto id and is
 * a usable answer — a consumer maps it to the Auto pool rate.
 */
export function recoverModelFromUsageData(
  usageData: CursorUsageData | undefined
): string | undefined {
  if (!usageData || typeof usageData !== "object") return undefined;
  const keys = Object.keys(usageData).filter((k) => {
    const entry = usageData[k];
    return k.trim().length > 0 && entry && typeof entry === "object";
  });
  if (keys.length !== 1) return undefined;
  return keys[0];
}

/** True when any prompt carries non-zero input or output tokens from bubbles. */
export function promptsHaveBillableTokens(prompts: ConversationPrompt[]): boolean {
  for (const p of prompts) {
    const m = p.metadata;
    if (!m) continue;
    if ((m.inputTokens ?? 0) > 0 || (m.outputTokens ?? 0) > 0) return true;
  }
  return false;
}

/**
 * Cursor 3+ often writes bubble tokenCount as {0,0}; the composer-level context
 * meter (promptTokenBreakdown.totalUsedTokens, else contextTokensUsed) is the
 * best local input signal. Returns that reading when present.
 */
export function resolveContextMeterTokens(composer: ComposerData): number | undefined {
  const fromBreakdown = composer.promptTokenBreakdown?.totalUsedTokens;
  if (typeof fromBreakdown === "number" && fromBreakdown > 0) return fromBreakdown;
  const used = composer.contextTokensUsed;
  if (typeof used === "number" && used > 0) return used;
  return undefined;
}

/**
 * When no bubble carries billable tokens, attach the composer context meter as
 * inputTokens on the last assistant turn so a consumer can derive a token cost
 * (input-only estimate for cache-blind Cursor). Matches the tokenuse.app
 * "context-meter input credit" pattern — one meter reading per conversation.
 */
export function applyContextMeterTokenFallback(
  prompts: ConversationPrompt[],
  composer: ComposerData,
  modelName?: string
): void {
  if (promptsHaveBillableTokens(prompts)) return;
  const meter = resolveContextMeterTokens(composer);
  if (!meter) return;

  const creditMeter = (turn: ConversationPrompt) => {
    if (!turn.metadata) turn.metadata = {};
    if (modelName && !turn.metadata.model) turn.metadata.model = modelName;
    turn.metadata.inputTokens = meter;
    // The context meter is Cursor's native context-composition total — input only, no
    // output/cache split — so NATIVE_PARTIAL, not a text-length estimate.
    turn.metadata.tokenFidelity = "TOKEN_FIDELITY_NATIVE_PARTIAL";
  };

  // Prefer a real (non-placeholder) assistant turn as the meter carrier. Fall
  // back to the last tool-only [Tool: …] turn so all-tool-call agent sessions
  // still credit the input meter instead of persisting zero tokens — input only,
  // as placeholders carry no output text to estimate.
  let placeholderCarrier: ConversationPrompt | undefined;
  for (let i = prompts.length - 1; i >= 0; i--) {
    const p = prompts[i];
    if (p?.role !== "assistant") continue;
    if (isCursorToolPlaceholderContent(p.content)) {
      if (!placeholderCarrier) placeholderCarrier = p;
      continue;
    }
    creditMeter(p);
    return;
  }
  if (placeholderCarrier) creditMeter(placeholderCarrier);
}

/** True for assistant turns synthesized as `[Tool: …]` placeholders in loadBubbles. */
export function isCursorToolPlaceholderContent(content: string): boolean {
  return content.trimStart().startsWith("[Tool:");
}

/** Text tokens that count toward IDE cost estimation (excludes tool-only placeholders). */
function promptTextTokensForEstimation(p: ConversationPrompt): number {
  if (p.role === "assistant" && isCursorToolPlaceholderContent(p.content)) return 0;
  return estimateTextTokens(p.content);
}

/** Rough token count from stored prompt text (~4 chars/token). */
export function estimateTextTokens(text: string): number {
  const len = text.trim().length;
  if (len <= 0) return 0;
  return Math.max(1, Math.ceil(len / 4));
}

/** Non-conversation share of the peak context window (tools, rules, skills, …). */
export function fixedContextOverhead(composer: ComposerData): number {
  const cats = composer.promptTokenBreakdown?.categories;
  if (!cats?.length) return 0;
  let sum = 0;
  for (const c of cats) {
    if (c.id === "conversation" || c.id === "summarized_conversation") continue;
    const t = c.estimatedTokens;
    if (typeof t === "number" && t > 0) sum += t;
  }
  return sum;
}

/** Conversation slice of the peak window — from breakdown or meter minus overhead. */
export function conversationTokenBudget(composer: ComposerData, overhead: number): number {
  // Sum both conversation buckets; fixedContextOverhead excludes the same pair,
  // so omitting summarized_conversation here would drop it from the budget
  // entirely and undercount summarized multi-turn sessions.
  let conv = 0;
  for (const c of composer.promptTokenBreakdown?.categories ?? []) {
    if (c.id !== "conversation" && c.id !== "summarized_conversation") continue;
    const t = c.estimatedTokens;
    if (typeof t === "number" && t > 0) conv += t;
  }
  if (conv > 0) return conv;
  const meter = resolveContextMeterTokens(composer);
  if (typeof meter === "number" && meter > overhead) return meter - overhead;
  return 0;
}

/** Maps IDE promptTokenBreakdown.categories → SessionMeta.context_composition. */
export function contextCompositionFromBreakdown(composer: ComposerData): ContextSegment[] {
  const cats = composer.promptTokenBreakdown?.categories;
  if (!cats?.length) return [];
  const out: ContextSegment[] = [];
  for (const c of cats) {
    if (!c.id || typeof c.estimatedTokens !== "number") continue;
    out.push({
      segment: c.id.slice(0, MAX_SEGMENT_ID_CHARS),
      tokens: c.estimatedTokens,
      chars: 0,
    });
  }
  return out.slice(0, MAX_CONTEXT_SEGMENTS);
}

/**
 * When bubble tokenCount is zero (Cursor 3+ composer-2.5), synthesize per-turn
 * input/output tokens so a consumer can price multi-turn sessions:
 *   - outputTokens from assistant text length
 *   - inputTokens from fixed overhead + conversation budget scaled by cumulative text
 *   - last turn anchored to the context meter peak when present
 * Falls back to applyContextMeterTokenFallback when no text/breakdown exists.
 *
 * Call only AFTER tokens_observed is computed from real bubble tokenCount — synthetic
 * tokens must not close the post-completion backfill settle window.
 */
export function applyIdeTokenEstimationFallback(
  prompts: ConversationPrompt[],
  composer: ComposerData,
  modelName?: string
): void {
  if (promptsHaveBillableTokens(prompts)) return;

  const overhead = fixedContextOverhead(composer);
  const convBudget = conversationTokenBudget(composer, overhead);
  const meterPeak = resolveContextMeterTokens(composer);

  let totalTextTokens = 0;
  for (const p of prompts) totalTextTokens += promptTextTokensForEstimation(p);

  if (overhead > 0 || convBudget > 0 || totalTextTokens > 0) {
    let cumulativeTextTokens = 0;
    for (const p of prompts) {
      if (p.role === "user") {
        cumulativeTextTokens += promptTextTokensForEstimation(p);
        continue;
      }
      if (p.role !== "assistant") continue;
      if (isCursorToolPlaceholderContent(p.content)) continue;

      if (!p.metadata) p.metadata = {};
      if (modelName && !p.metadata.model) p.metadata.model = modelName;

      const output = estimateTextTokens(p.content);
      if (output > 0) p.metadata.outputTokens = output;

      let input = overhead;
      if (convBudget > 0 && totalTextTokens > 0) {
        input += Math.round(convBudget * (cumulativeTextTokens / totalTextTokens));
      }

      if (input > 0 || output > 0) {
        p.metadata.inputTokens = Math.max(input, 1);
        // Synthesized from text/breakdown — ESTIMATE tier, not ledger-measured.
        p.metadata.tokenFidelity = "TOKEN_FIDELITY_ESTIMATE";
      }

      cumulativeTextTokens += promptTextTokensForEstimation(p);
    }

    if (meterPeak) {
      for (let i = prompts.length - 1; i >= 0; i--) {
        const p = prompts[i];
        if (p?.role !== "assistant") continue;
        if (isCursorToolPlaceholderContent(p.content)) continue;
        if (!p.metadata) p.metadata = {};
        const current = p.metadata.inputTokens ?? 0;
        if (current < meterPeak) {
          p.metadata.inputTokens = meterPeak;
          // The input is now the native context-meter peak (no output/cache split).
          // tokenFidelity is a flat per-turn trust filter, so it reflects the weakest
          // source contributing to the turn: a turn credited only by the meter (empty
          // text, no synthesized output) is purely meter-native → NATIVE_PARTIAL, while
          // a turn that also carries a text-estimated output stays at the weaker ESTIMATE
          // bar so that estimated output is never trusted as native.
          p.metadata.tokenFidelity =
            (p.metadata.outputTokens ?? 0) > 0
              ? "TOKEN_FIDELITY_ESTIMATE"
              : "TOKEN_FIDELITY_NATIVE_PARTIAL";
        }
        break;
      }
    }

    if (promptsHaveBillableTokens(prompts)) return;
  }

  applyContextMeterTokenFallback(prompts, composer, modelName);
}

const COMPOSER_PREFIX = "composerData:";
const BUBBLE_PREFIX = "bubbleId:";

// Cap on the first_prompt display-label copy. The full opening turn already ships in
// prompts[], so bound the session_meta copy — an uncapped large opening message (a
// pasted log/diff) would otherwise duplicate into session_meta and re-sync on every
// re-extraction cycle. Matches claudeCodeExtractor's FIRST_PROMPT_MAX_CHARS.
const FIRST_PROMPT_MAX_CHARS = 500;

const MRC_PREFIX = "messageRequestContext:";
const CURSOR_ROLE_ASSISTANT = 2;

// SQLite IN-clause batch size for Cursor's bubbleId:* loading. 500 is a
// memory/syscall trade-off — lower if Cursor's state.vscdb is on a slow disk.
const BUBBLE_BATCH_SIZE = 500;

// ── Token-settle forced re-extraction ────────────────────────────────────────

// Settle window (measured from lastUpdatedAt / last activity): only force a re-read
// of composers active within this window. 3 days comfortably covers Cursor's
// post-completion token backfill while bounding forced work to genuinely recent
// sessions; the historical tail is handled by the one-time ExtractorVersions backfill.
const CURSOR_REEXTRACT_SETTLE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

// Throttle: force a re-read of a given composer at most once per this interval.
// A host may scan every few minutes, and each forced re-read reloads bubbles from a
// multi-GB state.vscdb (plus any git subprocesses), so an unthrottled per-cycle
// re-read would be far too expensive. 8 h keeps at most ~3 forced re-reads/day per
// unsettled composer — enough to catch a late backfill within the settle window.
const CURSOR_REEXTRACT_THROTTLE_MS = 8 * 60 * 60 * 1000;

/**
 * Decides whether to force a full re-read of a Cursor composer whose lastUpdatedAt is
 * unchanged (the normal dedup would skip it).
 *
 * Why this exists: Cursor writes each bubble's tokenCount into state.vscdb AFTER the
 * turn completes (backfilled). When a turn's backfill lands *after* the composer's
 * final lastUpdatedAt bump, the lastUpdatedAt-based dedup never re-reads the composer,
 * so its bubbles stay at 0 tokens and total_tokens is 0 forever. Forcing a bounded,
 * throttled re-read of recently-active composers lets those late tokens flow.
 *
 * Returns true only within the settle window, before the *most recent* turn's tokens
 * have landed, and once the throttle interval has elapsed since the last re-read.
 *
 * `tokens_observed` tracks the LAST assistant turn specifically (set in processComposer),
 * not any turn — so an earlier turn's tokens can't latch it and close the window before
 * the final turn settles, and a new turn (lastUpdatedAt advances) reopens the window.
 *
 * Terminal condition: forced re-reads stop once the latest turn's tokens are observed
 * (backfill landed) OR the composer ages past the settle window (backfill landed or
 * never will) — whichever comes first.
 */
export function shouldForceCursorReextract(
  tracking: { last_reextract_at: number | null; tokens_observed: number },
  lastUpdatedAt: number,
  nowMs: number = Date.now()
): boolean {
  // Terminal: the latest turn's tokens already landed — nothing left to settle.
  if (tracking.tokens_observed) return false;
  // Only within the settle window (bounds forced work to recently-active sessions).
  if (nowMs - lastUpdatedAt >= CURSOR_REEXTRACT_SETTLE_WINDOW_MS) return false;
  // Throttle: at most one forced re-read per interval. A null value (a row written
  // before the column existed) reads as 0, so such a row is eligible immediately.
  // A negative elapsed (system clock moved backward since last_reextract_at was
  // written) is treated as "allow", not throttled indefinitely.
  const elapsed = nowMs - (tracking.last_reextract_at ?? 0);
  if (elapsed >= 0 && elapsed < CURSOR_REEXTRACT_THROTTLE_MS) return false;
  return true;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Reads Cursor IDE's state.vscdb and upserts conversations into the local DB.
 * Compares each conversation's lastUpdatedAt against stored tracking data
 * to only re-extract changed conversations.
 */
// Runs the terminal-CLI reader, isolating its failure so a CLI error never
// fails IDE extraction (and an absent/locked IDE db never blocks CLI capture).
// Called from both the IDE-absent early path and the normal post-IDE path, and
// both must carry the seat-tier gate: the CLI surface stamps from the cache row
// the IDE resolver wrote, so a gate honoured on only one path leaves the feature
// partly live after the host withdraws its lookup.
function runCursorCli(
  db: SessionSink,
  seen: Set<string>,
  cursorSeatTierLookupEnabled: boolean,
  captureLineage: boolean,
): number {
  try {
    return extractCursorCli(db, seen, { cursorSeatTierLookupEnabled, captureLineage });
  } catch (err) {
    logger.error("extraction.cursor", "cli_extraction_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    reportSourceError(null, err);
    return 0;
  }
}

/**
 * Merges the resolver's raw vendor fields onto the locally-derived installation
 * metadata. The stamp carries no `plan_tier_source`, so the local origin the
 * consumer needs to classify a tier it rejects survives this merge.
 */
function withSeatTierStamp(
  base: InstallationMetadata | null,
  stamp: Partial<InstallationMetadata>,
): InstallationMetadata | null {
  if (Object.keys(stamp).length === 0) return base;
  return { ...(base ?? {}), ...stamp };
}

/** One extraction cycle's knobs. */
export interface ExtractCursorOptions {
  /** Gates session-lineage capture (sub-agent transcripts). */
  captureLineage?: boolean;
  /**
   * The host's network call for the seat tier, and the seat-tier gate: absent
   * by default, and absent means the vendor is not contacted and neither
   * surface stamps a cached tier. The cache around it is the package's.
   */
  seatTierLookup?: SeatTierLookup;
  /** Test seam. Defaults to the real resolver. */
  resolveSeatTier?: typeof resolveCursorSeatTier;
}

/** A cycle's count, and the seat-tier run report whenever the resolver ran. */
export interface CursorScanResult {
  count: number;
  seatTier?: SeatTierRunReport;
}

export async function extractCursor(
  db: SessionSink,
  opts: ExtractCursorOptions = {},
): Promise<number> {
  return (await scanCursor(db, opts)).count;
}

export async function scanCursor(
  db: SessionSink,
  opts: ExtractCursorOptions = {},
): Promise<CursorScanResult> {
  const {
    captureLineage = false,
    seatTierLookup,
    resolveSeatTier = resolveCursorSeatTier,
  } = opts;
  const cursorSeatTierLookupEnabled = seatTierLookup !== undefined;
  let seatTierReport: SeatTierRunReport | undefined;
  const dbPath = getCursorDbPath();
  const startTime = Date.now();

  // The gate is logged per cycle because it is the only way to tell, from the
  // logs alone, whether a run made no vendor call because the
  // host supplied no lookup or because the call itself produced nothing.
  logger.info("extraction.cursor", "extraction_start", {
    dbPath,
    cursorSeatTierLookupEnabled,
  });

  try {
    accessSync(dbPath);
  } catch {
    // No IDE state.vscdb — a CLI-only cursor-agent user (Cursor IDE not
    // installed). Skip the IDE read but STILL capture terminal-CLI sessions;
    // the CLI store (~/.cursor/chats) is independent of the IDE db.
    logger.info("extraction.cursor", "db_not_found", { dbPath });
    const cliOnly = runCursorCli(db, new Set(), cursorSeatTierLookupEnabled, captureLineage);
    rotateStopLedgerUnlessRedirected();
    return { count: cliOnly };
  }

  // Build composerId → workspace folder map once before the extraction loop.
  // This is the most reliable fallback for sessions with no attached files.
  const workspaceMap = buildComposerWorkspaceMap();

  const reader = new SQLiteReader(dbPath);
  let extracted = 0;
  // Precedence dedup: the composerData (IDE + Agent) ids own these sessions;
  // seed `seen` with them so the CLI reader skips any session already captured
  // here. composerData > CLI > Agent.
  const seen = new Set<string>();
  // Whether the composerData read finished. If it fails mid-way (locked/corrupt
  // state.vscdb), `seen` is only partial — running the CLI reader then could
  // upsert a CLI row over a composerData session that shares its uuid (same
  // (ide_type, session_id) key), violating composerData > CLI precedence. So the
  // CLI pass runs only after a COMPLETE read (the absent-db, CLI-only case is
  // handled at the accessSync guard above, where there is no composerData).
  let ideReadComplete = false;

  try {
    reader.open();

    const rows = reader.query<KVRow>(
      `SELECT key, value FROM cursorDiskKV WHERE key LIKE ?`,
      [`${COMPOSER_PREFIX}%`]
    );

    logger.info("extraction.cursor", "conversations_found", {
      totalConversations: rows.length,
    });

    const cursorDir = join(homeDir(), ".cursor");

    // Parse each composer value once — reused by the lineage pre-pass and the
    // main loop (parseComposerData JSON-parses the whole row, not free at scale).
    const composers: ComposerData[] = [];
    for (const row of rows) {
      const cd = parseComposerData(row.value);
      if (cd) composers.push(cd);
    }

    // Lineage pre-pass: a composer that spawned sub-agents lists their composer
    // ids in `subagentComposerIds`, and each child is itself a composerData
    // session. Invert to child→parent so a child can be tagged SUBAGENT even
    // when it's processed before its parent. NOT `subComposerIds` — that is the
    // best-of-N sampling set (isBestOfNSubcomposer), not delegation.
    const childToParent = new Map<string, string>();
    if (captureLineage) {
      for (const cd of composers) {
        for (const childId of cd.subagentComposerIds ?? []) {
          if (typeof childId === "string" && childId) childToParent.set(childId, cd.composerId);
        }
      }
      // Fallback: Cursor also mirrors sub-agents under
      // ~/.cursor/projects/<slug>/agent-transcripts/<parent>/subagents/<child>.jsonl.
      // composerData.subagentComposerIds can lag or be absent on the first read;
      // the on-disk layout is a stable STRONG link for the same child uuid.
      for (const [childId, parentId] of buildChildToParentFromAgentTranscripts(cursorDir)) {
        if (!childToParent.has(childId)) childToParent.set(childId, parentId);
      }
      // Overlay last so a child is tagged even when both fallbacks above are
      // empty. Drop any parent that did not parse this cycle — otherwise the
      // child is SUBAGENT of a conversation that was never extracted.
      const composerIds = new Set(composers.map((c) => c.composerId));
      for (const cd of composers) {
        const parentId = parentComposerIdFromSubagentInfo(cd);
        if (parentId && composerIds.has(parentId)) {
          childToParent.set(cd.composerId, parentId);
        }
      }
      for (const [childId, parentId] of [...childToParent]) {
        if (!composerIds.has(parentId)) childToParent.delete(childId);
      }
    }

    // Read AI tracking and project signals once (global, not per-conversation).
    const aiMetrics = readCursorAiTracking(cursorDir);
    const projectSignals = readAllCursorProjectSignals(cursorDir);

    // MCP server names and the installation/plan tier are installation-global —
    // the same for every conversation — so resolve them once per cycle instead
    // of re-reading ~/.cursor/mcp.json and re-running the ItemTable tier queries
    // for every composer.
    const mcpNames = readCursorMcpServerNames();
    const readVscdbKey = (key: string): string | null => {
      try {
        const row = reader.queryOne<KVRow>("SELECT key, value FROM ItemTable WHERE key = ?", [key]);
        return row?.value ?? null;
      } catch {
        return null;
      }
    };
    const localMeta = detectCursorTier(readVscdbKey);

    // The seat tier is installation-global for the same reason the tier above is,
    // and here that is a traffic bound rather than an optimisation: per
    // conversation it would be one credentialed vendor call per session on the
    // machine. The resolver enforces at most one attempt per day on its own, but
    // this is the call site that keeps the gate, the cache and the lease reading
    // as one decision per cycle. Awaited with the reader still open because the
    // token lives in the same ItemTable this closure reads.
    const seatTier = await resolveSeatTier({
      enabled: cursorSeatTierLookupEnabled,
      teamId: localMeta?.cursor_team_id,
      meta: db,
      readVscdbKey,
      lookup: seatTierLookup,
    });
    seatTierReport = {
      outcome: seatTier.outcome,
      ...(seatTier.errorKind === undefined ? {} : { errorKind: seatTier.errorKind }),
    };
    const installMeta = withSeatTierStamp(localMeta, seatTier.stamp);

    // Read pre-aggregated daily stats from state.vscdb (tab/composer line metrics).
    const dailyStats = readCursorDailyStats((pattern) =>
      reader.query<KVRow>(
        "SELECT key, value FROM cursorDiskKV WHERE key LIKE ?",
        [pattern]
      )
    );

    // Merge dailyStats into aiMetrics (dailyStats supplements the ai-tracking.db data).
    const mergedMetrics = { ...aiMetrics, ...dailyStats };
    const hasMetrics = Object.keys(mergedMetrics).length > 0;
    const aiAttributionJson = hasMetrics ? JSON.stringify(mergedMetrics) : undefined;

    // The global stop-hook ledger, read once per run: measured per-generation tokens
    // keyed by conversation_id, which equals the composerId for an IDE session.
    const stopLedger = loadCursorStopLedger();

    for (const composerData of composers) {
      seen.add(composerData.composerId);

      try {
        if (processComposer(db, reader, composerData, workspaceMap, aiAttributionJson, projectSignals, mcpNames, installMeta, childToParent.get(composerData.composerId), stopLedger.get(composerData.composerId))) {
          extracted++;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error("extraction.cursor", "conversation_processing_error", {
          composerId: composerData.composerId,
          error: errorMsg,
        });
        reportRecordError(composerData.composerId, dbPath, err);
      }
    }

    // A child processed before its parent this cycle was stored PRIMARY; stamp
    // now that the parent row exists. Skip if the parent parsed but never
    // persisted (e.g. no user prompt) — a dangling SUBAGENT is hidden from
    // Sessions and not folded into anyone.
    if (captureLineage) {
      for (const [childId, parentId] of childToParent) {
        if (!db.getTracking("cursor", parentId)) continue;
        db.stampPendingSubagentLineage(
          "cursor",
          childId,
          conversationId("cursor", parentId)
        );
      }
    }
    ideReadComplete = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("locked")) {
      logger.warn("extraction.cursor", "db_locked");
    } else {
      logger.error("extraction.cursor", "db_access_error", { error: msg });
    }
    reportSourceError(dbPath, err);
  } finally {
    reader.close();
  }

  // Terminal-CLI sessions (~/.cursor/chats) — a store the IDE reader above never
  // touches. Gated on a complete composerData read so `seen` is authoritative
  // (see ideReadComplete): a partial `seen` from a failed read could let a CLI
  // row overwrite a composerData session. On failure we skip this cycle; the
  // next scheduled run retries once the IDE db is readable.
  if (ideReadComplete) {
    extracted += runCursorCli(db, seen, cursorSeatTierLookupEnabled, captureLineage);
  } else {
    logger.warn("extraction.cursor", "cli_skipped_incomplete_ide_read");
  }

  // Both the IDE and CLI passes have now consumed the global stop ledger for this
  // cycle, so rotate it if it has grown past the cap. Deferred to here (not the read)
  // so both passes see one consistent snapshot and a still-active conversation keeps
  // its lines for the next full re-read (see rotateCursorStopLedgerIfLarge).
  rotateStopLedgerUnlessRedirected();

  const durationMs = Date.now() - startTime;
  logger.info("extraction.cursor", "extraction_complete", {
    durationMs,
    newOrChangedConversations: extracted,
  });

  return seatTierReport === undefined ? { count: extracted } : { count: extracted, seatTier: seatTierReport };
}

// ── Internals ────────────────────────────────────────────────────────────────

/**
 * Rotates the stop-hook ledger, which is the one write a Cursor scan makes into
 * the vendor tree, and only on this machine's own Cursor install: a scan with a
 * redirected home root or Cursor database is reading a tree it does not own.
 */
function rotateStopLedgerUnlessRedirected(): void {
  if (homeRootOverride() !== undefined || hasPathOverride("CURSOR_DB_PATH")) return;
  rotateCursorStopLedgerIfLarge();
}

/**
 * Builds a map of composerId → workspace folder path by scanning Cursor's
 * workspaceStorage directory. Each workspace has a workspace.json (folder path)
 * and a state.vscdb whose ItemTable contains composer.composerData with
 * an allComposers list that enumerates all composer IDs for that workspace.
 *
 * This is the most reliable fallback for sessions with no attached files.
 */
function buildComposerWorkspaceMap(): Map<string, string> {
  const map = new Map<string, string>();
  const storagePath = getCursorWorkspaceStoragePath();

  let entries: string[];
  try {
    entries = readdirSync(storagePath);
  } catch {
    return map; // workspaceStorage doesn't exist (Cursor not installed or wrong platform)
  }

  for (const entry of entries) {
    try {
      const wsDir = join(storagePath, entry);

      // Read the workspace folder path from workspace.json
      const wsJsonPath = join(wsDir, "workspace.json");
      // Some workspaceStorage entries (notably `empty-window`) have no
      // workspace.json — that's expected, not an error. Skip quietly so the
      // catch below is reserved for genuine read/parse failures.
      if (!existsSync(wsJsonPath)) continue;
      const wsJson = JSON.parse(readFileSync(wsJsonPath, "utf8")) as Record<string, unknown>;
      const folderUri = wsJson["folder"];
      if (typeof folderUri !== "string" || !folderUri.startsWith("file://")) continue;
      const folderPath = fileUriPath(folderUri);
      if (!folderPath) continue;

      // Read composer IDs from the workspace-specific state.vscdb
      const wsDbPath = join(wsDir, "state.vscdb");
      if (!existsSync(wsDbPath)) continue;

      const db = openVendorDb(wsDbPath, 5000);
      try {
        const row = db
          .prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'")
          .get() as { value: string } | undefined;
        if (!row) continue;

        const composerData = JSON.parse(row.value) as {
          allComposers?: Array<{ composerId?: string }>;
        };
        for (const composer of composerData.allComposers ?? []) {
          if (typeof composer.composerId === "string") {
            // Only set if not already mapped (first workspace wins per composer)
            if (!map.has(composer.composerId)) {
              map.set(composer.composerId, folderPath);
            }
          }
        }
      } finally {
        db.close();
      }
    } catch (err) {
      logger.warn("extraction.cursor", "workspace_map_error", {
        workspace: entry,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return map;
}

/**
 * Collects all file:/// URIs from a composerData object, combining:
 * 1. allAttachedFileCodeChunksUris (primary source)
 * 2. codeBlockData keys (file URIs for files shown in code blocks)
 * 3. context.mentions.selections/fileSelections/terminalFiles keys. Older Cursor
 *    versions stored these as JSON strings containing a "uri" field; newer
 *    versions store the bare file:/// URI directly as the key. Handle both.
 */
function collectAllFileUris(composerData: ComposerData): string[] {
  const uris = new Set<string>(composerData.allAttachedFileCodeChunksUris ?? []);

  // codeBlockData keys are already file:/// URIs
  for (const key of Object.keys(composerData.codeBlockData ?? {})) {
    if (key.startsWith("file:///")) {
      uris.add(key);
    }
  }

  const mentionBuckets = [
    composerData.context?.mentions?.selections,
    composerData.context?.mentions?.fileSelections,
    composerData.context?.mentions?.terminalFiles,
  ];
  for (const bucket of mentionBuckets) {
    if (!bucket) continue;
    for (const key of Object.keys(bucket)) {
      const uri = mentionKeyToFileUri(key);
      if (uri) uris.add(uri);
    }
  }

  return Array.from(uris);
}

/**
 * Extracts a file:/// URI from a mention-bucket key. Cursor has used two formats:
 *   - newer: the key is the bare file:/// URI itself
 *   - older: the key is a JSON string carrying a "uri":"file:///…" field
 * Returns undefined if neither shape yields a file URI.
 */
export function mentionKeyToFileUri(key: string): string | undefined {
  if (key.startsWith("file:///")) return key;
  const m = key.match(/"uri"\s*:\s*"(file:\/\/\/[^"]+)"/);
  return m ? m[1] : undefined;
}

function processComposer(
  db: SessionSink,
  reader: SQLiteReader,
  composerData: ComposerData,
  workspaceMap: Map<string, string>,
  aiAttributionJson?: string,
  projectSignals?: import("./cursorProjectReader").CursorProjectSignals | null,
  // Installation-global values resolved once per cycle by the caller (same for
  // every composer): MCP server names and the plan/tier metadata.
  mcpNames: string[] = [],
  installMeta: InstallationMetadata | null = null,
  // Set (with captureLineage on) when this composer is a sub-agent child; its
  // parent's composerId. Undefined for a primary session.
  parentComposerId?: string,
  // The session's measured generations from the stop-hook ledger (keyed by this
  // composerId upstream). Present only for a session Cursor's stop hook recorded.
  stopGenerations?: MeasuredGeneration[]
): boolean {
  // Use composerId alone as sessionId so it stays stable even if project path changes.
  const sessionId = composerData.composerId;

  // Collect all available file URIs from composerData (attached files, code blocks, mentions)
  const allUris = collectAllFileUris(composerData);
  const rawProjectPath =
    extractProjectPathFromUris(allUris) ??
    workspaceMap.get(composerData.composerId) ??
    extractProjectPath(reader, composerData.composerId);

  // Normalize: if the resolved path looks like a file (last segment has an extension),
  // take its parent directory.
  const dirPath = normalizeToDirectory(rawProjectPath);

  // Central resolution: try findGitRoot(path), fallback to file paths from URIs.
  const filePathsFromUris = allUris
    .filter((u) => u.startsWith("file:///"))
    .map((u) => fileUriPath(u));
  const resolved = resolveProjectAndRepo(dirPath ?? undefined, filePathsFromUris);
  // A second resolution (from tool-call file paths) may refine these below, once
  // bubbles are loaded — hence `let`.
  let finalProjectPath = resolved?.projectPath ?? dirPath;
  let repoName = resolved?.repoName;
  const lastUpdatedAt = composerData.lastUpdatedAt;
  // parseComposerData only validates composerId/createdAt/lastUpdatedAt/
  // fullConversationHeadersOnly before casting to ComposerData — name is
  // unchecked, so guard its runtime type here rather than trust the cast.
  const cursorTitle = typeof composerData.name === "string" && composerData.name
    ? composerData.name
    : undefined;

  const tracking = db.getTracking("cursor", sessionId);

  // lastUpdatedAt unchanged: skip the full re-read (only patch project_path/repo_name)
  // UNLESS a token-settle re-read is due — see shouldForceCursorReextract.
  // Child lineage is a metadata patch on the existing row (stampPendingSubagentLineage),
  // not a loadBubbles bypass: Cursor composerData decays, and an unwindowed re-read
  // of the historical tail would overwrite a good transcript and re-queue a sync.
  if (
    tracking &&
    tracking.last_mtime_ms === lastUpdatedAt &&
    !shouldForceCursorReextract(tracking, lastUpdatedAt)
  ) {
    // Stamp first: updateProjectPath/updateRepoName flip synced → pending, and
    // stampPendingSubagentLineage must see the pre-patch ingest state.
    let stamped = false;
    if (parentComposerId && db.getTracking("cursor", parentComposerId)) {
      stamped = db.stampPendingSubagentLineage(
        "cursor",
        sessionId,
        conversationId("cursor", parentComposerId)
      );
    }
    if (finalProjectPath) {
      const redactedProjectPath = redactPath(finalProjectPath);
      if (redactedProjectPath !== tracking.project_path) {
        db.updateProjectPath("cursor", sessionId, redactedProjectPath);
      }
    }
    if (repoName && repoName !== tracking.repo_name) {
      db.updateRepoName("cursor", sessionId, repoName);
    }
    return stamped;
  }

  // Load full bubble content — pass composerData.modelConfig so model
  // can be added to per-message metadata on assistant bubbles.
  // modelConfig is the primary source; usageData's keys are the fallback. Without it a
  // session whose modelConfig names no model has its ESTIMATED tokens priced at a
  // generic rate — see recoverModelFromUsageData.
  const modelName =
    composerData.modelConfig?.modelName ?? recoverModelFromUsageData(composerData.usageData);
  const contextUsagePercent = composerData.contextUsagePercent;
  const {
    prompts,
    toolCounts,
    toolErrors,
    toolErrorCategories,
    userInterruptions,
    toolFilePaths,
    attributionEvents,
    firstUserPrompt,
    sessionEvents,
    eventCoverage,
    userTimestampsMs,
  } = loadBubbles(reader, composerData, modelName, contextUsagePercent);

  // Settlement tracks real bubble tokenCount only — before synthetic estimates.
  let lastAssistantBeforeEstimate: PromptMetadata | undefined;
  for (const p of prompts) {
    if (p.role === "assistant") lastAssistantBeforeEstimate = p.metadata;
  }
  const tokensObserved =
    (lastAssistantBeforeEstimate?.inputTokens ?? 0) > 0 ||
    (lastAssistantBeforeEstimate?.outputTokens ?? 0) > 0;

  applyIdeTokenEstimationFallback(prompts, composerData, modelName);

  // Overlay the stop-hook ledger's MEASURED per-generation tokens AFTER estimation, so a
  // turn the ledger covers is upgraded to measured while a turn it does not still keeps
  // its estimate. Merging before estimation would trip its session-wide
  // promptsHaveBillableTokens early-return and leave every unmatched turn with no count at
  // all (a partial ledger — the hook installed mid-conversation — undercounts the session).
  // Done in place so the const array and every reference below stay valid.
  if (stopGenerations && stopGenerations.length > 0) {
    const merged = mergeStopHookTokens(prompts, stopGenerations);
    prompts.length = 0;
    prompts.push(...merged);
  }

  if (prompts.filter((p) => p.role === "user").length === 0) return false;

  // Second resolution: when composerData-level signals didn't yield a repo
  // (common for recent agentic sessions — file context lives only in tool calls),
  // fall back to the absolute paths the agent touched. resolveProjectAndRepo →
  // findGitRoot on those paths recovers the repo root + remote.
  if (!repoName && toolFilePaths.length > 0) {
    const fromTools = resolveProjectAndRepo(finalProjectPath ?? undefined, toolFilePaths);
    if (fromTools) {
      finalProjectPath = fromTools.projectPath;
      repoName = fromTools.repoName;
    }
  }

  // Drop directory paths from the per-prompt file list. Runs after the second
  // resolution deliberately: toolFilePaths above still carries directories, and
  // findGitRoot wants them — only the list that becomes files_edited is filtered.
  {
    const cache = new Map<string, boolean>();
    let dropped = 0;
    let unresolved = 0;
    let probeFailed = 0;
    for (const prompt of prompts) {
      const files = prompt.metadata?.relevantFiles;
      if (!files || files.length === 0) continue;
      const r = partitionDirectoryPaths(files, finalProjectPath ?? undefined, cache);
      dropped += r.dropped;
      unresolved += r.unresolved;
      probeFailed += r.probeFailed;
      if (r.kept.length > 0) prompt.metadata!.relevantFiles = r.kept;
      else delete prompt.metadata!.relevantFiles;
    }
    if (dropped > 0 || unresolved > 0 || probeFailed > 0) {
      // Info, not debug: a host that drops debug still sees it, and this rate is
      // the only evidence the filter is working. It fires only when there was something to
      // drop, so it is not per-session noise.
      logger.info("extraction.cursor", "relevant_files_directory_filter", {
        composerId: composerData.composerId,
        dropped,
        unresolved,
        probeFailed,
      });
    }
  }

  // Recover PR refs + head branch from the session's own authoring evidence
  // (tool-call output + the agent's closing summary), repo-scoped to repoName.
  const attribution = collectCursorAttribution(attributionEvents, repoName);

  // Redact PII (secrets, paths, usernames) before persisting
  const redactedPrompts = redactPrompts(prompts);
  const redactedProjectPath = finalProjectPath ? redactPath(finalProjectPath) : undefined;

  // Derive languages from relevant_files across all prompts.
  const allFiles: string[] = [];
  for (const prompt of prompts) {
    if (prompt.metadata?.relevantFiles) {
      allFiles.push(...prompt.metadata.relevantFiles);
    }
  }
  const languages = deriveLanguages(allFiles);

  // Build session_meta from composerData fields + derived languages.
  const meta: SessionMetaPayload = {};
  // Surface origin: this extractor reads Cursor's IDE store (state.vscdb), so the session ran in
  // the Cursor IDE — stamp "ide" (the CLI path stamps a bare "cli" the same way).
  meta.source = "ide";
  // Free-text fields (session_title, first_prompt) are scrubbed centrally by
  // sanitizeSessionMeta at the JSON.stringify choke point below, so they're assigned
  // raw here. first_prompt is the exception: redact BEFORE the length cap so a secret
  // can't straddle the truncation bound (the choke point then re-redacts as a no-op).
  if (cursorTitle) meta.session_title = cursorTitle;
  // Opening user prompt — a display-name fallback for a session with no title.
  if (firstUserPrompt) meta.first_prompt = redactText(firstUserPrompt).slice(0, FIRST_PROMPT_MAX_CHARS);
  if (Object.keys(languages).length > 0) meta.languages = languages;
  if (typeof composerData.totalLinesAdded === "number" && composerData.totalLinesAdded > 0) {
    meta.lines_added = composerData.totalLinesAdded;
  }
  if (typeof composerData.totalLinesRemoved === "number" && composerData.totalLinesRemoved > 0) {
    meta.lines_removed = composerData.totalLinesRemoved;
  }
  if (typeof composerData.isAgentic === "boolean") {
    meta.uses_task_agent = composerData.isAgentic;
  }
  if (mcpNames.length > 0) {
    meta.mcp_server_names = mcpNames;
  }
  // Merge Cursor 3+ per-project signals (aggregated across all workspaces).
  if (projectSignals) {
    // NOTE: sub_agent_count is intentionally NOT set from the workspace-aggregate
    // projectSignals here — it now drives per-session delegation_level, and a
    // whole-workspace count would misclassify every session as "assisted". It is
    // set below strictly per-session from this composer's subagentComposerIds.
    if (projectSignals.agent_transcript_count) meta.agent_transcript_count = projectSignals.agent_transcript_count;
    if (projectSignals.tool_output_count) meta.tool_output_count = projectSignals.tool_output_count;
    if (projectSignals.terminal_session_count) meta.terminal_session_count = projectSignals.terminal_session_count;
    if (projectSignals.project_mcp_server_names && projectSignals.project_mcp_server_names.length > 0) {
      meta.project_mcp_server_names = projectSignals.project_mcp_server_names;
    }
  }
  // Per-session sub-agent count from this composer's own subagentComposerIds —
  // more accurate than the workspace-aggregate projectSignals count, and the
  // signal that drives delegation_level="assisted" for Cursor (Agent + IDE).
  if (Array.isArray(composerData.subagentComposerIds) && composerData.subagentComposerIds.length > 0) {
    meta.sub_agent_count = composerData.subagentComposerIds.length;
  }
  // Cursor 3+ workspace sidebar metadata: combined lines changed, files modified by AI, context usage.
  const linesChanged =
    (typeof composerData.totalLinesAdded === "number" ? composerData.totalLinesAdded : 0) +
    (typeof composerData.totalLinesRemoved === "number" ? composerData.totalLinesRemoved : 0);
  if (linesChanged > 0) {
    meta.cursor_lines_changed = linesChanged;
  }
  // Collect file paths the AI modified (codeBlockData keys are file:/// URIs).
  const codeBlockFiles = Object.keys(composerData.codeBlockData ?? {}).filter((k) =>
    k.startsWith("file:///")
  );
  if (codeBlockFiles.length > 0) {
    meta.cursor_files_modified = codeBlockFiles.length;
    // Store file paths so a consumer can populate filesEdited — same field CC uses
    // for tool_use tracking. Strip only the `file://` scheme, NOT the leading path
    // slash: a `file:///Users/…` URI is scheme + `/Users/…`, so slicing 8 (`file:///`)
    // would drop the leading `/` and yield `Users/<user>/…`, which redactPath's
    // `/Users/<user>/` matcher then passes through unredacted — leaking the username.
    meta.tracked_file_paths = codeBlockFiles.map((uri) => fileUriPath(uri));
  }
  if (typeof composerData.contextUsagePercent === "number" && composerData.contextUsagePercent > 0) {
    meta.cursor_context_usage_percent = composerData.contextUsagePercent;
  }
  if (typeof composerData.contextTokensUsed === "number" && composerData.contextTokensUsed > 0) {
    meta.context_tokens_used = composerData.contextTokensUsed;
  }
  if (typeof composerData.contextTokenLimit === "number" && composerData.contextTokenLimit > 0) {
    meta.context_token_limit = composerData.contextTokenLimit;
  }
  const contextComposition = contextCompositionFromBreakdown(composerData);
  if (contextComposition.length > 0) {
    meta.context_composition = contextComposition;
  }
  // Vendor-reported actual cost (¢ → USD). Only Cursor exposes this locally; unset
  // when absent so a consumer falls back to the token estimate.
  const reportedCostUsd = resolveCursorReportedCostUsd(composerData.usageData);
  if (reportedCostUsd != null) {
    meta.reported_cost_usd = reportedCostUsd;
  }
  // Git branch: collect every branch name Cursor recorded for this composer
  // and pick the last non-trunk entry (matches Claude's resolveGitBranch
  // behaviour so sessions that start on master and switch to a feature
  // branch are attributed to the feature branch).
  const cursorBranchesSeen: string[] = [];
  const pushBranch = (b: string | undefined) => {
    if (typeof b === "string" && b && (cursorBranchesSeen[cursorBranchesSeen.length - 1] !== b)) {
      cursorBranchesSeen.push(b);
    }
  };
  pushBranch(composerData.createdOnBranch);
  for (const entry of composerData.branches ?? []) pushBranch(entry.branchName);
  pushBranch(composerData.activeBranch?.branchName);
  pushBranch(composerData.committedToBranch);
  // Recovered head branch (git push / checkout -b / structured summary) — fills
  // git_branches when composerData's branch fields are empty (newer Cursor builds).
  pushBranch(attribution.branch ?? undefined);
  if (cursorBranchesSeen.length > 0) {
    meta.git_branches = cursorBranchesSeen;
    // Scalar git_branch kept for back-compat.
    const scalar = resolveSessionBranch(cursorBranchesSeen);
    if (scalar) meta.git_branch = scalar;
  }
  // PR references: recovered from the session's own authoring
  // evidence — a `gh pr create` / `glab mr create` / Bitbucket `curl` POST output,
  // or the agent's closing-summary URL (repo-scoped). Falls back to a PR URL in
  // the session-window commit messages. A wrong ref self-drops at a consumer
  // merged-set gate, so this only ever adds true matches.
  let prRefs = attribution.prReferences;
  if (prRefs.length === 0 && finalProjectPath) {
    const fromCommits = getSessionPRLink(finalProjectPath, composerData.createdAt, lastUpdatedAt, {
      urlOnly: true,
    });
    // Compare on the canonical last-2 key: the git-log MR repo may be a full
    // GitLab subgroup path while repoName is the git-remote last-2.
    if (
      fromCommits &&
      (!repoName || canonicalRepoKey(fromCommits.prRepository) === canonicalRepoKey(repoName))
    ) {
      prRefs = [
        {
          pr_url: fromCommits.prUrl,
          pr_number: fromCommits.prNumber,
          pr_repository: fromCommits.prRepository,
        },
      ];
    }
  }
  if (prRefs.length > 0) {
    meta.pr_references = prRefs;
    // Scalars from the first ref for pre-multi-PR back-compat.
    meta.pr_url = prRefs[0]!.pr_url;
    meta.pr_number = prRefs[0]!.pr_number;
    meta.pr_repository = prRefs[0]!.pr_repository;
  }
  // Derive git commit count from session diff stats using session time window.
  if (finalProjectPath) {
    const diff = getFullSessionDiffStats(finalProjectPath, composerData.createdAt, lastUpdatedAt);
    if (diff.gitCommits > 0) meta.git_commits = diff.gitCommits;
  }
  // Tool-call aggregates from agent-mode bubbles (the same fields copilotExtractor.ts
  // fills).
  if (Object.keys(toolCounts).length > 0) meta.tool_counts = toolCounts;
  if (toolErrors > 0) meta.tool_errors = toolErrors;
  if (Object.keys(toolErrorCategories).length > 0) meta.tool_error_categories = toolErrorCategories;
  if (userInterruptions > 0) meta.user_interruptions = userInterruptions;

  // User message timestamps. Newer Cursor builds stamp each bubble with `createdAt`;
  // when every user prompt carries one, those are the timestamps. Otherwise they are
  // derived from composerData's createdAt (session start) and lastUpdatedAt (last
  // activity), spread evenly over the user messages the headers list — a consumer
  // computing active time can filter out idle gaps (>5min):
  // large span / few messages → gaps exceed 5min → active time ≈ 0 (correct);
  // small span / many messages → gaps < 5min → active time ≈ span (correct).
  const userBubbleCount = composerData.fullConversationHeadersOnly?.filter(
    (h) => h.type === 1 // 1 = user
  ).length ?? 0;
  if (userTimestampsMs !== undefined) {
    meta.user_message_timestamps = userTimestampsMs.map((ms) => new Date(ms).toISOString());
    const responseTimes: number[] = [];
    for (let i = 1; i < userTimestampsMs.length; i++) {
      const gap = Math.round((userTimestampsMs[i]! - userTimestampsMs[i - 1]!) / 1000);
      if (gap >= 0) responseTimes.push(gap);
    }
    if (responseTimes.length > 0) meta.user_response_times = responseTimes;
    meta.message_hours = userTimestampsMs.map((ms) => new Date(ms).getUTCHours());
  } else if (userBubbleCount >= 2 && composerData.createdAt > 0 && composerData.lastUpdatedAt > composerData.createdAt) {
    const startMs = composerData.createdAt;
    const endMs = composerData.lastUpdatedAt;
    const spanMs = endMs - startMs;
    const stepMs = spanMs / (userBubbleCount - 1);
    const syntheticTimestamps: string[] = [];
    for (let i = 0; i < userBubbleCount; i++) {
      syntheticTimestamps.push(new Date(startMs + i * stepMs).toISOString());
    }
    meta.user_message_timestamps = syntheticTimestamps;
    // Also derive user_response_times (seconds between consecutive user messages).
    const responseTimes: number[] = [];
    for (let i = 1; i < syntheticTimestamps.length; i++) {
      responseTimes.push(Math.round(stepMs / 1000));
    }
    if (responseTimes.length > 0) meta.user_response_times = responseTimes;
    // Hour-of-day for each message.
    meta.message_hours = syntheticTimestamps.map((ts) => new Date(ts).getUTCHours());
  } else if (userBubbleCount === 1 && composerData.createdAt > 0) {
    // Single user message — emit one timestamp for work-pattern hour extraction.
    meta.user_message_timestamps = [new Date(composerData.createdAt).toISOString()];
    meta.message_hours = [new Date(composerData.createdAt).getUTCHours()];
  }

  // Also pass session_duration_seconds as a wall-clock fallback when active time is unavailable.
  if (composerData.createdAt > 0 && composerData.lastUpdatedAt > composerData.createdAt) {
    meta.session_duration_seconds = Math.round((composerData.lastUpdatedAt - composerData.createdAt) / 1000);
  }


  // Session lineage: this composer is a sub-agent spawned by parentComposerId
  // (child's subagentInfo.parentComposerId, or the parent's subagentComposerIds
  // invert). Tag it SUBAGENT so a consumer folds its usage into the parent and
  // excludes it from session counts. Child tokens (the fold weight) sum the
  // per-message token counts. STRONG — a direct composerData link.
  // parent_record_key must equal the parent's conversationId.
  if (
    parentComposerId &&
    !db.hasBeenIngested("cursor", sessionId) &&
    db.getTracking("cursor", parentComposerId)
  ) {
    const childTokens = sumPromptTokens(prompts);
    const lineage: SessionLineagePayload = {
      relation_type: "SUBAGENT",
      parent_record_key: conversationId("cursor", parentComposerId),
      linkage_confidence: "STRONG",
    };
    if (childTokens > 0) lineage.tokens = childTokens;
    meta.lineage = lineage;
  }

  const hasMetaFields = Object.keys(meta).length > 0;
  const sessionMetaJson = hasMetaFields ? JSON.stringify(sanitizeSessionMeta(meta)) : undefined;

  // Plan/tier metadata (installation-global, from ItemTable) is resolved once
  // per cycle by the caller and threaded in — it is identical for every
  // composer, so re-running the ~7 ItemTable queries here per conversation was
  // pure waste.
  const installMetaJson = installMeta ? JSON.stringify(installMeta) : undefined;

  db.upsert({
    ideType: "cursor",
    sessionId,
    conversation: redactedPrompts,
    projectPath: redactedProjectPath,
    repoName,
    lastMtimeMs: lastUpdatedAt,
    lastSize: 0, // Not applicable for Cursor
    lastOffset: 0,
    conversationSourceCreatedAtMs: composerData.createdAt,
    sessionMeta: sessionMetaJson,
    installationMetadata: installMetaJson,
    aiAttribution: aiAttributionJson,
    tokensObserved,
    // The loop timeline. Omitted when empty so a session with nothing to observe is absent
    // rather than carrying an empty array, which a consumer reads as coverage NONE either
    // way but which would otherwise put a pointless field on every row.
    sessionEvents: sessionEvents.length > 0 ? JSON.stringify(sessionEvents) : undefined,
    eventCoverage,
  });

  return true;
}

interface LoadBubblesResult {
  prompts: ConversationPrompt[];
  /** The normalized loop timeline, and how completely it observed the session. */
  sessionEvents: SessionEvent[];
  eventCoverage: EventCoverage;
  toolCounts: Record<string, number>;
  toolErrors: number;
  toolErrorCategories: Record<string, number>;
  userInterruptions: number;
  // Absolute file paths the agent touched via tool calls (read/edit/grep/…),
  // harvested from every tool bubble. Used as a project-resolution fallback when
  // composerData-level signals are absent — common for recent agentic sessions,
  // where the only repo signal lives in tool-call args.
  toolFilePaths: string[];
  // Per-bubble PR/branch evidence (tool commands + outputs, assistant summaries)
  // fed to collectCursorAttribution to recover pr_references / git_branches.
  attributionEvents: AttributionEvent[];
  // Each stored user prompt's own `createdAt`, in order — present only when every
  // user bubble carries one, so a part-stamped session never mixes real and spread times.
  userTimestampsMs?: number[];
  // First genuinely user-authored turn's text (spawn-injected turns skipped); the
  // opening-prompt display label. Undefined when the session has no such turn.
  firstUserPrompt?: string;
}

function loadBubbles(
  reader: SQLiteReader,
  composerData: ComposerData,
  modelName?: string,
  contextUsagePercent?: number
): LoadBubblesResult {
  const empty: LoadBubblesResult = {
    prompts: [],
    sessionEvents: [],
    eventCoverage: "EVENT_COVERAGE_NONE",
    toolCounts: {},
    toolErrors: 0,
    toolErrorCategories: {},
    userInterruptions: 0,
    toolFilePaths: [],
    attributionEvents: [],
  };

  const headers = composerData.fullConversationHeadersOnly;
  if (!Array.isArray(headers)) return empty;

  const validHeaders = headers.filter(
    (h): h is BubbleHeader => h != null && typeof h.bubbleId === "string"
  );
  if (validHeaders.length === 0) return empty;

  // Build keys and fetch in batches
  const keyToHeader = new Map<string, BubbleHeader>();
  const allKeys: string[] = [];

  for (const header of validHeaders) {
    const key = `${BUBBLE_PREFIX}${composerData.composerId}:${header.bubbleId}`;
    allKeys.push(key);
    keyToHeader.set(key, header);
  }

  const rowsByKey = new Map<string, KVRow>();
  for (let i = 0; i < allKeys.length; i += BUBBLE_BATCH_SIZE) {
    const batchKeys = allKeys.slice(i, i + BUBBLE_BATCH_SIZE);
    const placeholders = batchKeys.map(() => "?").join(",");
    const batchRows = reader.query<KVRow>(
      `SELECT key, value FROM cursorDiskKV WHERE key IN (${placeholders})`,
      batchKeys
    );
    for (const row of batchRows) {
      rowsByKey.set(row.key, row);
    }
  }

  // Build prompts in header order
  const prompts: ConversationPrompt[] = [];
  const toolCounts: Record<string, number> = {};
  let toolErrors = 0;
  const toolErrorCategories: Record<string, number> = {};
  let userInterruptions = 0;
  const toolFilePaths = new Set<string>();
  const attributionEvents: AttributionEvent[] = [];
  let userBubbles = 0;
  const userStamps: number[] = [];
  let firstUserPrompt: string | undefined;
  // The normalized loop timeline. Cursor records every fact it needs — the tool, its id and
  // the status it ended in — so the only thing missing was somewhere to put them. Built in
  // this loop rather than from a second pass because the prompt ORDINAL is only knowable
  // here: it is the one-based position the prompt takes in `prompts`, and a counter kept
  // elsewhere would drift the moment this loop skips a bubble.
  const eventBuilder = new SessionEventBuilder();
  // Timestamp floor for a bubble Cursor did not stamp. Cursor began stamping `createdAt` per
  // bubble at some version, so a conversation that spans the upgrade is part-stamped — and
  // measured across a real 50,466-bubble store the presence is MONOTONIC in header order:
  // of 431 conversations, 174 are fully stamped, 245 not at all, 12 are part-stamped, and
  // ZERO ever go stamped→unstamped. So an unstamped bubble always sits at or before the
  // first stamped one, which makes the session's own start its true lower bound. An epoch
  // fallback would assert 1970 — a 56-year error that any duration read off these events
  // reports as fact. Ordering is unaffected either way: a consumer orders on `sequence`,
  // assigned here in walk order.
  const sessionStart = new Date(
    composerData.createdAt > 0 ? composerData.createdAt : 0
  ).toISOString();

  for (const key of allKeys) {
    const bubbleRow = rowsByKey.get(key);
    if (!bubbleRow) continue;

    const bubble = parseBubbleData(bubbleRow.value);
    if (!bubble) continue;

    const header = keyToHeader.get(key)!;
    const role = header.type === CURSOR_ROLE_ASSISTANT ? "assistant" : "user";

    let content = bubble.text || bubble.rawText || "";
    let toolFiles: string[] = [];

    // Parse the tool-call args once per bubble and reuse for both the placeholder
    // synopsis and the project-resolution path harvest below — avoids a second
    // JSON.parse on the hot path (agentic sessions have many tool bubbles).
    const toolArgs =
      role === "assistant" && bubble.toolFormerData
        ? parseToolArgs(bubble.toolFormerData)
        : undefined;

    // Fallback: empty-text assistant bubbles with a tool call become
    // "[Tool: name args=...]" placeholders so the LLM sees the agent's trajectory.
    // User turns never carry toolFormerData in practice; the role guard matches
    // Claude Code's assistant-only tool_use handling.
    if (!content.trim() && role === "assistant" && bubble.toolFormerData) {
      const tc = formatToolCall(bubble.toolFormerData, toolArgs);
      content = tc.content;
      toolFiles = tc.files;
    }

    if (!content.trim()) continue;

    // Capture the first genuinely user-authored turn (the opening-prompt label). Skip a turn
    // nobody typed: a spawn-injected task prompt (which can carry an absolute path) or a
    // harness-injected `<system_notification>` — either would otherwise surface as the session's
    // label. Stored raw; redacted at the assignment site.
    if (
      role === "user" &&
      !bubble.subagentSpawnTaskToolCallId &&
      bubble.simulatedMessageMetadata == null &&
      firstUserPrompt === undefined
    ) {
      firstUserPrompt = content;
    }

    // Aggregate session-level tool stats across every assistant bubble that
    // carried a tool call, regardless of whether we emitted text or a placeholder.
    // Mirrors copilotExtractor.ts:673-675 / 1036-1038.
    //
    // Which status means what is `cursorStatusEffect`'s call, mapped there against the
    // vocabulary Cursor actually writes. Cursor exposes no error SUBTYPES the way
    // Copilot/Codex do ("exec_fail" / "mcp_fail" / "timeout"), so the category is the
    // status itself — which stays true if a second error spelling ever appears.
    if (role === "assistant" && bubble.toolFormerData?.name) {
      const toolName = bubble.toolFormerData.name;
      toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
      const status = bubble.toolFormerData.status;
      // An absent status is the second most common state on a real store and contributes
      // nothing, so it is filtered here rather than keyed into the category map.
      if (status !== undefined) {
        const effect = cursorStatusEffect(status);
        if (effect === "tool_error") {
          toolErrors++;
          toolErrorCategories[status] = (toolErrorCategories[status] ?? 0) + 1;
        } else if (effect === "user_interruption") {
          userInterruptions++;
        }
      }
      // Harvest file paths from every tool call (not just empty-text bubbles) so
      // project resolution can fall back to the files the agent actually touched.
      // Reuses the args parsed once above.
      if (toolArgs) {
        for (const f of extractToolFilePaths(toolArgs)) {
          toolFilePaths.add(f);
        }
      }
    }

    // Collect PR/branch attribution evidence: the assistant's prose (closing
    // summary) and, for tool calls, the command. Output is captured only for an
    // authoring PR command — so a `cat`/`grep`/build-log bubble's large stdout is
    // never parsed or held in memory.
    if (role === "assistant") {
      const tfd = bubble.toolFormerData;
      const ev: AttributionEvent = { role, text: bubble.text || bubble.rawText || "" };
      if (tfd) {
        ev.command = cursorToolCommand(tfd, toolArgs ?? {});
        ev.status = tfd.status;
        if (ev.command && isAuthoringPRCommand(ev.command)) ev.output = cursorToolOutput(tfd);
      }
      if (ev.text || ev.command) attributionEvents.push(ev);
    }

    const metadata: PromptMetadata = {};
    if (modelName) {
      metadata.model = modelName;
    }
    // Cursor reports contextUsagePercent on a 0-100 scale, but the PromptMetadata wire field
    // is a 0.0-1.0 fraction (a consumer multiplies it by 100 for a percent, so passing a
    // percent straight through inflates it ~100x). Convert here, mirroring the
    // Kiro extractor. Presence-of-source, not value > 0: a message whose measured context
    // occupancy is exactly 0 must still reach the wire, not be dropped as if unmeasured.
    if (typeof contextUsagePercent === "number") {
      metadata.contextUsagePercent = contextUsagePercent / 100;
    }
    applyTokenCount(metadata, bubble.tokenCount);

    // The bubble's requestId == the stop-hook generation_id; stamp it on the assistant
    // bubble so the stop-hook merge overlays this generation's measured tokens by exact id.
    if (role === "assistant" && bubble.requestId) {
      metadata.messageId = bubble.requestId;
    }

    // Merge per-bubble relevantFiles with any file paths extracted from tool args.
    const mergedFiles = new Set<string>();
    if (bubble.relevantFiles) for (const f of bubble.relevantFiles) mergedFiles.add(f);
    for (const f of toolFiles) mergedFiles.add(f);
    if (mergedFiles.size > 0) {
      metadata.relevantFiles = [...mergedFiles];
    }

    if (bubble.codeBlocks && bubble.codeBlocks.length > 0) {
      metadata.codeBlockCount = bubble.codeBlocks.length;
    }

    // A user bubble carrying Cursor's spawn marker was authored by a spawn tool call, not
    // the person. Flag it so the author stamp below reads DELEGATED_AGENT instead of HUMAN —
    // without this the marker is dropped and a delegated turn inflates human activity.
    if (bubble.subagentSpawnTaskToolCallId) {
      metadata.isSubAgent = true;
    }

    // authorship: INJECTED for a harness-injected bubble (simulatedMessageMetadata) or a
    // spawn-authored turn (isSubAgent, above); a non-injected user bubble is HUMAN. Omitted
    // (UNSPECIFIED) on assistant bubbles. Cursor stores no slash-command markup in bubble text,
    // so simulatedMessageMetadata is the injected marker we read here (best-effort per IDE).
    const authorship = promptAuthorship(
      { role: role as "user" | "assistant", metadata },
      { injected: bubble.simulatedMessageMetadata != null }
    );
    if (authorship !== "PROMPT_AUTHORSHIP_UNSPECIFIED") {
      metadata.authorship = authorship;
    }

    prompts.push({
      role: role as "user" | "assistant",
      content,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });

    if (role === "user") {
      userBubbles++;
      const stamped = bubble.createdAt === undefined ? Number.NaN : Date.parse(bubble.createdAt);
      if (Number.isFinite(stamped)) userStamps.push(stamped);
      // AFTER the push, exactly as the Claude path does it: the ordinal must be the position
      // this message now OCCUPIES, and `prompts.length` read before the push is the position
      // before it — one too low. A consumer dereferences `prompts[ordinal-1]`, so an ordinal
      // off by one resolves every reference to the PREVIOUS turn, which on an alternating
      // transcript is the assistant's prose.
      //
      // `metadata` is threaded rather than a bare `{ role }`: it is what carries isSubAgent, and
      // dropping it here would stamp a delegated turn HUMAN with no later correction left.
      // `injected` reflects `simulatedMessageMetadata` — see the BubbleData field doc above.
      eventBuilder.addPromptReference(
        prompts.length,
        bubble.createdAt ?? sessionStart,
        promptReferenceAuthor({ role, metadata }, { injected: bubble.simulatedMessageMetadata != null })
      );
    } else if (bubble.toolFormerData?.name) {
      // Cursor carries the call and its outcome on ONE bubble where Claude splits them across
      // two messages. Both events are still emitted: the pairing is what attributes a check to
      // the action it verified, and collapsing them would leave every result parentless.
      const at = bubble.createdAt ?? sessionStart;
      // Cursor supplies toolCallId on only about half of real tool bubbles, and a result with
      // no id is a result a consumer cannot attribute to the action it verified — which is
      // how a correction cycle is recognised. Synthesising one from the bubble key is sound
      // precisely because Cursor puts the call and its outcome on the SAME bubble: the two
      // events being paired is a fact about this row, not a guess about adjacency.
      const callId = bubble.toolFormerData.toolCallId ?? `cursor-bubble-${key}`;
      // `declaredName` is what turns this call into a SKILL_CALL, and a SKILL_CALL is the only
      // thing that tells a consumer WHERE a declaration happened. Without it a Cursor
      // declaration arrives unpositioned and its run reads as free-form. Derived through the shared `declaredArtifactOf` so the name
      // matches the usage row's exactly — a consumer positions a declaration only when a
      // typed event's name resolves against the declarations the session recorded.
      //
      // Args come from the SHARED resolver, not the `toolArgs` parsed above for the placeholder
      // and path harvest: that one reads `rawArgs` only, while a Cursor tool call may carry its
      // path under `params` instead, and the two spellings disagree. Resolving through the
      // shared helper is what makes the path reachable whichever field holds it.
      const declared = declaredArtifactOf(
        bubble.toolFormerData.name,
        resolveToolArgs(bubble.toolFormerData)
      );
      eventBuilder.addExternalToolCall({
        name: bubble.toolFormerData.name,
        at,
        callId,
        declaredName: declared?.assetName,
        summary: cursorToolSummary(bubble.toolFormerData),
      });
      eventBuilder.addExternalToolResult({
        at,
        // The whole tool payload, not just its status: a terminal tool's verdict is the exit
        // code sitting beside the output, and Cursor reports `completed` for a command that
        // exited nonzero.
        outcome: cursorToolOutcome(bubble.toolFormerData),
        callId,
        summary: typeof bubble.toolFormerData.result === "string" ? bubble.toolFormerData.result : undefined,
      });
    }
  }

  const sessionEvents = eventBuilder.build();
  return {
    prompts,
    sessionEvents,
    eventCoverage: eventBuilder.coverage(),
    toolCounts,
    toolErrors,
    toolErrorCategories,
    userInterruptions,
    toolFilePaths: [...toolFilePaths],
    attributionEvents,
    ...(userBubbles > 0 && userStamps.length === userBubbles ? { userTimestampsMs: userStamps } : {}),
    firstUserPrompt,
  };
}

/**
 * Derives the project root from Cursor's allAttachedFileCodeChunksUris.
 * Filters out Cursor-internal paths (.cursor/) and finds the longest
 * common directory prefix among the remaining file URIs.
 */
function extractProjectPathFromUris(
  uris: string[] | undefined
): string | undefined {
  if (!Array.isArray(uris) || uris.length === 0) return undefined;

  const paths: string[] = [];
  for (const uri of uris) {
    if (!uri.startsWith("file:///")) continue;
    const filePath = fileUriPath(uri); // keeps the leading /
    // Skip Cursor-internal paths
    if (filePath.includes("/.cursor/")) continue;
    paths.push(filePath);
  }

  if (paths.length === 0) return undefined;

  // Find longest common directory prefix
  const first = paths[0]!;
  const segments = first.split("/");
  let common = segments.length;

  for (let i = 1; i < paths.length; i++) {
    const other = paths[i]!.split("/");
    let match = 0;
    while (match < common && match < other.length && segments[match] === other[match]) {
      match++;
    }
    common = match;
  }

  // If common == segments.length, the "common prefix" is a full file path (e.g. single
  // attached file, or all files share the same name). Drop the filename to get the directory.
  if (common === segments.length) {
    common -= 1;
  }

  const commonPath = segments.slice(0, common).join("/");
  return commonPath.length > 1 ? commonPath : undefined;
}

function extractProjectPath(
  reader: SQLiteReader,
  composerId: string
): string | undefined {
  // Try messageRequestContext first
  const rows = reader.query<KVRow>(
    `SELECT key, value FROM cursorDiskKV WHERE key LIKE ? LIMIT 5`,
    [`${MRC_PREFIX}${composerId}:%`]
  );

  // parseRootPathFromCursorValue handles both layout shapes — a plain object and
  // the stringified-JSON entry recent Cursor builds write (which `parsed.projectLayouts[0].rootPath`
  // silently missed, dropping the only project signal a file-context-less chat session carries).
  for (const row of rows) {
    const rootPath = parseRootPathFromCursorValue(row.value);
    if (rootPath) return rootPath;
  }

  // Fallback: check first few bubbles
  const bubbleRows = reader.query<KVRow>(
    `SELECT key, value FROM cursorDiskKV WHERE key LIKE ? LIMIT 3`,
    [`${BUBBLE_PREFIX}${composerId}:%`]
  );

  for (const row of bubbleRows) {
    const rootPath = parseRootPathFromCursorValue(row.value);
    if (rootPath) return rootPath;
  }

  return undefined;
}

/**
 * If the last segment of a path contains a "." (i.e. looks like a filename),
 * return the parent directory. Otherwise return the path unchanged.
 */
function normalizeToDirectory(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const last = p.split("/").pop() ?? "";
  // A leading dot (hidden files/dirs like ".git") is not a file extension
  if (last.includes(".") && !last.startsWith(".")) {
    const parent = p.split("/").slice(0, -1).join("/");
    return parent.length > 1 ? parent : undefined;
  }
  return p;
}


// ── Parsing helpers ──────────────────────────────────────────────────────────

/**
 * Direct child→parent composer id from a Task-spawned child's own
 * composerData.subagentInfo. Undefined when the field is absent, empty, or
 * self-referential (a composer must not parent itself).
 */
export function parentComposerIdFromSubagentInfo(cd: {
  composerId: string;
  subagentInfo?: { parentComposerId?: unknown };
}): string | undefined {
  const parent = cd.subagentInfo?.parentComposerId;
  if (typeof parent !== "string" || parent === "" || parent === cd.composerId) {
    return undefined;
  }
  return parent;
}

/**
 * Builds child composerId → parent composerId from Cursor's on-disk sub-agent
 * transcripts: ~/.cursor/projects/<slug>/agent-transcripts/<parent>/subagents/<child>.jsonl
 */
export function buildChildToParentFromAgentTranscripts(cursorDir: string): Map<string, string> {
  const map = new Map<string, string>();
  const projectsDir = join(cursorDir, "projects");
  if (!existsSync(projectsDir)) return map;

  let projectSlugs: string[];
  try {
    projectSlugs = readdirSync(projectsDir);
  } catch {
    return map;
  }

  for (const slug of projectSlugs) {
    const transcriptsDir = join(projectsDir, slug, "agent-transcripts");
    if (!existsSync(transcriptsDir)) continue;

    let parentIds: string[];
    try {
      parentIds = readdirSync(transcriptsDir);
    } catch {
      continue;
    }

    for (const parentId of parentIds) {
      const subagentsDir = join(transcriptsDir, parentId, "subagents");
      if (!existsSync(subagentsDir)) continue;

      let childFiles: string[];
      try {
        childFiles = readdirSync(subagentsDir);
      } catch {
        continue;
      }

      for (const file of childFiles) {
        if (!file.endsWith(".jsonl")) continue;
        const childId = file.slice(0, -".jsonl".length);
        if (childId) map.set(childId, parentId);
      }
    }
  }
  return map;
}

function parseComposerData(raw: string): ComposerData | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)["composerId"] !== "string" ||
      typeof (parsed as Record<string, unknown>)["createdAt"] !== "number" ||
      !Array.isArray(
        (parsed as Record<string, unknown>)["fullConversationHeadersOnly"]
      )
    ) {
      return null;
    }
    // Sub-agent children (and some never-updated sessions) omit lastUpdatedAt.
    // Fall back to createdAt so they aren't dropped — required to ingest and
    // fold sub-agents. lastUpdatedAt drives the dedup token, so createdAt is a
    // safe stand-in for a session that never updated.
    const obj = parsed as Record<string, unknown>;
    if (typeof obj["lastUpdatedAt"] !== "number") obj["lastUpdatedAt"] = obj["createdAt"];
    return parsed as ComposerData;
  } catch {
    return null;
  }
}

// Per-tool "primary subject" arg keys. Tools not listed here get a bare
// `[Tool: name]` placeholder (no args preview) to avoid dumping unstructured JSON.
const TOOL_ARG_KEY: Record<string, string> = {
  read_file: "target_file",
  edit_file: "target_file",
  codebase_search: "query",
  grep_search: "query",
  file_search: "query",
  run_terminal_cmd: "command",
  list_dir: "relative_workspace_path",
};

// Arg keys whose value is a file (or directory) path, harvested into relevantFiles
// so project resolution and redaction treat it like Claude
// Code's tool_use.input.file_path. Keyed by ARG NAME rather than tool name because
// Cursor versions its tools (read_file → read_file_v2, edit_file → search_replace /
// write / MultiEdit, …) while the path arg stays one of these few keys.
const TOOL_FILE_ARG_KEYS = ["target_file", "file_path", "path"] as const;

// Harvests absolute/relative file paths from a tool call's parsed args.
function extractToolFilePaths(args: Record<string, unknown>): string[] {
  const files: string[] = [];
  for (const key of TOOL_FILE_ARG_KEYS) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) files.push(val);
  }
  return files;
}

// Drops directory paths, which reach relevantFiles whenever a search tool scopes
// itself with a `path` arg. A directory can never appear in a PR diff, so it adds
// nothing to session→PR overlap while still counting in the denominator that
// containment divides by — pushing correct matches under a consumer's gate. A consumer
// keeps extensionless paths on the assumption that the extractor already excluded
// directory arguments; this makes that true.
//
// The filesystem is the oracle rather than a tool-name allowlist, for the same
// reason TOOL_FILE_ARG_KEYS is keyed by arg name: vendor tool names rot.
//
// Only extensionless basenames are probed, so `Dockerfile` and `Makefile` are
// checked and kept; anything unresolvable or already deleted is kept too, since a
// file edited and then removed was still edited.
// hasPlausibleFileExtension reports whether a basename ends in something that
// could be a real file extension, which is the only case worth skipping a probe
// for. An extension needs a dot with characters on BOTH sides — a leading dot is
// part of the name (`.git`, `.cursor`) and a trailing one extends nothing
// (`..`, `foo.`) — and the tail must look like an extension rather than a version
// segment, so `python3.12` and `v1.2.3` are still probed while `foo.go` and
// `.env.local` are not.
//
// Directories with a short alphabetic tail still slip through — the `*.d` drop-in
// convention (`conf.d`, `init.d`), domain-named directories (`github.com` is the
// live one: a GOPATH checkout's own path segment), macOS bundles (`Foo.app`), and
// anything deliberately named like a source file. Accepted rather than fixed:
// on a large real sample of provably-directory entries this rule missed very few,
// and probing every path instead costs a stat per file entry to recover them. A
// miss leaves today's behaviour — the entry is kept — so the failure is a score
// that stays too low, never a real file discarded.
function hasPlausibleFileExtension(basename: string): boolean {
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot >= basename.length - 1) return false;
  return /^[A-Za-z][A-Za-z0-9]{0,5}$/.test(basename.slice(dot + 1));
}

export function partitionDirectoryPaths(
  files: string[],
  workspaceRoot: string | undefined,
  cache: Map<string, boolean>
): { kept: string[]; dropped: number; unresolved: number; probeFailed: number } {
  const kept: string[] = [];
  let dropped = 0;
  let unresolved = 0;
  let probeFailed = 0;
  for (const f of files) {
    const cached = cache.get(f);
    if (cached !== undefined) {
      if (cached) dropped++;
      else kept.push(f);
      continue;
    }
    let isDir = false;
    const basename = f.slice(f.lastIndexOf("/") + 1);
    if (!hasPlausibleFileExtension(basename)) {
      const abs = f.startsWith("/") ? f : workspaceRoot ? join(workspaceRoot, f) : undefined;
      if (abs === undefined) {
        unresolved++;
      } else {
        try {
          isDir = statSync(abs).isDirectory();
        } catch (err) {
          // A path we cannot stat is KEPT (isDir stays false), so both branches
          // below are safe for attribution — they differ only in what an operator
          // can learn. A vanished path is the bulk case and unremarkable; anything
          // else means the probe itself is failing, and a filter that silently
          // stops filtering is exactly what a per-session count cannot show.
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT" || code === "ENOTDIR") {
            unresolved++;
          } else {
            probeFailed++;
            logger.warn("extraction.cursor", "relevant_files_probe_failed", {
              code: code ?? "unknown",
              // The path is the actionable part and carries a home segment, so it
              // goes through the same redaction the session payload gets.
              path: redactPath(f),
            });
          }
        }
      }
    }
    cache.set(f, isDir);
    if (isDir) dropped++;
    else kept.push(f);
  }
  return { kept, dropped, unresolved, probeFailed };
}

// Parses a tool call's rawArgs JSON string into an object. Returns {} on
// missing/malformed input — extraction must never crash on bad tool data.
function parseToolArgs(tfd: ToolFormerData): Record<string, unknown> {
  if (typeof tfd.rawArgs !== "string" || tfd.rawArgs.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(tfd.rawArgs);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed rawArgs — caller falls back to an empty arg set.
  }
  return {};
}

// Extracts the shell command a Cursor terminal tool ran — `params.command`,
// falling back to the parsed rawArgs. Empty string when neither is present.
function cursorToolCommand(tfd: ToolFormerData, args: Record<string, unknown>): string {
  if (tfd.params && typeof tfd.params.command === "string") return tfd.params.command;
  return typeof args["command"] === "string" ? (args["command"] as string) : "";
}

// Extracts captured stdout from a tool's `result` JSON (`{"output":"…"}`).
// Returns "" on missing/malformed result — extraction must never crash on bad data.
function cursorToolOutput(tfd: ToolFormerData): string {
  if (typeof tfd.result !== "string" || tfd.result.length === 0) return "";
  // Cap before parsing — a tool's stdout can be megabytes (cat/grep/build logs);
  // a PR-create URL is in the first bytes, so a result over the cap is skipped
  // whole (its URL, if any, is lost) rather than paying a multi-MB JSON.parse.
  if (tfd.result.length > 512_000) return "";
  try {
    const parsed: unknown = JSON.parse(tfd.result);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out = (parsed as Record<string, unknown>)["output"];
      return typeof out === "string" ? out : "";
    }
  } catch {
    // Malformed result — no output to recover.
  }
  return "";
}

/**
 * Renders a Cursor agent-mode tool call as a compact content placeholder and
 * extracts any primary file-path arg. The placeholder feeds into ConversationPrompt.content
 * so the LLM sees the agent's trajectory; the file paths feed into relevantFiles metadata.
 *
 * Emitted shapes:
 *   [Tool: edit_file target_file=src/auth/session.test.ts]
 *   [Tool: grep_search query=getLoginUrl]
 *   [Tool: edit_file target_file=foo.go status=cancelled]
 *   [Tool: unknown]
 *
 * Redaction: the returned content flows through redactText() (anonymizeText + redactSecrets)
 * at export time, so absolute paths / secrets in args are scrubbed automatically. An arg
 * long enough to be cut is redacted before the cut (`toolArgPreview`).
 *
 * `preParsedArgs` lets callers that already parsed `tfd.rawArgs` (e.g. loadBubbles,
 * which also harvests file paths) reuse it and avoid a second JSON.parse on the hot path.
 */
export function formatToolCall(
  tfd: ToolFormerData,
  preParsedArgs?: Record<string, unknown>
): { content: string; files: string[] } {
  const name = tfd.name && tfd.name.length > 0 ? tfd.name : "unknown";

  const args = preParsedArgs ?? parseToolArgs(tfd);

  // Surface only non-default status states. "completed" is the common case
  // and would add noise to every placeholder.
  const statusSuffix =
    tfd.status && tfd.status !== "completed" ? ` status=${tfd.status}` : "";

  const argKey = TOOL_ARG_KEY[name];
  const argVal = argKey ? args[argKey] : undefined;

  let argsPreview = "";
  if (typeof argVal === "string" && argVal.length > 0) {
    argsPreview = ` ${argKey}=${toolArgPreview(argVal)}`;
  }

  const content = `[Tool: ${name}${argsPreview}${statusSuffix}]`;

  return { content, files: extractToolFilePaths(args) };
}

function parseBubbleData(raw: string): BubbleData | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)["bubbleId"] !== "string"
    ) {
      return null;
    }
    const obj = parsed as Record<string, unknown>;
    if (typeof obj["text"] !== "string" && typeof obj["rawText"] !== "string") {
      return null;
    }
    return parsed as BubbleData;
  } catch {
    return null;
  }
}

export function applyTokenCount(
  metadata: PromptMetadata,
  tokenCount: { inputTokens: number; outputTokens: number } | undefined
): void {
  if (!tokenCount || typeof tokenCount !== "object") return;
  const input =
    typeof tokenCount.inputTokens === "number" ? tokenCount.inputTokens : 0;
  const output =
    typeof tokenCount.outputTokens === "number" ? tokenCount.outputTokens : 0;
  if (input > 0) metadata.inputTokens = input;
  if (output > 0) metadata.outputTokens = output;
  // A bubble's tokenCount is Cursor's own per-message count, natively reported but
  // incomplete: it carries an input total with no output/cache split (output is
  // typically absent). That is NATIVE_PARTIAL — stamp it here, at the single choke
  // point for the billable path, so a token-bearing Cursor turn is never left
  // UNSPECIFIED. The stop-hook ledger later upgrades an id-matched turn to MEASURED;
  // the `!tokenFidelity` guard keeps this from clobbering an already-stamped tier.
  if ((input > 0 || output > 0) && !metadata.tokenFidelity) {
    metadata.tokenFidelity = "TOKEN_FIDELITY_NATIVE_PARTIAL";
  }
}
