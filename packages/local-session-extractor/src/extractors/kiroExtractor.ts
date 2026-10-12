// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";
import { createHash } from "node:crypto";
import type {
  ConversationPrompt,
  InstallationMetadata,
  SessionMetaPayload,
} from "../types/session";
import type { SessionSink } from "../types/store";
import { getKiroStorageJsonPath, getKiroGlobalStoragePath, getKiroUserMcpPath } from "./pathResolver";
import { detectKiroPlanTier } from "./planTierDetector";
import { logger } from "../seams/logger";
import { extractKiroDesktop } from "./kiroDesktopExtractor";
import { extractKiroIde } from "./kiroIdeExtractor";
import { extractKiroCli } from "./kiroCliExtractor";
import { extractKiroCrew } from "./kiroCrewExtractor";
import { deriveLanguages } from "./languageMap";
import { SIGNAL_SOURCE, outranksSource, type SignalSource } from "./signalSource";
import { GIT_CREATE_BRANCH, GIT_INVOCATION } from "./cursorAttributionSignals";
import type { SessionPRLink } from "./gitUtils";
import type { KiroAttributionEvent } from "./kiroAttribution";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KiroSessionsIndexEntry {
  sessionId: string;
  title?: string;
  dateCreated?: string;
  workspaceDirectory?: string;
}

export interface KiroUserTurnMetadata {
  loop_id?: { agent_id?: { name?: string; parent_id?: string | null }; rand?: number };
  total_request_count?: number;
  number_of_cycles?: number;
  builtin_tool_uses?: number;
  turn_duration?: { secs?: number; nanos?: number };
  /** "UserTurnEnd" on a normal turn; "ToolUseRejected" when the user denied a tool. */
  end_reason?: string;
  end_timestamp?: string;
  // Kiro meters in credits, not tokens: both are present on every turn but read 0
  // in captured sessions, so the totals they feed stay unset rather than being
  // written as measured zeros.
  input_token_count?: number;
  output_token_count?: number;
  context_usage_percentage?: number;
  /** Model resolved for this turn, e.g. "claude-opus-4.8" or the "auto" router alias. */
  model?: string;
  /** HTTP attempts including retries; exceeds total_request_count when requests were retried. */
  request_attempts?: number;
  /** Characters in the user's prompt for this turn. */
  user_prompt_length?: number;
  /** Characters in the assistant's reply for this turn. */
  assistant_response_length?: number;
  metering_usage?: Array<{ value?: number; unit?: string }>;
}

export interface KiroLegacySessionJson {
  sessionId?: string;
  title?: string;
  workspacePath?: string;
  workspaceDirectory?: string;
  autonomyMode?: string;
  sessionType?: string;
  selectedModel?: string;
  contextUsagePercentage?: number;
  initialContextEstimate?: {
    usagePercentage?: number;
    mcpToolsPercentage?: number;
    steeringPercentage?: number;
  };
  history?: Array<{
    message?: {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
      id?: string;
    };
    promptLogs?: Array<{
      modelTitle?: string;
      completionOptions?: { maxTokens?: number; model?: string };
    }>;
    contextItems?: unknown[];
  }>;
}

export interface KiroCliSessionJson {
  session_id?: string;
  cwd?: string;
  created_at?: string;
  updated_at?: string;
  title?: string;
  /** Why the session was created — "subagent" when Kiro spawned it as a delegate. */
  session_created_reason?: string;
  /** Top-level link to the parent session when this is a delegate's own session.
   *  The authoritative subagent signal for usage attribution (corroborated by
   *  session_created_reason); distinct from the turn-level loop_id.agent_id.parent_id. */
  parent_session_id?: string;
  session_state?: {
    version?: string;
    conversation_metadata?: { user_turn_metadatas?: KiroUserTurnMetadata[] };
    rts_model_state?: {
      model_info?: { model_id?: string; context_window_tokens?: number };
      context_usage_percentage?: number;
    };
    permissions?: {
      filesystem?: {
        allowed_read_paths?: string[];
        allowed_write_paths?: string[];
        denied_read_paths?: string[];
        denied_write_paths?: string[];
      };
      trusted_tools?: string[];
      denied_tools?: string[];
      allowed_commands?: string[];
    };
    agent_name?: string;
  };
}

export interface CliJsonlLine {
  version?: string;
  kind?: string;
  data?: {
    message_id?: string;
    content?: Array<{ kind?: string; data?: unknown }>;
    /** Present on `Prompt` lines only. `timestamp` is epoch SECONDS, not millis. */
    meta?: { timestamp?: number };
  };
}

export interface ParsedCliContent {
  prompts: ConversationPrompt[];
  toolCounts: Record<string, number>;
  toolErrors: number;
  filesEdited: Set<string>;
  composerSuggestedLines: number;
  lastPrompt: string | undefined;
  /** Epoch millis of each user prompt, in file order. Empty when unavailable. */
  userPromptTimestampsMs: number[];
  /** True when any assistant message carried a `thinking` content block. */
  usesExtendedThinking: boolean;
  /** Files the session read, from `read` tool operations — for tracked_file_paths. */
  filesRead: Set<string>;
  /** `git push` invocations whose tool result succeeded. */
  gitPushes: number;
  /** Authoring evidence for PR/branch recovery — see kiroAttribution.ts. */
  attributionEvents: KiroAttributionEvent[];
  /** Tool calls keyed by the plugin/MCP server that served them; "default" = built-in. */
  toolOriginCounts: Record<string, number>;
}

export interface ExecRecordSummary {
  toolCounts: Record<string, number>;
  billingCreditsUsed: number;
  steeringInclusionCount: number;
  filesEdited: Set<string>;
  composerSuggestedLines: number;
}

export interface SharedSessionFieldsInput {
  projectPath: string | null | undefined;
  artifacts: { specCount: number; steeringFileCount: number; hookCount: number };
  mcpServers: string[];
  // A resolved PR link always carries all three parts (see SessionPRLink), so
  // pr_references can be built without partial entries.
  prLink: SessionPRLink | null;
  usesWebSearch: boolean;
  usesWebFetch: boolean;
  languages: Record<string, number> | undefined;
  firstPrompt: string | undefined;
  lastPrompt: string | undefined;
}

/**
 * Names the provider a tool came from, for `tool_origin_counts`.
 *
 * A Kiro plugin (an MCP server, or an Open Plugin) does NOT open its own
 * conversation the way a Claude Code or Codex subagent does — it is invoked
 * inside the session that used it. So the plugin is identified as a property of
 * that session rather than becoming a session of its own, and the session is
 * never folded or skipped on its account.
 *
 * Kiro namespaces a plugin-provided tool by its server: `@kirocrew-cron/cron_list`
 * (the CLI's own form) or the `server__tool` MCP convention. Anything unnamespaced
 * is a built-in.
 */
export function toolProvider(toolName: string): string {
  const at = /^@([^/]+)\//.exec(toolName);
  if (at) return at[1]!;
  const mcp = /^([A-Za-z0-9_.-]+?)__/.exec(toolName);
  if (mcp) return mcp[1]!;
  return "default";
}

/**
 * Matches `git push` at the start of a command, after a shell separator, or after
 * a control-flow / wrapper keyword — `cd x && git push`, `if git push origin f;
 * then …`, `time git push` all count. Only executable text ever reaches this (the
 * single caller strips data spans first), so `echo "git push"` cannot match.
 *
 * The keyword list is a closed set rather than "any word", which would make the
 * separator requirement meaningless and match a push named as an argument.
 *
 * Shared by both Kiro surfaces — the IDE names the shell tool `execute_bash`,
 * the CLI names it `shell`, but a push is recognised identically on each. A push
 * leaves no trace in local git history, so the shell transcript is the only source.
 */
const COMMAND_POSITION = String.raw`(^|[;&|(){}\n]\s*|\b(?:if|then|elif|else|do|while|until|time|exec|nohup|sudo|command|env)\s+)!?\s*`;

const GIT_PUSH_RE = new RegExp(COMMAND_POSITION + GIT_INVOCATION + String.raw`push\b`);

/**
 * A branch-creating `git checkout` / `git switch` in command position — the branch-creating
 * twin of GIT_PUSH_RE, sharing its boundary so the two cannot drift apart.
 */
const GIT_CREATE_BRANCH_RE = new RegExp(
  COMMAND_POSITION + GIT_INVOCATION + GIT_CREATE_BRANCH + String.raw`\b`,
);

/**
 * True when a shell command really invokes `git push`.
 *
 * Quoted spans are removed first, because the separator test alone is
 * quote-blind: `echo "run tests; git push"` puts a `;` right before `git push`
 * inside a string literal and would otherwise be counted as a push that never
 * happened — an over-count, the opposite of the intended bias.
 */
export function commandPushesToGit(command: string): boolean {
  return GIT_PUSH_RE.test(executableShellText(command));
}

/** True when a shell command really creates a branch. See commandPushesToGit. */
export function commandCreatesBranch(command: string): boolean {
  return GIT_CREATE_BRANCH_RE.test(executableShellText(command));
}

/**
 * Strips the parts of a shell command that are DATA rather than executable text,
 * so a `git push` mentioned inside a string or a written file is not counted as
 * one that ran.
 *
 * Every branch here drops text rather than keeping it, so an input this cannot
 * parse confidently loses a real push instead of inventing one — the bias
 * `commandPushesToGit` promises. Naive quote-stripping gets that backwards: a
 * regex over complete `'…'`/`"…"` pairs leaves an UNTERMINATED quote entirely
 * unstripped, so the rest of the line stays visible and matches.
 */
export function executableShellText(command: string): string {
  // 1. Heredoc bodies. `cat <<EOF > deploy.sh … git push … EOF` writes a file
  //    whose text merely mentions a push. Unterminated heredocs drop to the end.
  const text = command
    .replace(/<<[-~]?\s*(['"]?)(\w+)\1[\s\S]*?^[ \t]*\2[ \t]*$/gm, " ")
    .replace(/<<[-~]?\s*(['"]?)(\w+)\1[\s\S]*$/, " ");

  // 2. Quoted spans, scanned rather than regex-matched so an unterminated quote
  //    really does drop the remainder. Inside "…", a backslash escapes the next
  //    character; inside '…' shell performs no escaping.
  let out = "";
  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    // Outside a span a backslash escapes the next character, so `\'` is a literal
    // quote and must not open one — otherwise the `'it'\''s` idiom for embedding
    // a quote swallows the rest of the command, including a real push.
    if (ch === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch !== "'" && ch !== '"') {
      out += ch;
      i++;
      continue;
    }
    let j = i + 1;
    let closed = false;
    while (j < text.length) {
      if (ch === '"' && text[j] === "\\") { j += 2; continue; }
      if (text[j] === ch) { closed = true; break; }
      j++;
    }
    if (!closed) return out; // unterminated — the remainder is not parseable
    out += " ";
    i = j + 1;
  }
  return out;
}

// ── Language detection ────────────────────────────────────────────────────────

// Known Kiro built-in local search tools — must not be misidentified as web search.
const KIRO_LOCAL_TOOLS = new Set([
  "grepsearch", "listsearch", "codesearch", "filesearch",
  "listdirectory", "readfile", "readmultiplefiles", "fswrite", "terminalcommand",
]);

// Thin wrapper over the shared deriveLanguages, preserving the Set input and
// undefined-when-empty return that kiroCli/kiroDesktop callers rely on.
export function getLanguagesFromFiles(filePaths: Set<string>): Record<string, number> | undefined {
  const langs = deriveLanguages(filePaths);
  return Object.keys(langs).length > 0 ? langs : undefined;
}

export function inferWebToolUsage(
  toolCounts: Record<string, number>,
): { usesWebSearch: boolean; usesWebFetch: boolean } {
  const names = Object.keys(toolCounts).map((n) => n.toLowerCase());
  return {
    usesWebSearch: names.some(
      (n) =>
        n.includes("brave") || n.includes("tavily") || n.includes("bing") ||
        n === "websearch" || n === "web_search" ||
        (n.includes("search") && !KIRO_LOCAL_TOOLS.has(n)),
    ),
    usesWebFetch: names.some(
      (n) => n.includes("fetch") || n.includes("http_request") || n.includes("browse"),
    ),
  };
}

// ── Workspace artifact counters ───────────────────────────────────────────────

function safeCountFiles(dir: string, filter: (name: string) => boolean): number {
  if (!existsSync(dir)) return 0;
  try { return readdirSync(dir).filter(filter).length; } catch { return 0; }
}

/** Hook manifests in `dir`: every `.kiro.hook`, plus each `.json` that declares triggers. */
function countHookManifests(dir: string): number {
  if (!existsSync(dir)) return 0;
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  let count = 0;
  for (const name of names) {
    if (name.startsWith(".")) continue;
    if (name.endsWith(".kiro.hook")) { count++; continue; }
    if (!name.endsWith(".json")) continue;
    try {
      if (hasHookDeclaration(readFileSync(join(dir, name), "utf-8"))) count++;
    } catch { /* unreadable — not a countable hook */ }
  }
  return count;
}

function safeCountSubdirs(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  } catch { return 0; }
}

/**
 * True when a `.kiro/hooks/*.json` file really is a hook manifest: a `hooks`
 * array whose entries carry a `trigger`. Kiro hooks fire on SessionStart /
 * PreToolUse / PostToolUse / PostFileSave and act via `{type:"command"}` (run a
 * shell command) or `{type:"agent"}` (inject a prompt into the session).
 *
 * Scratch JSON counted as a hook would report Kiro hook adoption as healthier
 * than it is, so only a manifest that declares triggers counts.
 */
function hasHookDeclaration(content: string): boolean {
  try {
    const raw = JSON.parse(content) as { hooks?: unknown };
    return Array.isArray(raw?.hooks) &&
      raw.hooks.some((h) => !!h && typeof h === "object" && "trigger" in (h as object));
  } catch {
    return false;
  }
}

export function countWorkspaceArtifacts(
  workspacePath: string,
): { specCount: number; steeringFileCount: number; hookCount: number } {
  if (!workspacePath || !existsSync(workspacePath)) {
    return { specCount: 0, steeringFileCount: 0, hookCount: 0 };
  }
  return {
    specCount: safeCountSubdirs(join(workspacePath, ".kiro", "specs")),
    steeringFileCount: safeCountFiles(join(workspacePath, ".kiro", "steering"), (f) => f.endsWith(".md")),
    // Kiro hooks ship as either a .json or a .kiro.hook manifest. A .json must
    // actually declare triggers (see countHookManifests), so scratch JSON in that directory cannot inflate the count.
    hookCount: countHookManifests(join(workspacePath, ".kiro", "hooks")),
  };
}

/** Server names declared in one `mcp.json`-shaped file. Empty when absent/malformed. */
function readMcpServerNames(mcpPath: string): string[] {
  if (!existsSync(mcpPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(mcpPath, "utf-8")) as Record<string, unknown>;
    const servers = raw["mcpServers"];
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      return Object.keys(servers as Record<string, unknown>);
    }
  } catch { /* malformed */ }
  return [];
}

/**
 * MCP servers available to a session, as the UNION of Kiro's two config scopes:
 * user-level `~/.kiro/settings/mcp.json` (applies to every session) and
 * workspace-level `<workspace>/.kiro/settings/mcp.json`.
 *
 * Reading only the workspace file under-reported every user who configures MCP
 * globally — the common case — leaving `uses_mcp` false for sessions that did
 * have servers.
 *
 * Semantics, stated because the field now has more than one source: this is
 * **configured and reachable for the session**, not "invoked". It deliberately
 * does NOT include a CLI agent's own `mcpServers` block — that is per-agent and
 * can suppress these entirely via `includeMcpJson: false`, so folding it in here
 * would report servers a session could not reach. User-scope entries are listed
 * first so the order is stable regardless of which workspace a session ran in.
 */
export function readKiroMcpServers(workspacePath?: string): string[] {
  const userServers = readMcpServerNames(getKiroUserMcpPath());
  const workspaceServers = workspacePath
    ? readMcpServerNames(join(workspacePath, ".kiro", "settings", "mcp.json"))
    : [];
  const merged: string[] = [];
  for (const name of [...userServers, ...workspaceServers]) {
    if (!merged.includes(name)) merged.push(name);
  }
  return merged;
}

// ── Session meta builder ──────────────────────────────────────────────────────

export function buildSharedSessionFields(input: SharedSessionFieldsInput): Partial<SessionMetaPayload> {
  return {
    project_path: input.projectPath ?? undefined,
    spec_count: input.artifacts.specCount || undefined,
    steering_file_count: input.artifacts.steeringFileCount || undefined,
    hook_count: input.artifacts.hookCount || undefined,
    mcp_server_names: input.mcpServers.length > 0 ? input.mcpServers : undefined,
    uses_mcp: input.mcpServers.length > 0 || undefined,
    // No branch field here by design. Kiro transcripts do not record the branch
    // per message the way Claude Code's do, so the only branch this builder
    // could offer is the checkout's HEAD read at EXTRACTION time — whatever the
    // developer happened to be on when the scan ran, not what the session
    // worked on. A branch matcher cannot tell the two apart and treats it as
    // strong evidence, so every session extracted in one sitting would be
    // attributed to whichever PR owned that branch. Branch evidence for Kiro comes only from
    // the transcript (collectKiroAttribution), which the IDE and CLI set
    // directly; a surface that recovers none reports none.
    // The three scalars are deprecated in favour of pr_references but stay
    // populated with the first reference for readers that predate the array.
    // pr_references is what PR attribution prefers, so writing only the scalars
    // would send Kiro rows down a different attribution path than every other
    // IDE. getSessionPRLink resolves at most one PR, hence a one-element array.
    pr_url: input.prLink?.prUrl,
    pr_number: input.prLink?.prNumber,
    pr_repository: input.prLink?.prRepository,
    // Stamped ambient, because that is what it is: this reference comes from
    // reading the local checkout near the session, not from anything the session
    // did. It names a PR precisely and says nothing about whether this session
    // contributed to it, so it may narrow a search and must never attribute on
    // its own. A recovered reference for the same PR supersedes this source.
    pr_references: input.prLink
      ? [{
          pr_url: input.prLink.prUrl,
          pr_number: input.prLink.prNumber,
          pr_repository: input.prLink.prRepository,
          source: SIGNAL_SOURCE.LOCAL_GIT_WINDOWED,
        }]
      : undefined,
    uses_web_search: input.usesWebSearch || undefined,
    uses_web_fetch: input.usesWebFetch || undefined,
    languages: input.languages,
    first_prompt: input.firstPrompt,
    last_prompt: input.lastPrompt,
  };
}

/**
 * Writes recovered branches onto a session_meta blob, in both shapes.
 *
 * Both fields, not one: branch_signals carries the provenance a reader needs to
 * tell a branch the session proved from one the workspace merely held, while
 * git_branches keeps a reader that predates provenance working. A reader can
 * merge them, so neither is redundant.
 *
 * Shared by the two Kiro surfaces so the invariant lives in one place, like
 * mergeRecoveredPRRefs below.
 */
export function applyRecoveredBranches(
  sessionMeta: SessionMetaPayload,
  recovered: { branches: string[]; branchSignals: Array<{ name: string; source: string }> },
): void {
  if (recovered.branchSignals.length === 0) return;
  sessionMeta.git_branches = recovered.branches;
  sessionMeta.branch_signals = recovered.branchSignals;
}

/**
 * Unions PR references recovered from the transcript into a session_meta blob.
 *
 * Ordering matters: whatever is already there came from `getSessionPRLink`, a
 * commit-message scan, and stays first so the deprecated scalars keep pointing at
 * the same PR they did before. Recovered refs are appended and deduped by
 * (repo, number).
 *
 * When the session had no PR at all, the recovered refs also populate the
 * scalars, so a reader that predates `pr_references` still sees the PR.
 */
export function mergeRecoveredPRRefs(
  sessionMeta: SessionMetaPayload,
  recovered: Array<{ pr_url: string; pr_number: number; pr_repository: string; source?: string }>,
): void {
  if (recovered.length === 0) return;

  const merged = [...(sessionMeta.pr_references ?? [])];
  const indexByKey = new Map<string, number>();
  merged.forEach((r, i) => indexByKey.set(`${r.pr_repository}#${r.pr_number}`, i));
  for (const ref of recovered) {
    const key = `${ref.pr_repository}#${ref.pr_number}`;
    const at = indexByKey.get(key);
    if (at !== undefined) {
      // Already present, from the local-checkout read. Keep the entry's position
      // but take the stronger provenance: one session can hold both a `gh pr
      // create` receipt and the same PR scraped out of a nearby commit, and
      // letting the scrape win would downgrade evidence the session produced
      // into evidence that can only scope a search.
      const existing = merged[at]!;
      if (ref.source && outranksSource(ref.source as SignalSource, existing.source)) {
        merged[at] = { ...existing, source: ref.source };
      }
      continue;
    }
    indexByKey.set(key, merged.length);
    merged.push(ref);
  }
  sessionMeta.pr_references = merged;

  const first = merged[0];
  if (first && !sessionMeta.pr_url) {
    sessionMeta.pr_url = first.pr_url;
    sessionMeta.pr_number = first.pr_number;
    sessionMeta.pr_repository = first.pr_repository;
  }
}

export function normalizeAgentMode(mode: string | undefined): "agent" | "spec" | "vibe" | undefined {
  if (!mode) return undefined;
  const lower = mode.toLowerCase();
  if (lower === "spec") return "spec";
  if (lower === "agent") return "agent";
  if (lower === "vibe") return "vibe";
  return undefined;
}

export function normalizeAutonomyMode(mode: string | undefined): "supervised" | "autopilot" | undefined {
  if (!mode) return undefined;
  const lower = mode.toLowerCase();
  if (lower === "autopilot") return "autopilot";
  if (lower === "supervised") return "supervised";
  return undefined;
}

// ── Execution records (legacy desktop backfill) ───────────────────────────────

type DiffIndexEntry = { groupDir: string; fileName: string };

function computeKiroWorkspaceHash(workspacePath: string): string {
  return createHash("sha256").update(workspacePath).digest("hex").slice(0, 32);
}

function processExecGroupFile(
  execPath: string,
  sessionId: string,
  result: ExecRecordSummary,
  diffIndex: Map<string, DiffIndexEntry[]>,
  execRootDir: string,
): void {
  try {
    const record = JSON.parse(readFileSync(execPath, "utf-8")) as {
      chatSessionId?: string;
      usageSummary?: Array<{ usedTools?: string[]; usage?: number }>;
      actions?: Array<{ actionType?: string; input?: { file?: string; modified?: string } }>;
    };
    if (record.chatSessionId !== sessionId) return;

    for (const summary of record.usageSummary ?? []) {
      result.billingCreditsUsed += summary.usage ?? 0;
      for (const tool of summary.usedTools ?? []) {
        result.toolCounts[tool] = (result.toolCounts[tool] ?? 0) + 1;
      }
    }

    for (const action of record.actions ?? []) {
      const actionType = action.actionType ?? "";
      if (actionType === "steering") result.steeringInclusionCount++;
      if (actionType === "create" || actionType === "modify" || actionType === "fsWrite") {
        const filePath = action.input?.file;
        if (filePath) result.filesEdited.add(filePath);

        // The query string in kiro-diff URIs is percent-encoded (e.g. %3D for =).
        const modified = action.input?.modified ?? "";
        if (modified.startsWith("kiro-diff:")) {
          try {
            const rawQuery = modified.split("?")[1] ?? "";
            const params = new URLSearchParams(decodeURIComponent(rawQuery));
            const commitId = params.get("commitId");
            if (commitId && filePath) {
              const existing = diffIndex.get(commitId) ?? [];
              existing.push({ groupDir: execRootDir, fileName: filePath });
              diffIndex.set(commitId, existing);
            }
          } catch { /* skip malformed URI */ }
        }
      }
    }
  } catch { /* skip malformed record */ }
}

function indexDiffStoreDir(storeDir: string, diffIndex: Map<string, DiffIndexEntry[]>): void {
  let commitIds: string[];
  try { commitIds = readdirSync(storeDir); } catch { return; }

  for (const commitId of commitIds) {
    const commitDir = join(storeDir, commitId);
    let isDir: boolean;
    try { isDir = statSync(commitDir).isDirectory(); } catch { continue; }
    if (!isDir) continue;

    let diffFiles: string[];
    try { diffFiles = readdirSync(commitDir); } catch { continue; }
    for (const diffFile of diffFiles) {
      const existing = diffIndex.get(commitId) ?? [];
      existing.push({ groupDir: commitDir, fileName: diffFile });
      diffIndex.set(commitId, existing);
    }
  }
}

/**
 * Reads Kiro execution records for a legacy desktop session.
 *
 * Records live at kiro.kiroagent/<sha256[:32]-workspace-path>/<execGroupHash>/<execId>.
 * Each record links to a session via chatSessionId and contains per-turn tool lists,
 * credit usage, and file actions with optional kiro-diff content URIs.
 */
export function readExecutionRecords(workspacePath: string, sessionId: string): ExecRecordSummary {
  const result: ExecRecordSummary = {
    toolCounts: {},
    billingCreditsUsed: 0,
    steeringInclusionCount: 0,
    filesEdited: new Set(),
    composerSuggestedLines: 0,
  };

  const hash = computeKiroWorkspaceHash(workspacePath);
  const execRootDir = join(getKiroGlobalStoragePath(), "kiro.kiroagent", hash);
  if (!existsSync(execRootDir)) return result;

  let groupEntries: string[];
  try { groupEntries = readdirSync(execRootDir); } catch { return result; }

  const diffIndex = new Map<string, DiffIndexEntry[]>();

  for (const entry of groupEntries) {
    const entryPath = join(execRootDir, entry);
    let isDir: boolean;
    try { isDir = statSync(entryPath).isDirectory(); } catch { continue; }
    if (!isDir) continue;

    let children: string[];
    try { children = readdirSync(entryPath); } catch { continue; }

    // Distinguish ExecGroup dirs (children are JSON files) from DiffStore dirs (children are subdirs).
    const firstChild = children[0];
    if (!firstChild) continue;
    let firstChildIsDir: boolean;
    try { firstChildIsDir = statSync(join(entryPath, firstChild)).isDirectory(); } catch { continue; }

    if (!firstChildIsDir) {
      for (const execFile of children) {
        processExecGroupFile(join(entryPath, execFile), sessionId, result, diffIndex, execRootDir);
      }
    } else {
      indexDiffStoreDir(entryPath, diffIndex);
    }
  }

  for (const [, entries] of diffIndex) {
    for (const { groupDir, fileName } of entries) {
      if (!result.filesEdited.has(fileName)) continue;
      const filePath = join(groupDir, fileName);
      if (!existsSync(filePath)) continue;
      try {
        result.composerSuggestedLines += readFileSync(filePath, "utf-8").split("\n").filter(Boolean).length;
      } catch { /* skip */ }
    }
  }

  return result;
}

// ── Machine ID ────────────────────────────────────────────────────────────────

function readKiroMachineId(): string | undefined {
  const storagePath = getKiroStorageJsonPath();
  if (!existsSync(storagePath)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(storagePath, "utf-8")) as Record<string, unknown>;
    // "telemetry.devDeviceId" is a stable UUID; "telemetry.machineId" is a hex hash.
    const machineId = raw["telemetry.devDeviceId"] ?? raw["telemetry.machineId"];
    if (typeof machineId === "string" && machineId.length > 0) return machineId;
  } catch { /* malformed */ }
  return undefined;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Extracts Kiro IDE sessions from Desktop (new format + legacy) and CLI sources.
 * Returns the number of sessions upserted.
 *
 * Extraction order:
 *  1. New IDE format (~/.kiro/sessions/{hash}/sess_{uuid}/) — primary
 *  2. Legacy desktop format (globalStorage/workspace-sessions/) — fallback for older data
 *  3. CLI sessions (~/.kiro/sessions/cli/) — separate format, always extracted
 *  4. Crew sessions (~/.kiro/crew/) — separate format, always extracted
 */
export function extractKiro(db: SessionSink): number {
  logger.info("extraction.kiro", "extraction_start", {});

  const tierInfo = detectKiroPlanTier();
  const machineId = readKiroMachineId();

  const installMeta: InstallationMetadata = {
    ...(tierInfo ?? {}),
    platform: platform(),
    entrypoint: "kiro",
    ...(machineId ? { ide_machine_id: machineId } : {}),
  };

  // New IDE format (session.json + messages.jsonl) — covers current Kiro versions
  const ideCount = extractKiroIde(db, installMeta);
  // Legacy desktop format (flat JSON in globalStorage) — fallback for older sessions
  const legacyDesktopCount = extractKiroDesktop(db, installMeta);
  // CLI sessions — separate path, always extracted
  const cliCount = extractKiroCli(db, installMeta);
  // Crew — the autonomous-agent surface, and Kiro's only source of cost
  const crewCount = extractKiroCrew(db, installMeta);
  const total = ideCount + legacyDesktopCount + cliCount + crewCount;

  logger.info("extraction.kiro", "extraction_complete", {
    ideCount,
    legacyDesktopCount,
    cliCount,
    crewCount,
    total,
  });
  return total;
}
