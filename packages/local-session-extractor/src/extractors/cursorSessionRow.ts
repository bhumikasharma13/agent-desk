// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Shared row-builder for the Cursor terminal-CLI and Agent-desktop native
 * stores. Both readers parse their own store (Cursor-specific parsing) into a
 * normalized CursorSessionRowInput and hand it here; this module owns the parts
 * that must be identical across surfaces:
 *
 *   - the `source` discriminator ("cli" / "agent") on SessionMeta,
 *   - the OUTPUT-cost-unknown invariant: neither surface logs OUTPUT tokens or a
 *     cost, so we leave output/cost fields UNSET (never 0), keeping these sessions
 *     out of full-cost denominators instead of averaging in a false $0. The CLI
 *     reader DOES supply per-turn INPUT tokens (from the field-5 context totals it
 *     re-sends each turn) on the prompts, from which a consumer derives an
 *     input-only cost (a lower bound) — and a per-segment context_composition.
 *     The Agent reader supplies neither, so it stays fully cost-unknown.
 *   - the SessionLineage shape, emitted only when the reader supplies lineage,
 *   - PII redaction of prompts + project path before the row is persisted.
 *
 * It returns the argument object for `Db.upsert` — the reader calls
 * `db.upsert(buildCursorSessionRow(input))`. Keeping this a pure transform (no
 * DB, no filesystem) is what makes the token/cost accounting unit-testable.
 */

import {
  MAX_CONTEXT_SEGMENTS,
  MAX_SEGMENT_ID_CHARS,
  type ContextSegment,
  type ConversationPrompt,
  type InstallationMetadata,
  type SessionLineagePayload,
  type SessionMetaPayload,
} from "../types/session";
import type { SessionSink } from "../types/store";
import { redactPath, redactPrompts, sanitizeSessionMeta } from "../redaction";
import { resolveSessionBranch } from "./gitUtils";
import type { PRRef } from "./cursorAttributionSignals";

/** The argument object accepted by Db.upsert — kept in sync via the class type. */
export type CursorUpsertParams = Parameters<SessionSink["upsert"]>[0];

/**
 * Normalized, surface-agnostic input a Cursor reader assembles from its native
 * store. Only fields the CLI reader actually populates are modeled — no
 * Agent-only fields, no token/cost fields (structurally absent).
 * `prompts` already carry per-message model metadata set by the reader.
 */
export interface CursorSessionRowInput {
  /** Surface discriminator — persisted as SessionMeta.source. */
  source: "cli" | "agent";
  /** Raw Cursor session uuid (the dedup key; conversationId is derived from it). */
  sessionId: string;
  /** Ordered conversation, user + assistant, redacted here before persistence. */
  prompts: ConversationPrompt[];

  projectPath?: string;
  repoName?: string;

  // Per-surface dedup/tracking stat (CLI: store.db; Agent: the .jsonl).
  lastMtimeMs: number;
  lastSize: number;
  lastOffset?: number;
  /** Session start (meta.json createdAtMs) — unix ms. */
  conversationSourceCreatedAtMs?: number;

  // ── SessionMeta contributions (all optional; omitted when empty) ──
  sessionTitle?: string;
  languages?: Record<string, number>;
  trackedFilePaths?: string[];
  toolCounts?: Record<string, number>;
  toolErrors?: number;
  toolErrorCategories?: Record<string, number>;
  userInterruptions?: number;
  usesTaskAgent?: boolean;
  /** Sub-agent types the session spawned via the Task tool (e.g. "bugbot"). */
  spawnedAgentNames?: string[];
  /** Count of sub-agents spawned (Task tool invocations). */
  subAgentCount?: number;
  usesMcp?: boolean;
  usesWebSearch?: boolean;
  usesExtendedThinking?: boolean;
  userMessageCount?: number;
  assistantMessageCount?: number;
  gitPushes?: number;
  /**
   * Context-window utilization, 0–100. For CLI this is REAL when the store's
   * protobuf root/checkpoint blobs carry a per-turn context-token composition
   * (peak total context tokens / window); it falls back to a char-based estimate
   * (total conversation size / 4 chars-per-token / model window) only when that
   * block is absent. This is the saturation %, a SessionMeta field distinct from
   * the per-prompt input tokens (those ride on the prompts' metadata).
   */
  cursorContextUsagePercent?: number;
  /**
   * Per-segment context composition of the session's peak turn (CLI only) →
   * SessionMeta.context_composition.
   */
  contextComposition?: ContextSegment[];
  /** Count of context compactions — the `summarized_conversation` context category rising
   *  0→non-zero across the per-turn field-5 series. CLI-only: the IDE composer exposes a
   *  peak snapshot, not a per-turn series, so it cannot count transitions. */
  compactionCount?: number;
  mcpServerNames?: string[];
  /** Real per-user-message timestamps (ISO 8601) parsed from the <timestamp> tag. */
  userMessageTimestamps?: string[];
  sessionDurationSeconds?: number;
  gitBranches?: string[];
  gitCommits?: number;
  linesAdded?: number;
  linesRemoved?: number;
  filesModified?: number;
  prReferences?: PRRef[];

  /** Per-scan install metadata (CLI tier, login email, privacy mode). */
  installMeta?: InstallationMetadata;
  /**
   * Session lineage. Supplied only when captureLineage is on AND the reader
   * resolved a parent link; absent otherwise (a primary session has none).
   */
  lineage?: SessionLineagePayload;
}

/** Non-empty guard for record maps (skip emitting an empty {} into SessionMeta). */
function hasEntries(rec: Record<string, unknown> | undefined): boolean {
  return !!rec && Object.keys(rec).length > 0;
}

/**
 * Builds the Db.upsert argument for a single Cursor CLI/Agent session.
 *
 * Cost-unknown: this function never writes any token or cost field — not on the
 * row, not into SessionMeta, and it does not synthesize per-prompt token
 * metadata. The absence is the signal.
 */
export function buildCursorSessionRow(input: CursorSessionRowInput): CursorUpsertParams {
  const meta: SessionMetaPayload = { source: input.source };

  if (input.sessionTitle) meta.session_title = input.sessionTitle;
  if (hasEntries(input.languages)) meta.languages = input.languages;
  if (input.trackedFilePaths && input.trackedFilePaths.length > 0) {
    // Absolute tool-call paths carry the real OS username — anonymize like the
    // project path (the anonymizer hashes /Users/<name>/ → /Users/user_<hash>/).
    meta.tracked_file_paths = input.trackedFilePaths.map(redactPath);
  }
  if (hasEntries(input.toolCounts)) meta.tool_counts = input.toolCounts;
  if (input.toolErrors && input.toolErrors > 0) meta.tool_errors = input.toolErrors;
  if (hasEntries(input.toolErrorCategories)) meta.tool_error_categories = input.toolErrorCategories;
  if (input.userInterruptions && input.userInterruptions > 0) {
    meta.user_interruptions = input.userInterruptions;
  }
  if (typeof input.usesTaskAgent === "boolean") meta.uses_task_agent = input.usesTaskAgent;
  if (input.spawnedAgentNames && input.spawnedAgentNames.length > 0) {
    meta.spawned_agent_names = input.spawnedAgentNames;
  }
  if (input.subAgentCount && input.subAgentCount > 0) meta.sub_agent_count = input.subAgentCount;
  if (input.usesMcp) meta.uses_mcp = true;
  if (input.usesWebSearch) meta.uses_web_search = true;
  if (input.usesExtendedThinking) meta.uses_extended_thinking = true;
  if (input.userMessageCount && input.userMessageCount > 0) meta.user_message_count = input.userMessageCount;
  if (input.assistantMessageCount && input.assistantMessageCount > 0) {
    meta.assistant_message_count = input.assistantMessageCount;
  }
  if (input.gitPushes && input.gitPushes > 0) meta.git_pushes = input.gitPushes;
  if (input.cursorContextUsagePercent && input.cursorContextUsagePercent > 0) {
    meta.cursor_context_usage_percent = input.cursorContextUsagePercent;
  }
  if (input.compactionCount && input.compactionCount > 0) meta.compaction_count = input.compactionCount;
  if (input.contextComposition && input.contextComposition.length > 0) {
    // Defensive cap (untrusted payload): the reader already caps, but re-clamp
    // here so no path stores more than MAX_CONTEXT_SEGMENTS segments.
    meta.context_composition = input.contextComposition.slice(0, MAX_CONTEXT_SEGMENTS).map((s) => ({
      segment: s.segment.slice(0, MAX_SEGMENT_ID_CHARS),
      tokens: s.tokens,
      chars: s.chars,
    }));
  }
  if (input.mcpServerNames && input.mcpServerNames.length > 0) {
    meta.mcp_server_names = input.mcpServerNames;
  }

  // Real per-message timestamps feed the hour-of-day and active-time
  // derivations. Derive message_hours + user_response_times from them here so
  // both surfaces share one derivation. Skip any unparseable timestamp rather
  // than dropping the whole session (mirrors the CC per-element guard).
  const timestamps = (input.userMessageTimestamps ?? []).filter(
    (ts) => !Number.isNaN(new Date(ts).getTime())
  );
  if (timestamps.length > 0) {
    meta.user_message_timestamps = timestamps;
    meta.message_hours = timestamps.map((ts) => new Date(ts).getUTCHours());
    if (timestamps.length >= 2) {
      const responseTimes: number[] = [];
      for (let i = 1; i < timestamps.length; i++) {
        const gapSec = Math.round(
          (new Date(timestamps[i]!).getTime() - new Date(timestamps[i - 1]!).getTime()) / 1000
        );
        responseTimes.push(gapSec);
      }
      meta.user_response_times = responseTimes;
    }
  }

  if (input.sessionDurationSeconds && input.sessionDurationSeconds > 0) {
    meta.session_duration_seconds = input.sessionDurationSeconds;
  }

  if (input.gitBranches && input.gitBranches.length > 0) {
    meta.git_branches = input.gitBranches;
    const scalar = resolveSessionBranch(input.gitBranches);
    if (scalar) meta.git_branch = scalar;
  }
  if (input.gitCommits && input.gitCommits > 0) meta.git_commits = input.gitCommits;
  if (input.linesAdded && input.linesAdded > 0) meta.lines_added = input.linesAdded;
  if (input.linesRemoved && input.linesRemoved > 0) meta.lines_removed = input.linesRemoved;
  if (input.filesModified && input.filesModified > 0) meta.files_modified = input.filesModified;

  if (input.prReferences && input.prReferences.length > 0) {
    meta.pr_references = input.prReferences;
    // Scalars from the first ref for pre-multi-PR back-compat (matches IDE reader).
    meta.pr_url = input.prReferences[0]!.pr_url;
    meta.pr_number = input.prReferences[0]!.pr_number;
    meta.pr_repository = input.prReferences[0]!.pr_repository;
  }

  // Lineage is emitted only when the reader resolved one — a primary session
  // carries no lineage key, matching CC/Codex.
  if (input.lineage) meta.lineage = input.lineage;

  const redactedProjectPath = input.projectPath ? redactPath(input.projectPath) : undefined;
  const sessionMetaJson = Object.keys(meta).length > 0 ? JSON.stringify(sanitizeSessionMeta(meta)) : undefined;
  const installMetaJson = input.installMeta ? JSON.stringify(input.installMeta) : undefined;

  return {
    ideType: "cursor",
    sessionId: input.sessionId,
    conversation: redactPrompts(input.prompts),
    projectPath: redactedProjectPath,
    repoName: input.repoName,
    lastMtimeMs: input.lastMtimeMs,
    lastSize: input.lastSize,
    lastOffset: input.lastOffset ?? 0,
    conversationSourceCreatedAtMs: input.conversationSourceCreatedAtMs,
    sessionMeta: sessionMetaJson,
    installationMetadata: installMetaJson,
  };
}
