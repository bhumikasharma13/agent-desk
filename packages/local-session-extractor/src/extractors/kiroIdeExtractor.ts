// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Kiro IDE Session Extractor — new format (v1).
 *
 * Kiro IDE sessions are stored at:
 *   ~/.kiro/sessions/<workspace-hash>/sess_<uuid>/
 *     ├── session.json        — session metadata
 *     ├── messages.jsonl      — full conversation event stream
 *     ├── sub-executions/     — sub-agent JSONL files
 *     ├── snapshots/          — file checkpoints (not extracted)
 *     ├── publish.cursor      — internal sync state (not extracted)
 *     └── publish-sub.cursor  — internal sync state (not extracted)
 *
 * This extractor handles discovery, parsing, and signal derivation for these
 * sessions. The legacy format (flat .json files under globalStorage) remains
 * handled by kiroDesktopExtractor.ts as a fallback.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  AgenticSessionConfigPayload,
  AiAttributionMetrics,
  ConversationPrompt,
  InstallationMetadata,
  PromptMetadata,
  SessionMetaPayload,
  SubAgentRunPayload,
  TurnUsagePayload,
} from "../types/session";
import type { SessionSink } from "../types/store";
import { promptAuthorship } from "./sessionEvents";
import { redactPrompts, redactPath, sanitizeSessionMeta } from "../redaction";
import { resolveProjectAndRepo, getFullSessionDiffStats, getGitHeadSha, getSessionPRLink, recoverWindowedBranches } from "./gitUtils";
import { dateMs, spanSeconds } from "./dateMs";
import { getKiroIdeSessionsPath } from "./pathResolver";
import { logger } from "../seams/logger";
import { reportRecordError } from "../seams/scanScope";
import { collectKiroAttribution, mergeWindowedBranches, type KiroAttributionEvent } from "./kiroAttribution";
import {
  SessionEventBuilder,
  promptReferenceAuthor,
  type SessionEvent,
  type SessionEventAuthor,
  type EventCoverage,
} from "./sessionEvents";
import { noteUnknownRecordKind, kiroRecordKind, requireConsumedShape } from "./knownRecordKinds";
import { writtenLineCount } from "./lineCount";
import {
  commandPushesToGit,
  applyRecoveredBranches,
  mergeRecoveredPRRefs,
  countWorkspaceArtifacts,
  readKiroMcpServers,
  buildSharedSessionFields,
  normalizeAgentMode,
  normalizeAutonomyMode,
  getLanguagesFromFiles,
  inferWebToolUsage,
} from "./kiroExtractor";

// ── Types for the new session format ──────────────────────────────────────────

/** session.json shape for Kiro IDE sessions (schema v1). */
export interface KiroIdeSessionJson {
  schemaVersion?: string;
  dataModelVersion?: number;
  id?: string;
  title?: string;
  agentMode?: string;          // "vibe" | "spec"
  workspacePaths?: string[];
  createdAt?: string;          // ISO 8601
  lastModifiedAt?: string;     // ISO 8601
  modelId?: string;            // "auto" or specific model
  autopilot?: boolean;
  semanticReviewEnabled?: boolean;
  ftaEnabled?: boolean;
  specPlanEnabled?: boolean;
  specWorkflow?: string;
  specSkipClarificationEnabled?: boolean;
  description?: string;
  status?: string;             // "in_progress" | "completed" | "idle" | "waiting_on_user"
}

/** A single line from messages.jsonl. */
export interface KiroIdeMessage {
  id?: string;
  timestamp?: string;          // ISO 8601
  payload?: KiroIdeMessagePayload;
}

export type KiroIdeMessagePayload =
  | KiroIdeUserPayload
  | KiroIdeAssistantPayload
  | KiroIdeToolCallPayload
  | KiroIdeToolResultPayload
  | KiroIdeTurnStartPayload
  | KiroIdeTurnEndPayload
  | KiroIdeUsageSummaryPayload
  | KiroIdeSessionMetadataPayload
  | KiroIdeSessionEventPayload
  | KiroIdeSessionStartPayload
  | KiroIdeSubAgentStartPayload
  | KiroIdeSubAgentCompletePayload
  | KiroIdePendingInteractionPayload
  | KiroIdeInteractionResolvedPayload;

interface KiroIdeUserPayload {
  type: "user";
  content?: string;
  images?: unknown[];
  documents?: unknown[];
  _meta?: {
    traceparent?: string;
    kiro?: { __callerClientId?: string };
  };
}

interface KiroIdeAssistantPayload {
  type: "assistant";
  content?: string;
  operationType?: string;
  executionId?: string;
  _meta?: { kiro?: { agentMode?: string } };
}

interface KiroIdeToolCallPayload {
  type: "tool_call";
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  status?: string;
  kind?: string;
  executionId?: string;
  actionType?: string;
  title?: string;
  /** The edited file, as Kiro reports it. Present exactly when `kind === "edit"`. */
  filePath?: string;
  _meta?: {
    kiro?: {
      agentMode?: string;
      toolOrigin?: string;
      toolId?: string;
      /** What a `disclose_context` call actually loaded, named by Kiro itself.
       *  `type` discriminates a skill from the other context kinds the same tool
       *  loads; `uri` is a `file://` URL to the loaded file. Absent when the call
       *  disclosed nothing (a failed load). */
      disclosedContext?: { type?: string; displayName?: string; uri?: string };
    };
  };
}

interface KiroIdeToolResultPayload {
  type: "tool_result";
  toolCallId?: string;
  content?: string;
  success?: boolean;
  executionId?: string;
  _meta?: { kiro?: { agentMode?: string } };
}

interface KiroIdeTurnStartPayload {
  type: "turn_start";
  executionId?: string;
}

interface KiroIdeTurnEndPayload {
  type: "turn_end";
  stopReason?: string;
  executionId?: string;
}

interface KiroIdeUsageSummaryPayload {
  type: "usage_summary";
  promptTurnSummaries?: Array<{
    unit?: string;
    unitPlural?: string;
    usage?: number;
    usedTools?: string[];
  }>;
  elapsedTime?: number;        // ms
  status?: string;
  executionId?: string;
}

interface KiroIdeSessionMetadataPayload {
  type: "session_metadata";
  key?: string;
  value?: { usagePercentage?: number };
  executionId?: string;
}

interface KiroIdeSessionEventPayload {
  type: "session_event";
  category?: string;
  context?: { executionId?: string; status?: string };
}

interface KiroIdeSessionStartPayload {
  type: "session_start";
  agentType?: string;
  content?: string;
}

/**
 * Emitted when the agent delegates to a sub-agent. `subSessionId` equals the
 * `sub-executions/<id>.jsonl` filename, so this is the only place the sub-agent's
 * NAME is recorded — the directory listing alone yields opaque UUIDs.
 */
interface KiroIdeSubAgentStartPayload {
  type: "sub_agent_start";
  subAgentName?: string;
  subSessionId?: string;
  parentExecutionId?: string;
  prompt?: string;
  explanation?: string;
}

interface KiroIdeSubAgentCompletePayload {
  type: "sub_agent_complete";
  subSessionId?: string;
  parentExecutionId?: string;
  status?: string;
  response?: string;
}

/**
 * A prompt awaiting the user. For `tool_approval`, `options[].kind` carries the
 * vocabulary worth recording (allow_once / allow_always / reject_once /
 * reject_always) while `optionId` is what `interaction_resolved` echoes back —
 * so the two events must be joined on `toolCallId` to classify an answer.
 *
 * `question` holds the raw command awaiting approval and is deliberately NOT
 * captured: it is free text that can carry secrets.
 */
interface KiroIdePendingInteractionPayload {
  type: "pending_interaction";
  interactionType?: string;
  toolCallId?: string;
  executionId?: string;
  question?: string;
  options?: Array<{ optionId?: string; name?: string; kind?: string }>;
}

/**
 * The user's answer to a `pending_interaction`. For `tool_approval` prompts,
 * `selectedOption` is one of accept / always-accept / reject / always-reject.
 */
interface KiroIdeInteractionResolvedPayload {
  type: "interaction_resolved";
  toolCallId?: string;
  executionId?: string;
  outcome?: string;
  selectedOption?: string;
}

/**
 * Stop reasons that mean the USER stopped the assistant. `user_interruptions` is
 * consumed as exactly that claim and feeds friction metrics, so an allowlist is
 * used rather than "anything but end_turn": a token-limit or error finish
 * (`max_tokens`, a failure) ends a turn without anyone cancelling it, and
 * counting those inflates every Kiro session's friction. An unrecognised reason
 * is not counted — under-reporting a real cancel is recoverable, inventing one
 * is not.
 */
const USER_CANCELLED_STOP_REASONS = new Set([
  "cancelled",
  "canceled",
  "user_interrupt",
  "user_cancelled",
  "aborted",
]);

// ── Parsing helpers ───────────────────────────────────────────────────────────

interface ParsedIdeSession {
  prompts: ConversationPrompt[];
  toolCounts: Record<string, number>;
  toolErrors: number;
  filesEdited: Set<string>;
  /** Files the session READ (read_file / readFile / read_code), for tracked_file_paths. */
  filesRead: Set<string>;
  composerSuggestedLines: number;
  userInterruptions: number;
  /** Tool calls the user explicitly denied at the approval prompt. */
  toolRejections: number;
  /** `git push` invocations that exited successfully — git history cannot show these. */
  gitPushes: number;
  totalCredits: number;
  totalElapsedMs: number;
  maxContextUsagePercent: number;
  userMessageTimestamps: string[];
  messageHours: number[];
  userResponseTimes: number[];
  /** Sub-agent display names in first-seen order, from `sub_agent_start` events. */
  subAgentNames: string[];
  /** Delegations with their outcome, joined `sub_agent_start` → `sub_agent_complete`. */
  subAgentRuns: SubAgentRunPayload[];
  /** Approval prompts keyed by the option kind the user chose. */
  toolApprovalOutcomes: Record<string, number>;
  /** Tool calls keyed by `_meta.kiro.toolOrigin` ("default", "acp"). */
  toolOriginCounts: Record<string, number>;
  /** Per-turn metering, one entry per `usage_summary`. */
  turnUsage: TurnUsagePayload[];
  userPromptChars: number;
  assistantResponseChars: number;
  /** Authoring evidence for PR/branch recovery — see kiroAttribution.ts. */
  attributionEvents: KiroAttributionEvent[];
  /** Lines that failed to parse. Non-zero means the row is a partial extraction. */
  malformedLines: number;
  /**
   * The normalized event timeline (greenfield for Kiro). PROMPT_REFERENCE
   * ordinals are parse-order placeholders — the caller remaps them to the merged
   * conversation's positions, since Kiro interleaves sub-execution prompts.
   */
  sessionEvents: SessionEvent[];
  eventCoverage: EventCoverage;
}

/**
 * Parse a messages.jsonl file into structured signals.
 * Each line is a JSON object with { id, timestamp, payload }.
 */
export function parseIdeMessages(lines: string[]): ParsedIdeSession {
  let malformedLines = 0;
  const prompts: ConversationPrompt[] = [];
  const toolCounts: Record<string, number> = {};
  const filesEdited = new Set<string>();
  const filesRead = new Set<string>();
  let toolErrors = 0;
  let composerSuggestedLines = 0;
  let userInterruptions = 0;
  let toolRejections = 0;
  let gitPushes = 0;
  let totalCredits = 0;
  let totalElapsedMs = 0;
  let maxContextUsagePercent = 0;
  const contextByExecution = new Map<string, number>();
  const userMessageTimestamps: string[] = [];
  const messageHours: number[] = [];
  const userResponseTimes: number[] = [];
  const subAgentNames: string[] = [];
  const subAgentRuns: SubAgentRunPayload[] = [];
  const toolApprovalOutcomes: Record<string, number> = {};
  const toolOriginCounts: Record<string, number> = {};
  const turnUsage: TurnUsagePayload[] = [];
  // Parallel to turnUsage: the executionId each entry came from, so the
  // turn_end that follows it can be matched without polluting the payload type.
  const turnUsageExecutionIds: string[] = [];
  let userPromptChars = 0;
  let assistantResponseChars = 0;

  let lastAssistantEndTs: number | null = null;
  // toolCallId → shell command, so a `git push` is only counted once its
  // tool_result confirms it succeeded (a failed push changed nothing).
  const pendingShellCommands = new Map<string, string>();
  const attributionEvents: KiroAttributionEvent[] = [];
  // Index into attributionEvents of the most recent assistant message, so a
  // turn_end can mark it as that turn's closing prose. Kiro emits many assistant
  // events per turn, so only the last one before a turn_end is a summary.
  let lastAssistantEventIdx: number | null = null;
  // toolCallId → optionId→kind, so an `interaction_resolved` answer can be
  // classified by the vendor's own kind vocabulary rather than by its optionId.
  const pendingApprovalKinds = new Map<string, Record<string, string>>();
  // subSessionId → index in subAgentRuns, so `sub_agent_complete` can attach its
  // status to the run its `sub_agent_start` opened.
  const subAgentRunIndex = new Map<string, number>();
  // executionId → stopReason, so a turn's usage_summary can record why it ended.
  // usage_summary precedes turn_end, so this is resolved in a second pass.
  const stopReasonByExecution = new Map<string, string>();
  // executionId → the assistant message that closes that execution, so the turn's
  // per-execution credits + context can be stamped on it after the whole walk.
  const lastAssistantPromptByExecution = new Map<string, ConversationPrompt>();
  // Per-execution edit accounting, stamped onto the same closing assistant message:
  // the files this execution's edit tools touched, and its added/removed line totals.
  const editFilesByExecution = new Map<string, Set<string>>();
  const linesAddedByExecution = new Map<string, number>();
  const linesRemovedByExecution = new Map<string, number>();
  const addEditFile = (execId: string | undefined, path: string): void => {
    if (!execId) return;
    let files = editFilesByExecution.get(execId);
    if (!files) editFilesByExecution.set(execId, (files = new Set()));
    files.add(path);
  };
  const addEditLines = (execId: string | undefined, added: number, removed: number): void => {
    if (!execId) return;
    if (added) linesAddedByExecution.set(execId, (linesAddedByExecution.get(execId) ?? 0) + added);
    if (removed) linesRemovedByExecution.set(execId, (linesRemovedByExecution.get(execId) ?? 0) + removed);
  };
  // An edit tool_call records its files/lines, but a later tool_result may report
  // it FAILED — a failed fs_write/str_replace must not count as an edit. So an
  // edit's attribution is buffered by toolCallId here and committed only once its
  // result confirms it did not fail (mirrors pendingShellCommands). An edit call
  // with no toolCallId can't be paired, so it commits at once (unchanged); an
  // unpaired buffered edit (no result — a truncated capture) is flushed at the end
  // of the walk, preserving the pre-buffer "assume applied" behaviour.
  interface PendingEdit {
    executionId?: string;
    files: string[];
    added: number;
    removed: number;
    suggested: number;
  }
  const pendingEdits = new Map<string, PendingEdit>();
  const commitEdit = (e: PendingEdit): void => {
    for (const f of e.files) {
      filesEdited.add(f);
      addEditFile(e.executionId, f);
    }
    addEditLines(e.executionId, e.added, e.removed);
    composerSuggestedLines += e.suggested;
  };
  // Route one edit's attribution through the buffer when the call has an id to
  // pair a result against; otherwise commit it immediately (can't gate on success).
  const recordEdit = (toolCallId: string | undefined, e: PendingEdit): void => {
    if (!toolCallId) {
      commitEdit(e);
      return;
    }
    const existing = pendingEdits.get(toolCallId);
    if (existing) {
      existing.files.push(...e.files);
      existing.added += e.added;
      existing.removed += e.removed;
      existing.suggested += e.suggested;
    } else {
      pendingEdits.set(toolCallId, e);
    }
  };
  // The Kiro session's event timeline.
  const eventBuilder = new SessionEventBuilder();

  // Kiro records the human prompt (`user`) just BEFORE the turn's opening
  // `turn_start`, but a turn grouper opens the turn at TURN_STARTED — so a prompt
  // reference emitted at the user record would fall OUTSIDE the bracket, leaving
  // the turn authorless and stranding its human prompt in the prior turn. Hold
  // the human prompt reference and emit it once the turn opens, so it sits inside
  // the bracket it belongs to. Assistant references already fall inside the
  // bracket and are emitted directly. (A boot/bracket-only turn has no pending
  // prompt, so it opens authorless — correct.)
  let pendingHumanPromptRef:
    | { ordinal: number; timestamp: string | undefined; author: SessionEventAuthor }
    | null = null;
  const flushPendingPromptRef = () => {
    if (pendingHumanPromptRef) {
      eventBuilder.addPromptReference(
        pendingHumanPromptRef.ordinal,
        pendingHumanPromptRef.timestamp,
        pendingHumanPromptRef.author
      );
      pendingHumanPromptRef = null;
    }
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let msg: KiroIdeMessage;
    try {
      msg = JSON.parse(line) as KiroIdeMessage;
    } catch {
      // Counted, not logged here: the remaining lines usually still parse, so the
      // row is stored looking complete while silently missing whatever prompts,
      // tools or cost that line carried. The caller warns once per file — per
      // line would bury the rest of the extraction log on a truncated transcript.
      malformedLines++;
      continue;
    }

    const payload = msg.payload;
    // Count any record kind the corpus has never shown us — the vendor-drift
    // tripwire. Runs BEFORE the missing-type early return below: a record that
    // lost or renamed its `payload.type` is exactly the schema drift this counter
    // exists to catch, and kiroRecordKind maps that absence to the unrecognized
    // "<none>" kind rather than letting it disappear silently. A no-op for every
    // recognized kind, acted-on or skipped below.
    noteUnknownRecordKind("kiro", kiroRecordKind(payload ?? {}));
    if (!payload || !payload.type) continue;
    // Kiro emits an empty-string timestamp placeholder on some records; normalize
    // it (and any unparseable value) to undefined here so every downstream
    // consumer — the event timeline's occurred_at included — falls back to the
    // epoch sentinel rather than writing an invalid "" that sorts before all
    // real timestamps. Mirrors the truthy guards the rest of this file already uses.
    const rawTimestamp = msg.timestamp;
    const timestamp =
      rawTimestamp && !Number.isNaN(Date.parse(rawTimestamp)) ? rawTimestamp : undefined;

    switch (payload.type) {
      case "user": {
        const p = payload as KiroIdeUserPayload;
        // Shape guard on the message-bearing field: the next line reads `content`
        // only as a string (`.trim()`), so an absent OR non-string `content` drops
        // the human prompt. A string on every real user record (verified against the
        // fixtures). Kiro's credits field is deliberately NOT guarded — a
        // `usage_summary`'s `promptTurnSummaries[].usage` is legitimately absent on
        // an un-metered turn (the `sawUsage` path), so a guard there would cry wolf.
        requireConsumedShape("kiro", "user", "payload.content", p.content, "string");
        // Read defensively: `?.` guards null/undefined but not a wrong TYPE, and
        // `.trim()` on a non-string (a content-block array) throws — which the caller's
        // per-session catch turns into the whole session dropped, not one empty turn.
        // Degrade to "" so the shape drift the guard just counted stays a dropped turn.
        const content = typeof p.content === "string" ? p.content.trim() : "";
        if (content) {
          userPromptChars += content.length;
          prompts.push({
            role: "user",
            content,
            ...(timestamp ? { timestamp } : {}),
          });
          // Ordinal is a parse-order placeholder — the caller remaps it to the
          // merged conversation's position (sub-executions interleave). Buffered,
          // not emitted here: it is flushed at the next turn_start so it lands
          // inside the turn's bracket (see pendingHumanPromptRef above). Flush any
          // earlier pending ref first, for a malformed run of two user records
          // with no turn_start between them.
          flushPendingPromptRef();
          pendingHumanPromptRef = {
            ordinal: prompts.length,
            timestamp,
            author: promptReferenceAuthor({ role: "user" }),
          };
          // Only real timestamps are recorded: an empty placeholder is not a
          // valid ISO 8601 value downstream, and it would desync this array
          // from message_hours, which is only appended when one is present.
          if (timestamp) {
            userMessageTimestamps.push(timestamp);
            const hour = new Date(timestamp).getUTCHours();
            if (!isNaN(hour)) messageHours.push(hour);

            // User response time: gap between last assistant turn end and this user message
            if (lastAssistantEndTs !== null) {
              const userTs = new Date(timestamp).getTime();
              if (!isNaN(userTs)) {
                const gap = Math.round((userTs - lastAssistantEndTs) / 1000);
                if (gap >= 0 && gap < 86400) { // cap at 24h
                  userResponseTimes.push(gap);
                }
              }
            }
          }
        }
        break;
      }

      case "assistant": {
        const p = payload as KiroIdeAssistantPayload;
        // Shape guard on the message-bearing field: the next line reads `content`
        // only as a string (`.trim()`), so an absent OR non-string `content` drops
        // the model's turn. A string on every real assistant record (verified against
        // the fixtures).
        requireConsumedShape("kiro", "assistant", "payload.content", p.content, "string");
        // Read defensively — see the user branch above: `.trim()` on a wrong-shaped
        // (non-string) content throws and the per-session catch drops the whole session.
        const content = typeof p.content === "string" ? p.content.trim() : "";
        if (content) {
          assistantResponseChars += content.length;
          const assistantPrompt: ConversationPrompt = {
            role: "assistant",
            content,
            ...(timestamp ? { timestamp } : {}),
          };
          prompts.push(assistantPrompt);
          // The turn's measured credits and context occupancy land on the message
          // that CLOSES the execution — the last assistant message before turn_end.
          // Both are keyed by executionId and stamped after the whole walk.
          if (p.executionId) lastAssistantPromptByExecution.set(p.executionId, assistantPrompt);
          eventBuilder.addPromptReference(prompts.length, timestamp, promptReferenceAuthor({ role: "assistant" }));
          lastAssistantEventIdx = attributionEvents.length;
          attributionEvents.push({ text: content });
        }
        break;
      }

      case "tool_call": {
        const p = payload as KiroIdeToolCallPayload;
        const toolName = p.toolName ?? "unknown";
        toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
        eventBuilder.addExternalToolCall({
          name: toolName,
          at: timestamp ?? new Date(0).toISOString(),
          ...(p.toolCallId ? { callId: p.toolCallId } : {}),
          // A command runner's command IS the grounding summary: a consumer's
          // checker-command rule needs both a recognized tool name and a nonempty
          // summary, so without the command a Kiro shell result (`execute_bash`)
          // is rejected as evidence even though its exit status is stored. Any
          // tool carrying `args.command` passes it; addExternalToolCall bounds and
          // redacts it (a non-shell tool's summary is harmless — a consumer reads
          // it as a command only for a recognized command runner).
          ...(typeof p.args?.command === "string" ? { summary: p.args.command } : {}),
        });

        // Where the tool came from. Kept separate from uses_mcp: "acp" is an
        // Agent-Client-Protocol peer, which is not an MCP server.
        const origin = p._meta?.kiro?.toolOrigin;
        if (origin) toolOriginCounts[origin] = (toolOriginCounts[origin] ?? 0) + 1;

        // Files the session read. `read_file`/`readFile` carry a single `path`;
        // `read_code` carries `files: [{path}]`.
        if ((toolName === "read_file" || toolName === "readFile") && typeof p.args?.path === "string") {
          filesRead.add(p.args.path);
        } else if (toolName === "read_code" && Array.isArray(p.args?.files)) {
          for (const entry of p.args.files as Array<{ path?: unknown }>) {
            if (entry && typeof entry.path === "string") filesRead.add(entry.path);
          }
        }

        // Shell commands are the only record of a `git push`; git history cannot
        // show one. Held until tool_result confirms the exit status.
        if (toolName === "execute_bash" && typeof p.args?.command === "string" && p.toolCallId) {
          pendingShellCommands.set(p.toolCallId, p.args.command);
        }

        // This call's edit attribution, accumulated then buffered by toolCallId so
        // a failed result can drop it before it is committed (see recordEdit).
        const edit: PendingEdit = { executionId: p.executionId, files: [], added: 0, removed: 0, suggested: 0 };

        // Kiro labels the call `kind: "edit"` and reports the file in `filePath`,
        // which is its own answer and covers edit tools this code never enumerated
        // — a name allowlist silently drops files for any tool Kiro adds later.
        if (p.kind === "edit" && typeof p.filePath === "string") {
          edit.files.push(p.filePath);
        }

        // args still drive the suggested-line count, which needs the written text.
        if ((toolName === "fs_write" || toolName === "str_replace" || toolName === "fs_append") && p.args) {
          // Validated, not asserted: args come from vendor JSON, so a non-string
          // here would otherwise enter a Set<string> and reach path/language
          // derivation as a non-path.
          const rawPath = p.args.path ?? p.args.targetFile;
          const filePath = typeof rawPath === "string" ? rawPath : undefined;
          if (filePath) {
            edit.files.push(filePath);
            // Estimate lines suggested for AI attribution
            // fs_append is every line it writes — nothing is replaced. It was
            // already admitted above (so the file counted as edited) while no
            // branch counted its lines, leaving append-only sessions reporting
            // modified files against zero AI volume.
            //
            // Reads `text`, the field fs_write is verified to use: no captured
            // session on hand contains an fs_append call, so its payload field is
            // inferred rather than grounded in a captured fixture. If Kiro names
            // it something else the count stays 0, so a wrong guess cannot
            // overcount.
            if ((toolName === "fs_write" || toolName === "fs_append") && typeof p.args.text === "string") {
              const written = writtenLineCount(p.args.text as string);
              edit.suggested += written;
              // A write/append adds its lines; it removes nothing the transcript can count.
              edit.added += written;
            } else if (toolName === "str_replace" && typeof p.args.newStr === "string") {
              const newLines = writtenLineCount(p.args.newStr as string);
              const oldLines = typeof p.args.oldStr === "string" ? writtenLineCount(p.args.oldStr as string) : 0;
              const net = newLines - oldLines;
              if (net > 0) edit.suggested += net;
              // Per-message counts are gross, not net: str_replace has no line-level
              // diff, so the old block's lines are removed and the new block's added.
              edit.added += newLines;
              edit.removed += oldLines;
            }
          }
        }

        if (edit.files.length > 0 || edit.added || edit.removed || edit.suggested) {
          recordEdit(p.toolCallId, edit);
        }
        break;
      }

      case "tool_result": {
        const p = payload as KiroIdeToolResultPayload;
        if (p.success === false) {
          toolErrors++;
        }
        eventBuilder.addExternalToolResult({
          at: timestamp ?? new Date(0).toISOString(),
          // UNKNOWN when the vendor stated no status — a consumer reads this as a
          // check's verdict, so a synthesized pass would satisfy a bar nothing verified.
          outcome:
            p.success === false
              ? "SESSION_EVENT_OUTCOME_FAILED"
              : p.success === true
                ? "SESSION_EVENT_OUTCOME_SUCCEEDED"
                : "SESSION_EVENT_OUTCOME_UNKNOWN",
          ...(p.toolCallId ? { callId: p.toolCallId } : {}),
          ...(typeof p.content === "string" ? { summary: p.content } : {}),
        });
        if (p.toolCallId) {
          const command = pendingShellCommands.get(p.toolCallId);
          if (command !== undefined) {
            pendingShellCommands.delete(p.toolCallId);
            if (p.success === true && commandPushesToGit(command)) gitPushes++;
            // Pair the command with its stdout: `gh pr create` prints the PR URL,
            // which is the authoritative reference.
            attributionEvents.push({
              command,
              ...(typeof p.content === "string" ? { output: p.content } : {}),
              ok: p.success === true,
            });
          }
          const pendingEdit = pendingEdits.get(p.toolCallId);
          if (pendingEdit !== undefined) {
            pendingEdits.delete(p.toolCallId);
            // A failed edit is not an edit — drop it. success===false is the only
            // signal to discard; an absent status still commits, so a vendor that
            // omits success does not silently drop real edits.
            if (p.success !== false) commitEdit(pendingEdit);
          }
        }
        break;
      }

      case "pending_interaction": {
        const p = payload as KiroIdePendingInteractionPayload;
        if (p.interactionType === "tool_approval" && p.toolCallId) {
          const kinds: Record<string, string> = {};
          for (const opt of p.options ?? []) {
            if (opt.optionId && opt.kind) kinds[opt.optionId] = opt.kind;
          }
          pendingApprovalKinds.set(p.toolCallId, kinds);
        }
        break;
      }

      case "interaction_resolved": {
        const p = payload as KiroIdeInteractionResolvedPayload;
        const kinds = p.toolCallId ? pendingApprovalKinds.get(p.toolCallId) : undefined;
        // Only tool_approval interactions are counted; a "Keep Iterating"-style
        // answer to some other question is not an approval decision.
        if (kinds && p.selectedOption) {
          // Fall back to the raw optionId if the prompt offered no kind, so an
          // answer is still counted rather than silently dropped.
          const kind = kinds[p.selectedOption] ?? p.selectedOption;
          toolApprovalOutcomes[kind] = (toolApprovalOutcomes[kind] ?? 0) + 1;
          // Both vocabularies: the vendor's option KIND (reject_once /
          // reject_always) and the raw optionId fallback (reject / always-reject).
          // "always-reject" does not start with "reject", so a permanent denial
          // was silently missing from tool_error_categories.tool_rejected.
          if (kind.startsWith("reject") || kind.endsWith("reject")) toolRejections++;
          pendingApprovalKinds.delete(p.toolCallId!);
        }
        break;
      }

      case "sub_agent_start": {
        const p = payload as KiroIdeSubAgentStartPayload;
        const name = p.subAgentName?.trim();
        // Positional span open — its subSessionId pairs with the matching close so
        // concurrent delegations stay distinguishable.
        eventBuilder.addSubagentStarted({
          at: timestamp,
          ...(p.subSessionId ? { callId: p.subSessionId } : {}),
          ...(name ? { name } : {}),
        });
        if (name && !subAgentNames.includes(name)) subAgentNames.push(name);
        if (name) {
          // The prompt/explanation on this event are free text and are left
          // uncaptured on purpose — see the payload type.
          const run: SubAgentRunPayload = {
            name,
            ...(p.subSessionId ? { sub_session_id: p.subSessionId } : {}),
          };
          if (p.subSessionId) subAgentRunIndex.set(p.subSessionId, subAgentRuns.length);
          subAgentRuns.push(run);
        }
        break;
      }

      case "sub_agent_complete": {
        const p = payload as KiroIdeSubAgentCompletePayload;
        if (p.subSessionId && p.status) {
          const idx = subAgentRunIndex.get(p.subSessionId);
          if (idx !== undefined) subAgentRuns[idx]!.status = p.status;
        }
        eventBuilder.addSubagentCompleted({
          at: timestamp,
          ...(p.subSessionId ? { callId: p.subSessionId } : {}),
          outcome:
            p.status === "success"
              ? "SESSION_EVENT_OUTCOME_SUCCEEDED"
              : p.status === "error"
                ? "SESSION_EVENT_OUTCOME_FAILED"
                : "SESSION_EVENT_OUTCOME_UNKNOWN",
        });
        break;
      }

      case "turn_start": {
        // Kiro's native turn-opening edge — a turn grouper brackets turns on these
        // rather than the human-prompt cut.
        eventBuilder.addTurnStarted(timestamp);
        // The human prompt recorded just before this edge belongs INSIDE the turn
        // it opened; emit it now so it sits within the bracket.
        flushPendingPromptRef();
        break;
      }

      case "turn_end": {
        const p = payload as KiroIdeTurnEndPayload;
        if (p.stopReason && p.executionId) stopReasonByExecution.set(p.executionId, p.stopReason);
        // The assistant message that preceded this turn_end is the turn's closing
        // prose — the only assistant text attribution may read.
        if (lastAssistantEventIdx !== null) {
          attributionEvents[lastAssistantEventIdx]!.isTurnFinal = true;
          lastAssistantEventIdx = null;
        }
        const cancelled = !!p.stopReason && USER_CANCELLED_STOP_REASONS.has(p.stopReason);
        if (cancelled) {
          userInterruptions++;
        }
        // Kiro emits a turn_end even on cancellation, so the bracket always closes
        // here. Only `end_turn` says the model finished its turn; a cancellation is
        // CANCELLED, an error FAILED, and any other or missing reason UNKNOWN —
        // never a fabricated pass.
        eventBuilder.addTurnCompleted(
          timestamp,
          cancelled
            ? "SESSION_EVENT_OUTCOME_CANCELLED"
            : p.stopReason === "end_turn"
              ? "SESSION_EVENT_OUTCOME_SUCCEEDED"
              : p.stopReason === "error"
                ? "SESSION_EVENT_OUTCOME_FAILED"
                : "SESSION_EVENT_OUTCOME_UNKNOWN"
        );
        // Record when the assistant turn ended for user_response_time calculation
        if (timestamp) {
          const ts = new Date(timestamp).getTime();
          if (!isNaN(ts)) lastAssistantEndTs = ts;
        }
        break;
      }

      case "usage_summary": {
        const p = payload as KiroIdeUsageSummaryPayload;
        if (p.elapsedTime) totalElapsedMs += p.elapsedTime;
        let turnCredits = 0;
        // Presence of a usage source, not value > 0: a turn metered at exactly 0
        // credits is a MEASURED zero and must reach the wire, not be dropped.
        let sawUsage = false;
        const turnTools: string[] = [];
        for (const summary of p.promptTurnSummaries ?? []) {
          if (summary.usage !== undefined) {
            sawUsage = true;
            turnCredits += summary.usage;
          }
          // usedTools is an ordered call sequence; repeats are meaningful.
          for (const t of summary.usedTools ?? []) turnTools.push(t);
        }
        totalCredits += turnCredits;
        turnUsage.push({
          ...(sawUsage ? { credits: turnCredits } : {}),
          // elapsedTime is milliseconds; the field is seconds.
          ...(typeof p.elapsedTime === "number" ? { active_seconds: p.elapsedTime / 1000 } : {}),
          ...(turnTools.length > 0 ? { tool_names: turnTools } : {}),
        });
        turnUsageExecutionIds.push(p.executionId ?? "");
        break;
      }

      case "session_metadata": {
        const p = payload as KiroIdeSessionMetadataPayload;
        if (p.key === "contextUsage" && p.value?.usagePercentage !== undefined) {
          const pct = p.value.usagePercentage;
          if (pct > maxContextUsagePercent) maxContextUsagePercent = pct;
          // Kiro emits several of these per execution as the turn grows, so the
          // turn's occupancy is the highest it reached, not the last reported.
          // Seed on first sight (even 0) so a genuine 0% occupancy stays present,
          // not conflated via `?? 0` with an unmeasured turn.
          const id = p.executionId;
          if (id) {
            const prev = contextByExecution.get(id);
            if (prev === undefined || pct > prev) contextByExecution.set(id, pct);
          }
        }
        break;
      }

      // session_start, session_event, pending_interaction and sub_agent_complete
      // carry no signal not already derived from the events above.
      default:
        break;
    }
  }

  // A human prompt whose turn never opened a bracket (a truncated capture) still
  // gets its reference, at the timeline's end — the honest fallback over dropping
  // the human input entirely.
  flushPendingPromptRef();

  // An edit whose tool_result never arrived (a truncated capture) is committed
  // here — the same "assume applied" fallback the code used before result-gating,
  // so a cut-off session does not lose an edit that only lacked its result record.
  for (const edit of pendingEdits.values()) commitEdit(edit);
  pendingEdits.clear();

  // turn_end arrives AFTER its usage_summary, so the stop reason can only be
  // attached once the whole stream has been read.
  for (let i = 0; i < turnUsage.length; i++) {
    const execId = turnUsageExecutionIds[i] ?? "";
    const pct = contextByExecution.get(execId);
    if (pct !== undefined) turnUsage[i]!.context_usage_percent = pct;
    const reason = stopReasonByExecution.get(execId);
    if (reason) turnUsage[i]!.end_reason = reason;

    // Re-point the same executionId join onto the per-message metadata: the
    // measured credits and the native context occupancy land on the assistant
    // message that closed this execution. Joined by executionId, never
    // index-matched against the timeline (sub-executions interleave). Fidelity is
    // ESTIMATE: Kiro exposes no exact per-message token counts, so its per-message
    // accounting is estimate-grade.
    // A tool-only or interrupted execution has no closing assistant message, so it
    // gets NO per-message stamp — by design. Its cost is not lost: the turn-level
    // turn_usage above carries this execution's credits and context_usage_percent,
    // which is the authoritative home for a turn that produced no message to stamp.
    const credits = turnUsage[i]!.credits;
    const closingMessage = lastAssistantPromptByExecution.get(execId);
    if (closingMessage && (credits !== undefined || pct !== undefined)) {
      const meta: PromptMetadata = closingMessage.metadata ?? {};
      if (credits !== undefined) meta.nativeBillingUnits = credits;
      // Kiro's usagePercentage is 0-100; the session-level TurnUsage field keeps
      // that scale (stamped above), but the per-message contextUsagePercent wire
      // field is a 0.0-1.0 fraction (PromptMetadata), so divide.
      if (pct !== undefined) meta.contextUsagePercent = pct / 100;
      meta.tokenFidelity = "TOKEN_FIDELITY_ESTIMATE";
      closingMessage.metadata = meta;
    }
  }

  // The execution's edit files and line totals land on the same closing message.
  // Kept separate from the credit/context stamp above so an execution that edited
  // but had no usage_summary still records its files and lines.
  for (const [execId, files] of editFilesByExecution) {
    const closingMessage = lastAssistantPromptByExecution.get(execId);
    if (!closingMessage || files.size === 0) continue;
    const meta: PromptMetadata = closingMessage.metadata ?? {};
    meta.filesEdited = [...files];
    const added = linesAddedByExecution.get(execId);
    const removed = linesRemovedByExecution.get(execId);
    if (added !== undefined) meta.linesAdded = added;
    if (removed !== undefined) meta.linesRemoved = removed;
    closingMessage.metadata = meta;
  }

  return {
    prompts,
    toolCounts,
    toolErrors,
    filesEdited,
    filesRead,
    composerSuggestedLines,
    userInterruptions,
    toolRejections,
    gitPushes,
    totalCredits,
    totalElapsedMs,
    maxContextUsagePercent,
    userMessageTimestamps,
    messageHours,
    userResponseTimes,
    subAgentNames,
    subAgentRuns,
    toolApprovalOutcomes,
    toolOriginCounts,
    turnUsage,
    userPromptChars,
    assistantResponseChars,
    attributionEvents,
    malformedLines,
    sessionEvents: eventBuilder.build(),
    eventCoverage: eventBuilder.coverage(),
  };
}

interface ParsedSubExecutions {
  /** Delegated turns, tagged so human-interaction metrics can exclude them. */
  prompts: ConversationPrompt[];
  toolCounts: Record<string, number>;
  filesEdited: Set<string>;
  filesRead: Set<string>;
  composerSuggestedLines: number;
  toolErrors: number;
  toolRejections: number;
  gitPushes: number;
  /** Count of sub-execution transcripts on disk — the delegation count. */
  subExecutionCount: number;
  toolOriginCounts: Record<string, number>;
  toolApprovalOutcomes: Record<string, number>;
  maxContextUsagePercent: number;
  assistantResponseChars: number;
  attributionEvents: KiroAttributionEvent[];
  /** Credits billed inside sub-executions — real spend, on the parent's tab. */
  totalCredits: number;
  /** Vendor-measured working time inside sub-executions, in ms. */
  totalElapsedMs: number;
  turnUsage: TurnUsagePayload[];
  /**
   * Each child's turn-boundary timeline, concatenated file-by-file in the SAME
   * order its prompts are appended to `prompts` — so the k-th PROMPT_REFERENCE
   * here still corresponds to the k-th entry in `prompts`, the invariant the
   * caller's ordinal remap relies on. Without these, a SUBAGENT span carried no
   * child turn edges and a consumer could not segment delegated turns.
   */
  sessionEvents: SessionEvent[];
}

/**
 * Newest mtime and total size across the sub-execution transcripts, folded into
 * the session's dedup token. Returns zeroes when the directory is absent, so
 * the token is then the parent files' alone.
 */
function latestSubExecutionMtime(subExecDir: string): { mtimeMs: number; totalSize: number } {
  let mtimeMs = 0;
  let totalSize = 0;
  if (!existsSync(subExecDir)) return { mtimeMs, totalSize };
  let files: string[];
  try { files = readdirSync(subExecDir).filter((f) => f.endsWith(".jsonl")); } catch { return { mtimeMs, totalSize }; }
  for (const file of files) {
    try {
      const st = statSync(join(subExecDir, file));
      if (st.mtimeMs > mtimeMs) mtimeMs = st.mtimeMs;
      totalSize += st.size;
    } catch { /* vanished mid-scan */ }
  }
  return { mtimeMs, totalSize };
}

/**
 * Parse sub-execution JSONL files. These have the same message format but
 * represent delegated sub-agent work. Their metrics fold into the parent
 * session's (rather than becoming their own conversation rows), so the parent's
 * tool/file/error counts cover everything the session did.
 *
 * Sub-agent NAMES do not come from here — the filenames are opaque UUIDs. They
 * come from the parent's `sub_agent_start` events, which carry `subAgentName`
 * alongside the matching `subSessionId`.
 */
function parseSubExecutions(subExecDir: string): ParsedSubExecutions {
  const result: ParsedSubExecutions = {
    prompts: [],
    toolCounts: {},
    filesEdited: new Set<string>(),
    filesRead: new Set<string>(),
    composerSuggestedLines: 0,
    toolErrors: 0,
    toolRejections: 0,
    gitPushes: 0,
    subExecutionCount: 0,
    toolOriginCounts: {},
    toolApprovalOutcomes: {},
    maxContextUsagePercent: 0,
    assistantResponseChars: 0,
    attributionEvents: [],
    totalCredits: 0,
    totalElapsedMs: 0,
    turnUsage: [],
    sessionEvents: [],
  };

  if (!existsSync(subExecDir)) return result;

  let files: string[];
  try { files = readdirSync(subExecDir).filter((f) => f.endsWith(".jsonl")); } catch { return result; }

  for (const file of files) {
    const filePath = join(subExecDir, file);
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      const parsed = parseIdeMessages(lines);
      if (parsed.malformedLines > 0) {
        logger.warn("extraction.kiro", "ide_sub_execution_lines_malformed", {
          file: filePath,
          malformedLines: parsed.malformedLines,
        });
      }

      result.subExecutionCount++;
      for (const [tool, count] of Object.entries(parsed.toolCounts)) {
        result.toolCounts[tool] = (result.toolCounts[tool] ?? 0) + count;
      }
      for (const f of parsed.filesEdited) result.filesEdited.add(f);
      for (const f of parsed.filesRead) result.filesRead.add(f);
      result.composerSuggestedLines += parsed.composerSuggestedLines;
      result.toolErrors += parsed.toolErrors;
      result.toolRejections += parsed.toolRejections;
      result.gitPushes += parsed.gitPushes;
      // A Kiro sub-execution never becomes its own session, so its turns belong
      // to this conversation — without them, analysis reads only the parent's
      // narration of work the sub-agent actually did. Tagged rather than blended:
      // a sub-agent's task prompt is not a human ask, and nothing measuring the
      // human's side may count it.
      for (const p of parsed.prompts) {
        result.prompts.push({ ...p, metadata: { ...(p.metadata ?? {}), isSubAgent: true } });
      }
      // Accumulated in the SAME per-file order the prompts above are — so the k-th
      // PROMPT_REFERENCE across the concatenation still lines up with the k-th
      // prompt (both gated on the same content check inside parseIdeMessages).
      // The caller remaps each reference's parse-order ordinal to the merged
      // conversation position, exactly as it does for the parent's references.
      result.sessionEvents.push(...parsed.sessionEvents);
      result.assistantResponseChars += parsed.assistantResponseChars;
      // A sub-agent's usage_summary bills to this session; dropping it
      // under-reported the session's real credits and working time.
      result.totalCredits += parsed.totalCredits;
      result.totalElapsedMs += parsed.totalElapsedMs;
      result.turnUsage.push(...parsed.turnUsage);
      // A sub-agent can run the `git push` / `gh pr create` for the session, so
      // its command evidence counts. Its prose does not: a sub-execution has no
      // turn_end, so nothing in it is marked turn-final.
      for (const ev of parsed.attributionEvents) {
        if (ev.command) result.attributionEvents.push(ev);
      }
      for (const [origin, n] of Object.entries(parsed.toolOriginCounts)) {
        result.toolOriginCounts[origin] = (result.toolOriginCounts[origin] ?? 0) + n;
      }
      // Their rejections already reach tool_error_categories, so dropping the
      // outcome map showed rejected tools with no approvals to account for them.
      for (const [kind, n] of Object.entries(parsed.toolApprovalOutcomes)) {
        result.toolApprovalOutcomes[kind] = (result.toolApprovalOutcomes[kind] ?? 0) + n;
      }
      // Occupancy of one shared window, so the session peak is the highest any
      // execution reached — not a sum. A sub-agent that filled the context is the
      // case this exists to catch, and its credits already fold into the parent.
      if (parsed.maxContextUsagePercent > result.maxContextUsagePercent) {
        result.maxContextUsagePercent = parsed.maxContextUsagePercent;
      }
    } catch (err) {
      logger.warn("extraction.kiro", "ide_sub_execution_parse_failed", {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Builds the agent-mode config, or undefined when session.json reported none of
 * it. Each flag is copied only when actually present: Kiro omits these keys on
 * sessions that never touched the setting, and a written `false` would claim the
 * user turned it off.
 */
function buildAgenticSessionConfig(
  sessionJson: KiroIdeSessionJson,
): AgenticSessionConfigPayload | undefined {
  const config: AgenticSessionConfigPayload = {
    ...(sessionJson.status ? { status: sessionJson.status } : {}),
    ...(sessionJson.specWorkflow ? { spec_workflow: sessionJson.specWorkflow } : {}),
    ...(sessionJson.specPlanEnabled !== undefined
      ? { spec_plan_enabled: sessionJson.specPlanEnabled } : {}),
    ...(sessionJson.semanticReviewEnabled !== undefined
      ? { semantic_review_enabled: sessionJson.semanticReviewEnabled } : {}),
    ...(sessionJson.ftaEnabled !== undefined ? { fta_enabled: sessionJson.ftaEnabled } : {}),
  };
  return Object.keys(config).length > 0 ? config : undefined;
}

// ── Main extraction ───────────────────────────────────────────────────────────

/**
 * Extract Kiro IDE sessions from the new format at ~/.kiro/sessions/{hash}/sess_{uuid}/.
 * Skips the 'cli' subdirectory (handled by kiroCliExtractor).
 */
export function extractKiroIde(db: SessionSink, installMeta: InstallationMetadata): number {
  const sessionsRoot = getKiroIdeSessionsPath();
  if (!existsSync(sessionsRoot)) return 0;

  let workspaceHashDirs: string[];
  try {
    workspaceHashDirs = readdirSync(sessionsRoot).filter((d) => {
      // Skip 'cli' directory — handled by kiroCliExtractor
      if (d === "cli") return false;
      const fullPath = join(sessionsRoot, d);
      try { return statSync(fullPath).isDirectory(); } catch { return false; }
    });
  } catch { return 0; }

  let count = 0;

  for (const hashDir of workspaceHashDirs) {
    const workspaceDir = join(sessionsRoot, hashDir);
    let sessionDirs: string[];
    try {
      sessionDirs = readdirSync(workspaceDir).filter((d) => {
        if (!d.startsWith("sess_")) return false;
        try { return statSync(join(workspaceDir, d)).isDirectory(); } catch { return false; }
      });
    } catch { continue; }

    for (const sessionDir of sessionDirs) {
      const sessionPath = join(workspaceDir, sessionDir);
      try {
        const extracted = extractSingleIdeSession(db, sessionPath, installMeta);
        if (extracted) count++;
      } catch (err) {
        logger.warn("extraction.kiro", "ide_session_error", {
          sessionPath,
          error: err instanceof Error ? err.message : String(err),
        });
        reportRecordError(null, sessionPath, err);
      }
    }
  }

  return count;
}

/**
 * Extract a single Kiro IDE session from its directory.
 * Returns true if a session was upserted, false if skipped.
 */
function extractSingleIdeSession(
  db: SessionSink,
  sessionPath: string,
  installMeta: InstallationMetadata,
): boolean {
  const sessionJsonPath = join(sessionPath, "session.json");
  const messagesJsonlPath = join(sessionPath, "messages.jsonl");

  // Both files must exist for a valid session
  if (!existsSync(sessionJsonPath) || !existsSync(messagesJsonlPath)) return false;

  const msgStat = statSync(messagesJsonlPath);
  const sessionStat = statSync(sessionJsonPath);

  // Dedup token. It must cover the sub-executions too: a sub-agent transcript can
  // be created or appended AFTER the parent's last write, and a token built only
  // from session.json + messages.jsonl would then be unchanged, so the next poll
  // takes the fast path and that sub-agent's tools, files and errors are dropped
  // permanently rather than merely late.
  const subExecDir = join(sessionPath, "sub-executions");
  const subExecStamp = latestSubExecutionMtime(subExecDir);
  const effectiveMtime = Math.max(sessionStat.mtimeMs, msgStat.mtimeMs, subExecStamp.mtimeMs);
  // Size is summed rather than taken from messages.jsonl alone, so a sub-execution
  // that grows without changing mtime granularity still moves the token.
  const effectiveSize = msgStat.size + subExecStamp.totalSize;

  // Read session.json for metadata
  const sessionJson = JSON.parse(readFileSync(sessionJsonPath, "utf-8")) as KiroIdeSessionJson;
  // basename, not split("/") — pathResolver builds Windows paths too, where a
  // slash split yields the whole path and every session collapses to one rowId.
  const sessionId = sessionJson.id ?? basename(sessionPath) ?? "unknown";
  const rowId = `kiro-ide:${sessionId}`;

  // Dedup check
  const tracking = db.getTracking("kiro", rowId);
  if (tracking?.last_mtime_ms === effectiveMtime && tracking?.last_size === effectiveSize) {
    return false;
  }

  // Parse messages.jsonl
  const messagesContent = readFileSync(messagesJsonlPath, "utf-8");
  const messageLines = messagesContent.trim().split("\n").filter(Boolean);
  const parsed = parseIdeMessages(messageLines);
  if (parsed.malformedLines > 0) {
    logger.warn("extraction.kiro", "ide_transcript_lines_malformed", {
      file: messagesJsonlPath,
      malformedLines: parsed.malformedLines,
    });
  }

  // Skip sessions with no user messages
  const userPrompts = parsed.prompts.filter((p) => p.role === "user");
  if (userPrompts.length === 0) return false;

  const subExec = parseSubExecutions(subExecDir);

  // Merge sub-execution signals into the main session
  const mergedToolCounts = { ...parsed.toolCounts };
  for (const [tool, count] of Object.entries(subExec.toolCounts)) {
    mergedToolCounts[tool] = (mergedToolCounts[tool] ?? 0) + count;
  }
  const mergedFilesEdited = new Set([...parsed.filesEdited, ...subExec.filesEdited]);
  const mergedFilesRead = new Set([...parsed.filesRead, ...subExec.filesRead]);
  const totalComposerSuggestedLines = parsed.composerSuggestedLines + subExec.composerSuggestedLines;
  const totalToolErrors = parsed.toolErrors + subExec.toolErrors;
  const totalToolRejections = parsed.toolRejections + subExec.toolRejections;
  const totalGitPushes = parsed.gitPushes + subExec.gitPushes;
  const totalAssistantChars = parsed.assistantResponseChars + subExec.assistantResponseChars;
  // Interleaved by timestamp so the delegated turns sit where they happened,
  // rather than as a block appended after the parent's closing summary. An entry
  // without a timestamp sorts at the time of the entry before it in its own
  // transcript (the start, if none), so it stays next to it and the comparator
  // is a total order; the sort is stable, so ties keep transcript order.
  const withSortTime = (list: ConversationPrompt[]): Array<{ prompt: ConversationPrompt; at: number }> => {
    let last = Number.NEGATIVE_INFINITY;
    return list.map((prompt) => {
      const own = prompt.timestamp ? Date.parse(prompt.timestamp) : Number.NaN;
      if (Number.isFinite(own)) last = own;
      return { prompt, at: last };
    });
  };
  const conversationPrompts = [...withSortTime(parsed.prompts), ...withSortTime(subExec.prompts)]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((e) => e.prompt);

  // A PROMPT_REFERENCE's ordinal must index the STORED conversation, but the
  // timeline is built during the parent walk — before sub-execution prompts are
  // merged and sorted in, which shifts every parent prompt's position. The k-th
  // PROMPT_REFERENCE was emitted for the k-th parent prompt (push order == parsed.
  // prompts order), so remap it to that prompt's index in the merged list. The
  // objects are identical through the sort, and redactPrompts preserves order, so
  // the position holds in the stored row. Parse-order fallback if a prompt is somehow absent.
  const ordinalByPrompt = new Map<ConversationPrompt, number>();
  conversationPrompts.forEach((prompt, i) => ordinalByPrompt.set(prompt, i + 1));
  let parentPromptRefIdx = 0;
  for (const ev of parsed.sessionEvents) {
    if (ev.kind !== "SESSION_EVENT_KIND_PROMPT_REFERENCE") continue;
    const parentPrompt = parsed.prompts[parentPromptRefIdx++];
    const ordinal = parentPrompt ? ordinalByPrompt.get(parentPrompt) : undefined;
    if (ordinal !== undefined) ev.prompt_ordinal = ordinal;
  }
  // The identical remap for the delegated children: the k-th child PROMPT_REFERENCE
  // was emitted for the k-th child prompt (parseSubExecutions concatenates both in
  // lockstep), and those prompt objects went into the merged list unchanged, so
  // ordinalByPrompt resolves each to its position among the parent's turns. Without
  // this a child reference would keep its per-child parse-order ordinal — pointing
  // at the wrong prompt (usually a parent's) in the stored conversation.
  let childPromptRefIdx = 0;
  for (const ev of subExec.sessionEvents) {
    if (ev.kind !== "SESSION_EVENT_KIND_PROMPT_REFERENCE") continue;
    const childPrompt = subExec.prompts[childPromptRefIdx++];
    const ordinal = childPrompt ? ordinalByPrompt.get(childPrompt) : undefined;
    if (ordinal !== undefined) ev.prompt_ordinal = ordinal;
  }

  // The stored timeline is the parent's turn edges plus the delegated children's,
  // so a SUBAGENT span carries the child turn boundaries a consumer segments on.
  // Children are appended after the parent (not timestamp-interleaved): a consumer
  // associates a typed event with the next PROMPT_REFERENCE at or after it BY
  // `sequence`, and each parser starts `sequence` at 1,
  // so a child's edges must be rebased past the parent's to keep a child's typed
  // events anchoring to a child reference rather than a colliding parent one. The
  // reference→prompt mapping is already carried by the remapped `prompt_ordinal`
  // above, independent of array order. Parent events keep their order and sequences
  // untouched — a session with no sub-executions serializes exactly as before.
  const conversationSessionEvents = subExec.sessionEvents.length > 0
    ? [...parsed.sessionEvents, ...subExec.sessionEvents]
    : parsed.sessionEvents;
  if (subExec.sessionEvents.length > 0) {
    // parseIdeMessages assigns dense sequences 1..N in array order, so the parent
    // block already reads 1..N; continue the counter into the child block.
    const parentSeqEnd = parsed.sessionEvents.length;
    subExec.sessionEvents.forEach((ev, i) => {
      ev.sequence = parentSeqEnd + i + 1;
    });
  }

  // authorship for Kiro: a folded sub-execution turn (isSubAgent) is INJECTED, a genuine user
  // turn is HUMAN, an assistant turn stays UNSPECIFIED. Kiro's typed stream never launders
  // slash-commands or tool output into a user turn, so (role, isSubAgent) is the whole signal —
  // computed here over the merged list rather than at each build site.
  for (const p of conversationPrompts) {
    const authorship = promptAuthorship(p);
    if (authorship !== "PROMPT_AUTHORSHIP_UNSPECIFIED") {
      p.metadata = { ...(p.metadata ?? {}), authorship };
    }
  }

  const maxContextPercent = Math.max(parsed.maxContextUsagePercent, subExec.maxContextUsagePercent);
  const mergedToolApprovalOutcomes = { ...parsed.toolApprovalOutcomes };
  for (const [kind, n] of Object.entries(subExec.toolApprovalOutcomes)) {
    mergedToolApprovalOutcomes[kind] = (mergedToolApprovalOutcomes[kind] ?? 0) + n;
  }
  const mergedToolOriginCounts = { ...parsed.toolOriginCounts };
  for (const [origin, n] of Object.entries(subExec.toolOriginCounts)) {
    mergedToolOriginCounts[origin] = (mergedToolOriginCounts[origin] ?? 0) + n;
  }
  // Kiro tags built-in tools "default"; anything else came from an ACP peer.
  const builtinToolUses = mergedToolOriginCounts["default"] ?? 0;
  // Vendor-measured working time, as opposed to the wall-clock session span.
  const agentActiveSeconds = (parsed.totalElapsedMs + subExec.totalElapsedMs) / 1000;
  const totalCredits = parsed.totalCredits + subExec.totalCredits;
  // Kiro IDE records one model per session in session.json; apply it to every
  // prompt the way kiroCliExtractor does, so IDE rows are not model-blind.
  // "auto" is Kiro's router alias and is stored verbatim — it is what the user
  // actually selected, and inventing a concrete model here would be a guess.
  const sessionModel = sessionJson.modelId?.trim();

  // Stamped here, not in the parser: the model is a session-level setting from
  // session.json, which parseIdeMessages never sees. Every turn ran under it —
  // Kiro has no per-turn model switch — so this matches the CLI's per-turn model
  // rather than leaving IDE turn_usage model-blind.
  const allTurnUsage = [...parsed.turnUsage, ...subExec.turnUsage].map((t) =>
    sessionModel && t.model === undefined ? { ...t, model: sessionModel } : t,
  );

  // Resolve workspace path from session metadata
  const workspacePath = sessionJson.workspacePaths?.[0] ?? null;

  // A session delegated work if the parent announced a sub-agent OR a
  // sub-execution transcript exists (older sessions predate sub_agent_start).
  const usesSubAgent = parsed.subAgentNames.length > 0 || subExec.subExecutionCount > 0;

  // Timestamps
  const createdMs = dateMs(sessionJson.createdAt, sessionStat.birthtimeMs);
  const updatedMs = dateMs(sessionJson.lastModifiedAt, effectiveMtime);
  // The git/PR LOOKUP window ends later than the session does when a sub-execution
  // was written after the parent's last save: that late work has commits and PRs
  // the declared end would exclude. Kept separate from updatedAt on purpose —
  // updatedAt is the session's own span and feeds duration, which must stay the
  // vendor's declared time rather than drifting to whenever a file was touched.
  const lookupEnd = Math.max(updatedMs ?? effectiveMtime, effectiveMtime);
  const durationSeconds = spanSeconds(createdMs, updatedMs);

  // Git metrics from the workspace
  const gitMetrics = workspacePath && createdMs !== undefined
    ? getFullSessionDiffStats(workspacePath, createdMs, lookupEnd)
    : { linesAdded: 0, linesRemoved: 0, filesModified: 0, gitCommits: 0 };

  // Workspace artifacts
  const artifacts = workspacePath ? countWorkspaceArtifacts(workspacePath) : { specCount: 0, steeringFileCount: 0, hookCount: 0 };
  // Called even without a workspace: `~/.kiro/settings/mcp.json` applies to every
  // session regardless, so skipping the reader hid a user's global servers on any
  // session whose session.json carries no workspacePaths.
  const mcpServers = readKiroMcpServers(workspacePath ?? undefined);

  // Web tool detection
  const { usesWebSearch, usesWebFetch } = inferWebToolUsage(mergedToolCounts);

  // Languages from edited files
  const languages = mergedFilesEdited.size > 0 ? getLanguagesFromFiles(mergedFilesEdited) : undefined;

  if (sessionModel) {
    // Over the merged list, so delegated turns carry it too — the sub-agent ran
    // under the same session model.
    for (const p of conversationPrompts) {
      p.metadata = { ...(p.metadata ?? {}), model: sessionModel } satisfies PromptMetadata;
    }
  }

  // Branch/PR evidence the session itself produced — the transcript is the only
  // session-time source. The checkout's HEAD is whatever the developer moved on
  // to by the next scan, so it is not offered as branch evidence (see
  // buildSharedSessionFields).
  // The walk is bounded by the session's DECLARED span, never lookupEnd: that is
  // deliberately wider (it reaches a late sub-execution's commits), and a checkout
  // made after the last message but before the poll is exactly the drift this
  // replaces — admitting it would survive inside a bound that looks time-bounded.
  const recovered = mergeWindowedBranches(
    collectKiroAttribution(
      [...parsed.attributionEvents, ...subExec.attributionEvents],
      resolveProjectAndRepo(workspacePath ?? undefined, [])?.repoName,
    ),
    workspacePath
      ? recoverWindowedBranches(workspacePath, createdMs ?? Number.NaN, updatedMs ?? Number.NaN)
      : [],
  );

  // Build session meta
  const sessionMeta: SessionMetaPayload = {
    ...buildSharedSessionFields({
      projectPath: workspacePath,
      artifacts,
      mcpServers,
      prLink: workspacePath && createdMs !== undefined ? getSessionPRLink(workspacePath, createdMs, lookupEnd) : null,
      usesWebSearch,
      usesWebFetch,
      languages,
      firstPrompt: userPrompts[0]?.content,
      lastPrompt: userPrompts[userPrompts.length - 1]?.content,
    }),
    // Distinct from the older Kiro format's "kiro" so the two IDE formats stay
    // separable downstream.
    source: "kiro-ide",
    session_title: sessionJson.title,
    session_duration_seconds: durationSeconds,
    duration_minutes: durationSeconds !== undefined && durationSeconds > 0 ? durationSeconds / 60 : undefined,
    // Parent-only, though the conversation now carries delegated turns too: a
    // sub-agent's task prompt is the main agent talking to itself, not the human
    // prompting again, and counting it would inflate every per-prompt rate.
    user_message_count: userPrompts.length,
    // Folded, unlike the user count — these are model output, the same reason
    // assistant_response_chars and the sub-agent's credits already fold in.
    assistant_message_count: conversationPrompts.filter((p) => p.role === "assistant").length,
    agent_mode: normalizeAgentMode(sessionJson.agentMode),
    // Only reported when session.json actually carries the flag. Kiro omits it
    // on sessions that never touched autopilot, and defaulting an absent field
    // to "supervised" would publish a supervision level nobody observed.
    autonomy_mode: sessionJson.autopilot === undefined
      ? undefined
      : normalizeAutonomyMode(sessionJson.autopilot ? "autopilot" : "supervised"),
    tool_counts: Object.keys(mergedToolCounts).length > 0 ? mergedToolCounts : undefined,
    tool_errors: totalToolErrors || undefined,
    // A denied tool is a distinct failure mode from one that ran and errored,
    // so it is categorised rather than folded into tool_errors.
    tool_error_categories: totalToolRejections > 0 ? { tool_rejected: totalToolRejections } : undefined,
    user_interruptions: parsed.userInterruptions || undefined,
    billing_credits_used: totalCredits > 0 ? totalCredits : undefined,
    ide_context_usage_percent: maxContextPercent > 0 ? maxContextPercent : undefined,
    files_edited: mergedFilesEdited.size > 0 ? Array.from(mergedFilesEdited).map(redactPath) : undefined,
    files_modified: mergedFilesEdited.size > 0 ? mergedFilesEdited.size : undefined,
    tracked_file_paths: mergedFilesRead.size > 0 ? Array.from(mergedFilesRead).map(redactPath) : undefined,
    uses_task_agent: usesSubAgent || undefined,
    spawned_agent_names: parsed.subAgentNames.length > 0 ? parsed.subAgentNames : undefined,
    // Timing signals
    user_message_timestamps: parsed.userMessageTimestamps.length > 0 ? parsed.userMessageTimestamps : undefined,
    message_hours: parsed.messageHours.length > 0 ? parsed.messageHours : undefined,
    user_response_times: parsed.userResponseTimes.length > 0 ? parsed.userResponseTimes : undefined,
    // ── Agentic session detail ────────────────────────────────────────────────
    // The surface-qualified session key ("kiro-ide:<vendor id>"), the
    // same value as the row's session_id. Carried inside session_meta so a
    // reader holding only the meta blob can identify the session, and so IDE and
    // CLI ids stay distinguishable from each other in one field.
    kiro_id: rowId,
    tool_approval_outcomes: Object.keys(mergedToolApprovalOutcomes).length > 0
      ? mergedToolApprovalOutcomes
      : undefined,
    agent_active_seconds: agentActiveSeconds > 0 ? agentActiveSeconds : undefined,
    turn_usage: allTurnUsage.length > 0 ? allTurnUsage : undefined,
    sub_agent_runs: parsed.subAgentRuns.length > 0 ? parsed.subAgentRuns : undefined,
    user_prompt_chars: parsed.userPromptChars || undefined,
    assistant_response_chars: totalAssistantChars || undefined,
    builtin_tool_uses: builtinToolUses || undefined,
    tool_origin_counts: Object.keys(mergedToolOriginCounts).length > 0
      ? mergedToolOriginCounts
      : undefined,
    agentic_session_config: buildAgenticSessionConfig(sessionJson),
  };

  // Git metrics
  if (gitMetrics.linesAdded > 0) sessionMeta.lines_added = gitMetrics.linesAdded;
  if (gitMetrics.linesRemoved > 0) sessionMeta.lines_removed = gitMetrics.linesRemoved;
  if (!sessionMeta.files_modified && gitMetrics.filesModified > 0) sessionMeta.files_modified = gitMetrics.filesModified;
  if (gitMetrics.gitCommits > 0) sessionMeta.git_commits = gitMetrics.gitCommits;
  // A push leaves no trace in local history, so the shell transcript is the only
  // source; commits stay git-derived because the diff window counts them exactly.
  if (totalGitPushes > 0) sessionMeta.git_pushes = totalGitPushes;
  applyRecoveredBranches(sessionMeta, recovered);
  mergeRecoveredPRRefs(sessionMeta, recovered.prReferences);
  if (workspacePath) {
    const headSha = getGitHeadSha(workspacePath);
    if (headSha) sessionMeta.git_sha = headSha;
  }

  // AI attribution
  const aiAttribution: AiAttributionMetrics = {};
  if (totalComposerSuggestedLines > 0) {
    aiAttribution.composer_suggested_lines = totalComposerSuggestedLines;
  }

  // Resolve project/repo
  const resolved = resolveProjectAndRepo(workspacePath ?? undefined, []);

  db.upsert({
    ideType: "kiro",
    sessionId: rowId,
    conversation: redactPrompts(conversationPrompts),
    projectPath: workspacePath ? redactPath(workspacePath) : undefined,
    repoName: resolved?.repoName,
    lastMtimeMs: effectiveMtime,
    lastSize: effectiveSize,
    lastOffset: 0,
    conversationSourceCreatedAtMs: createdMs,
    sessionMeta: JSON.stringify(sanitizeSessionMeta(sessionMeta)),
    // "kiro-ide" — the older Kiro format keeps "kiro-desktop", so an
    // row can be attributed to the format it actually came from.
    installationMetadata: JSON.stringify({ ...installMeta, entrypoint: "kiro-ide" }),
    aiAttribution: Object.keys(aiAttribution).length > 0 ? JSON.stringify(aiAttribution) : undefined,
    // Omitted when empty so a session with nothing observed is absent rather than
    // an empty array — a consumer reads either as coverage NONE. Parent turn edges
    // plus the delegated children's, so a SUBAGENT span is segmentable.
    sessionEvents: conversationSessionEvents.length > 0 ? JSON.stringify(conversationSessionEvents) : undefined,
    eventCoverage: parsed.eventCoverage,
  });

  return true;
}
