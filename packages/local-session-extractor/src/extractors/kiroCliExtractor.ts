// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import type {
  AiAttributionMetrics,
  ConversationPrompt,
  InstallationMetadata,
  SessionMetaPayload,
  TurnUsagePayload,
} from "../types/session";
import type { SessionSink } from "../types/store";
import { redactPrompts, redactPath, sanitizeSessionMeta } from "../redaction";
import { resolveProjectAndRepo, getGitHeadSha, getSessionPRLink, getFullSessionDiffStats, recoverWindowedBranches } from "./gitUtils";
import { dateMs, spanSeconds } from "./dateMs";
import { getKiroCliSessionsPath } from "./pathResolver";
import { logger } from "../seams/logger";
import { reportRecordError } from "../seams/scanScope";
import { collectKiroAttribution, mergeWindowedBranches, type KiroAttributionEvent } from "./kiroAttribution";
import {
  commandPushesToGit,
  toolProvider,
  applyRecoveredBranches,
  mergeRecoveredPRRefs,
  getLanguagesFromFiles,
  inferWebToolUsage,
  countWorkspaceArtifacts,
  readKiroMcpServers,
  buildSharedSessionFields,
} from "./kiroExtractor";
import type {
  KiroCliSessionJson,
  KiroUserTurnMetadata,
  CliJsonlLine,
  ParsedCliContent,
} from "./kiroExtractor";

// ── CLI JSONL parsing ─────────────────────────────────────────────────────────

// Returns the AI-suggested line count for one tool block (feeds
// composer_suggested_lines) and records the touched file. lines_added/removed are
// derived from the real git diff (see extractKiroCli), not these per-write counts.
function processToolUseBlock(
  tu: { name?: string; input?: Record<string, unknown> } | undefined,
  toolCounts: Record<string, number>,
  filesEdited: Set<string>,
): number {
  if (!tu) return 0;

  const toolName = tu.name ?? "unknown";
  toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;

  if (toolName === "write" && typeof tu.input?.path === "string") {
    filesEdited.add(tu.input.path);
    const content = (tu.input.content as string | undefined) ?? "";
    return content.split("\n").length;
  }

  if (toolName === "str_replace" && typeof tu.input?.path === "string") {
    filesEdited.add(tu.input.path);
    const newStr = (tu.input.new_str as string | undefined) ?? "";
    const oldStr = (tu.input.old_str as string | undefined) ?? "";
    const added = newStr.split("\n").length - oldStr.split("\n").length;
    return added > 0 ? added : 0;
  }

  return 0;
}

/**
 * Joins a CLI toolResult's text blocks into one string — that is where a
 * `gh pr create` prints the PR URL. Its `content` is an array of
 * `{ kind, data }`; only `text` blocks carry command output.
 */
function toolResultText(data: unknown): string | undefined {
  const content = (data as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content as Array<{ kind?: string; data?: unknown }>) {
    if (block?.kind === "text" && typeof block.data === "string") parts.push(block.data);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function parseCliJsonl(lines: string[]): ParsedCliContent {
  const prompts: ConversationPrompt[] = [];
  const toolCounts: Record<string, number> = {};
  const toolOriginCounts: Record<string, number> = {};
  const filesEdited = new Set<string>();
  const filesRead = new Set<string>();
  const userPromptTimestampsMs: number[] = [];
  let toolErrors = 0;
  let composerSuggestedLines = 0;
  let lastPrompt: string | undefined;
  let usesExtendedThinking = false;
  let gitPushes = 0;
  // toolUseId → shell command, resolved against the ToolResults status so only a
  // push that actually succeeded is counted. The CLI names the tool `shell`
  // (the IDE calls the same thing `execute_bash`).
  const pendingShellCommands = new Map<string, string>();
  const attributionEvents: KiroAttributionEvent[] = [];
  // Index of the most recent assistant message. A CLI turn ends where the next
  // Prompt begins, so that message is the turn's closing prose.
  let lastAssistantEventIdx: number | null = null;

  for (const line of lines) {
    try {
      const msg = JSON.parse(line) as CliJsonlLine;
      if (!msg.kind || !Array.isArray(msg.data?.content)) continue;

      const blocks = msg.data.content;

      if (msg.kind === "Prompt") {
        const text = blocks
          .filter((b) => b.kind === "text")
          .map((b) => (b.data as string | undefined) ?? "")
          .join("\n")
          .trim();
        if (text) {
          // meta.timestamp is epoch seconds; the rest of the pipeline works in millis.
          const tsSeconds = msg.data.meta?.timestamp;
          const timestampMs = typeof tsSeconds === "number" && Number.isFinite(tsSeconds)
            ? tsSeconds * 1000
            : undefined;
          prompts.push({
            role: "user",
            content: text,
            ...(timestampMs !== undefined ? { timestamp: new Date(timestampMs).toISOString() } : {}),
          });
          if (timestampMs !== undefined) userPromptTimestampsMs.push(timestampMs);
          lastPrompt = text;
          // A new prompt ends the previous turn, so the assistant message before
          // it was that turn's closing prose.
          if (lastAssistantEventIdx !== null) {
            attributionEvents[lastAssistantEventIdx]!.isTurnFinal = true;
            lastAssistantEventIdx = null;
          }
        }
      } else if (msg.kind === "AssistantMessage") {
        const textParts: string[] = [];
        for (const block of blocks) {
          if (block.kind === "text") {
            const t = (block.data as string | undefined) ?? "";
            if (t) textParts.push(t);
          } else if (block.kind === "thinking") {
            usesExtendedThinking = true;
          } else if (block.kind === "toolUse") {
            const tu = block.data as
              { name?: string; toolUseId?: string; input?: Record<string, unknown> } | undefined;
            composerSuggestedLines += processToolUseBlock(tu, toolCounts, filesEdited);
            // Which plugin/MCP server served this call, if any. Recorded on the
            // session — a Kiro plugin runs inside it, never as its own session.
            const provider = toolProvider(tu?.name ?? "unknown");
            toolOriginCounts[provider] = (toolOriginCounts[provider] ?? 0) + 1;

            // `read` carries operations: [{ mode, path, offset?, limit? }].
            if (tu?.name === "read" && Array.isArray(tu.input?.operations)) {
              for (const op of tu.input.operations as Array<{ path?: unknown }>) {
                if (op && typeof op.path === "string") filesRead.add(op.path);
              }
            }
            if (tu?.name === "shell" && typeof tu.input?.command === "string" && tu.toolUseId) {
              pendingShellCommands.set(tu.toolUseId, tu.input.command);
            }
          }
        }
        const text = textParts.join("").trim();
        if (text) {
          prompts.push({ role: "assistant", content: text });
          lastAssistantEventIdx = attributionEvents.length;
          attributionEvents.push({ text });
        }
      } else if (msg.kind === "ToolResults") {
        for (const block of blocks) {
          if (block.kind === "toolResult") {
            const tr = block.data as { status?: string; toolUseId?: string } | undefined;
            if (tr?.status === "error") toolErrors++;
            if (tr?.toolUseId) {
              const command = pendingShellCommands.get(tr.toolUseId);
              if (command !== undefined) {
                pendingShellCommands.delete(tr.toolUseId);
                if (tr.status === "success" && commandPushesToGit(command)) gitPushes++;
                const output = toolResultText(block.data);
                attributionEvents.push({
                  command,
                  ...(output ? { output } : {}),
                  ok: tr.status === "success",
                });
              }
            }
          }
        }
      }
    } catch { /* skip malformed lines */ }
  }

  // The transcript ends without a following Prompt, so the final assistant
  // message closes the last turn and is summary-eligible.
  if (lastAssistantEventIdx !== null) {
    attributionEvents[lastAssistantEventIdx]!.isTurnFinal = true;
  }

  return {
    prompts, toolCounts, toolErrors, filesEdited, composerSuggestedLines, lastPrompt,
    userPromptTimestampsMs, usesExtendedThinking, filesRead, gitPushes, attributionEvents,
    toolOriginCounts,
  };
}

/**
 * Derives the timing signals from the two independent clocks the CLI records:
 * per-prompt `meta.timestamp` (when the user sent) and per-turn `end_timestamp`
 * (when the assistant finished). A response time is the gap from the most recent
 * turn that ended BEFORE a prompt to that prompt — the same "assistant finished →
 * user replied" definition the other extractors use.
 */
function deriveCliTiming(
  userPromptTimestampsMs: number[],
  turns: KiroUserTurnMetadata[],
): { userMessageTimestamps: string[]; messageHours: number[]; userResponseTimes: number[] } {
  const userMessageTimestamps = userPromptTimestampsMs.map((ms) => new Date(ms).toISOString());
  const messageHours = userPromptTimestampsMs.map((ms) => new Date(ms).getUTCHours());

  const turnEndsMs = turns
    .map((t) => (t.end_timestamp ? new Date(t.end_timestamp).getTime() : NaN))
    .filter((ms) => !isNaN(ms))
    .sort((a, b) => a - b);

  const userResponseTimes: number[] = [];
  for (const promptMs of userPromptTimestampsMs) {
    // Latest turn end strictly before this prompt.
    let precedingEnd: number | undefined;
    for (const endMs of turnEndsMs) {
      if (endMs >= promptMs) break;
      precedingEnd = endMs;
    }
    if (precedingEnd === undefined) continue;
    const gap = Math.round((promptMs - precedingEnd) / 1000);
    // Same 24h ceiling the IDE path uses: a longer gap is a new working session,
    // not a response time, and would skew the average.
    if (gap >= 0 && gap < 86400) userResponseTimes.push(gap);
  }

  return { userMessageTimestamps, messageHours, userResponseTimes };
}

// ── CLI session extraction ────────────────────────────────────────────────────

function aggregateTurnStats(turns: KiroUserTurnMetadata[]): {
  totalCredits: number; totalCycles: number; totalRequests: number;
  totalInputTokens: number; totalOutputTokens: number;
  totalAttempts: number; totalBuiltinToolUses: number;
  activeSeconds: number;
  userPromptChars: number; assistantResponseChars: number;
} {
  return {
    totalCredits: turns.flatMap((t) => t.metering_usage ?? []).reduce((s, u) => s + (u.value ?? 0), 0),
    totalCycles: turns.reduce((s, t) => s + (t.number_of_cycles ?? 0), 0),
    totalRequests: turns.reduce((s, t) => s + (t.total_request_count ?? 0), 0),
    totalInputTokens: turns.reduce((s, t) => s + (t.input_token_count ?? 0), 0),
    totalOutputTokens: turns.reduce((s, t) => s + (t.output_token_count ?? 0), 0),
    totalAttempts: turns.reduce((s, t) => s + (t.request_attempts ?? 0), 0),
    totalBuiltinToolUses: turns.reduce((s, t) => s + (t.builtin_tool_uses ?? 0), 0),
    activeSeconds: turns.reduce((s, t) => s + turnDurationSeconds(t), 0),
    userPromptChars: turns.reduce((s, t) => s + (t.user_prompt_length ?? 0), 0),
    assistantResponseChars: turns.reduce((s, t) => s + (t.assistant_response_length ?? 0), 0),
  };
}

/** turn_duration is a Rust Duration split into whole secs plus nanos. */
function turnDurationSeconds(turn: KiroUserTurnMetadata): number {
  const secs = turn.turn_duration?.secs ?? 0;
  const nanos = turn.turn_duration?.nanos ?? 0;
  return secs + nanos / 1_000_000_000;
}

/** Per-turn metering, one entry per user turn, in the order Kiro recorded them. */
function buildTurnUsage(turns: KiroUserTurnMetadata[]): TurnUsagePayload[] {
  return turns.map((t) => {
    const credits = (t.metering_usage ?? []).reduce((s, u) => s + (u.value ?? 0), 0);
    const activeSeconds = turnDurationSeconds(t);
    return {
      ...(credits > 0 ? { credits } : {}),
      ...(t.turn_duration !== undefined ? { active_seconds: activeSeconds } : {}),
      ...(t.context_usage_percentage !== undefined
        ? { context_usage_percent: t.context_usage_percentage } : {}),
      ...(t.end_reason ? { end_reason: t.end_reason } : {}),
      ...(t.model ? { model: t.model } : {}),
    };
  });
}

function extractSubAgentNames(turns: KiroUserTurnMetadata[]): string[] {
  const names: string[] = [];
  for (const t of turns) {
    const name = t.loop_id?.agent_id?.name;
    if (name && t.loop_id?.agent_id?.parent_id !== null && !names.includes(name)) names.push(name);
  }
  return names;
}

export function extractKiroCli(db: SessionSink, installMeta: InstallationMetadata | null): number {
  const sessionsDir = getKiroCliSessionsPath();
  if (!existsSync(sessionsDir)) return 0;

  let files: string[];
  try { files = readdirSync(sessionsDir).filter((f) => f.endsWith(".json")); } catch { return 0; }

  let count = 0;
  for (const file of files) {
    const sessionId = file.replace(".json", "");
    const jsonPath = join(sessionsDir, file);
    const jsonlPath = join(sessionsDir, `${sessionId}.jsonl`);

    try {
      const st = statSync(jsonPath);
      // The sibling .jsonl is the turn transcript, read whole below.
      let jsonlSize: number | undefined;
      try {
        jsonlSize = statSync(jsonlPath).size;
      } catch {
        // No .jsonl sibling for this session.
      }
      const rowId = `kiro-cli:${sessionId}`;

      const tracking = db.getTracking("kiro", rowId);
      if (tracking?.last_mtime_ms === st.mtimeMs && tracking?.last_size === st.size) continue;

      const sessionJson = JSON.parse(readFileSync(jsonPath, "utf-8")) as KiroCliSessionJson;
      const jsonlLines =
        jsonlSize !== undefined ? readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean) : [];

      const parsed = parseCliJsonl(jsonlLines);
      if (parsed.prompts.filter((p) => p.role === "user").length === 0) continue;

      const turns = sessionJson.session_state?.conversation_metadata?.user_turn_metadatas ?? [];
      const turnStats = aggregateTurnStats(turns);
      const subAgentNames = extractSubAgentNames(turns);
      // sub-agent detection: any turn with a non-null parent_id
      const usesSubAgent = turns.some((t) => (t.loop_id?.agent_id?.parent_id ?? null) !== null);

      const contextPct = sessionJson.session_state?.rts_model_state?.context_usage_percentage;
      const contextWindow = sessionJson.session_state?.rts_model_state?.model_info?.context_window_tokens;
      const sessionModel = sessionJson.session_state?.rts_model_state?.model_info?.model_id;
      const perms = sessionJson.session_state?.permissions;
      const agentName = sessionJson.session_state?.agent_name;

      const timing = deriveCliTiming(parsed.userPromptTimestampsMs, turns);
      // A denied tool is a distinct failure mode from one that ran and errored;
      // it is a category within tool_errors, matching the Codex breakdown.
      const toolRejections = turns.filter((t) => t.end_reason === "ToolUseRejected").length;

      // Apply session-level model to all prompts (CLI has one model per session)
      if (sessionModel) {
        for (const p of parsed.prompts) { p.metadata = { ...(p.metadata ?? {}), model: sessionModel }; }
      }

      const createdMs = dateMs(sessionJson.created_at);
      const updatedMs = dateMs(sessionJson.updated_at);
      const durationSeconds = spanSeconds(createdMs, updatedMs);
      const cwd = sessionJson.cwd ?? undefined;
      const { usesWebSearch, usesWebFetch } = inferWebToolUsage(parsed.toolCounts);

      // lines_added/removed come from the real git diff over the session window,
      // like the other extractors — the per-write tool counts (kept below for
      // composer_suggested_lines) re-count the whole file and over-state edits.
      const diff = cwd && createdMs !== undefined && updatedMs !== undefined
        ? getFullSessionDiffStats(cwd, createdMs, updatedMs)
        : undefined;

      const sessionMeta: SessionMetaPayload = {
        ...buildSharedSessionFields({
          projectPath: cwd,
          artifacts: cwd ? countWorkspaceArtifacts(cwd) : { specCount: 0, steeringFileCount: 0, hookCount: 0 },
          // Unconditional: `~/.kiro/settings/mcp.json` applies to every session,
          // so gating the whole reader on a workspace hid a user's global servers
          // on any session without a cwd. The reader adds workspace servers only
          // when there is one.
          mcpServers: readKiroMcpServers(cwd ?? undefined),
          prLink: cwd && createdMs !== undefined && updatedMs !== undefined ? getSessionPRLink(cwd, createdMs, updatedMs) : null,
          usesWebSearch,
          usesWebFetch,
          languages: parsed.filesEdited.size > 0 ? getLanguagesFromFiles(parsed.filesEdited) : undefined,
          firstPrompt: parsed.prompts.find((p) => p.role === "user")?.content,
          lastPrompt: parsed.lastPrompt,
        }),
        source: "kiro-cli",
        session_title: sessionJson.title,
        session_duration_seconds: durationSeconds,
        duration_minutes: durationSeconds !== undefined && durationSeconds > 0 ? durationSeconds / 60 : undefined,
        user_message_count: parsed.prompts.filter((p) => p.role === "user").length,
        assistant_message_count: parsed.prompts.filter((p) => p.role === "assistant").length,
        tool_counts: Object.keys(parsed.toolCounts).length > 0 ? parsed.toolCounts : undefined,
        tool_errors: parsed.toolErrors || undefined,
        tool_error_categories: toolRejections > 0 ? { tool_rejected: toolRejections } : undefined,
        uses_extended_thinking: parsed.usesExtendedThinking || undefined,
        // Timing — the CLI records both clocks, so these need no synthetic spread.
        user_message_timestamps: timing.userMessageTimestamps.length > 0 ? timing.userMessageTimestamps : undefined,
        message_hours: timing.messageHours.length > 0 ? timing.messageHours : undefined,
        user_response_times: timing.userResponseTimes.length > 0 ? timing.userResponseTimes : undefined,
        files_modified: parsed.filesEdited.size || undefined,
        files_edited: parsed.filesEdited.size > 0 ? Array.from(parsed.filesEdited).map(redactPath) : undefined,
        lines_added: diff && diff.linesAdded > 0 ? diff.linesAdded : undefined,
        lines_removed: diff && diff.linesRemoved > 0 ? diff.linesRemoved : undefined,
        // Commits come from the git window like the other extractors; a push
        // leaves no local trace, so it can only come from the shell transcript.
        git_commits: diff && diff.gitCommits > 0 ? diff.gitCommits : undefined,
        git_pushes: parsed.gitPushes || undefined,
        tracked_file_paths: parsed.filesRead.size > 0
          ? Array.from(parsed.filesRead).map(redactPath)
          : undefined,
        uses_task_agent: usesSubAgent || undefined,
        spawned_agent_names: subAgentNames.length > 0 ? subAgentNames : undefined,
        ide_context_usage_percent: contextPct,
        // Kiro reports occupancy as a percentage; the absolute pair the other
        // surfaces send is recoverable because the window size is alongside it.
        context_token_limit: contextWindow && contextWindow > 0 ? contextWindow : undefined,
        context_tokens_used: contextWindow && contextWindow > 0 && contextPct !== undefined
          ? Math.round((contextPct / 100) * contextWindow)
          : undefined,
        // ── Agentic session detail ──────────────────────────────────────────
        // The surface-qualified session key ("kiro-cli:<vendor id>"), the
        // same value as the row's session_id — the IDE extractor writes the same
        // shape, so one field identifies a session across both surfaces.
        kiro_id: rowId,
        model_request_attempts: turnStats.totalAttempts || undefined,
        agent_active_seconds: turnStats.activeSeconds > 0 ? turnStats.activeSeconds : undefined,
        turn_usage: turns.length > 0 ? buildTurnUsage(turns) : undefined,
        user_prompt_chars: turnStats.userPromptChars || undefined,
        assistant_response_chars: turnStats.assistantResponseChars || undefined,
        builtin_tool_uses: turnStats.totalBuiltinToolUses || undefined,
        tool_origin_counts: Object.keys(parsed.toolOriginCounts).length > 0
          ? parsed.toolOriginCounts
          : undefined,
        // tool_approval_outcomes and sub_agent_runs are IDE-only: the CLI records
        // that a tool was rejected (end_reason) but not which approval option was
        // offered, nor a per-delegation outcome. Inventing either would report a
        // decision the user never made.
        total_model_request_count: turnStats.totalRequests || undefined,
        total_agent_cycles: turnStats.totalCycles || undefined,
        billing_credits_used: turnStats.totalCredits || undefined,
        total_input_tokens: turnStats.totalInputTokens || undefined,
        total_output_tokens: turnStats.totalOutputTokens || undefined,
        sandbox_allowed_read_paths: perms?.filesystem?.allowed_read_paths?.length
          ? perms.filesystem.allowed_read_paths.map(redactPath)
          : undefined,
        sandbox_allowed_write_paths: perms?.filesystem?.allowed_write_paths?.length
          ? perms.filesystem.allowed_write_paths.map(redactPath)
          : undefined,
      };

      const resolved = resolveProjectAndRepo(cwd, []);

      // Branch/PR evidence the session itself produced. Only the transcript is
      // session-time; the checkout's HEAD is whatever the developer moved on to
      // by extraction, so it is deliberately not offered as branch evidence (see
      // buildSharedSessionFields). git_sha stays: nothing matches on it.
      // Declared span only — see kiroIdeExtractor for why lookupEnd must not be
      // threaded into this walk.
      const recovered = mergeWindowedBranches(
        collectKiroAttribution(parsed.attributionEvents, resolved?.repoName),
        cwd && createdMs !== undefined && updatedMs !== undefined
          ? recoverWindowedBranches(cwd, createdMs, updatedMs)
          : [],
      );
      if (cwd) {
        const headSha = getGitHeadSha(cwd);
        if (headSha) sessionMeta.git_sha = headSha;
      }
      applyRecoveredBranches(sessionMeta, recovered);
      mergeRecoveredPRRefs(sessionMeta, recovered.prReferences);

      const aiAttribution: AiAttributionMetrics = {};
      if (parsed.composerSuggestedLines > 0) {
        aiAttribution.composer_suggested_lines = parsed.composerSuggestedLines;
      }

      const sessionInstallMeta: InstallationMetadata = {
        ...(installMeta ?? {}),
        entrypoint: agentName ? `kiro-cli:${agentName}` : "kiro-cli",
        platform: platform(),
      };

      db.upsert({
        ideType: "kiro",
        sessionId: rowId,
        conversation: redactPrompts(parsed.prompts),
        projectPath: cwd ? redactPath(cwd) : undefined,
        repoName: resolved?.repoName,
        lastMtimeMs: st.mtimeMs,
        lastSize: st.size,
        lastOffset: 0,
        conversationSourceCreatedAtMs: createdMs,
        sessionMeta: JSON.stringify(sanitizeSessionMeta(sessionMeta)),
        installationMetadata: JSON.stringify(sessionInstallMeta),
        aiAttribution: Object.keys(aiAttribution).length > 0 ? JSON.stringify(aiAttribution) : undefined,
      });
      count++;
    } catch (err) {
      logger.warn("extraction.kiro", "cli_session_error", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      reportRecordError(sessionId, null, err);
    }
  }
  return count;
}
