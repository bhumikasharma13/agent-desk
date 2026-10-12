// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  AiAttributionMetrics,
  ConversationPrompt,
  InstallationMetadata,
  PromptMetadata,
  SessionMetaPayload,
} from "../types/session";
import type { SessionSink } from "../types/store";
import { redactPrompts, redactPath, sanitizeSessionMeta } from "../redaction";
import { resolveProjectAndRepo, getFullSessionDiffStats, getSessionPRLink, recoverWindowedBranches } from "./gitUtils";
import { getKiroWorkspaceSessionsPath } from "./pathResolver";
import { logger } from "../seams/logger";
import { reportRecordError } from "../seams/scanScope";
import { mergeWindowedBranches } from "./kiroAttribution";
import {
  countWorkspaceArtifacts,
  readKiroMcpServers,
  readExecutionRecords,
  buildSharedSessionFields,
  applyRecoveredBranches,
  normalizeAgentMode,
  normalizeAutonomyMode,
  getLanguagesFromFiles,
  inferWebToolUsage,
} from "./kiroExtractor";
import type {
  KiroLegacySessionJson,
  KiroSessionsIndexEntry,
} from "./kiroExtractor";

// ── Legacy format ─────────────────────────────────────────────────────────────

function extractMessageText(
  content: string | Array<{ type?: string; text?: string }> | undefined,
): string {
  if (Array.isArray(content)) {
    return content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
  }
  return typeof content === "string" ? content : "";
}

function parseLegacyHistory(
  history: NonNullable<KiroLegacySessionJson["history"]>,
  selectedModel: string | undefined,
): { prompts: ConversationPrompt[]; maxOutputTokens: number } {
  const prompts: ConversationPrompt[] = [];
  // selectedModel holds the real LLM ID (e.g. "claude-sonnet-4.5").
  // promptLogs.completionOptions.model is often the routing tag "agent", not the real model.
  let pendingModel: string | undefined;

  for (const entry of history) {
    const msg = entry.message;
    if (!msg?.role) continue;
    const text = extractMessageText(msg.content).trim();
    if (!text) continue;

    const role: "user" | "assistant" = msg.role === "user" ? "user" : "assistant";
    const logModel = entry.promptLogs?.[0]?.completionOptions?.model;
    // Use log model only if it's a real LLM ID (not the "agent" routing tag)
    const resolvedModel = logModel && logModel !== "agent" ? logModel : selectedModel;
    if (resolvedModel) pendingModel = resolvedModel;

    let metadata: PromptMetadata | undefined;
    if (role === "assistant" && pendingModel) {
      metadata = { model: pendingModel };
      pendingModel = undefined;
    }
    prompts.push({ role, content: text, ...(metadata ? { metadata } : {}) });
  }

  const maxOutputTokens = history
    .flatMap((e) => e.promptLogs ?? [])
    .map((pl) => pl.completionOptions?.maxTokens ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);

  return { prompts, maxOutputTokens };
}

function readSessionIndex(workspaceDir: string): Map<string, string> {
  const indexMap = new Map<string, string>();
  const indexPath = join(workspaceDir, "sessions.json");
  if (!existsSync(indexPath)) return indexMap;
  try {
    const entries = JSON.parse(readFileSync(indexPath, "utf-8")) as KiroSessionsIndexEntry[];
    for (const entry of entries) {
      if (entry.sessionId && entry.dateCreated) indexMap.set(entry.sessionId, entry.dateCreated);
    }
  } catch { /* ignore malformed index */ }
  return indexMap;
}

function extractLegacyFormatSessions(db: SessionSink, workspaceDir: string, installMeta: InstallationMetadata): number {
  const indexMap = readSessionIndex(workspaceDir);
  const sessionFiles = readdirSync(workspaceDir).filter(
    (f) => f.endsWith(".json") && f !== "sessions.json",
  );

  let count = 0;
  for (const file of sessionFiles) {
    const filePath = join(workspaceDir, file);
    try {
      const st = statSync(filePath);
      const sessionId = file.replace(".json", "");
      const rowId = `kiro-desktop-legacy:${sessionId}`;

      const tracking = db.getTracking("kiro", rowId);
      if (tracking?.last_mtime_ms === st.mtimeMs && tracking?.last_size === st.size) continue;

      const raw = JSON.parse(readFileSync(filePath, "utf-8")) as KiroLegacySessionJson;
      const { prompts, maxOutputTokens } = parseLegacyHistory(raw.history ?? [], raw.selectedModel);
      const userPrompts = prompts.filter((p) => p.role === "user");
      if (userPrompts.length === 0) continue;

      const workspacePath = raw.workspacePath ?? raw.workspaceDirectory ?? null;
      const dateCreatedStr = indexMap.get(raw.sessionId ?? sessionId);
      const createdAtMs = dateCreatedStr ? parseInt(dateCreatedStr, 10) : st.birthtimeMs;
      const createdAt = new Date(isNaN(createdAtMs) ? st.birthtimeMs : createdAtMs);
      const updatedAt = new Date(st.mtimeMs);

      const artifacts = workspacePath ? countWorkspaceArtifacts(workspacePath) : { specCount: 0, steeringFileCount: 0, hookCount: 0 };
      // Same reasoning as the CLI and IDE paths: user-level servers are not
      // workspace-scoped, so a session without a workspace still has them.
      const mcpServers = readKiroMcpServers(workspacePath ?? undefined);
      const execSummary = workspacePath ? readExecutionRecords(workspacePath, raw.sessionId ?? sessionId) : null;
      const gitMetrics = workspacePath
        ? getFullSessionDiffStats(workspacePath, createdAt.getTime(), updatedAt.getTime())
        : { linesAdded: 0, linesRemoved: 0, filesModified: 0, gitCommits: 0 };

      const execToolCounts = execSummary && Object.keys(execSummary.toolCounts).length > 0 ? execSummary.toolCounts : undefined;
      const execFilesEdited = execSummary && execSummary.filesEdited.size > 0 ? execSummary.filesEdited : undefined;
      const { usesWebSearch, usesWebFetch } = execToolCounts ? inferWebToolUsage(execToolCounts) : { usesWebSearch: false, usesWebFetch: false };

      const sessionMeta: SessionMetaPayload = {
        ...buildSharedSessionFields({
          projectPath: workspacePath,
          artifacts,
          mcpServers,
          prLink: workspacePath ? getSessionPRLink(workspacePath, createdAt.getTime(), updatedAt.getTime()) : null,
          usesWebSearch,
          usesWebFetch,
          languages: execFilesEdited ? getLanguagesFromFiles(execFilesEdited) : undefined,
          firstPrompt: userPrompts[0]?.content,
          lastPrompt: userPrompts[userPrompts.length - 1]?.content,
        }),
        source: "kiro",
        session_title: raw.title,
        user_message_count: userPrompts.length,
        assistant_message_count: prompts.filter((p) => p.role === "assistant").length,
        session_duration_seconds: Math.max(0, (updatedAt.getTime() - createdAt.getTime()) / 1000),
        agent_mode: normalizeAgentMode(raw.sessionType),
        autonomy_mode: normalizeAutonomyMode(raw.autonomyMode),
        ide_context_usage_percent: raw.contextUsagePercentage,
        mcp_context_percent: raw.initialContextEstimate?.mcpToolsPercentage,
        steering_context_percent: raw.initialContextEstimate?.steeringPercentage,
        max_output_tokens: maxOutputTokens || undefined,
        tool_counts: execToolCounts,
        billing_credits_used: execSummary && execSummary.billingCreditsUsed > 0 ? execSummary.billingCreditsUsed : undefined,
        steering_inclusion_count: execSummary && execSummary.steeringInclusionCount > 0 ? execSummary.steeringInclusionCount : undefined,
        files_edited: execFilesEdited ? Array.from(execFilesEdited).map(redactPath) : undefined,
        files_modified: execFilesEdited ? execFilesEdited.size : undefined,
      };

      if (gitMetrics.linesAdded > 0) sessionMeta.lines_added = gitMetrics.linesAdded;
      if (gitMetrics.linesRemoved > 0) sessionMeta.lines_removed = gitMetrics.linesRemoved;
      if (!sessionMeta.files_modified && gitMetrics.filesModified > 0) sessionMeta.files_modified = gitMetrics.filesModified;
      if (gitMetrics.gitCommits > 0) sessionMeta.git_commits = gitMetrics.gitCommits;

      // This surface reads a stored JSON session, so it has no command transcript
      // and cannot produce a `gh pr create` receipt — the reflog is its only route
      // to a branch. Without it the session carries no branch at all, so a
      // stored branch match is unreproducible. The empty attribution is the
      // merge's identity, so windowed branches enter stamped LOCAL_GIT_WINDOWED.
      applyRecoveredBranches(
        sessionMeta,
        mergeWindowedBranches(
          { prReferences: [], branchSignals: [], branches: [] },
          workspacePath
            ? recoverWindowedBranches(workspacePath, createdAt.getTime(), updatedAt.getTime())
            : [],
        ),
      );

      const aiAttribution: AiAttributionMetrics = {};
      if (execSummary && execSummary.composerSuggestedLines > 0) {
        aiAttribution.composer_suggested_lines = execSummary.composerSuggestedLines;
      }

      const resolved = resolveProjectAndRepo(workspacePath ?? undefined, []);
      db.upsert({
        ideType: "kiro",
        sessionId: rowId,
        conversation: redactPrompts(prompts),
        projectPath: workspacePath ? redactPath(workspacePath) : undefined,
        repoName: resolved?.repoName,
        lastMtimeMs: st.mtimeMs,
        lastSize: st.size,
        lastOffset: 0,
        conversationSourceCreatedAtMs: createdAt.getTime(),
        sessionMeta: JSON.stringify(sanitizeSessionMeta(sessionMeta)),
        installationMetadata: JSON.stringify({ ...installMeta, entrypoint: "kiro-desktop" }),
        aiAttribution: Object.keys(aiAttribution).length > 0 ? JSON.stringify(aiAttribution) : undefined,
      });
      count++;
    } catch (err) {
      logger.warn("extraction.kiro", "legacy_session_error", {
        file: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      reportRecordError(null, filePath, err);
    }
  }
  return count;
}

// ── Desktop entry point ───────────────────────────────────────────────────────

export function extractKiroDesktop(db: SessionSink, installMeta: InstallationMetadata): number {
  const legacyRoot = getKiroWorkspaceSessionsPath();
  if (!existsSync(legacyRoot)) return 0;

  let dirs: string[];
  try { dirs = readdirSync(legacyRoot); } catch { return 0; }

  let count = 0;
  for (const dir of dirs) {
    const workspaceDir = join(legacyRoot, dir);
    try { if (!statSync(workspaceDir).isDirectory()) continue; } catch { continue; }
    try {
      count += extractLegacyFormatSessions(db, workspaceDir, installMeta);
    } catch (err) {
      logger.warn("extraction.kiro", "workspace_dir_error", {
        workspaceDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return count;
}
