// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ConversationPrompt, InstallationMetadata, PromptMetadata, SessionLineagePayload, SessionMetaPayload } from "../types/session";
import type { SessionSink } from "../types/store";
import { conversationId } from "../store/ids";
import { redactPrompts, redactPath, sanitizeSessionMeta } from "../redaction";
import {
  getCodexArchivedSessionsPath,
  getCodexAuthJsonPath,
  getCodexConfigTomlPath,
  getCodexSessionsPath,
  getCodexSqlitePath,
  getCodexVersionJsonPath,
} from "./pathResolver";
import { codexSourceToEntrypoint, readCodexInstallationMetadata, readCodexPlanTier } from "./planTierDetector";
import { findPRUrlInText } from "./prUrlParser";
import {
  SessionEventBuilder,
  promptReferenceAuthor,
  outcomeForExitCode,
  type EventCoverage,
  type SessionEvent,
  type SessionEventOutcome,
} from "./sessionEvents";
import { SQLiteReader } from "./sqliteReader";
import { resolveProjectAndRepo, getFullSessionDiffStats, getSessionPRLink, parseRepoName } from "./gitUtils";
import { logger } from "../seams/logger";
import { reportRecordError, reportSourceError } from "../seams/scanScope";
import { noteUnknownRecordKind, codexRecordKind, requireConsumedShape } from "./knownRecordKinds";
import { MAX_TRANSCRIPT_BYTES } from "./transcriptCache";
import * as zlib from "node:zlib";

// ── Known web search/fetch tool names ─────────────────────────────────────────
// Used for MCP tool detection to avoid false positives from code-search tools
// like "code_search", "file_search", "search_files", etc.
const CODEX_MCP_WEB_SEARCH_TOOLS = new Set([
  "web_search", "search_web", "bing_search", "brave_search", "tavily_search",
  "google_search", "search_internet", "websearch", "web", "bing_web",
]);
const CODEX_MCP_WEB_FETCH_TOOLS = new Set([
  "fetch", "web_fetch", "browse", "get_url", "read_url", "open_url",
  "browse_url", "fetch_url", "http_fetch", "fetch_web", "web_browse",
]);

// The canonical form of a `/goal` invocation. Codex records a goal as thread STATE and never
// writes the command as transcript text, so the extractor writes this form for it: a consumer's
// marker scan matches a slash command at a prompt's opening, and this is that shape.
const GOAL_COMMAND_PREFIX = "/goal ";

// The closed set of Codex turn_context.approval_policy values (legacy suggest/auto-edit/full-auto
// and modern never/on-request/on-failure/untrusted). approval_policy is captured verbatim and
// stored onto the turn's permission_mode, so an unvetted vendor string is rejected rather than
// stored (symmetry with the Claude allow-list).
const CODEX_APPROVAL_POLICIES = new Set([
  "suggest", "auto-edit", "full-auto", "never", "on-request", "on-failure", "untrusted",
]);

// ── Codex config helpers ──────────────────────────────────────────────────────

/**
 * Parses the MCP server table headers from ~/.codex/config.toml: Codex's
 * `[mcp_servers.<name>]`, and `[mcpServers.<name>]` as older configs spell it.
 * A nested table (`[mcp_servers.<name>.env]`) is part of a server, not another
 * one. Returns each server name once — command/args are not collected — or an
 * empty array if the file is absent or has no server tables.
 */
export function readCodexMcpServers(configTomlPath: string): string[] {
  if (!existsSync(configTomlPath)) return [];
  try {
    const content = readFileSync(configTomlPath, "utf-8");
    const names = new Set<string>();
    // [mcp_servers.my-server], [mcp_servers."my server"], [mcpServers.my-server]
    const re = /^\s*\[\s*(?:mcp_servers|mcpServers)\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const name = (m[1] ?? m[2] ?? m[3] ?? "").trim();
      if (name) names.add(name);
    }
    return [...names];
  } catch {
    return [];
  }
}

// ── SQLite thread row ─────────────────────────────────────────────────────────
// Actual schema from state_5.sqlite (verified against real Codex Desktop install):
//   id, rollout_path, source, model, model_provider, cwd, git_branch,
//   title, created_at (epoch secs), updated_at (epoch secs), tokens_used, ...

interface CodexThread {
  id: string;
  rollout_path: string | null;
  source: string | null;
  model: string | null;
  model_provider: string | null;
  cwd: string | null;
  git_branch: string | null;
  // `title` is Codex's AI-generated summary; `name` is a user-assigned rename
  // (a distinct column, written by `UPDATE threads SET name = ?`), null until the
  // user renames. A rename must win over the AI title — resolved in processThread.
  title: string | null;
  name: string | null;
  created_at: number;   // epoch seconds
  updated_at: number;   // epoch seconds
  tokens_used: number;
  // New columns from schema version 24+
  git_sha: string | null;
  git_origin_url: string | null;
  cli_version: string | null;
  first_user_message: string | null;
  reasoning_effort: string | null;
  memory_mode: string | null;
  approval_mode: string | null;
  sandbox_policy: string | null;
}

// ── Token usage ───────────────────────────────────────────────────────────────

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  // The provider's reasoning bucket — a SUBSET of output_tokens, so it is carried
  // for the reasoning_tokens field but never added into the output total.
  reasoning_tokens?: number;
  // The last request's total occupied tokens — for context-percent. Per the Codex
  // normalization rule, the LAST request's total, never the cumulative session sum.
  total_tokens?: number;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extracts Codex conversations from the shared ~/.codex/ storage root, covering
 * the CLI, VS Code extension, and Desktop App surfaces (all share state_5.sqlite
 * and sessions/). Falls back to scanning the sessions directory if the SQLite
 * index is unavailable.
 */
export async function extractCodex(db: SessionSink, captureLineage = false): Promise<number> {
  const sqlitePath = getCodexSqlitePath();
  const sessionsPath = getCodexSessionsPath();
  const archivedSessionsPath = getCodexArchivedSessionsPath();

  logger.info("extraction.codex", "extraction_start", { sqlitePath, sessionsPath });

  // Read shared metadata once — passed to every thread/session processor
  const baseMeta = readCodexInstallationMetadata(getCodexVersionJsonPath());
  const tierInfo = readCodexPlanTier(getCodexAuthJsonPath());
  const installationMeta: InstallationMetadata | null = tierInfo
    ? {
        ...(baseMeta ?? {}),
        plan_tier: tierInfo.planTier,
        plan_tier_source: tierInfo.planTierSource,
        ...(tierInfo.loginEmail ? { login_email: tierInfo.loginEmail } : {}),
      }
    : baseMeta;
  const mcpServers = readCodexMcpServers(getCodexConfigTomlPath());

  if (existsSync(sqlitePath)) {
    return extractFromSqlite(db, sqlitePath, installationMeta, mcpServers, captureLineage);
  }

  // SQLite unavailable — fall back to directory scan of both active and archived sessions
  const hasActive = existsSync(sessionsPath);
  const hasArchived = existsSync(archivedSessionsPath);
  if (hasActive || hasArchived) {
    logger.info("extraction.codex", "sqlite_not_found_using_directory_fallback", {});
    let count = 0;
    if (hasActive) count += extractFromDirectory(db, sessionsPath, installationMeta, mcpServers);
    if (hasArchived) count += extractFromDirectory(db, archivedSessionsPath, installationMeta, mcpServers);
    return count;
  }

  logger.info("extraction.codex", "codex_not_installed", {});
  return 0;
}

// ── SQLite-based extraction ───────────────────────────────────────────────────

function extractFromSqlite(
  db: SessionSink,
  sqlitePath: string,
  installationMeta: InstallationMetadata | null,
  mcpServers: string[],
  captureLineage = false
): number {
  const reader = new SQLiteReader(sqlitePath);
  let extracted = 0;

  try {
    reader.open();

    // `name` (the user rename) is one of the newest threads columns; a Codex DB
    // older than its introduction lacks it. Selecting it unconditionally would
    // throw "no such column: name", which the catch below swallows into a 0-count
    // return — halting ALL Codex extraction on those installs, not just renames.
    // Probe and degrade to NULL so older schemas still extract (title-only).
    const nameSelect = tableHasColumn(reader, "threads", "name") ? "name" : "NULL AS name";

    const threads = reader.query<CodexThread>(
      `SELECT id, rollout_path, source, model, model_provider, cwd, git_branch,
              title, ${nameSelect}, created_at, updated_at, tokens_used,
              git_sha, git_origin_url, cli_version, first_user_message,
              reasoning_effort, memory_mode, approval_mode, sandbox_policy
       FROM threads`
    );

    logger.info("extraction.codex", "threads_found", { count: threads.length });

    // Map each spawned child thread to its parent from thread_spawn_edges
    // (schema v24+). A thread appearing as child_thread_id was spawned as a
    // subagent; parent_thread_id is its lineage parent (undefined if the edge
    // row lacks it). Used to tag the child with session lineage so a consumer
    // folds it onto the parent instead of analyzing it as a standalone session.
    const childToParent = new Map<string, string | undefined>();
    try {
      const edges = reader.query<{ child_thread_id: string; parent_thread_id: string | null }>(
        "SELECT child_thread_id, parent_thread_id FROM thread_spawn_edges"
      );
      for (const e of edges) childToParent.set(e.child_thread_id, e.parent_thread_id ?? undefined);
    } catch { /* table absent in older schema versions — safe to ignore */ }

    // Build a map of thread_id → tool names from thread_dynamic_tools (schema v24+).
    const dynamicToolsMap = new Map<string, string[]>();
    try {
      const rows = reader.query<{ thread_id: string; name: string }>(
        "SELECT thread_id, name FROM thread_dynamic_tools"
      );
      for (const row of rows) {
        const existing = dynamicToolsMap.get(row.thread_id);
        if (existing) { existing.push(row.name); }
        else { dynamicToolsMap.set(row.thread_id, [row.name]); }
      }
    } catch { /* table absent in older schema versions — safe to ignore */ }

    for (const thread of threads) {
      try {
        const isChild = childToParent.has(thread.id);
        const parentThreadId = childToParent.get(thread.id);
        const dynTools = dynamicToolsMap.get(thread.id);
        if (processThread(db, thread, installationMeta, mcpServers, isChild, dynTools, parentThreadId, captureLineage)) extracted++;
      } catch (err) {
        logger.warn("extraction.codex", "thread_processing_error", {
          threadId: thread.id,
          error: err instanceof Error ? err.message : String(err),
        });
        reportRecordError(thread.id, thread.rollout_path ?? null, err);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("locked")) {
      logger.warn("extraction.codex", "database_locked", {
        hint: "Codex session is active — will retry next cycle",
      });
    } else {
      logger.warn("extraction.codex", "sqlite_read_error", { error: msg });
    }
    reportSourceError(sqlitePath, err);
  } finally {
    reader.close();
  }

  return extracted;
}

// Codex originators that mark a `codex exec` launched from within an interactive
// session — a hook's nested exec inherits the parent surface's originator
// (codex_vscode / Codex Desktop / codex-tui). A bare-terminal `codex exec`
// reports codex_exec/codex_cli and is deliberately absent here, so a genuine
// human exec is never tagged as a hook (fail-safe toward keeping real usage).
const NESTED_EXEC_ORIGINATORS = new Set(["codex_vscode", "Codex Desktop", "codex-tui"]);

// parseCodexSubagentSource inspects threads.source. A non-subagent thread carries a
// plain string ("vscode"|"cli"|"exec"); a subagent thread carries a JSON object under
// a `subagent` key in one of two real shapes: an OBJECT value
// ({"subagent":{"thread_spawn":{"parent_thread_id":…}}}) for a spawn-edge child, and a
// STRING value ({"subagent":"review"}) for a self-declaring agent variant (auto-review,
// guardian) that carries no parent. Both are subagents; only the object form has a
// parent id. Reports whether the source is a subagent and its parent thread id when present.
function parseCodexSubagentSource(rawSource: string | undefined): { isSubagent: boolean; parentThreadId?: string } {
  if (!rawSource || !rawSource.trimStart().startsWith("{")) return { isSubagent: false };
  try {
    const parsed = JSON.parse(rawSource) as Record<string, unknown>;
    const sub = parsed["subagent"];
    // The vendor marks a subagent thread with a `subagent` key in exactly two shapes: a
    // STRING value ("review" — auto-review/guardian; missing it misclassifies the thread as
    // PRIMARY) or a non-null OBJECT value (spawn-edge child, carrying
    // thread_spawn.parent_thread_id). Anything else — absent, null, boolean, number, array —
    // is not a subagent marker; reject it rather than guess (a bare `false` must not read as
    // a subagent), matching the documented contract.
    if (typeof sub === "string") return { isSubagent: true };
    if (typeof sub !== "object" || sub === null || Array.isArray(sub)) return { isSubagent: false };
    const spawn = (sub as Record<string, unknown>)["thread_spawn"];
    const parentId =
      spawn !== null && typeof spawn === "object" ? (spawn as Record<string, unknown>)["parent_thread_id"] : undefined;
    return { isSubagent: true, parentThreadId: typeof parentId === "string" ? parentId : undefined };
  } catch {
    return { isSubagent: false };
  }
}

// classifyCodexLineage tags a thread that must not be analyzed as a standalone
// session. SUBAGENT: a spawn-edge child OR a self-declaring {"subagent":...}
// source (the latter covers agent variants like guardian/auto-review that carry
// no spawn edge). HOOK: a non-interactive `codex exec` fired from within an
// interactive session (its originator inherits the parent surface). Returns
// undefined for a human-driven session, which stays PRIMARY.
export function classifyCodexLineage(args: {
  isChildThread: boolean;
  parentThreadId: string | undefined;
  rawSource: string | undefined;
  originator: string | undefined;
  tokens: number;
}): SessionLineagePayload | undefined {
  const { isChildThread, parentThreadId, rawSource, originator, tokens } = args;
  const sub = parseCodexSubagentSource(rawSource);

  if (isChildThread || sub.isSubagent) {
    const parent = parentThreadId ?? sub.parentThreadId;
    return {
      relation_type: "SUBAGENT",
      parent_record_key: parent ? conversationId("codex", parent) : undefined,
      linkage_confidence: parent ? "STRONG" : "NONE",
      tokens,
    };
  }

  if (rawSource === "exec" && originator !== undefined && NESTED_EXEC_ORIGINATORS.has(originator)) {
    return {
      relation_type: "HOOK",
      linkage_confidence: "NONE",
      tokens,
    };
  }

  return undefined;
}

function processThread(
  db: SessionSink,
  thread: CodexThread,
  installationMeta: InstallationMetadata | null,
  mcpServers: string[],
  isChildThread?: boolean,
  dynamicToolNames?: string[],
  parentThreadId?: string,
  captureLineage?: boolean
): boolean {
  const sessionId = thread.id;
  // updated_at is epoch seconds — convert to ms for storage
  const updatedAtMs = thread.updated_at * 1000;

  // Dedup: skip if updated_at unchanged since last extraction. A metadata-only
  // mutation that doesn't bump updated_at (a session rename — `UPDATE threads SET
  // name = ?` / `SET title = ?`) is therefore not re-read until the next turn
  // advances updated_at; a rename on an otherwise-settled session propagates only
  // on that next activity or a `reset --dedup`.
  const tracking = db.getTracking("codex", sessionId);
  if (tracking && tracking.last_mtime_ms === updatedAtMs) {
    // Opportunistically patch metadata if it was missing on a prior cycle
    if (thread.cwd && (!tracking.project_path || !tracking.repo_name)) {
      const resolved = resolveProjectAndRepo(thread.cwd, []);
      if (resolved) {
        const redactedPath = redactPath(resolved.projectPath);
        if (redactedPath !== tracking.project_path) {
          db.updateProjectPath("codex", sessionId, redactedPath);
        }
        if (resolved.repoName && resolved.repoName !== tracking.repo_name) {
          db.updateRepoName("codex", sessionId, resolved.repoName);
        }
      }
    }
    return false;
  }

  // rollout_path in state_5.sqlite is the full absolute path to the JSONL file
  const filePath = thread.rollout_path;
  if (!filePath) {
    logger.warn("extraction.codex", "no_rollout_path", { threadId: thread.id });
    return false;
  }

  const content = loadFileContent(filePath);
  if (!content) return false;

  // Pass thread.model as the authoritative model name — model_provider in the JSONL
  // is the provider string (e.g. "openai"), not the actual model (e.g. "o4-mini").
  const result = parseRolloutContent(content, thread.id, thread.model ?? undefined);
  if (!result || result.userTurns === 0) return false;

  // Project path: prefer cwd from session_meta, fall back to threads.cwd
  const cwd = result.cwd ?? thread.cwd ?? undefined;
  const resolved = resolveProjectAndRepo(cwd, []);
  // Prefer git_origin_url from SQLite over git remote lookup (more reliable, no shell call).
  const repoName =
    (thread.git_origin_url ? parseRepoName(thread.git_origin_url) : undefined) ??
    (result.gitRepositoryUrlFromMeta ? parseRepoName(result.gitRepositoryUrlFromMeta) : undefined) ??
    resolved?.repoName;
  const projectPath = resolved?.projectPath ?? cwd;

  const redactedPrompts = redactPrompts(result.prompts);
  const redactedProjectPath = projectPath ? redactPath(projectPath) : undefined;

  const gitBranch = result.gitBranch ?? thread.git_branch ?? undefined;
  const sessionMetaObj: SessionMetaPayload = {};
  if (gitBranch) {
    sessionMetaObj.git_branch = gitBranch;
    // Codex exposes only a single snapshot value for this session — emit
    // it as a single-element git_branches array so a reader can use a
    // single code path across all IDEs.
    sessionMetaObj.git_branches = [gitBranch];
  }
  // Classify how the thread was originated. thread.source is authoritative
  // (threads.source in SQLite): a {"subagent":...} object for agent-spawned
  // threads, else a plain string ("vscode"|"cli"|"exec"). thread_spawn_edges
  // still supplies the parent for spawn-edge subagents.
  const lineage = classifyCodexLineage({
    isChildThread: isChildThread ?? false,
    parentThreadId,
    rawSource: thread.source ?? result.source ?? undefined,
    originator: result.originator,
    tokens: thread.tokens_used ?? 0,
  });

  const effectiveSource =
    lineage?.relation_type === "SUBAGENT" ? "subagent" : (result.source ?? thread.source ?? undefined);
  if (effectiveSource) sessionMetaObj.source = effectiveSource;

  // Session lineage: tag a unit that must not be analyzed as a standalone
  // session so a consumer skips it (subagent → folds onto its parent when the
  // parent edge is present; hook → non-interactive automation run, no parent).
  // parent_record_key is the parent's conversationId — the same transform
  // the store applies to the parent thread's id — so the fold matches. Gated on
  // the captureLineage scan option.
  if (lineage && captureLineage) {
    sessionMetaObj.lineage = lineage;
  }
  // A user rename (`name`) wins over the AI-generated `title`; a blank name falls
  // through to the title so it can't shadow a good value. Both are free text
  // redacted at the sanitizeSessionMeta choke point (session_title is "text").
  const sessionTitle = firstNonBlank(thread.name, thread.title);
  if (sessionTitle) sessionMetaObj.session_title = sessionTitle;
  if (result.trackedFilePaths.length > 0 || result.patchedFilePaths.length > 0) {
    const allTracked = new Set([...result.trackedFilePaths, ...result.patchedFilePaths]);
    sessionMetaObj.tracked_file_paths = [...allTracked];
  }
  if (result.patchedFilePaths.length > 0) sessionMetaObj.files_edited = result.patchedFilePaths;
  if (mcpServers.length > 0) sessionMetaObj.mcp_server_names = mcpServers;
  // thread_dynamic_tools — per-session dynamically registered tool names.
  if (dynamicToolNames && dynamicToolNames.length > 0) sessionMetaObj.dynamic_tool_names = dynamicToolNames;

  // New SQLite columns.
  const gitSha = thread.git_sha ?? result.gitCommitHashFromMeta ?? undefined;
  if (gitSha) sessionMetaObj.git_sha = gitSha;
  if (thread.reasoning_effort) {
    sessionMetaObj.reasoning_effort = thread.reasoning_effort;
    // reasoning_effort being set means the session used o-series chain-of-thought reasoning.
    sessionMetaObj.uses_extended_thinking = true;
  }
  if (thread.memory_mode) sessionMetaObj.memory_mode = thread.memory_mode;
  if (thread.approval_mode) sessionMetaObj.approval_mode = thread.approval_mode;
  if (thread.sandbox_policy) sessionMetaObj.sandbox_policy = thread.sandbox_policy;
  if (thread.first_user_message) sessionMetaObj.first_prompt = thread.first_user_message;

  // MCP and tool signals.
  if (result.usesMcp) sessionMetaObj.uses_mcp = true;
  if (result.usesWebSearch) sessionMetaObj.uses_web_search = true;
  if (result.usesWebFetch) sessionMetaObj.uses_web_fetch = true;
  if (Object.keys(result.mcpToolCounts).length > 0) {
    sessionMetaObj.tool_counts = result.mcpToolCounts;
  }
  if (result.toolErrors > 0) sessionMetaObj.tool_errors = result.toolErrors;
  if (Object.keys(result.toolErrorCategories).length > 0) sessionMetaObj.tool_error_categories = result.toolErrorCategories;
  if (result.userInterruptions > 0) sessionMetaObj.user_interruptions = result.userInterruptions;
  if (result.compactionCount > 0) sessionMetaObj.compaction_count = result.compactionCount;
  if (result.lastPrompt) sessionMetaObj.last_prompt = result.lastPrompt;

  // Git diff metrics: committed changes in the session window + uncommitted dirty state
  // Guard updated_at > 0: a zero value would produce endMs=0 (Jan 1970), causing the
  // git diff HEAD fallback to attribute arbitrary dirty state to this session.
  if (cwd && thread.updated_at > 0) {
    const startMs = thread.created_at > 0 ? thread.created_at * 1000 : undefined;
    const endMs = thread.updated_at * 1000;
    const diff = getFullSessionDiffStats(cwd, startMs, endMs);
    if (diff.linesAdded > 0) sessionMetaObj.lines_added = diff.linesAdded;
    if (diff.linesRemoved > 0) sessionMetaObj.lines_removed = diff.linesRemoved;
    if (diff.filesModified > 0) sessionMetaObj.files_modified = diff.filesModified;
    if (diff.gitCommits > 0) sessionMetaObj.git_commits = diff.gitCommits;
  }
  // Supplement from command-parsed counters when git diff gives zeros.
  if (!sessionMetaObj.git_commits && result.gitCommits > 0) sessionMetaObj.git_commits = result.gitCommits;
  if (result.gitPushes > 0) sessionMetaObj.git_pushes = result.gitPushes;
  if (!sessionMetaObj.lines_added && result.linesAddedFromCommands > 0) {
    sessionMetaObj.lines_added = result.linesAddedFromCommands;
  }
  if (!sessionMetaObj.lines_removed && result.linesRemovedFromCommands > 0) {
    sessionMetaObj.lines_removed = result.linesRemovedFromCommands;
  }

  // Timing signals from per-message timestamps.
  if (result.userTimestampsMs.length > 0) {
    sessionMetaObj.user_message_timestamps = result.userTimestampsMs.map((ms) => new Date(ms).toISOString());
    sessionMetaObj.message_hours = result.userTimestampsMs.map((ms) => new Date(ms).getUTCHours());
    const responseTimes: number[] = [];
    for (let i = 1; i < result.userTimestampsMs.length; i++) {
      const diff = (result.userTimestampsMs[i]! - result.userTimestampsMs[i - 1]!) / 1000;
      if (diff >= 0) responseTimes.push(Math.round(diff));
    }
    if (responseTimes.length > 0) sessionMetaObj.user_response_times = responseTimes;
  }

  // PR links: prefer MCP/tool-detected links, fall back to git commit messages.
  // Scalar pr_* fields carry the FIRST reference for back-compat; pr_references
  // carries every distinct PR the session touched.
  let resolvedPrLinks: Array<{ pr_url: string; pr_number: number; pr_repository: string }> = [];
  if (result.prLinks.length > 0) {
    resolvedPrLinks = result.prLinks.map((p) => ({
      pr_url: p.prUrl, pr_number: p.prNumber, pr_repository: p.prRepository,
    }));
  } else if (cwd && thread.updated_at > 0) {
    const startMs = thread.created_at > 0 ? thread.created_at * 1000 : undefined;
    const endMs = thread.updated_at * 1000;
    const prFromGit = getSessionPRLink(cwd, startMs, endMs);
    if (prFromGit) {
      resolvedPrLinks = [{
        pr_url: prFromGit.prUrl, pr_number: prFromGit.prNumber, pr_repository: prFromGit.prRepository,
      }];
    }
  }
  if (resolvedPrLinks.length > 0) {
    sessionMetaObj.pr_url = resolvedPrLinks[0]!.pr_url;
    sessionMetaObj.pr_number = resolvedPrLinks[0]!.pr_number;
    sessionMetaObj.pr_repository = resolvedPrLinks[0]!.pr_repository;
    sessionMetaObj.pr_references = resolvedPrLinks;
  }

  const sessionMeta =
    Object.keys(sessionMetaObj).length > 0 ? JSON.stringify(sanitizeSessionMeta(sessionMetaObj)) : undefined;

  // Merge shared installationMeta with per-session entrypoint derived from source.
  // cli_version from SQLite takes precedence over version.json for per-session accuracy.
  const sessionInstallMeta: InstallationMetadata = {
    ...(installationMeta ?? {}),
    entrypoint: codexSourceToEntrypoint(result.source ?? thread.source),
    ...(thread.cli_version ? { cc_version: thread.cli_version } : {}),
  };

  db.upsert({
    ideType: "codex",
    sessionId,
    conversation: redactedPrompts,
    projectPath: redactedProjectPath,
    repoName,
    lastMtimeMs: updatedAtMs,
    lastSize: result.prompts.length,
    lastOffset: 0,
    conversationSourceCreatedAtMs: thread.created_at > 0 ? thread.created_at * 1000 : undefined,
    sessionMeta,
    installationMetadata: JSON.stringify(sessionInstallMeta),
    // Omitted when empty so a session with nothing observed is absent rather than carrying an
    // empty array — a consumer reads either as coverage NONE.
    sessionEvents: result.sessionEvents.length > 0 ? JSON.stringify(result.sessionEvents) : undefined,
    eventCoverage: result.eventCoverage,
  });

  return true;
}

// ── Directory-scan fallback (when state_5.sqlite is absent) ──────────────────

function extractFromDirectory(
  db: SessionSink,
  sessionsPath: string,
  installationMeta: InstallationMetadata | null,
  mcpServers: string[]
): number {
  let extracted = 0;

  try {
    const years = readdirSync(sessionsPath);
    for (const year of years) {
      if (!/^\d{4}$/.test(year)) continue;
      const yearPath = join(sessionsPath, year);

      const months = readdirSync(yearPath);
      for (const month of months) {
        if (!/^\d{2}$/.test(month)) continue;
        const monthPath = join(yearPath, month);

        const days = readdirSync(monthPath);
        for (const day of days) {
          if (!/^\d{2}$/.test(day)) continue;
          const dayPath = join(monthPath, day);

          // Filename format: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl[.zst]
          const files = readdirSync(dayPath).filter(
            (f) => f.startsWith("rollout-") && (f.endsWith(".jsonl") || f.endsWith(".jsonl.zst"))
          );

          for (const file of files) {
            // Extract thread_id: last UUID segment after the final "-" cluster
            const threadId = extractThreadIdFromFilename(file);
            if (!threadId) continue;

            const filePath = join(dayPath, file);
            try {
              if (processSessionFile(db, threadId, filePath, installationMeta, mcpServers)) extracted++;
            } catch (err) {
              logger.warn("extraction.codex", "session_file_error", {
                filePath,
                error: err instanceof Error ? err.message : String(err),
              });
              reportRecordError(threadId, filePath, err);
            }
          }
        }
      }
    }
  } catch (err) {
    logger.warn("extraction.codex", "sessions_dir_scan_error", {
      error: err instanceof Error ? err.message : String(err),
    });
    reportSourceError(sessionsPath, err);
  }

  return extracted;
}

/**
 * Parses the session start timestamp from a rollout filename.
 * Format: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl[.zst]
 * Returns unix ms, or undefined if the timestamp cannot be parsed.
 */
function parseRolloutTimestamp(filename: string): number | undefined {
  // e.g. rollout-2025-04-13T10-30-45-550e8400-e29b-41d4-a716-446655440000.jsonl
  const m = /^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-/.exec(filename);
  if (!m) return undefined;
  const isoStr = `${m[1]!}T${m[2]!}:${m[3]!}:${m[4]!}Z`;
  const ms = Date.parse(isoStr);
  return isNaN(ms) ? undefined : ms;
}

/**
 * Extracts the thread UUID from a rollout filename.
 * Format: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl
 * The UUID is the last 36 characters before ".jsonl".
 */
function extractThreadIdFromFilename(filename: string): string | null {
  const base = filename.replace(/\.jsonl(\.zst)?$/, "");
  // UUID v7 is always 36 chars: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  if (base.length < 36) return null;
  const candidate = base.slice(-36);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate)) {
    return candidate;
  }
  return null;
}

function processSessionFile(
  db: SessionSink,
  sessionId: string,
  filePath: string,
  installationMeta: InstallationMetadata | null,
  mcpServers: string[]
): boolean {
  let fileStat: { mtimeMs: number; size: number };
  try {
    const s = statSync(filePath);
    fileStat = { mtimeMs: Math.floor(s.mtimeMs), size: s.size };
  } catch {
    return false;
  }

  const tracking = db.getTracking("codex", sessionId);
  if (
    tracking &&
    tracking.last_mtime_ms === fileStat.mtimeMs &&
    tracking.last_size === fileStat.size
  ) {
    return false;
  }

  const content = loadFileContent(filePath);
  if (!content) return false;

  const result = parseRolloutContent(content, sessionId);
  if (!result || result.userTurns === 0) return false;

  const resolved = resolveProjectAndRepo(result.cwd, []);
  const repoName =
    (result.gitRepositoryUrlFromMeta ? parseRepoName(result.gitRepositoryUrlFromMeta) : undefined) ??
    resolved?.repoName;
  const projectPath = resolved?.projectPath ?? result.cwd;

  const redactedPrompts = redactPrompts(result.prompts);
  const redactedProjectPath = projectPath ? redactPath(projectPath) : undefined;

  // Parse session start time from the rollout filename so historical sessions
  // get their real start time rather than the extraction timestamp.
  const createdAtMs = parseRolloutTimestamp(basename(filePath));

  const sessionMetaObj: SessionMetaPayload = {};
  if (result.gitBranch) {
    sessionMetaObj.git_branch = result.gitBranch;
    sessionMetaObj.git_branches = [result.gitBranch];
  }
  if (result.source) sessionMetaObj.source = result.source;
  if (result.trackedFilePaths.length > 0 || result.patchedFilePaths.length > 0) {
    const allTracked = new Set([...result.trackedFilePaths, ...result.patchedFilePaths]);
    sessionMetaObj.tracked_file_paths = [...allTracked];
  }
  if (result.patchedFilePaths.length > 0) sessionMetaObj.files_edited = result.patchedFilePaths;
  if (mcpServers.length > 0) sessionMetaObj.mcp_server_names = mcpServers;
  if (result.gitCommitHashFromMeta) sessionMetaObj.git_sha = result.gitCommitHashFromMeta;
  if (result.usesMcp) sessionMetaObj.uses_mcp = true;
  if (result.usesWebSearch) sessionMetaObj.uses_web_search = true;
  if (result.usesWebFetch) sessionMetaObj.uses_web_fetch = true;
  if (Object.keys(result.mcpToolCounts).length > 0) {
    sessionMetaObj.tool_counts = result.mcpToolCounts;
  }
  if (result.toolErrors > 0) sessionMetaObj.tool_errors = result.toolErrors;
  if (Object.keys(result.toolErrorCategories).length > 0) sessionMetaObj.tool_error_categories = result.toolErrorCategories;
  if (result.userInterruptions > 0) sessionMetaObj.user_interruptions = result.userInterruptions;
  if (result.compactionCount > 0) sessionMetaObj.compaction_count = result.compactionCount;
  if (result.lastPrompt) sessionMetaObj.last_prompt = result.lastPrompt;

  // Git diff metrics: committed changes in the session window + uncommitted dirty state
  if (result.cwd) {
    const diff = getFullSessionDiffStats(result.cwd, createdAtMs, fileStat.mtimeMs);
    if (diff.linesAdded > 0) sessionMetaObj.lines_added = diff.linesAdded;
    if (diff.linesRemoved > 0) sessionMetaObj.lines_removed = diff.linesRemoved;
    if (diff.filesModified > 0) sessionMetaObj.files_modified = diff.filesModified;
    if (diff.gitCommits > 0) sessionMetaObj.git_commits = diff.gitCommits;
  }
  if (!sessionMetaObj.git_commits && result.gitCommits > 0) sessionMetaObj.git_commits = result.gitCommits;
  if (result.gitPushes > 0) sessionMetaObj.git_pushes = result.gitPushes;
  if (!sessionMetaObj.lines_added && result.linesAddedFromCommands > 0) {
    sessionMetaObj.lines_added = result.linesAddedFromCommands;
  }
  if (!sessionMetaObj.lines_removed && result.linesRemovedFromCommands > 0) {
    sessionMetaObj.lines_removed = result.linesRemovedFromCommands;
  }

  // Timing signals.
  if (result.userTimestampsMs.length > 0) {
    sessionMetaObj.user_message_timestamps = result.userTimestampsMs.map((ms) => new Date(ms).toISOString());
    sessionMetaObj.message_hours = result.userTimestampsMs.map((ms) => new Date(ms).getUTCHours());
    const responseTimes: number[] = [];
    for (let i = 1; i < result.userTimestampsMs.length; i++) {
      const diff = (result.userTimestampsMs[i]! - result.userTimestampsMs[i - 1]!) / 1000;
      if (diff >= 0) responseTimes.push(Math.round(diff));
    }
    if (responseTimes.length > 0) sessionMetaObj.user_response_times = responseTimes;
  }

  // PR links. Scalar fields carry the FIRST reference for back-compat;
  // pr_references carries every distinct PR the session touched.
  let archivedPrLinks: Array<{ pr_url: string; pr_number: number; pr_repository: string }> = [];
  if (result.prLinks.length > 0) {
    archivedPrLinks = result.prLinks.map((p) => ({
      pr_url: p.prUrl, pr_number: p.prNumber, pr_repository: p.prRepository,
    }));
  } else if (result.cwd) {
    const prFromGit = getSessionPRLink(result.cwd, createdAtMs, fileStat.mtimeMs);
    if (prFromGit) {
      archivedPrLinks = [{
        pr_url: prFromGit.prUrl, pr_number: prFromGit.prNumber, pr_repository: prFromGit.prRepository,
      }];
    }
  }
  if (archivedPrLinks.length > 0) {
    sessionMetaObj.pr_url = archivedPrLinks[0]!.pr_url;
    sessionMetaObj.pr_number = archivedPrLinks[0]!.pr_number;
    sessionMetaObj.pr_repository = archivedPrLinks[0]!.pr_repository;
    sessionMetaObj.pr_references = archivedPrLinks;
  }

  const sessionMeta =
    Object.keys(sessionMetaObj).length > 0 ? JSON.stringify(sanitizeSessionMeta(sessionMetaObj)) : undefined;

  // Merge shared installationMeta with per-session entrypoint derived from source.
  const sessionInstallMeta: InstallationMetadata = {
    ...(installationMeta ?? {}),
    entrypoint: codexSourceToEntrypoint(result.source),
  };

  db.upsert({
    ideType: "codex",
    sessionId,
    conversation: redactedPrompts,
    projectPath: redactedProjectPath,
    repoName,
    lastMtimeMs: fileStat.mtimeMs,
    lastSize: fileStat.size,
    lastOffset: 0,
    conversationSourceCreatedAtMs: createdAtMs,
    sessionMeta,
    installationMetadata: JSON.stringify(sessionInstallMeta),
    sessionEvents: result.sessionEvents.length > 0 ? JSON.stringify(result.sessionEvents) : undefined,
    eventCoverage: result.eventCoverage,
  });

  return true;
}

// ── Content loading ───────────────────────────────────────────────────────────

/**
 * A rollout's text, or null when it cannot be opened or read. It is opened without
 * blocking and read only when it is a regular file, so a FIFO at a rollout path
 * cannot stall the scan, and held to the transcript size limit before and after
 * decompression. A file it will not read whole throws, so the caller reports the
 * session as unreadable.
 */
function loadFileContent(filePath: string): string | null {
  let fd: number;
  try {
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("the rollout is not a regular file");
    if (st.size > MAX_TRANSCRIPT_BYTES) {
      throw new Error(`the rollout is ${st.size} bytes, over the ${MAX_TRANSCRIPT_BYTES}-byte limit`);
    }
    let raw: Buffer;
    try {
      raw = readFileSync(fd);
    } catch {
      return null;
    }
    return filePath.endsWith(".zst") ? decompressZstd(filePath, raw) : raw.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

function decompressZstd(filePath: string, compressed: Buffer): string | null {
  try {
    // zlib has zstd since Node 23.8 / 22.15, so every supported Node (24+) has it;
    // the check keeps a runtime without it from throwing.
    const decompressSync = (zlib as unknown as Record<string, unknown>)["zstdDecompressSync"] as
      | ((buf: Buffer, options: { maxOutputLength: number }) => Buffer)
      | undefined;

    if (typeof decompressSync !== "function") {
      logger.warn("extraction.codex", "zstd_not_available", {
        filePath,
        hint: "this Node's zlib has no zstd; .jsonl.zst archived sessions are skipped",
      });
      return null;
    }

    const decompressed = decompressSync(compressed, { maxOutputLength: MAX_TRANSCRIPT_BYTES });
    return decompressed.toString("utf-8");
  } catch (err) {
    if ((err as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(`the rollout decompresses to over the ${MAX_TRANSCRIPT_BYTES}-byte limit`, { cause: err });
    }
    logger.warn("extraction.codex", "zstd_decompress_error", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ── JSONL parser ──────────────────────────────────────────────────────────────
// The Codex rollout format:
//
//   {"type":"session_meta","payload":{"id":"...","cwd":"...","source":"vscode",
//     "model_provider":"openai","git":{"branch":"main",...},...}}
//
//   {"type":"event_msg","payload":{"type":"user_message","message":"user text",...}}
//   {"type":"event_msg","payload":{"type":"agent_message","message":"partial response",...}}
//   {"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{...}},...}}
//   {"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"full response",...}}
//
// Codex 0.118 and later write the user's turn as an item instead of a `user_message`, and
// the assistant's messages as AgentMessage items instead of `agent_message`:
//
//   {"type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage",
//     "content":[{"type":"text","text":"user text",...}],...},...}}
//
// We reconstruct turns from event_msg lines:
//   user_message, item_completed UserMessage → user ConversationPrompt (one per turn)
//   task_complete → assistant ConversationPrompt (uses last_agent_message)
//   token_count   → token usage attached to the next task_complete

interface ParseResult {
  cwd: string | undefined;
  gitBranch: string | undefined;
  gitCommitHashFromMeta: string | undefined;
  gitRepositoryUrlFromMeta: string | undefined;
  model: string | undefined;
  source: string | undefined;
  /** session_meta.originator — the launch surface (codex_vscode, Codex Desktop,
   *  codex_exec, codex-tui). Distinguishes a hook's nested `codex exec` (inherits
   *  the parent surface) from a bare-terminal one (codex_exec). */
  originator: string | undefined;
  prompts: ConversationPrompt[];
  userTurns: number;
  /** Unique file paths read during the session (from exec_command_end events, type="read"). */
  trackedFilePaths: string[];
  /** Files patched by the AI via apply_patch (from patch_apply_end events). */
  patchedFilePaths: string[];
  /** The timestamp of each user turn, in order. */
  userTimestampsMs: number[];
  /** Git commits made during the session (from exec_command_end git commit with exit_code=0). */
  gitCommits: number;
  /** Git pushes made during the session (from exec_command_end git push with exit_code=0). */
  gitPushes: number;
  linesAddedFromCommands: number;
  linesRemovedFromCommands: number;
  usesMcp: boolean;
  usesWebSearch: boolean;
  usesWebFetch: boolean;
  /** Every distinct PR the session touched, in first-seen order. Emitted
   *  as pr_references in the session meta. The first entry also populates
   *  the deprecated scalar pr_url/pr_number/pr_repository for back-compat. */
  prLinks: Array<{ prUrl: string; prNumber: number; prRepository: string }>;
  mcpToolCounts: Record<string, number>;
  lastPrompt: string | undefined;
  userInterruptions: number;
  toolErrors: number;
  toolErrorCategories: Record<string, number>;
  /** Count of `context_compacted` events — how many times Codex compacted its context
   *  window. Feeds the session-level `session_meta.compaction_count`. */
  compactionCount: number;
  /** The thread goal this session pursued, or undefined for a session that ran none.
   *
   *  A `/goal` thread emits NO `user_message` event: the objective is typed into the goal
   *  mechanism rather than as a thread message, and each continuation arrives as a `response_item`
   *  message the rollout parser does not read as a turn. So without this a goal session counts
   *  zero user turns and the caller discards it whole.
   *
   *  What makes the invocation COUNTABLE is the prompt the parser writes for it, prefixed with
   *  the canonical command, plus the typed GOAL event on `sessionEvents` that positions that
   *  prompt. Neither reads this struct: it reports what the goal WAS, for a caller that wants
   *  the objective and its counters without walking the timeline.
   *
   *  `updates` is how many state changes the thread reported for the RUNNING goal. It is not an
   *  iteration count and not an invocation count: the terminal status is written to the CLI's own
   *  goal store and never to the transcript, so every update seen here carries `active`.
   */
  goal: CodexThreadGoal | undefined;
  /** How many DISTINCT `/goal` invocations the thread carried. Two in one thread is real
   *  captured behaviour, and each is its own attempt. */
  goalInvocations: number;
  /** The normalized timeline: the goal declarations (when any), the prompt turns, and the tool
   *  calls and results read from the `response_item` records — the same shape the Claude Code and
   *  Cursor extractors emit, for every session rather than only goal-carrying ones.
   *
   *  A GOAL event exists to POSITION its declaration: a `/goal` relayed as prompt text is only
   *  recoverable by a consumer's marker fallback, which reads the text and can say nothing about
   *  where in the session it landed, so a second invocation cannot be told from a re-report of the
   *  first. A typed GOAL event carries its own sequence, and the prompt references place it on the
   *  turn that declared it. The tool events give the run an action-then-check timeline the loop
   *  analyzer can ground on, instead of a session legible only by its goal and prompt turns. */
  sessionEvents: SessionEvent[];
  /** How completely the timeline observed the session. `NONE` whenever it is empty. */
  eventCoverage: EventCoverage;
}

/** One Codex thread goal, as `thread_goal_updated` reports it. */
export interface CodexThreadGoal {
  objective: string;
  /** The last status the transcript reported. Always `active` in practice — see `updates`.
   *
   *  The terminal status is not here to be read: Codex keeps it in its own goal store
   *  (`~/.codex/goals_1.sqlite`, table `thread_goals`), whose vocabulary is
   *  `active | paused | blocked | usage_limited | budget_limited | complete`. Reading it needs
   *  more than a file read — that store is keyed by thread, so it holds only a thread's CURRENT
   *  goal and cannot answer per-invocation for a thread that was re-goaled, and no field on the
   *  wire can carry six statuses without flattening three of them onto a value meaning
   *  something else. */
  status: string;
  tokensUsed: number;
  timeUsedSeconds: number;
  updates: number;
}

/**
 * One rollout line as a record, or undefined for a line that is not valid JSON or is
 * JSON but not an object (`null`, `42`, `"x"`, `[]`): the walk skips both alike.
 */
function parseRolloutLine(line: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
}

export function parseRolloutContent(content: string, threadId: string, modelOverride?: string): ParseResult | null {
  const lines = content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return null;

  // Line 1 must be session_meta
  const firstLine = parseRolloutLine(lines[0]!);
  if (!firstLine) return null;

  const lineType = firstLine["type"];

  // Legacy pre-envelope format: no "type" key on line 1
  if (!lineType) {
    logger.warn("extraction.codex", "legacy_format_skipped", {
      threadId,
      hint: "Pre-envelope rollout format; cannot parse",
    });
    return null;
  }

  if (lineType !== "session_meta") return null;

  const metaPayload = toRecord(firstLine["payload"]);
  const cwd =
    typeof metaPayload["cwd"] === "string" ? metaPayload["cwd"] : undefined;
  // The model id: the override (threads.model, e.g. "o4-mini") is authoritative;
  // without one, each turn_context's `model` names the model for that turn.
  // session_meta's `model_provider` ("openai") is a provider, never a model id.
  let model = modelOverride;
  const source =
    typeof metaPayload["source"] === "string" ? metaPayload["source"] : undefined;
  const originator =
    typeof metaPayload["originator"] === "string" ? metaPayload["originator"] : undefined;

  // git branch lives at payload.git.branch
  const gitObj = toRecord(metaPayload["git"]);
  const gitBranch =
    typeof gitObj["branch"] === "string" ? gitObj["branch"] : undefined;
  const gitCommitHashFromMeta =
    typeof gitObj["commit_hash"] === "string" ? gitObj["commit_hash"] : undefined;
  const gitRepositoryUrlFromMeta =
    typeof gitObj["repository_url"] === "string" ? gitObj["repository_url"] : undefined;

  const prompts: ConversationPrompt[] = [];
  const trackedFilePathSet = new Set<string>();
  const patchedFilePathSet = new Set<string>();
  const userTimestampsMs: number[] = [];
  const mcpToolCounts: Record<string, number> = {};
  let userTurns = 0;
  let pendingUsage: TokenUsage | undefined;
  // The model's context window, carried alongside the token counts in the same
  // token_count record; pairs with the turn's total_tokens for context-percent.
  let pendingModelContextWindow: number | undefined;
  // This turn's edit accounting from patch_apply_end records, stamped on the
  // assistant message the turn closes with and reset per turn.
  const pendingEditFiles = new Set<string>();
  let pendingLinesAdded = 0;
  let pendingLinesRemoved = 0;
  // Clears the per-turn edit/usage/context buffers (NOT the prompt buffering,
  // which intentionally spans records). Run at task_complete after the flush, and
  // at task_started so an abandoned turn (a second task_started with no
  // intervening task_complete) does not bleed its edits/usage into the next turn.
  const resetTurnBuffers = (): void => {
    pendingUsage = undefined;
    pendingModelContextWindow = undefined;
    pendingEditFiles.clear();
    pendingLinesAdded = 0;
    pendingLinesRemoved = 0;
  };
  let pendingUserText: string | undefined;
  let pendingUserTimestampMs: number | undefined;
  // The HITL gate the CURRENT turn_context declares — updated as turn_context records stream past.
  let currentApprovalPolicy: string | undefined;
  // The gate SNAPSHOT for the buffered user turn, captured when its user_message arrives and held
  // (like pendingUserText) until the turn flushes. Reading currentApprovalPolicy at flush time
  // instead would let an abandoned/retried turn — whose text is preserved across a second
  // task_started while a new turn_context arrives — flush under a LATER turn's policy. Captured
  // verbatim onto the turn's permission_mode.
  let pendingApprovalPolicy: string | undefined;
  let gitCommits = 0;
  let gitPushes = 0;
  let linesAddedFromCommands = 0;
  let linesRemovedFromCommands = 0;
  let usesMcp = false;
  let usesWebSearch = false;
  let usesWebFetch = false;
  let lastPrompt: string | undefined;
  let userInterruptions = 0;
  let toolErrors = 0;
  let compactionCount = 0;
  let goal: CodexThreadGoal | undefined;
  // The running goal's createdAt, which discriminates a refresh from a second invocation.
  let goalCreatedAt = 0;
  let goalInvocations = 0;
  // Built during the walk because a prompt's ORDINAL is only knowable here — it is the
  // one-based position the prompt takes in `prompts`, and a counter kept anywhere else would
  // drift the first time this walk buffers a turn it never flushes.
  const eventBuilder = new SessionEventBuilder();
  const toolErrorCategories: Record<string, number> = {};
  const prLinks: Array<{ prUrl: string; prNumber: number; prRepository: string }> = [];
  const prLinkKeys = new Set<string>();
  const addPrLink = (pr: { prUrl: string; prNumber: number; prRepository: string }) => {
    const key = `${pr.prRepository}#${pr.prNumber}`;
    if (prLinkKeys.has(key)) return;
    prLinkKeys.add(key);
    prLinks.push(pr);
  };

  // The tool timeline is built from `response_item` records — the universal form. A modern rollout
  // records every tool call twice: as a `response_item` (a `*_call` line and a matching
  // `*_call_output`/`*_output` line, correlated by `call_id`) AND, for the exec/patch/mcp subset,
  // as an `event_msg` `*_end`. The response_item form is the SUPERSET — verified over real captured
  // sessions, and most tool-bearing sessions carry ONLY it. So the timeline reads response_item.
  // An `*_end` record whose `call_id` HAS a response_item twin emits nothing from its block (the
  // twin already carries it — emitting both would double-count); one with NO twin is end-only (an
  // older rollout that predates the response_item form) and emits its own timeline pair, so those
  // sessions are not left blank. Either way the `*_end` blocks still read their richer non-timeline
  // signals (files read, git commits, PR links, MCP counts).
  //
  // call_id → tool name, so a `*_output` result can decide its outcome from what the CALL was.
  // Results arrive on a later line than their call, so the name is not derivable from adjacency.
  const riToolNameByCallId = new Map<string, string>();

  // Filled by the pre-pass below, before the main walk reaches any record:
  //  - riCallIds: every call_id that appears as a response_item call. A `*_end` record whose
  //    call_id is here has a response_item twin already carrying its timeline, so the `*_end`
  //    block emits nothing (dedup). A `*_end` record NOT here is end-only (an older rollout that
  //    predates the response_item form) and DOES emit, so its timeline is not lost.
  //  - endOutcomeByCallId: the structured verdict a `*_end` record states (exec exit_code, patch
  //    success, mcp Err). A twinned response_item result adopts it, because the response_item
  //    output can omit a verdict the `*_end` form recorded explicitly (an MCP Err most notably).
  const riCallIds = new Set<string>();
  const endOutcomeByCallId = new Map<string, SessionEventOutcome>();

  const emitResponseItemTool = (payload: Record<string, unknown>, at: string | undefined): void => {
    const riType = typeof payload["type"] === "string" ? (payload["type"] as string) : "";
    const callId = typeof payload["call_id"] === "string" ? (payload["call_id"] as string) : undefined;
    const atStr = at ?? new Date(0).toISOString();

    // ── Call side: `function_call`, `custom_tool_call`, and any other `<tool>_call` (the OpenAI
    // Responses convention — `tool_search_call`, plus native tools that appear only here such as
    // `web_search_call`/`image_generation_call`). Matched by suffix so an unobserved native tool
    // still lands in the timeline rather than being silently dropped.
    if (riType.endsWith("_call") && !riType.endsWith("_call_output")) {
      // `custom_tool_call.name` is "exec"/"apply_patch"; `function_call.name` is the tool. A
      // suffix-matched native call has no `name`, so its type (minus `_call`) names it.
      const name =
        typeof payload["name"] === "string" && (payload["name"] as string).length > 0
          ? (payload["name"] as string)
          : riType.slice(0, -"_call".length);
      let summary: string | undefined;
      if (riType === "custom_tool_call") {
        // apply_patch's input is a diff — summarize by the files it touches, never the body.
        summary =
          name === "apply_patch"
            ? summarizeApplyPatch(payload["input"])
            : typeof payload["input"] === "string"
              ? (payload["input"] as string)
              : undefined;
      } else {
        // function_call / native calls carry a JSON `arguments` string; summarize by the key that
        // names the work (the command, a query, a path), never a file body.
        summary = summarizeCallArgs(payload["arguments"]);
      }
      if (callId) riToolNameByCallId.set(callId, name);
      eventBuilder.addExternalToolCall({ name, at: atStr, callId, summary });
      return;
    }

    // ── Result side: `function_call_output`, `custom_tool_call_output`, `tool_search_output`,
    // and any `<tool>_call_output`. The outcome is read from the RESULT only when the tool reports
    // a real exit status (see responseItemOutcome); everything else stays UNKNOWN, never a
    // synthesized pass, which a consumer would read as a verdict.
    if (riType.endsWith("_output")) {
      const name = callId ? riToolNameByCallId.get(callId) : undefined;
      const output = payload["output"];
      const summary = typeof output === "string" ? (output as string) : undefined;
      // A structured verdict from the `*_end` twin wins over the output-derived one: the twin can
      // carry an explicit outcome (an MCP Err, an exec exit_code) that the response_item output
      // does not. Falls back to the output when there is no twin (a response_item-only session).
      const endOutcome = callId ? endOutcomeByCallId.get(callId) : undefined;
      eventBuilder.addExternalToolResult({
        at: atStr,
        outcome: endOutcome ?? responseItemOutcome(name, output),
        callId,
        summary,
      });
      return;
    }
    // `reasoning`, `message`, `agent_message` are not tools — no timeline event.
  };

  // Emits the call+result pair for an END-ONLY `*_end` record — one with no response_item twin
  // (an older rollout format). A record whose call_id has a twin is handled by response_item and
  // must NOT come through here, or the tool would be counted twice. The synthetic call id links
  // the pair only when the record carries none (the oldest records omit it).
  let endOnlySeq = 0;
  const emitEndOnlyPair = (args: {
    name: string;
    outcome: SessionEventOutcome;
    callSummary?: string;
    resultSummary?: string;
    callId?: string;
    at?: string;
  }): void => {
    const at = args.at ?? new Date(0).toISOString();
    const callId = args.callId ?? `codex-end-${++endOnlySeq}`;
    eventBuilder.addExternalToolCall({ name: args.name, at, callId, summary: args.callSummary });
    eventBuilder.addExternalToolResult({ at, outcome: args.outcome, callId, summary: args.resultSummary });
  };

  // Commit any buffered user message as a turn. Codex buffers the user text in a
  // single slot and flushes at task_complete; mid-turn steering can inject a
  // second user_message before that, so we also flush before overwriting the slot.
  const flushPendingUser = (): void => {
    if (!pendingUserText) return;
    const ts = pendingUserTimestampMs !== undefined
      ? new Date(pendingUserTimestampMs).toISOString()
      : undefined;
    const userMeta: PromptMetadata = {};
    if (model) userMeta.model = model;
    if (pendingApprovalPolicy) userMeta.permission_mode = pendingApprovalPolicy;
    prompts.push({
      role: "user",
      content: pendingUserText,
      timestamp: ts,
      metadata: Object.keys(userMeta).length > 0 ? userMeta : undefined,
    });
    // HUMAN because a person authored it either way: they typed the message, or they typed the
    // objective into the goal mechanism. The stamp is load-bearing — a consumer accepts an
    // objective only from a human turn.
    //
    // An IDE-injected context turn ("# Context from my IDE setup: …") arrives as a
    // `user_message` too, and Codex's payload carries nothing that separates it from a typed
    // one, so it is stamped HUMAN as well. That errs on the safe side: a spurious human turn
    // inside a run's cycle only ever DROPS that run's autonomy, never credits it.
    eventBuilder.addPromptReference(prompts.length, ts, promptReferenceAuthor({ role: "user" }));
    if (pendingUserTimestampMs !== undefined) {
      userTimestampsMs.push(pendingUserTimestampMs);
    }
    userTurns++;
    pendingUserText = undefined;
    pendingUserTimestampMs = undefined;
    pendingApprovalPolicy = undefined;
  };

  // Buffers a typed user turn: the text, the gate active now (held with the text until the turn
  // flushes) and the envelope timestamp for the timing signals.
  const bufferUserTurn = (message: string, envTs: unknown): void => {
    pendingUserText = message;
    lastPrompt = message;
    pendingApprovalPolicy = currentApprovalPolicy;
    if (typeof envTs === "string") {
      const ms = Date.parse(envTs);
      if (!isNaN(ms)) pendingUserTimestampMs = ms;
    }
  };

  // The texts of this turn's user turns, by the record form that carried them. A rollout can
  // write one turn in both forms (`user_message` and an `item_completed` UserMessage), so a text
  // in one form is that turn's twin when the other form already carried it in the same turn, and
  // is skipped. Each twin is used once, so the same text typed twice in one turn is two turns.
  // Cleared at task_started, the turn boundary that precedes both forms.
  const turnUserTextsFromEvents: string[] = [];
  const turnUserTextsFromItems: string[] = [];
  const takeTwin = (otherForm: string[], message: string): boolean => {
    const i = otherForm.indexOf(message);
    if (i < 0) return false;
    otherForm.splice(i, 1);
    return true;
  };

  // Pre-pass: learn which call_ids the response_item form carries, and the structured verdict each
  // `*_end` record states — both needed while emitting during the main walk, before file order
  // would reveal them. Order-independent by construction: a call's two forms can appear in either
  // order, and a `*_end` twin must be recognised as such wherever it sits.
  for (let i = 1; i < lines.length; i++) {
    const pl = parseRolloutLine(lines[i]!);
    if (!pl) continue;
    const payload = toRecord(pl["payload"]);
    const t = typeof payload["type"] === "string" ? (payload["type"] as string) : "";
    const cid = typeof payload["call_id"] === "string" ? (payload["call_id"] as string) : undefined;
    if (pl["type"] === "response_item" && t.endsWith("_call") && !t.endsWith("_call_output")) {
      if (cid) riCallIds.add(cid);
    } else if (
      pl["type"] === "event_msg" &&
      (t === "exec_command_end" || t === "patch_apply_end" || t === "mcp_tool_call_end")
    ) {
      if (cid) endOutcomeByCallId.set(cid, endRecordOutcome(t, payload));
    }
  }

  for (let i = 1; i < lines.length; i++) {
    const line = parseRolloutLine(lines[i]!);
    if (!line) continue;

    // Count any record kind the corpus has never shown us — the vendor-drift
    // tripwire — before the dispatch below drops the ones it does not read.
    noteUnknownRecordKind("codex", codexRecordKind(line));

    // response_item carries the tool timeline (calls and their results). event_msg carries the
    // turns and the richer per-tool signals. Both are walked in file order, so tool events and
    // prompt references share one monotonically increasing sequence — which is what a consumer
    // orders the timeline on.
    if (line["type"] === "response_item") {
      emitResponseItemTool(
        toRecord(line["payload"]),
        typeof line["timestamp"] === "string" ? (line["timestamp"] as string) : undefined,
      );
      continue;
    }

    // A `turn_context` precedes each turn and is authoritative for that turn's approval_policy.
    // A known value sets the gate; a present-but-unrecognized one (e.g. a vendor-added policy) means
    // the gate changed to a value we can't vet, so clear it rather than forward-fill the previous
    // turn's gate — the schema promises unset when unknown, and an unvetted string never ships. An
    // absent field is a gap, not a change, so the last known value stays (that is the forward-fill).
    if (line["type"] === "turn_context") {
      const turnPayload = toRecord(line["payload"]);
      const ap = turnPayload["approval_policy"];
      if (typeof ap === "string") {
        currentApprovalPolicy = CODEX_APPROVAL_POLICIES.has(ap) ? ap : undefined;
      }
      const turnModel = turnPayload["model"];
      if (modelOverride === undefined && typeof turnModel === "string" && turnModel.length > 0) model = turnModel;
      continue;
    }

    if (line["type"] !== "event_msg") continue;

    const payload = toRecord(line["payload"]);
    const evType = payload["type"];

    if (evType === "user_message") {
      // Shape guard on the message-bearing field: the next line reads `message` ONLY
      // as a string, so both an absent `message` AND a valid alternate shape (a
      // content-block array) make the human turn vanish — userTurns stays zero and the
      // caller drops the whole session. A string on every real record of this kind
      // (verified against the fixtures). Codex's token field is deliberately NOT
      // guarded: `token_count` records are absent in a zero-token session and their
      // `info.last_token_usage` is legitimately absent on a boot record, so a guard
      // there would cry wolf (the parser already tolerates both).
      requireConsumedShape("codex", "event_msg/user_message", "payload.message", payload["message"], "string");
      const message = typeof payload["message"] === "string" ? payload["message"].trim() : "";
      if (message && takeTwin(turnUserTextsFromItems, message)) continue;
      flushPendingUser();
      if (message) {
        turnUserTextsFromEvents.push(message);
        bufferUserTurn(message, line["timestamp"]);
      }
      continue;
    }

    // Codex 0.118 and later write the user's turn as this item instead of a `user_message`.
    // Its text is the concatenation of the `text` entries of `content`, joined with no
    // separator, which is how Codex derives `user_message.message` from the same item, so
    // both forms of one turn compare equal. Other entries (images) carry no text.
    if (evType === "item_completed") {
      const item = toRecord(payload["item"]);
      if (item["type"] !== "UserMessage") continue;
      const content = requireConsumedShape(
        "codex", "event_msg/item_completed/UserMessage", "payload.item.content", item["content"], "array",
      );
      const message = (Array.isArray(content) ? content : [])
        .map((entry) => toRecord(entry))
        .filter((entry) => entry["type"] === "text" && typeof entry["text"] === "string")
        .map((entry) => entry["text"] as string)
        .join("")
        .trim();
      if (!message || takeTwin(turnUserTextsFromEvents, message)) continue;
      flushPendingUser();
      turnUserTextsFromItems.push(message);
      bufferUserTurn(message, line["timestamp"]);
      continue;
    }

    // A `/goal` thread reports its objective here and nowhere else a rollout reader can see.
    // The objective is the instruction the person gave, so the FIRST report of it becomes the
    // session's opening user turn — without which `userTurns` stays zero and the caller drops
    // the whole session. Later reports only refresh the counters: the objective does not change
    // within a thread, and re-pushing it would invent turns nobody took.
    if (evType === "thread_goal_updated") {
      const goalObj = toRecord(payload["goal"]);
      const objective =
        typeof goalObj["objective"] === "string" ? goalObj["objective"].trim() : "";
      const status = typeof goalObj["status"] === "string" ? goalObj["status"] : "";
      const tokensUsed = typeof goalObj["tokensUsed"] === "number" ? goalObj["tokensUsed"] : 0;
      const timeUsedSeconds =
        typeof goalObj["timeUsedSeconds"] === "number" ? goalObj["timeUsedSeconds"] : 0;
      const createdAt = typeof goalObj["createdAt"] === "number" ? goalObj["createdAt"] : 0;
      // A report with no objective still carries fresh counters, so refresh from it rather
      // than dropping the whole event — a status change can arrive with the objective cleared.
      if (!objective) {
        if (goal !== undefined) {
          goal = { ...goal, status, tokensUsed, timeUsedSeconds, updates: goal.updates + 1 };
        }
        continue;
      }
      // Refresh vs second invocation, written as one inline condition so the refresh arm
      // narrows `goal` to defined. `createdAt` is the discriminator: Codex re-reports the
      // running goal on every state change, but re-invoking `/goal` in the same thread mints a
      // new one — and a real captured thread does exactly that, two invocations each with their
      // own createdAt and their own task_started/task_complete. Keying on absence alone counted
      // those as one and lost an attempt.
      if (
        goal !== undefined &&
        (createdAt === 0 || createdAt === goalCreatedAt) &&
        objective === goal.objective
      ) {
        goal = { ...goal, status, tokensUsed, timeUsedSeconds, updates: goal.updates + 1 };
        continue;
      }
      {
        goal = { objective, status, tokensUsed, timeUsedSeconds, updates: 1 };
        goalCreatedAt = createdAt;
        goalInvocations++;
        flushPendingUser();
        // Prefixed with the canonical command. Codex records the objective as goal STATE and
        // never writes the invocation as text, so without this a consumer sees a bare sentence
        // and its marker scan — which matches a slash command at a prompt's opening — counts no
        // declaration. The person did invoke `/goal` with this objective. Writing the `/goal`
        // form makes that invocation countable, and it is the same shape a harness that DOES
        // record the command produces.
        pendingUserText = `${GOAL_COMMAND_PREFIX}${objective}`;
        lastPrompt = pendingUserText;
        // Snapshot the gate active now, held with the buffered text until this turn flushes.
        pendingApprovalPolicy = currentApprovalPolicy;
        // Emitted BEFORE the turn it declares is flushed, which is what positions it: the
        // consumer attributes a declaration to the first prompt reference at or after its own
        // sequence, so a GOAL event pushed here lands on this invocation's own turn rather
        // than on the previous one.
        //
        // The status is not carried. `thread_goal_updated` only ever reports `active` — the
        // terminal status lives in the CLI's goal store — and the event has no field that
        // could hold it honestly: its `outcome` is a four-value enum against a six-value
        // status vocabulary, and its summary field is read as the run's objective.
        eventBuilder.addGoalDeclaration({
          objective,
          at: typeof line["timestamp"] === "string" ? line["timestamp"] : undefined,
        });
        const envTs = line["timestamp"];
        if (typeof envTs === "string") {
          const ms = Date.parse(envTs);
          if (!isNaN(ms)) pendingUserTimestampMs = ms;
        }
      }
      continue;
    }

    if (evType === "turn_aborted") {
      userInterruptions++;
      continue;
    }

    if (evType === "token_count") {
      const info = toRecord(payload["info"]);
      const lastUsage = toRecord(info["last_token_usage"]);
      if (Object.keys(lastUsage).length > 0) {
        pendingUsage = extractUsage(lastUsage);
      }
      if (typeof info["model_context_window"] === "number") {
        pendingModelContextWindow = info["model_context_window"];
      }
      continue;
    }

    if (evType === "exec_command_end") {
      // Timeline: only when this record is END-ONLY (no response_item twin — an older rollout).
      // A twinned record's timeline comes from response_item, so emitting here too would
      // double-count. The rest of this block is signals (files, git, PR), always read.
      const execCallId = typeof payload["call_id"] === "string" ? (payload["call_id"] as string) : undefined;
      if (!execCallId || !riCallIds.has(execCallId)) {
        const cmdArr = payload["command"];
        const shellCmd = Array.isArray(cmdArr) ? String(cmdArr[cmdArr.length - 1] ?? "") : "";
        emitEndOnlyPair({
          name: "exec_command",
          outcome: endRecordOutcome("exec_command_end", payload),
          callSummary: shellCmd || undefined,
          resultSummary:
            typeof payload["aggregated_output"] === "string" ? (payload["aggregated_output"] as string) : undefined,
          callId: execCallId,
          at: typeof line["timestamp"] === "string" ? (line["timestamp"] as string) : undefined,
        });
      }

      // Track files read by the agent (existing signal).
      const parsedCmd = payload["parsed_cmd"];
      if (Array.isArray(parsedCmd)) {
        for (const cmd of parsedCmd) {
          const c = toRecord(cmd);
          if (c["type"] === "read" && typeof c["path"] === "string" && c["path"].length > 0) {
            trackedFilePathSet.add(c["path"] as string);
          }
        }
      }

      // Detect git commits and pushes from the command array.
      const exitCode = payload["exit_code"];
      if (typeof exitCode === "number" && exitCode !== 0) {
        toolErrors++;
        toolErrorCategories["exec_fail"] = (toolErrorCategories["exec_fail"] ?? 0) + 1;
      }
      if (exitCode === 0) {
        const command = payload["command"];
        // command shape: ["/bin/zsh", "-lc", "<actual shell command>"]
        const shellCmd = Array.isArray(command)
          ? String(command[command.length - 1] ?? "")
          : "";
        if (shellCmd.includes("git commit")) {
          gitCommits++;
          const output = typeof payload["aggregated_output"] === "string"
            ? (payload["aggregated_output"] as string)
            : "";
          const insertMatch = output.match(/(\d+) insertion/);
          const deleteMatch = output.match(/(\d+) deletion/);
          if (insertMatch) {
            const n = parseInt(insertMatch[1]!, 10);
            if (!isNaN(n)) linesAddedFromCommands += n;
          }
          if (deleteMatch) {
            const n = parseInt(deleteMatch[1]!, 10);
            if (!isNaN(n)) linesRemovedFromCommands += n;
          }
        }
        if (shellCmd.includes("git push")) {
          gitPushes++;
        }
        // PR detection from gh pr create output. Accumulate every distinct
        // PR the session opens — a single session can cut multiple PRs.
        // The parser is host-agnostic, so `gh` output or equivalents on
        // GitLab / Bitbucket self-hosted all resolve correctly.
        if (shellCmd.includes("gh pr create") || shellCmd.includes("glab mr create")) {
          const output = typeof payload["aggregated_output"] === "string"
            ? (payload["aggregated_output"] as string)
            : "";
          const ref = findPRUrlInText(output);
          if (ref) {
            addPrLink({ prUrl: ref.pr_url, prNumber: ref.pr_number, prRepository: ref.pr_repository });
          }
        }
      }
      continue;
    }

    if (evType === "patch_apply_end") {
      // Timeline: only when END-ONLY (no response_item twin). A failed apply is emitted too, so a
      // broken edit still shows in the timeline the analyzer reads.
      const patchCallId = typeof payload["call_id"] === "string" ? (payload["call_id"] as string) : undefined;
      if (!patchCallId || !riCallIds.has(patchCallId)) {
        const patchChanges = payload["changes"];
        const patchFiles =
          patchChanges && typeof patchChanges === "object" && !Array.isArray(patchChanges)
            ? Object.keys(patchChanges as Record<string, unknown>)
            : [];
        emitEndOnlyPair({
          name: "apply_patch",
          outcome: endRecordOutcome("patch_apply_end", payload),
          callSummary: patchFiles.length > 0 ? patchFiles.join(", ") : undefined,
          callId: patchCallId,
          at: typeof line["timestamp"] === "string" ? (line["timestamp"] as string) : undefined,
        });
      }

      const success = payload["success"];
      if (success !== true) continue;
      const changes = payload["changes"];
      if (changes && typeof changes === "object" && !Array.isArray(changes)) {
        for (const [filePath, change] of Object.entries(changes as Record<string, unknown>)) {
          if (filePath.length === 0) continue;
          patchedFilePathSet.add(filePath);
          pendingEditFiles.add(filePath);
          // Each file's change carries a unified_diff; count its real +/- lines
          // into this turn's totals (stamped on the turn's assistant message).
          const diff = change && typeof change === "object" ? (change as { unified_diff?: unknown }).unified_diff : undefined;
          if (typeof diff === "string") {
            const { added, removed } = countUnifiedDiffLines(diff);
            pendingLinesAdded += added;
            pendingLinesRemoved += removed;
          }
        }
      }
      continue;
    }

    if (evType === "mcp_tool_call_end") {
      usesMcp = true;
      const invocation = toRecord(payload["invocation"]);
      const server = typeof invocation["server"] === "string" ? invocation["server"] : "unknown";
      const tool = typeof invocation["tool"] === "string" ? invocation["tool"] : "unknown";
      const key = `${server}/${tool}`;
      mcpToolCounts[key] = (mcpToolCounts[key] ?? 0) + 1;

      // Timeline: only when END-ONLY (no response_item twin). A twinned MCP call's result adopts
      // this record's Err/success verdict via endOutcomeByCallId, so the failure is preserved
      // without a second emission here.
      const mcpCallId = typeof payload["call_id"] === "string" ? (payload["call_id"] as string) : undefined;
      if (!mcpCallId || !riCallIds.has(mcpCallId)) {
        emitEndOnlyPair({
          name: tool,
          outcome: endRecordOutcome("mcp_tool_call_end", payload),
          callSummary: key,
          callId: mcpCallId,
          at: typeof line["timestamp"] === "string" ? (line["timestamp"] as string) : undefined,
        });
      }

      // Web search/fetch via MCP tool name — use exact allowlist to avoid matching
      // local-codebase tools like "code_search", "file_search", "fetch_schema".
      const toolLower = tool.toLowerCase();
      if (CODEX_MCP_WEB_SEARCH_TOOLS.has(toolLower)) usesWebSearch = true;
      if (CODEX_MCP_WEB_FETCH_TOOLS.has(toolLower)) usesWebFetch = true;

      // MCP tool error detection: result has an Err variant.
      const result = toRecord(payload["result"]);
      if ("Err" in result) {
        toolErrors++;
        toolErrorCategories["mcp_fail"] = (toolErrorCategories["mcp_fail"] ?? 0) + 1;
      }

      // Extract PR link from MCP PR-creation tool results. Accumulate every
      // distinct PR — MCP can be invoked more than once per session, and
      // the parser handles GitLab / Bitbucket MCP servers too.
      if (tool === "github_create_pull_request" || tool === "gitlab_create_merge_request") {
        const result = toRecord(payload["result"]);
        const ok = toRecord(result["Ok"]);
        const content = ok["content"];
        if (Array.isArray(content)) {
          for (const item of content) {
            const c = toRecord(item);
            const text = typeof c["text"] === "string" ? c["text"] : "";
            const ref = findPRUrlInText(text);
            if (ref) {
              addPrLink({ prUrl: ref.pr_url, prNumber: ref.pr_number, prRepository: ref.pr_repository });
              break;
            }
          }
        }
      }
      continue;
    }

    if (evType === "context_compacted") {
      // Codex compacts its own context window and records a bare marker (timestamp +
      // type only — no trigger or pre-compaction token detail, unlike Claude's
      // compact_boundary). Count it for the session-level compaction_count. We do NOT
      // emit a positional COMPACTION timeline event: the engine attributes a COMPACTION
      // to the turn whose PROMPT_REFERENCE most recently preceded it, and Codex emits its
      // prompt reference buffered at turn-end (flushPendingUser fires at task_complete),
      // so a mid-turn boundary would attribute to the previous turn. The session count is
      // a plain total, unaffected by position.
      compactionCount++;
      continue;
    }

    if (evType === "task_started") {
      // The provider's native turn-opening edge. A second task_started with no
      // intervening task_complete means the prior turn was abandoned (retried or
      // truncated): reset its edit/usage/context buffers so they are not stamped
      // onto the next turn's closing message. Prompt buffering is preserved — it
      // intentionally spans records. On the first task_started the buffers are
      // already empty (the prior task_complete cleared them), so this is a no-op.
      resetTurnBuffers();
      turnUserTextsFromEvents.length = 0;
      turnUserTextsFromItems.length = 0;
      eventBuilder.addTurnStarted(typeof line["timestamp"] === "string" ? line["timestamp"] : undefined);
      continue;
    }

    if (evType === "task_complete") {
      // Flush the user turn first
      flushPendingUser();

      // Flush the assistant turn
      const agentMsg =
        typeof payload["last_agent_message"] === "string"
          ? payload["last_agent_message"].trim()
          : "";
      if (agentMsg) {
        const assistantPrompt = buildAssistantPrompt(agentMsg, model, pendingUsage, pendingModelContextWindow, {
          files: [...pendingEditFiles],
          added: pendingLinesAdded,
          removed: pendingLinesRemoved,
        });
        prompts.push(assistantPrompt);
        // The assistant prompt carries no timestamp of its own, so the envelope's is the only
        // time this turn has. Ordering does not depend on it — a consumer orders on `sequence`.
        eventBuilder.addPromptReference(
          prompts.length,
          typeof line["timestamp"] === "string" ? line["timestamp"] : undefined,
          promptReferenceAuthor(assistantPrompt),
        );
      }
      // Close the native bracket after the turn's content. A turn that never
      // reaches task_complete emits no close — a turn grouper ends it at the next
      // TURN_STARTED or the timeline end.
      eventBuilder.addTurnCompleted(typeof line["timestamp"] === "string" ? line["timestamp"] : undefined);
      resetTurnBuffers();
      continue;
    }
  }

  // Handle incomplete sessions (no task_complete yet — task still running)
  flushPendingUser();

  // Coverage is computed honestly from what the timeline observed — no blanket flat cap. The
  // timeline reads the `response_item` form (the superset of the old `event_msg`-end subset,
  // including native tools that appear only there), so `coverage()` sees the real set of calls and
  // results. COMPLETE therefore means what it means everywhere: tool calls plus a majority of
  // results carrying an explicit outcome. Most Codex results report no exit status (`exec`'s script
  // output carries none), so an exec-heavy session lands at PARTIAL on the honest rule.
  //
  // A `/goal` thread is the one case held to PARTIAL regardless: its human continuations arrive as
  // `response_item` messages the parser does not read as turns (the `<codex_internal_context
  // source="goal">` re-injection every goal thread carries), so the timeline cannot see a
  // mid-cycle human turn — and a session whose human turns are provably incomplete must not claim
  // full legibility. Run detection is unaffected; only the legibility rating is held.
  const rawCoverage = eventBuilder.coverage();
  const eventCoverage: EventCoverage =
    goal !== undefined && rawCoverage === "EVENT_COVERAGE_COMPLETE" ? "EVENT_COVERAGE_PARTIAL" : rawCoverage;

  return {
    cwd, gitBranch, gitCommitHashFromMeta, gitRepositoryUrlFromMeta,
    model, source, originator, prompts, userTurns,
    trackedFilePaths: [...trackedFilePathSet],
    patchedFilePaths: [...patchedFilePathSet],
    userTimestampsMs,
    gitCommits, gitPushes, linesAddedFromCommands, linesRemovedFromCommands,
    usesMcp, usesWebSearch, usesWebFetch,
    prLinks, mcpToolCounts,
    lastPrompt, userInterruptions, toolErrors, toolErrorCategories,
    compactionCount,
    goal, goalInvocations,
    // The normalized timeline for this session: the goal declaration (when any), the prompt turns,
    // and the tool calls/results read from response_item — emitted for every session, as the
    // Claude Code and Cursor extractors do.
    sessionEvents: eventBuilder.build(),
    eventCoverage,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildAssistantPrompt(
  content: string,
  model: string | undefined,
  usage: TokenUsage | undefined,
  modelContextWindow: number | undefined,
  edits: { files: string[]; added: number; removed: number }
): ConversationPrompt {
  const metadata: PromptMetadata = {};
  if (model) metadata.model = model;
  // The turn's edits (from its patch_apply_end records) land on the assistant
  // message that closes it. Line counts are present (incl. 0) whenever a file was
  // edited — the unset-vs-zero distinction the wire keeps.
  if (edits.files.length > 0) {
    metadata.filesEdited = edits.files;
    metadata.linesAdded = edits.added;
    metadata.linesRemoved = edits.removed;
  }
  if (usage?.input_tokens) metadata.inputTokens = usage.input_tokens;
  if (usage?.output_tokens) metadata.outputTokens = usage.output_tokens;
  if (usage?.cached_input_tokens) metadata.cacheReadInputTokens = usage.cached_input_tokens;
  // !== undefined, not truthiness: reasoning_tokens is optional to distinguish an
  // unsupported split (absent) from a measured zero. extractUsage preserves a
  // reported 0, so a truthiness check would collapse that measured zero to absent.
  if (usage?.reasoning_tokens !== undefined) metadata.reasoningTokens = usage.reasoning_tokens;
  // Context occupancy = the last request's total ÷ the model's window, both from
  // the same token_count record. Guard the window so a zero/absent one can't divide.
  // The per-message contextUsagePercent field is a 0.0–1.0 fraction (see
  // PromptMetadata.contextUsagePercent), so store the raw
  // ratio — rounded to 0.1% granularity — not a 0–100 percentage.
  if (usage?.total_tokens && modelContextWindow && modelContextWindow > 0) {
    metadata.contextUsagePercent = Math.round((usage.total_tokens / modelContextWindow) * 1000) / 1000;
  }
  // Codex reports exact per-turn token counts, so any token-bearing message is
  // MEASURED. A message with no counts stays UNSPECIFIED by absence.
  if (usage?.input_tokens || usage?.output_tokens) {
    metadata.tokenFidelity = "TOKEN_FIDELITY_MEASURED";
  }
  return {
    role: "assistant",
    content,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

// ── response_item tool summaries and outcomes ─────────────────────────────────

// Arguments-string keys that name the work a call did, in preference order. A file body or diff is
// deliberately never among them — a command or path names the work; its contents are not needed to.
const CALL_ARG_SUMMARY_KEYS = [
  "cmd", "command", "query", "pattern", "path", "file_path", "description", "url",
] as const;

// Summarizes a call from its JSON `arguments` string (function_call and native `<tool>_call`), by
// the first key that names the work. Returns undefined when the arguments are absent, unparseable,
// or carry none of those keys — the builder then ships the call under its tool name alone.
function summarizeCallArgs(argsJson: unknown): string | undefined {
  if (typeof argsJson !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  for (const key of CALL_ARG_SUMMARY_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return undefined;
}

// The files an apply_patch envelope touches — the summary names them without carrying the diff
// body. Codex writes the V4A patch format, whose file headers are `*** Add|Update|Delete File: <p>`.
function summarizeApplyPatch(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const files: string[] = [];
  const re = /^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    const p = m[1]!.trim();
    if (p.length > 0) files.push(p);
  }
  return files.length > 0 ? files.join(", ") : undefined;
}

// The verdict a response_item result states, when it states one an actor could not author. Used
// only for a response_item-only tool — a twinned call takes the structured outcome from its
// `*_end` record (endOutcomeByCallId) instead.
//  - exec_command's output is a structured runner report: a `<header>\nOutput:\n<stdout>` envelope
//    whose header line is `Process exited with code N` (an exited process) or `Process running
//    with session ID N` (still running → UNKNOWN). The exit is read from the HEADER only, never
//    from the stdout that follows — a still-running process can print "Process exited with code 0"
//    into its own stdout, and reading that as the runner's verdict would invert the result.
//  - apply_patch's output is JSON carrying metadata.exit_code.
// Every other result — including the `exec` script tool, whose output carries no exit status — is
// UNKNOWN, never synthesized into a pass a consumer would read as a verdict. Keyed on the tool
// NAME (resolved from the call) so an unrelated tool's text is never mistaken for a command verdict.
function responseItemOutcome(name: string | undefined, output: unknown): SessionEventOutcome {
  if (typeof output !== "string") return "SESSION_EVENT_OUTCOME_UNKNOWN";
  if (name === "exec_command") {
    // Header is the region before the `\nOutput:\n` delimiter. Absent the delimiter there is no
    // structured status to trust, so UNKNOWN rather than scanning raw output.
    const delim = output.indexOf("\nOutput:\n");
    if (delim < 0) return "SESSION_EVENT_OUTCOME_UNKNOWN";
    const header = output.slice(0, delim);
    const m = /^Process exited with code (\d+)$/m.exec(header);
    if (m) return outcomeForExitCode(parseInt(m[1]!, 10));
    return "SESSION_EVENT_OUTCOME_UNKNOWN";
  }
  if (name === "apply_patch") {
    try {
      const parsed = JSON.parse(output) as Record<string, unknown>;
      const meta = parsed?.["metadata"];
      if (meta && typeof meta === "object") {
        const code = (meta as Record<string, unknown>)["exit_code"];
        if (typeof code === "number") return outcomeForExitCode(code);
      }
    } catch {
      // output not JSON — fall through to UNKNOWN.
    }
  }
  return "SESSION_EVENT_OUTCOME_UNKNOWN";
}

// The verdict a structured `*_end` record states. These records carry the outcome as a typed field
// rather than as text: exec_command_end's integer `exit_code`, patch_apply_end's boolean `success`,
// mcp_tool_call_end's `result` Err/Ok variant. Used both to dedup-preserve a twinned result's
// verdict (endOutcomeByCallId) and to score an end-only record's own result.
function endRecordOutcome(evType: string, payload: Record<string, unknown>): SessionEventOutcome {
  if (evType === "exec_command_end") {
    return typeof payload["exit_code"] === "number"
      ? outcomeForExitCode(payload["exit_code"] as number)
      : "SESSION_EVENT_OUTCOME_UNKNOWN";
  }
  if (evType === "patch_apply_end") {
    return payload["success"] === true
      ? "SESSION_EVENT_OUTCOME_SUCCEEDED"
      : "SESSION_EVENT_OUTCOME_FAILED";
  }
  if (evType === "mcp_tool_call_end") {
    // Codex records an MCP result as a Result enum: `{ Ok: … }` or `{ Err: … }`. The Err variant
    // is the only failure signal on this record.
    return "Err" in toRecord(payload["result"])
      ? "SESSION_EVENT_OUTCOME_FAILED"
      : "SESSION_EVENT_OUTCOME_SUCCEEDED";
  }
  return "SESSION_EVENT_OUTCOME_UNKNOWN";
}

// Counts added/removed lines in a unified diff — a `+`/`-` line that is NOT the
// `+++`/`---` file header. This is the actual line-level delta, unlike the gross
// block sizes a diff-less surface (Kiro str_replace) must fall back to.
function countUnifiedDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

function extractUsage(usage: Record<string, unknown>): TokenUsage | undefined {
  const result: TokenUsage = {};
  if (typeof usage["input_tokens"] === "number") result.input_tokens = usage["input_tokens"];
  if (typeof usage["cached_input_tokens"] === "number")
    result.cached_input_tokens = usage["cached_input_tokens"];
  if (typeof usage["output_tokens"] === "number") result.output_tokens = usage["output_tokens"];
  // reasoning_output_tokens is the vendor field; it feeds reasoning_tokens only —
  // never folded into output_tokens (it is already a subset of it).
  if (typeof usage["reasoning_output_tokens"] === "number")
    result.reasoning_tokens = usage["reasoning_output_tokens"];
  if (typeof usage["total_tokens"] === "number") result.total_tokens = usage["total_tokens"];
  return Object.keys(result).length > 0 ? result : undefined;
}

// True if `table` has `column`, via PRAGMA table_info. Lets the reader tolerate a
// vendor column absent on an older schema version rather than throwing on SELECT.
// `table` is always a code-literal here (never user input), so interpolation is safe.
function tableHasColumn(reader: SQLiteReader, table: string, column: string): boolean {
  try {
    const cols = reader.query<{ name: string }>(`PRAGMA table_info(${table})`);
    return cols.some((c) => c.name === column);
  } catch {
    return false;
  }
}

// Returns the first argument that is a non-blank string (after trimming),
// trimmed; undefined if none qualify. Used to resolve session_title as
// name (user rename) → title (AI), so a null/empty rename can't shadow the title.
function firstNonBlank(...vals: Array<string | null | undefined>): string | undefined {
  for (const v of vals) {
    if (typeof v === "string") {
      const t = v.trim();
      if (t.length > 0) return t;
    }
  }
  return undefined;
}

function toRecord(val: unknown): Record<string, unknown> {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return {};
}