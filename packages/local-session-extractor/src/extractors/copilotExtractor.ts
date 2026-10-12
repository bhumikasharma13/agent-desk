// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { platform, tmpdir } from "node:os";
import type { ConversationPrompt, InstallationMetadata, PromptMetadata, SessionMetaPayload } from "../types/session";
import { openVendorDb } from "./sqliteReader";
import type { SessionSink } from "../types/store";
import { redactPrompts, redactPath, sanitizeSessionMeta } from "../redaction";
import {
  getCopilotCLISessionStatePath,
  getCopilotJBAppsJsonPath,
  getCopilotJBMcpJsonPath,
  getCopilotJBVersionsJsonPath,
  getCopilotVSCodeGlobalDbPath,
  getCopilotVSCodeUserDataPath,
  getCopilotVSCodeWorkspaceStoragePath,
  homeDir,
} from "./pathResolver";
import {
  type CopilotCLIContext,
  type CopilotJBGlobalMetadata,
  detectCopilotCLIMetadata,
  detectCopilotJBMetadata,
  detectCopilotVSCodeMetadata,
  readCopilotJBGlobalMetadata,
} from "./planTierDetector";
import { resolveProjectAndRepo, getFullSessionDiffStats, getSessionPRLink, getGitHeadSha } from "./gitUtils";
import { fileUriPath } from "./fileUri";
import { findPRUrlInText } from "./prUrlParser";
import { logger } from "../seams/logger";
import { reportRecordError, reportSourceError } from "../seams/scanScope";

// ════════════════════════════════════════════════════════════════════════════
// VS CODE COPILOT
// ════════════════════════════════════════════════════════════════════════════

// ── VS Code session index types ───────────────────────────────────────────────

interface SessionIndexEntry {
  sessionId: string;
  title?: string;
  lastMessageDate?: number; // unix ms
  isEmpty?: boolean;
  isExternal?: boolean;
}

interface SessionIndex {
  version?: number;
  entries?: Record<string, SessionIndexEntry>;
}

// ── Shared request/response types ────────────────────────────────────────────

interface ResponseItem {
  kind?: string;
  value?: string;
}

interface ResultUsage {
  promptTokens?: number;
  completionTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

interface LegacyRequest {
  requestId?: string;
  timestamp?: number;
  message?: { text?: string };
  response?: ResponseItem[];
  modelId?: string;
  isCanceled?: boolean;
}

interface LegacySession {
  version?: number;
  requests?: LegacyRequest[];
}

interface RawJsonlRequest {
  requestId?: string;
  timestamp?: number;
  message?: {
    text?: string;
    parts?: Array<{ kind?: string; value?: string; text?: string }>;
  };
  response?: ResponseItem[];
  result?: { usage?: ResultUsage };
  modelId?: string;
  isCanceled?: boolean;
}

interface VSCodeSessionFile {
  sessionId: string;
  filePath: string;
  ext: ".json" | ".jsonl";
}

const VSCODE_VARIANTS = ["Code", "Code - Insiders"] as const;

// ── Session index reading ─────────────────────────────────────────────────────

function readSessionIndex(dbPath: string): Map<string, SessionIndexEntry> {
  const map = new Map<string, SessionIndexEntry>();
  if (!existsSync(dbPath)) return map;
  try {
    const db = openVendorDb(dbPath, 3000);
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("chat.ChatSessionStore.index") as { value: string } | undefined;
      if (!row) return map;
      const index = JSON.parse(row.value) as SessionIndex;
      for (const entry of Object.values(index.entries ?? {})) {
        if (typeof entry.sessionId === "string") map.set(entry.sessionId, entry);
      }
    } finally {
      db.close();
    }
  } catch {
    // DB locked or malformed — continue with empty index
  }
  return map;
}

// ── Workspace MCP server reading ─────────────────────────────────────────────
//
// VS Code stores its active MCP server list in the workspace state.vscdb under
// the key "mcp.extCachedServers" as a JSON array of server descriptor objects.
// We read only the names (no secrets) and attach them to project_mcp_server_names.

function readWorkspaceMcpServers(dbPath: string): string[] {
  if (!existsSync(dbPath)) return [];
  try {
    const db = openVendorDb(dbPath, 3000);
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("mcp.extCachedServers") as { value: string } | undefined;
      if (!row) return [];
      const servers = JSON.parse(row.value) as Array<{ name?: string; id?: string }>;
      return servers.map((s) => s.name ?? s.id ?? "").filter((n) => n.length > 0);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

// ── Workspace map building ────────────────────────────────────────────────────

function buildWorkspaceFolderMap(workspaceStoragePath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(workspaceStoragePath)) return map;
  let entries: string[];
  try { entries = readdirSync(workspaceStoragePath); } catch { return map; }
  for (const entry of entries) {
    try {
      const wsJsonPath = join(workspaceStoragePath, entry, "workspace.json");
      if (!existsSync(wsJsonPath)) continue;
      const wsJson = JSON.parse(readFileSync(wsJsonPath, "utf8")) as Record<string, unknown>;
      const folderUri = wsJson["folder"];
      if (typeof folderUri === "string" && folderUri.startsWith("file://")) {
        const folderPath = fileUriPath(folderUri);
        if (folderPath) map.set(entry, folderPath);
      }
    } catch { /* skip malformed workspace.json */ }
  }
  return map;
}

// ── Text extraction helpers ───────────────────────────────────────────────────

function extractMessageText(
  message: RawJsonlRequest["message"] | LegacyRequest["message"]
): string {
  if (!message) return "";
  if (typeof message.text === "string" && message.text.trim()) return message.text.trim();
  if (Array.isArray((message as RawJsonlRequest["message"])?.parts)) {
    return ((message as RawJsonlRequest["message"])!.parts!)
      .map((p) => p.text ?? p.value ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function extractResponseText(items: ResponseItem[]): string {
  return items
    .filter((item) => item.kind == null && typeof item.value === "string")
    .map((item) => item.value!)
    .join("")
    .trim();
}

// ── PR links ─────────────────────────────────────────────────────────────────

type PrLink = { prUrl: string; prNumber: number; prRepository: string };

/** A list of distinct PR links, keyed by repository and number, in first-seen order. */
function prLinkCollector(): { links: PrLink[]; add: (pr: PrLink) => void } {
  const links: PrLink[] = [];
  const keys = new Set<string>();
  return {
    links,
    add: (pr) => {
      const key = `${pr.prRepository}#${pr.prNumber}`;
      if (keys.has(key)) return;
      keys.add(key);
      links.push(pr);
    },
  };
}

/**
 * Writes PR links onto session_meta: `pr_references` carries every distinct PR
 * the session touched, and the scalar fields carry the first one for readers
 * that only read the scalars. No links, no change.
 */
function applyPrLinks(meta: SessionMetaPayload, links: readonly PrLink[]): void {
  const first = links[0];
  if (first === undefined) return;
  meta.pr_url = first.prUrl;
  meta.pr_number = first.prNumber;
  meta.pr_repository = first.prRepository;
  meta.pr_references = links.map((p) => ({ pr_url: p.prUrl, pr_number: p.prNumber, pr_repository: p.prRepository }));
}

// ── JSONL / legacy JSON parsing ───────────────────────────────────────────────

function reconstructPrompts(requests: RawJsonlRequest[]): ConversationPrompt[] {
  const prompts: ConversationPrompt[] = [];
  for (const req of requests) {
    if (req.isCanceled) continue;
    const at = req.timestamp != null ? new Date(req.timestamp).getTime() : Number.NaN;
    const ts = Number.isFinite(at) ? new Date(at).toISOString() : undefined;

    const userText = extractMessageText(req.message);
    if (userText) {
      const meta: PromptMetadata = {};
      if (req.modelId) meta.model = req.modelId;
      if (req.result?.usage?.promptTokens) meta.inputTokens = req.result.usage.promptTokens;
      if (req.result?.usage?.cacheCreationInputTokens) meta.cacheCreationInputTokens = req.result.usage.cacheCreationInputTokens;
      if (req.result?.usage?.cacheReadInputTokens) meta.cacheReadInputTokens = req.result.usage.cacheReadInputTokens;
      prompts.push({ role: "user", content: userText, timestamp: ts, metadata: Object.keys(meta).length > 0 ? meta : undefined });
    }

    const assistantText = extractResponseText(req.response ?? []);
    if (assistantText) {
      const meta: PromptMetadata = {};
      if (req.modelId) meta.model = req.modelId;
      if (req.result?.usage?.completionTokens) meta.outputTokens = req.result.usage.completionTokens;
      prompts.push({ role: "assistant", content: assistantText, timestamp: ts, metadata: Object.keys(meta).length > 0 ? meta : undefined });
    }
  }
  return prompts;
}

/**
 * Applies a single VS Code chat-store event (kind=1 SET or kind=2 APPEND) to
 * the in-memory requests array.  Handles all path shapes observed in practice:
 *
 *   k=["requests"]                  append new request(s) (kind=2 only)
 *   k=["requests", n]               replace request at index n (kind=1)
 *   k=["requests", n, "field"]      set scalar/object field (kind=1)
 *   k=["requests", n, "response"]   append response items (kind=2)
 *   k=["requests", n, "result"]     set result object (kind=1)
 *   k=["requests", n, f1, f2, ...]  deep-set nested field (kind=1)
 */
function applyMutation(
  requests: RawJsonlRequest[],
  k: unknown[],
  v: unknown,
  append: boolean
): void {
  if (k.length === 0 || k[0] !== "requests") return;

  if (k.length === 1) {
    // Replace or append the top-level requests array
    if (Array.isArray(v)) {
      if (append) {
        requests.push(...(v as RawJsonlRequest[]));
      }
      // SET on whole array is unusual; ignore to avoid clobbering existing state
    }
    return;
  }

  // The file is untrusted input. The index must be a whole number no further ahead
  // than the next request, so a crafted index cannot allocate without bound or
  // leave `req` undefined.
  const idx = k[1];
  if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx > requests.length) return;
  // A path segment that names a prototype would write onto every object in the process.
  if (k.some((seg) => seg === "__proto__" || seg === "constructor" || seg === "prototype")) return;
  // Extend the array if the index is the next request
  if (requests.length === idx) requests.push({} as RawJsonlRequest);
  const req = requests[idx]!;

  if (k.length === 2) {
    // Replace the entire request object at this index
    if (!append && typeof v === "object" && v !== null) {
      Object.assign(req, v);
    }
    return;
  }

  // Traverse path beyond k[2] for deep-set (e.g. ["requests", n, "message", "text"])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let target: Record<string, any> = req as Record<string, unknown>;
  for (let i = 2; i < k.length - 1; i++) {
    const seg = k[i];
    if (typeof seg !== "string" && typeof seg !== "number") return;
    const key = seg as string;
    if (target[key] == null || typeof target[key] !== "object") target[key] = {};
    target = target[key] as Record<string, unknown>;
  }

  const last = k[k.length - 1];
  if (typeof last !== "string" && typeof last !== "number") return;
  const lastKey = last as string;

  if (append && Array.isArray(v)) {
    const existing = target[lastKey];
    if (Array.isArray(existing)) {
      existing.push(...v);
    } else {
      target[lastKey] = [...v];
    }
  } else if (!append) {
    target[lastKey] = v;
  }
}

// ── Timing signal helpers ─────────────────────────────────────────────────────

/**
 * Given unix-ms timestamps of user messages, computes the three timing signals
 * stored in SessionMetaPayload:
 *   user_message_timestamps — ISO 8601 strings, one per message
 *   user_response_times     — seconds between consecutive user messages (proxy
 *                             for how long the user spent reviewing the AI reply)
 *   message_hours           — hour-of-day (0-23) for each message
 */
function computeTimingSignals(userTimestampsMs: number[]): {
  userMessageTimestamps: string[];
  userResponseTimes: number[];
  messageHours: number[];
} {
  const userMessageTimestamps = userTimestampsMs.map((ms) => new Date(ms).toISOString());
  const userResponseTimes: number[] = [];
  for (let i = 1; i < userTimestampsMs.length; i++) {
    const diffSec = (userTimestampsMs[i]! - userTimestampsMs[i - 1]!) / 1000;
    if (diffSec >= 0) userResponseTimes.push(Math.round(diffSec));
  }
  const messageHours = userTimestampsMs.map((ms) => new Date(ms).getUTCHours());
  return { userMessageTimestamps, userResponseTimes, messageHours };
}

/**
 * Reads Copilot JetBrains per-IDE MCP server names from
 * ~/.config/github-copilot/<ideCode>/mcp.json.
 * Returns empty array if the file is absent or has no servers.
 */
function readCopilotJBMcpServers(mcpJsonPath: string): string[] {
  if (!existsSync(mcpJsonPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(mcpJsonPath, "utf-8")) as Record<string, unknown>;
    // Supports both "servers" (newer Copilot format) and "mcpServers" (VS Code convention)
    const servers = (raw["servers"] ?? raw["mcpServers"]) as Record<string, unknown> | undefined;
    if (!servers || typeof servers !== "object") return [];
    return Object.keys(servers).filter((k) => k.length > 0);
  } catch {
    return [];
  }
}

// Tool IDs that represent file edits/writes (not reads or searches).
const VSCODE_EDIT_TOOL_IDS = new Set([
  "copilot_replaceString",
  "copilot_editFile",
  "copilot_createFile",
  "copilot_renameFile",
  "copilot_deleteFile",
  "copilot_insertEdit",
  "copilot_writeFile",
]);

// Tool IDs that perform web search in VS Code Copilot (MCP-based).
const VSCODE_WEB_SEARCH_TOOL_IDS = new Set([
  "copilot_webSearch", "bing_search", "brave_search", "tavily_search",
]);
// Tool IDs that perform web fetch/browse.
const VSCODE_WEB_FETCH_TOOL_IDS = new Set([
  "copilot_fetchWebPage", "fetch", "browse", "get_url", "read_url",
]);

// Patterns in user message text that imply web search intent.
const WEB_SEARCH_TEXT_RE = /#web\b|@Bing\b/i;

function parseVSCodeJsonl(filePath: string): {
  prompts: ConversationPrompt[];
  sessionTitle?: string;
  /** Unix ms timestamps for each non-cancelled user request, in order. */
  userTimestampsMs: number[];
  usesMcp: boolean;
  usesTaskAgent: boolean;
  usesExtendedThinking: boolean;
  toolCounts: Record<string, number>;
  /** Every distinct PR the session opened, in first-seen order. */
  prLinks: Array<{ prUrl: string; prNumber: number; prRepository: string }>;
  filesEdited: string[];
  lastPrompt: string | undefined;
  userInterruptions: number;
  toolErrors: number;
  usesWebSearch: boolean;
  usesWebFetch: boolean;
} {
  const lines = readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim());
  // Replay all events against a single mutable requests array so that
  // in-place mutations (kind=1 SET) and appends (kind=2) are both applied.
  const requests: RawJsonlRequest[] = [];
  let sessionTitle: string | undefined;

  for (const line of lines) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (typeof event !== "object" || event === null) continue;
    const ev = event as Record<string, unknown>;
    const kind = ev["kind"];
    const k = ev["k"] as unknown[] | undefined;
    const v = ev["v"];

    if (kind === 0) {
      // Snapshot: reset state from the stored value
      const snapshot = v as Record<string, unknown> | undefined;
      if (!snapshot) continue;
      if (typeof snapshot["customTitle"] === "string") sessionTitle = snapshot["customTitle"];
      if (Array.isArray(snapshot["requests"])) {
        requests.length = 0;
        requests.push(...(snapshot["requests"] as RawJsonlRequest[]));
      }
    } else if ((kind === 1 || kind === 2) && Array.isArray(k)) {
      applyMutation(requests, k, v, kind === 2);
    }
  }

  const userTimestampsMs = requests
    .filter((r) => !r.isCanceled && r.timestamp != null && extractMessageText(r.message) !== "")
    .map((r) => new Date(r.timestamp!).getTime())
    .filter((ms) => Number.isFinite(ms));

  // Collect session-level signals from response item kinds.
  let usesMcp = false;
  let usesTaskAgent = false;
  let usesExtendedThinking = false;
  let usesWebSearch = false;
  let usesWebFetch = false;
  let toolErrors = 0;
  let userInterruptions = 0;
  let lastPrompt: string | undefined;
  const toolCounts: Record<string, number> = {};
  const { links: prLinks, add: addPrLink } = prLinkCollector();
  const editedFileUris = new Set<string>();

  for (const req of requests) {
    // Count cancelled requests as user interruptions.
    if (req.isCanceled) {
      userInterruptions++;
      continue;
    }

    // Track last user prompt (most recent non-cancelled user message).
    const msgText = extractMessageText(req.message);
    if (msgText) {
      lastPrompt = msgText;
      // Text-match web search intent: #web or @Bing in the user message.
      if (WEB_SEARCH_TEXT_RE.test(msgText)) usesWebSearch = true;
    }

    // Detect agent mode from request.agent field.
    const agent = (req as Record<string, unknown>)["agent"] as Record<string, unknown> | undefined;
    if (agent) {
      const modes = agent["modes"];
      if (Array.isArray(modes) && modes.includes("agent")) usesTaskAgent = true;
      const agentId = typeof agent["id"] === "string" ? agent["id"] : "";
      if (agentId.includes("editsAgent") || agentId.includes("agentMode")) usesTaskAgent = true;
    }

    // Scan response items for typed kinds.
    for (const item of req.response ?? []) {
      if (item.kind === "mcpServersStarting") {
        usesMcp = true;
      } else if (item.kind === "thinking") {
        // Non-empty value = actual reasoning content (empty items are terminators).
        if (typeof (item as Record<string, unknown>)["value"] === "string" &&
            ((item as Record<string, unknown>)["value"] as string).length > 0) {
          usesExtendedThinking = true;
        }
      } else if (item.kind === "toolInvocationSerialized") {
        const raw = item as Record<string, unknown>;
        const toolId = typeof raw["toolId"] === "string" ? (raw["toolId"] as string) : "unknown";
        // Use toolId as the canonical name; fall back to nested tool.name if absent.
        const tool = raw["tool"] as Record<string, unknown> | undefined;
        const toolName = toolId !== "unknown" ? toolId : (typeof tool?.["name"] === "string" ? (tool["name"] as string) : "unknown");
        toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;

        // Web search/fetch detection via exact allow-list — substring fallback is omitted to
        // avoid false positives from native tools like "code_search", "fetch_schema".
        if (VSCODE_WEB_SEARCH_TOOL_IDS.has(toolId)) usesWebSearch = true;
        if (VSCODE_WEB_FETCH_TOOL_IDS.has(toolId)) usesWebFetch = true;

        // Extract edited file paths from invocationMessage.uris for write/edit tools.
        if (VSCODE_EDIT_TOOL_IDS.has(toolId)) {
          const invMsg = raw["invocationMessage"] as Record<string, unknown> | undefined;
          const uris = invMsg?.["uris"] as Record<string, unknown> | undefined;
          if (uris) {
            for (const uriKey of Object.keys(uris)) {
              if (uriKey.startsWith("file://")) {
                // Decode URL-encoded path and strip any #line-line fragment.
                const decoded = fileUriPath(uriKey).split("#")[0];
                if (decoded) editedFileUris.add(decoded);
              }
            }
          }
        }

        // Tool error detection: result has isError=true or content looks like an error.
        const result = raw["result"] as Record<string, unknown> | undefined;
        if (result) {
          if (result["isError"] === true) {
            toolErrors++;
          } else {
            const content = typeof result["content"] === "string" ? (result["content"] as string) : "";
            if (content.startsWith("Error:") || content.startsWith("ERROR:")) toolErrors++;
          }
          // Check tool result for PR/MR URL. Accumulate every distinct PR —
          // a session can invoke multiple tool calls that each return a PR.
          // Host-agnostic parsing also recognizes GitLab / Bitbucket URLs.
          {
            const content = typeof result["content"] === "string" ? result["content"] as string : "";
            const ref = findPRUrlInText(content);
            if (ref) {
              addPrLink({ prUrl: ref.pr_url, prNumber: ref.pr_number, prRepository: ref.pr_repository });
            }
          }
        }
      }
    }
  }

  const filesEdited = Array.from(editedFileUris);
  return { prompts: reconstructPrompts(requests), sessionTitle, userTimestampsMs, usesMcp, usesTaskAgent, usesExtendedThinking, toolCounts, prLinks, filesEdited, lastPrompt, userInterruptions, toolErrors, usesWebSearch, usesWebFetch };
}

function parseLegacyJson(filePath: string): ConversationPrompt[] {
  const session = JSON.parse(readFileSync(filePath, "utf8")) as LegacySession;
  if (!Array.isArray(session.requests)) return [];
  const requests: RawJsonlRequest[] = session.requests.map((r) => ({
    requestId: r.requestId,
    timestamp: r.timestamp,
    message: r.message,
    response: r.response,
    modelId: r.modelId,
    isCanceled: r.isCanceled,
  }));
  return reconstructPrompts(requests);
}

function scanVSCodeSessionFiles(dir: string): VSCodeSessionFile[] {
  if (!existsSync(dir)) return [];
  let files: string[];
  try { files = readdirSync(dir); } catch { return []; }
  const sessions: VSCodeSessionFile[] = [];
  for (const file of files) {
    const ext = extname(file);
    if (ext !== ".json" && ext !== ".jsonl") continue;
    const sessionId = basename(file, ext);
    if (sessionId) sessions.push({ sessionId, filePath: join(dir, file), ext: ext as ".json" | ".jsonl" });
  }
  return sessions;
}

function processVSCodeSession(
  db: SessionSink,
  session: VSCodeSessionFile,
  folderPath: string | undefined,
  indexEntry: SessionIndexEntry | undefined,
  installationMeta: InstallationMetadata | null,
  workspaceDbPath?: string
): boolean {
  if (indexEntry?.isEmpty) return false;
  if (indexEntry?.isExternal) return false;

  let lastMtimeMs: number;
  // lastSize stays 0 when lastMessageDate is used as the dedup key — the timestamp
  // alone uniquely identifies session state, so size comparison is skipped intentionally.
  let lastSize = 0;
  if (indexEntry?.lastMessageDate != null) {
    lastMtimeMs = indexEntry.lastMessageDate;
  } else {
    try {
      const st = statSync(session.filePath);
      lastMtimeMs = st.mtimeMs;
      lastSize = st.size;
    } catch { return false; }
  }

  const tracking = db.getTracking("copilot", session.sessionId);
  if (tracking && tracking.last_mtime_ms === lastMtimeMs && tracking.last_size === lastSize) {
    // Only rescan git metadata when it's missing — avoids a filesystem walk on every
    // scan for the common case where project_path is already resolved.
    if (folderPath && (!tracking.project_path || !tracking.repo_name)) {
      const resolved = resolveProjectAndRepo(folderPath);
      const redactedPath = redactPath(resolved?.projectPath ?? folderPath);
      if (redactedPath !== tracking.project_path) db.updateProjectPath("copilot", session.sessionId, redactedPath);
      if (resolved?.repoName && resolved.repoName !== tracking.repo_name) db.updateRepoName("copilot", session.sessionId, resolved.repoName);
    }
    return false;
  }

  let prompts: ConversationPrompt[];
  let sessionTitle: string | undefined = indexEntry?.title;
  let userTimestampsMs: number[] = [];
  let usesMcp = false;
  let usesTaskAgent = false;
  let usesExtendedThinking = false;
  let usesWebSearch = false;
  let usesWebFetch = false;
  let toolCounts: Record<string, number> = {};
  let toolErrors = 0;
  let userInterruptions = 0;
  let vscodePrLinks: Array<{ prUrl: string; prNumber: number; prRepository: string }> = [];
  let vscodeFilesEdited: string[] = [];
  let lastPrompt: string | undefined;
  try {
    if (session.ext === ".jsonl") {
      const result = parseVSCodeJsonl(session.filePath);
      prompts = result.prompts;
      sessionTitle ??= result.sessionTitle;
      userTimestampsMs = result.userTimestampsMs;
      usesMcp = result.usesMcp;
      usesTaskAgent = result.usesTaskAgent;
      usesExtendedThinking = result.usesExtendedThinking;
      usesWebSearch = result.usesWebSearch;
      usesWebFetch = result.usesWebFetch;
      toolCounts = result.toolCounts;
      toolErrors = result.toolErrors;
      userInterruptions = result.userInterruptions;
      vscodePrLinks = result.prLinks;
      vscodeFilesEdited = result.filesEdited;
      lastPrompt = result.lastPrompt;
    } else {
      prompts = parseLegacyJson(session.filePath);
    }
  } catch (err) {
    logger.warn("extraction.copilot", "vscode_session_parse_error", {
      sessionId: session.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  if (prompts.filter((p) => p.role === "user").length === 0) return false;

  const resolved = folderPath ? resolveProjectAndRepo(folderPath) : undefined;
  const finalProjectPath = resolved?.projectPath ?? folderPath;
  const redactedProjectPath = finalProjectPath ? redactPath(finalProjectPath) : undefined;

  const userCount = prompts.filter((p) => p.role === "user").length;
  const assistantCount = prompts.filter((p) => p.role === "assistant").length;
  const meta: SessionMetaPayload = {};
  if (sessionTitle) meta.session_title = sessionTitle;
  if (userCount > 0) meta.user_message_count = userCount;
  if (assistantCount > 0) meta.assistant_message_count = assistantCount;

  if (userTimestampsMs.length > 0) {
    const { userMessageTimestamps, userResponseTimes, messageHours } = computeTimingSignals(userTimestampsMs);
    if (userMessageTimestamps.length > 0) meta.user_message_timestamps = userMessageTimestamps;
    if (userResponseTimes.length > 0) meta.user_response_times = userResponseTimes;
    if (messageHours.length > 0) meta.message_hours = messageHours;
  }

  // Response-kind signals from parsed JSONL.
  if (usesMcp) meta.uses_mcp = true;
  if (usesTaskAgent) meta.uses_task_agent = true;
  if (usesExtendedThinking) meta.uses_extended_thinking = true;
  if (usesWebSearch) meta.uses_web_search = true;
  if (usesWebFetch) meta.uses_web_fetch = true;
  if (Object.keys(toolCounts).length > 0) meta.tool_counts = toolCounts;
  if (toolErrors > 0) meta.tool_errors = toolErrors;
  if (userInterruptions > 0) meta.user_interruptions = userInterruptions;
  if (lastPrompt) meta.last_prompt = lastPrompt;
  applyPrLinks(meta, vscodePrLinks);
  if (vscodeFilesEdited.length > 0) meta.files_edited = vscodeFilesEdited;

  // Per-workspace MCP server names from the workspace state.vscdb.
  if (workspaceDbPath) {
    const wsMcpServers = readWorkspaceMcpServers(workspaceDbPath);
    if (wsMcpServers.length > 0) meta.project_mcp_server_names = wsMcpServers;
  }

  // Git diff metrics: committed changes in the session window + uncommitted dirty state.
  // Use the first user message timestamp as session start (available from JSONL sessions).
  // Falls back to uncommitted-only when no timestamps are present (legacy JSON sessions).
  if (finalProjectPath) {
    const sessionStartMs = userTimestampsMs.length > 0 ? userTimestampsMs[0] : undefined;
    const diff = getFullSessionDiffStats(finalProjectPath, sessionStartMs, lastMtimeMs);
    if (diff.linesAdded > 0) meta.lines_added = diff.linesAdded;
    if (diff.linesRemoved > 0) meta.lines_removed = diff.linesRemoved;
    if (diff.filesModified > 0) meta.files_modified = diff.filesModified;
    if (diff.gitCommits > 0) meta.git_commits = diff.gitCommits;

    // Capture HEAD SHA at the time of the session.
    const headSha = getGitHeadSha(finalProjectPath);
    if (headSha) meta.git_sha = headSha;

    // PR fallback: scan git commit messages if tool detection didn't find a PR.
    if (!meta.pr_url) {
      const prFromGit = getSessionPRLink(finalProjectPath, sessionStartMs, lastMtimeMs);
      if (prFromGit) {
        applyPrLinks(meta, [prFromGit]);
      }
    }
  }

  db.upsert({
    ideType: "copilot",
    sessionId: session.sessionId,
    conversation: redactPrompts(prompts),
    projectPath: redactedProjectPath,
    repoName: resolved?.repoName,
    lastMtimeMs,
    lastSize,
    lastOffset: 0,
    // lastMtimeMs already resolves to the session-index lastMessageDate when present and the
    // file mtime otherwise, so it is always a real source time — never null, which would make
    // the store date the session to the row insert time (today).
    conversationSourceCreatedAtMs: lastMtimeMs,
    sessionMeta: Object.keys(meta).length > 0 ? JSON.stringify(sanitizeSessionMeta(meta)) : undefined,
    installationMetadata: installationMeta ? JSON.stringify(installationMeta) : undefined,
  });

  return true;
}

function extractVSCode(db: SessionSink): number {
  if (platform() !== "darwin") {
    logger.info("extraction.copilot", "vscode_skipped_non_macos");
    return 0;
  }

  let extracted = 0;

  for (const variant of VSCODE_VARIANTS) {
    const userDataPath = getCopilotVSCodeUserDataPath(variant);
    if (!existsSync(userDataPath)) continue;
    logger.info("extraction.copilot", "variant_found", { variant });

    try {
      const globalDbPath = getCopilotVSCodeGlobalDbPath(variant);
      const globalIndex = readSessionIndex(globalDbPath);
      const installationMeta = detectCopilotVSCodeMetadata(globalDbPath);
      const workspaceStoragePath = getCopilotVSCodeWorkspaceStoragePath(variant);
      const workspaceFolderMap = buildWorkspaceFolderMap(workspaceStoragePath);
      let variantCount = 0;

      // Workspace-specific sessions
      if (existsSync(workspaceStoragePath)) {
        let wsDirs: string[];
        try { wsDirs = readdirSync(workspaceStoragePath); } catch { wsDirs = []; }
        for (const wsEntry of wsDirs) {
          const wsDir = join(workspaceStoragePath, wsEntry);
          const sessionFiles = scanVSCodeSessionFiles(join(wsDir, "chatSessions"));
          if (sessionFiles.length === 0) continue;
          const folderPath = workspaceFolderMap.get(wsEntry);
          const wsDbPath = join(wsDir, "state.vscdb");
          const wsIndex = readSessionIndex(wsDbPath);
          for (const session of sessionFiles) {
            const indexEntry = wsIndex.get(session.sessionId) ?? globalIndex.get(session.sessionId);
            try {
              if (processVSCodeSession(db, session, folderPath, indexEntry, installationMeta, wsDbPath)) variantCount++;
            } catch (err) {
              logger.error("extraction.copilot", "vscode_session_error", {
                sessionId: session.sessionId,
                error: err instanceof Error ? err.message : String(err),
              });
              reportRecordError(session.sessionId, session.filePath, err);
            }
          }
        }
      }

      // Empty-window sessions
      const emptyWindowDir = join(userDataPath, "globalStorage", "emptyWindowChatSessions");
      for (const session of scanVSCodeSessionFiles(emptyWindowDir)) {
        const indexEntry = globalIndex.get(session.sessionId);
        try {
          if (processVSCodeSession(db, session, undefined, indexEntry, installationMeta)) variantCount++;
        } catch (err) {
          logger.error("extraction.copilot", "vscode_session_error", {
            sessionId: session.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
          reportRecordError(session.sessionId, session.filePath, err);
        }
      }

      logger.info("extraction.copilot", "variant_complete", { variant, extracted: variantCount });
      extracted += variantCount;
    } catch (err) {
      logger.error("extraction.copilot", "variant_extraction_error", {
        variant,
        error: err instanceof Error ? err.message : String(err),
      });
      reportSourceError(null, err);
    }
  }

  return extracted;
}

// ════════════════════════════════════════════════════════════════════════════
// COPILOT CLI
// ════════════════════════════════════════════════════════════════════════════

// Known web-search tool name segments (the part after mcp__<server>__).
// Checked against the final segment only to avoid matching code-search tools
// like mcp__context7__search_codebase or mcp__x__file_search.
const CLI_MCP_WEB_SEARCH_TOOLS = new Set([
  "web_search", "search_web", "bing_search", "brave_search", "tavily_search",
  "google_search", "search_internet", "websearch", "web",
]);
// Known web-fetch tool name segments.
const CLI_MCP_WEB_FETCH_TOOLS = new Set([
  "fetch", "web_fetch", "browse", "get_url", "read_url", "open_url",
]);

interface WorkspaceInfo {
  projectPath?: string;
  repoName?: string;
  sessionTitle?: string;
}

function readWorkspaceInfo(sessionDir: string): WorkspaceInfo {
  const yamlPath = join(sessionDir, "workspace.yaml");
  if (!existsSync(yamlPath)) return {};
  try {
    const yaml = readFileSync(yamlPath, "utf8");
    const get = (key: string) => {
      const m = yaml.match(new RegExp(`^${key}:\\s*(.+)`, "m"));
      return m?.[1]?.trim() || undefined;
    };
    return {
      projectPath: get("git_root") ?? get("cwd"),
      repoName: get("repository"),
      sessionTitle: get("summary"),
    };
  } catch { return {}; }
}

interface CLIParseResult {
  prompts: ConversationPrompt[];
  userTimestampsMs: number[];
  usesMcp: boolean;
  usesExtendedThinking: boolean;
  usesWebSearch: boolean;
  usesWebFetch: boolean;
  toolCounts: Record<string, number>;
  toolErrors: number;
  userInterruptions: number;
  lastPrompt: string | undefined;
  gitCommits: number;
  gitPushes: number;
  /** Every distinct PR the session opened via `gh pr create`, in first-seen order. */
  prLinks: Array<{ prUrl: string; prNumber: number; prRepository: string }>;
  shutdownTimestampMs: number | undefined;
  lastAssistantTurnEndMs: number | undefined;
  userResponseTimes: number[];
}

function parseCLIEventsJsonl(filePath: string): CLIParseResult {
  const lines = readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim());
  const prompts: ConversationPrompt[] = [];
  const userTimestampsMs: number[] = [];
  const toolCounts: Record<string, number> = {};
  const userResponseTimes: number[] = [];
  let usesMcp = false;
  let usesExtendedThinking = false;
  let usesWebSearch = false;
  let usesWebFetch = false;
  let toolErrors = 0;
  let userInterruptions = 0;
  let lastPrompt: string | undefined;
  let gitCommits = 0;
  let gitPushes = 0;
  const { links: prLinks, add: addPrLink } = prLinkCollector();
  let shutdownTimestampMs: number | undefined;
  let lastAssistantTurnEndMs: number | undefined;

  for (const line of lines) {
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const type = ev["type"] ?? "";
    const data = ev["data"] as Record<string, unknown> | undefined ?? {};
    const envTs = typeof ev["timestamp"] === "string" ? Date.parse(ev["timestamp"] as string) : NaN;

    if (type === "user.message") {
      const content = (data["content"] as string | undefined)?.trim() ?? "";
      if (!content) continue;
      const ts = !isNaN(envTs) ? new Date(envTs).toISOString() : undefined;
      // user_response_times: time from last assistant turn end to this user message.
      if (!isNaN(envTs) && lastAssistantTurnEndMs !== undefined) {
        const diffSec = (envTs - lastAssistantTurnEndMs) / 1000;
        if (diffSec >= 0) userResponseTimes.push(Math.round(diffSec));
      }
      prompts.push({ role: "user", content, timestamp: ts });
      if (!isNaN(envTs)) userTimestampsMs.push(envTs);
      lastPrompt = content;

    } else if (type === "user.interrupt" || type === "session.interrupted") {
      userInterruptions++;

    } else if (type === "assistant.message") {
      const content = (data["content"] as string | undefined)?.trim() ?? "";
      const meta: PromptMetadata = {};
      if (typeof data["outputTokens"] === "number") meta.outputTokens = data["outputTokens"] as number;
      // Extended thinking detection.
      if (typeof data["reasoningText"] === "string" && (data["reasoningText"] as string).length > 0) {
        usesExtendedThinking = true;
      }
      if (content) {
        prompts.push({ role: "assistant", content, metadata: Object.keys(meta).length > 0 ? meta : undefined });
      }

    } else if (type === "assistant.turn_end") {
      if (!isNaN(envTs)) lastAssistantTurnEndMs = envTs;

    } else if (type === "tool.execution_complete") {
      const toolName = typeof data["toolName"] === "string" ? (data["toolName"] as string) : "unknown";
      toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
      const args = data["arguments"] as Record<string, unknown> | undefined ?? {};
      const shellCmd = typeof args["command"] === "string" ? (args["command"] as string) : "";
      const result = typeof data["result"] === "string" ? (data["result"] as string) : "";
      if (shellCmd.includes("git commit")) gitCommits++;
      if (shellCmd.includes("git push")) gitPushes++;
      // PR detection from PR-creation CLIs. Accumulate every distinct PR.
      if (shellCmd.includes("gh pr create") || shellCmd.includes("glab mr create")) {
        const ref = findPRUrlInText(result);
        if (ref) {
          addPrLink({ prUrl: ref.pr_url, prNumber: ref.pr_number, prRepository: ref.pr_repository });
        }
      }
      // Detect MCP-routed tool calls (toolName format: "mcp__<server>__<tool>").
      if (toolName.startsWith("mcp__")) {
        usesMcp = true;
        // Check only the final segment (after mcp__<server>__) against exact allowlists
        // to avoid false positives from code-search tools like mcp__context7__search_codebase
        // or mcp__x__file_search matching a broad includes("search") check.
        const toolSegment = toolName.slice(toolName.lastIndexOf("__") + 2).toLowerCase();
        if (CLI_MCP_WEB_SEARCH_TOOLS.has(toolSegment)) usesWebSearch = true;
        if (CLI_MCP_WEB_FETCH_TOOLS.has(toolSegment)) usesWebFetch = true;
      }
      // Tool error detection: non-zero exit code or error-prefixed result.
      const exitCode = data["exitCode"];
      if (exitCode !== undefined && exitCode !== 0) {
        toolErrors++;
      } else if (result.startsWith("Error:") || result.startsWith("ERROR:")) {
        toolErrors++;
      }

    } else if (type === "session.shutdown") {
      if (!isNaN(envTs)) shutdownTimestampMs = envTs;
    }
  }

  return { prompts, userTimestampsMs, usesMcp, usesExtendedThinking, usesWebSearch, usesWebFetch, toolCounts, toolErrors, userInterruptions, lastPrompt, gitCommits, gitPushes, prLinks, shutdownTimestampMs, lastAssistantTurnEndMs, userResponseTimes };
}

function processCLISession(db: SessionSink, sessionId: string, sessionDir: string): boolean {
  const eventsPath = join(sessionDir, "events.jsonl");
  if (!existsSync(eventsPath)) return false;

  let st: ReturnType<typeof statSync>;
  try { st = statSync(eventsPath); } catch { return false; }

  const lastMtimeMs = st.mtimeMs;
  const lastSize = st.size;

  const tracking = db.getTracking("copilot", sessionId);
  if (tracking && tracking.last_mtime_ms === lastMtimeMs && tracking.last_size === lastSize) return false;

  const cliMeta = detectCopilotCLIMetadata(eventsPath);
  const installationMeta = cliMeta?.installMeta ?? null;
  const cliContext: CopilotCLIContext = cliMeta?.cliContext ?? {};

  let parsed: CLIParseResult;
  try {
    parsed = parseCLIEventsJsonl(eventsPath);
  } catch (err) {
    logger.warn("extraction.copilot-cli", "session_parse_error", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  if (parsed.prompts.filter((p) => p.role === "user").length === 0) return false;

  // Project path: prefer context from session.start over workspace.yaml.
  const wsInfo = readWorkspaceInfo(sessionDir);
  const projectPath = cliContext.gitRoot ?? cliContext.cwd ?? wsInfo.projectPath;
  const repoNameFromContext = cliContext.repository;
  const resolved = projectPath ? resolveProjectAndRepo(projectPath) : undefined;
  const finalProjectPath = resolved?.projectPath ?? projectPath;
  const repoName = repoNameFromContext ?? resolved?.repoName ?? wsInfo.repoName;

  const userCount = parsed.prompts.filter((p) => p.role === "user").length;
  const assistantCount = parsed.prompts.filter((p) => p.role === "assistant").length;
  const meta: SessionMetaPayload = {};

  if (wsInfo.sessionTitle) meta.session_title = wsInfo.sessionTitle;
  if (userCount > 0) meta.user_message_count = userCount;
  if (assistantCount > 0) meta.assistant_message_count = assistantCount;

  // Timing signals.
  if (parsed.userTimestampsMs.length > 0) {
    const { userMessageTimestamps, messageHours } = computeTimingSignals(parsed.userTimestampsMs);
    if (userMessageTimestamps.length > 0) meta.user_message_timestamps = userMessageTimestamps;
    if (messageHours.length > 0) meta.message_hours = messageHours;
  }
  // More accurate user_response_times (from turn_end boundaries).
  if (parsed.userResponseTimes.length > 0) meta.user_response_times = parsed.userResponseTimes;

  // Session duration from shutdown event.
  if (parsed.shutdownTimestampMs !== undefined && cliContext.startTime) {
    const startMs = Date.parse(cliContext.startTime);
    if (!isNaN(startMs)) {
      meta.duration_minutes = Math.round((parsed.shutdownTimestampMs - startMs) / 60000 * 10) / 10;
    }
  }

  // Git context from session.start.data.context.
  if (cliContext.branch) {
    meta.git_branch = cliContext.branch;
    // Copilot CLI exposes only a single snapshot — emit as a single-element
    // git_branches array for matcher uniformity.
    meta.git_branches = [cliContext.branch];
  }
  if (cliContext.headCommit) meta.git_sha = cliContext.headCommit;
  if (cliContext.startTime) meta.start_time = cliContext.startTime;

  // Tool + MCP signals.
  if (parsed.usesMcp) meta.uses_mcp = true;
  if (parsed.usesExtendedThinking) meta.uses_extended_thinking = true;
  if (parsed.usesWebSearch) meta.uses_web_search = true;
  if (parsed.usesWebFetch) meta.uses_web_fetch = true;
  if (Object.keys(parsed.toolCounts).length > 0) meta.tool_counts = parsed.toolCounts;
  if (parsed.toolErrors > 0) meta.tool_errors = parsed.toolErrors;
  if (parsed.userInterruptions > 0) meta.user_interruptions = parsed.userInterruptions;
  if (parsed.lastPrompt) meta.last_prompt = parsed.lastPrompt;
  if (parsed.gitCommits > 0) meta.git_commits = parsed.gitCommits;
  if (parsed.gitPushes > 0) meta.git_pushes = parsed.gitPushes;

  applyPrLinks(meta, parsed.prLinks);

  // Git diff metrics + PR fallback via commit messages.
  if (finalProjectPath) {
    const sessionStartMs = parsed.userTimestampsMs.length > 0 ? parsed.userTimestampsMs[0] : undefined;
    const diff = getFullSessionDiffStats(finalProjectPath, sessionStartMs, lastMtimeMs);
    if (diff.linesAdded > 0) meta.lines_added = diff.linesAdded;
    if (diff.linesRemoved > 0) meta.lines_removed = diff.linesRemoved;
    if (diff.filesModified > 0) meta.files_modified = diff.filesModified;
    if (diff.gitCommits > 0 && !meta.git_commits) meta.git_commits = diff.gitCommits;

    if (!meta.pr_url) {
      const prFromGit = getSessionPRLink(finalProjectPath, sessionStartMs, lastMtimeMs);
      if (prFromGit) {
        applyPrLinks(meta, [prFromGit]);
      }
    }
  }

  // Carry the session's real start so it is dated by when it happened, not when it was
  // extracted. Prefer session.start startTime, then the first user-message time, then the
  // file mtime; with none of these the store falls back to the row insert time (today).
  const cliStartMs = cliContext.startTime ? Date.parse(cliContext.startTime) : NaN;
  const cliSourceCreatedAtMs = !isNaN(cliStartMs)
    ? cliStartMs
    : parsed.userTimestampsMs.length > 0
      ? parsed.userTimestampsMs[0]
      : lastMtimeMs;

  db.upsert({
    ideType: "copilot",
    sessionId,
    conversation: redactPrompts(parsed.prompts),
    projectPath: finalProjectPath ? redactPath(finalProjectPath) : undefined,
    repoName,
    lastMtimeMs,
    lastSize,
    lastOffset: 0,
    conversationSourceCreatedAtMs: cliSourceCreatedAtMs,
    sessionMeta: Object.keys(meta).length > 0 ? JSON.stringify(sanitizeSessionMeta(meta)) : undefined,
    installationMetadata: installationMeta ? JSON.stringify(installationMeta) : undefined,
  });

  return true;
}

function extractCLI(db: SessionSink): number {
  const sessionStatePath = getCopilotCLISessionStatePath();
  if (!existsSync(sessionStatePath)) {
    logger.debug("extraction.copilot-cli", "session_state_dir_not_found", { path: sessionStatePath });
    return 0;
  }

  const startTime = Date.now();
  logger.info("extraction.copilot-cli", "extraction_start");

  let entries: string[];
  try {
    entries = readdirSync(sessionStatePath);
  } catch (err) {
    logger.error("extraction.copilot-cli", "readdir_error", { error: err instanceof Error ? err.message : String(err) });
    reportSourceError(sessionStatePath, err);
    return 0;
  }

  let extracted = 0;
  for (const entry of entries) {
    const sessionDir = join(sessionStatePath, entry);
    try { if (!statSync(sessionDir).isDirectory()) continue; } catch { continue; }
    try {
      if (processCLISession(db, entry, sessionDir)) extracted++;
    } catch (err) {
      logger.error("extraction.copilot-cli", "session_error", {
        sessionId: entry,
        error: err instanceof Error ? err.message : String(err),
      });
      reportRecordError(entry, sessionDir, err);
    }
  }

  logger.info("extraction.copilot-cli", "extraction_complete", {
    durationMs: Date.now() - startTime,
    newOrChangedConversations: extracted,
  });
  return extracted;
}

// ════════════════════════════════════════════════════════════════════════════
// JETBRAINS COPILOT
// ════════════════════════════════════════════════════════════════════════════

const JETBRAINS_IDE_CODES = [
  "go",   // GoLand
  "iu",   // IntelliJ IDEA Ultimate
  "ic",   // IntelliJ IDEA Community
  "ws",   // WebStorm
  "py",   // PyCharm Professional
  "pc",   // PyCharm Community
  "rm",   // RubyMine
  "ps",   // PhpStorm
  "cl",   // CLion
  "rd",   // Rider
  "db",   // DataGrip
  "rr",   // RustRover
  "intellij", // fallback code seen on some installs
] as const;

const JB_SESSION_SUBDIRS: Array<{ dir: string; dbFile: string }> = [
  { dir: "chat-agent-sessions",  dbFile: "copilot-agent-sessions-nitrite.db" },
  { dir: "chat-sessions",        dbFile: "copilot-chat-nitrite.db" },
  { dir: "chat-edit-sessions",   dbFile: "copilot-edit-sessions-nitrite.db" },
];

// ── H2 MVStore / Nitrite binary parsing ───────────────────────────────────────
//
// JetBrains Copilot persists chat sessions in Nitrite backed by H2 MVStore.
// We extract conversations with two binary heuristics:
//   1. User prompts: TC_STRING "stringContent" key followed by another TC_STRING value.
//   2. AI responses: large TC_STRING blobs that parse as JSON with "__first__"/"__last__"
//      keys, containing Markdown nodes: { type: "Markdown", data: '{"text":"..."}' }.
//
// H2 MVStore appends new B-tree pages to the end of the file. For large files
// we only tail-scan to avoid blocking the event loop.

const TC_STRING_OPCODE = 0x74;
const SC_KEY = Buffer.from("stringContent");
const JB_FULL_SCAN_THRESHOLD = 2 * 1024 * 1024; // 2 MB — full scan
const JB_TAIL_SCAN_BYTES     = 5 * 1024 * 1024; // 5 MB tail for large files

function readFileTail(dbPath: string, fileSize: number): Buffer {
  const toRead = Math.min(fileSize, JB_TAIL_SCAN_BYTES);
  const buf = Buffer.allocUnsafe(toRead);
  const fd = openSync(dbPath, "r");
  try {
    readSync(fd, buf, 0, toRead, fileSize - toRead);
  } finally {
    closeSync(fd);
  }
  return buf;
}

function readTCString(buf: Buffer, pos: number): { value: string; end: number } | null {
  if (pos + 3 > buf.length) return null;
  if (buf[pos] !== TC_STRING_OPCODE) return null;
  const len = buf.readUInt16BE(pos + 1);
  if (len === 0 || pos + 3 + len > buf.length) return null;
  return { value: buf.toString("utf8", pos + 3, pos + 3 + len), end: pos + 3 + len };
}

function extractJBUserPrompts(buf: Buffer): Array<{ offset: number; text: string }> {
  const results: Array<{ offset: number; text: string }> = [];
  const seen = new Set<string>();
  const keyLen = SC_KEY.length;

  for (let i = 0; i + 3 + keyLen < buf.length; i++) {
    if (buf[i] !== TC_STRING_OPCODE) continue;
    const flen = buf.readUInt16BE(i + 1);
    if (flen !== keyLen) continue;
    if (!buf.subarray(i + 3, i + 3 + keyLen).equals(SC_KEY)) continue;

    const vs = readTCString(buf, i + 3 + keyLen);
    if (!vs || vs.value.trim() === "") continue;
    if (!seen.has(vs.value)) {
      seen.add(vs.value);
      results.push({ offset: i, text: vs.value });
    }
  }
  return results;
}

function collectMarkdown(node: unknown, out: string[]): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;

  if (n["type"] === "Value" && typeof n["value"] === "string") {
    try {
      const inner = JSON.parse(n["value"] as string) as Record<string, unknown>;
      if (inner["type"] === "Markdown" && typeof inner["data"] === "string") {
        const data = JSON.parse(inner["data"] as string) as Record<string, unknown>;
        if (typeof data["text"] === "string" && data["text"].length > 0) out.push(data["text"] as string);
      }
      collectMarkdown(inner, out);
    } catch { /* not valid JSON */ }
  }

  if (n["type"] === "Subgraph" && typeof n["value"] === "string") {
    try { collectMarkdown(JSON.parse(n["value"] as string), out); } catch { /* ignore */ }
  }

  for (const v of Object.values(n)) {
    if (v && typeof v === "object") collectMarkdown(v, out);
  }
}

function extractJBAIResponses(buf: Buffer, userTextSet: Set<string>): Array<{ offset: number; text: string }> {
  const results: Array<{ offset: number; text: string }> = [];
  const seen = new Set<string>();
  const MIN_BLOB = 100;

  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] !== TC_STRING_OPCODE) continue;
    const len = buf.readUInt16BE(i + 1);
    if (len < MIN_BLOB || i + 3 + len > buf.length) continue;

    const raw = buf.toString("utf8", i + 3, i + 3 + len);
    if (!raw.includes('"Markdown"') && !raw.includes("Subgraph")) continue;

    let outer: unknown;
    try { outer = JSON.parse(raw); } catch { continue; }
    if (typeof outer !== "object" || outer === null) continue;

    const keys = Object.keys(outer as Record<string, unknown>);
    if (!keys.includes("__first__") && !keys.includes("__last__")) continue;

    const texts: string[] = [];
    collectMarkdown(outer, texts);
    const aiParts = texts.filter((t) => t.trim().length > 20 && !userTextSet.has(t));
    const joined = aiParts.join("\n\n").trim();
    if (!joined || seen.has(joined)) continue;
    seen.add(joined);
    results.push({ offset: i, text: joined });
  }

  return results;
}

function parseNitriteDb(dbPath: string, fileSize: number): ConversationPrompt[] {
  const buf = fileSize > JB_FULL_SCAN_THRESHOLD ? readFileTail(dbPath, fileSize) : readFileSync(dbPath);

  const userEntries = extractJBUserPrompts(buf);
  if (userEntries.length === 0) return [];

  const userTextSet = new Set(userEntries.map((e) => e.text));
  const aiEntries = extractJBAIResponses(buf, userTextSet);

  const all: Array<{ offset: number; role: "user" | "assistant"; text: string }> = [
    ...userEntries.map((e) => ({ offset: e.offset, role: "user" as const, text: e.text })),
    ...aiEntries.map((e) => ({ offset: e.offset, role: "assistant" as const, text: e.text })),
  ];
  // Sort by byte offset as a chronological proxy. This is a heuristic: H2 MVStore
  // is a B-tree and pages can be rewritten non-chronologically after compaction.
  // For the tail-scan path (files > 2 MB) it is even less reliable since only the
  // last 5 MB is read. Works correctly for the common append-only write pattern.
  all.sort((a, b) => a.offset - b.offset);

  return all.map((entry): ConversationPrompt => ({
    role: entry.role,
    content: entry.text,
  }));
}

function processJBSession(
  db: SessionSink,
  ideCode: string,
  sessionId: string,
  sessionDir: string,
  dbFileName: string,
  globalMeta: CopilotJBGlobalMetadata | null
): boolean {
  const dbPath = join(sessionDir, dbFileName);
  if (!existsSync(dbPath)) return false;

  let st: ReturnType<typeof statSync>;
  try { st = statSync(dbPath); } catch { return false; }

  const lastMtimeMs = st.mtimeMs;
  const lastSize = st.size;
  const compositeId = `jb:${ideCode}:${sessionId}:${dbFileName}`;

  const tracking = db.getTracking("copilot", compositeId);
  if (tracking && tracking.last_mtime_ms === lastMtimeMs && tracking.last_size === lastSize) return false;

  // Large files: read tail directly (O_RDONLY is safe alongside the IDE's write lock).
  // Small files: copy first to avoid partial-read races.
  // The copy goes to a fresh private directory (mkdtemp makes it 0700 with a
  // random name), never a shared path another local user could predict.
  let readPath: string;
  let tmpDir: string | null = null;

  if (lastSize > JB_FULL_SCAN_THRESHOLD) {
    readPath = dbPath;
  } else {
    try {
      tmpDir = mkdtempSync(join(tmpdir(), "local-session-extractor-jb-"));
      readPath = join(tmpDir, "chat.db");
      copyFileSync(dbPath, readPath);
    } catch (err) {
      logger.warn("extraction.copilot-jb", "copy_failed", {
        dbPath,
        error: err instanceof Error ? err.message : String(err),
      });
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
      return false;
    }
  }

  let prompts: ConversationPrompt[];
  try {
    prompts = parseNitriteDb(readPath, lastSize);
  } catch (err) {
    logger.warn("extraction.copilot-jb", "parse_error", {
      sessionId: compositeId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }

  if (prompts.filter((p) => p.role === "user").length === 0) return false;

  const userCount = prompts.filter((p) => p.role === "user").length;
  const assistantCount = prompts.filter((p) => p.role === "assistant").length;
  const meta: SessionMetaPayload = {};
  if (userCount > 0) meta.user_message_count = userCount;
  if (assistantCount > 0) meta.assistant_message_count = assistantCount;

  const mcpServers = readCopilotJBMcpServers(getCopilotJBMcpJsonPath(ideCode));
  if (mcpServers.length > 0) meta.mcp_server_names = mcpServers;

  // Best-effort project path: read the most recently opened project for this IDE
  // from recentProjects.xml. No direct link exists between a session and a project,
  // so this is correct only when the user has one active project per IDE.
  const rawProjectPath = resolveJBProjectPath(ideCode);
  const resolved = rawProjectPath ? resolveProjectAndRepo(rawProjectPath) : undefined;
  const projectPath = resolved?.projectPath ?? rawProjectPath;
  const repoName = resolved?.repoName;

  // Git diff metrics: uncommitted changes at session time. Session start is unknown
  // for JetBrains (no timestamps in Nitrite DB), so we pass undefined and rely on
  // the dirty-state scan only.
  if (rawProjectPath) {
    const diff = getFullSessionDiffStats(rawProjectPath, undefined, lastMtimeMs);
    if (diff.linesAdded > 0) meta.lines_added = diff.linesAdded;
    if (diff.linesRemoved > 0) meta.lines_removed = diff.linesRemoved;
    if (diff.filesModified > 0) meta.files_modified = diff.filesModified;
    if (diff.gitCommits > 0) meta.git_commits = diff.gitCommits;
  }

  const installationMeta = detectCopilotJBMetadata(ideCode, globalMeta);

  db.upsert({
    ideType: "copilot",
    sessionId: compositeId,
    conversation: redactPrompts(prompts),
    projectPath: projectPath ? redactPath(projectPath) : undefined,
    repoName,
    lastMtimeMs,
    lastSize,
    lastOffset: 0,
    // The Nitrite DB carries no per-message timestamps, so use the DB file mtime as the
    // source time — last activity, but on the real day, so the session is not dated to the
    // extraction day.
    conversationSourceCreatedAtMs: lastMtimeMs,
    sessionMeta: Object.keys(meta).length > 0 ? JSON.stringify(sanitizeSessionMeta(meta)) : undefined,
    installationMetadata: JSON.stringify(installationMeta),
  });

  return true;
}

// ── JetBrains project path resolution via recentProjects.xml ─────────────────
//
// Copilot session directories (~/.config/github-copilot/<ide-code>/) contain
// no project path. As a best-effort proxy we read the most recently opened
// project from the IDE's recentProjects.xml — this is correct when the user
// has only one active project, and a reasonable approximation otherwise.

const JB_IDE_CODE_TO_PRODUCT_PREFIXES: Record<string, string[]> = {
  go: ["GoLand"],
  iu: ["IntelliJIdea", "IdeaIU"],
  ic: ["IdeaIC"],
  ws: ["WebStorm"],
  py: ["PyCharm"],
  pc: ["PyCharmCE"],
  rm: ["RubyMine"],
  ps: ["PhpStorm"],
  cl: ["CLion"],
  rd: ["Rider"],
  db: ["DataGrip"],
  rr: ["RustRover"],
  intellij: ["IntelliJIdea", "IdeaIU", "IdeaIC"],
};

function getJetBrainsConfigRoot(): string {
  const home = homeDir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "JetBrains");
  if (platform() === "win32") return join(home, "AppData", "Roaming", "JetBrains");
  return join(home, ".config", "JetBrains");
}

/**
 * Parses a recentProjects.xml and returns the most recently opened project path.
 * Handles both the modern `additionalInfo` map format (with projectOpenTimestamp)
 * and the legacy `recentPaths` list format. Expands JetBrains $USER_HOME$ macro.
 */
function readMostRecentProject(xmlPath: string): string | undefined {
  let xml: string;
  try { xml = readFileSync(xmlPath, "utf-8"); } catch { return undefined; }

  const home = homeDir();

  // Modern format: <entry key="$USER_HOME$/path"> ... projectOpenTimestamp="ms" ... </entry>
  // Split by entry so timestamps can't leak across entries.
  const chunks = xml.split("<entry key=");
  let bestPath: string | undefined;
  let bestTs = -1;
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const keyMatch = /^"([^"]+)"/.exec(chunk);
    if (!keyMatch) continue;
    const path = keyMatch[1]!.replace(/\$USER_HOME\$/g, home);
    const tsMatch = /projectOpenTimestamp="(\d+)"/.exec(chunk);
    const ts = tsMatch ? parseInt(tsMatch[1]!, 10) : 0;
    if (ts > bestTs) { bestTs = ts; bestPath = path; }
  }
  if (bestPath) return bestPath;

  // Legacy format: first <option value="..."/> in recentPaths list
  const legacyMatch = /<option\s+value="([^"]+)"/.exec(xml);
  if (legacyMatch) return legacyMatch[1]!.replace(/\$USER_HOME\$/g, home);

  return undefined;
}

/**
 * Returns the most recently opened project path for a JetBrains IDE code, or
 * undefined if the config root / recentProjects.xml is not found.
 */
function resolveJBProjectPath(ideCode: string): string | undefined {
  const prefixes = JB_IDE_CODE_TO_PRODUCT_PREFIXES[ideCode];
  if (!prefixes || prefixes.length === 0) return undefined;

  const configRoot = getJetBrainsConfigRoot();
  let productDirs: string[];
  try { productDirs = readdirSync(configRoot); } catch { return undefined; }

  // Pick the matching product directory whose recentProjects.xml was most
  // recently modified (i.e. the most recently used IDE installation).
  let bestXmlPath: string | undefined;
  let bestMtime = -1;
  for (const dir of productDirs) {
    if (!prefixes.some((p) => dir.startsWith(p))) continue;
    const xmlPath = join(configRoot, dir, "options", "recentProjects.xml");
    try {
      const mtime = statSync(xmlPath).mtimeMs;
      if (mtime > bestMtime) { bestMtime = mtime; bestXmlPath = xmlPath; }
    } catch { /* not found or unreadable */ }
  }

  return bestXmlPath ? readMostRecentProject(bestXmlPath) : undefined;
}

function extractJetBrains(db: SessionSink): number {
  const base = join(homeDir(), ".config", "github-copilot");
  if (!existsSync(base)) {
    logger.debug("extraction.copilot-jb", "base_dir_not_found", { path: base });
    return 0;
  }

  const startTime = Date.now();
  logger.info("extraction.copilot-jb", "extraction_start");
  let extracted = 0;

  // Read global metadata once — shared across all IDE codes and sessions
  const globalMeta = readCopilotJBGlobalMetadata(
    getCopilotJBAppsJsonPath(),
    getCopilotJBVersionsJsonPath()
  );

  for (const ideCode of JETBRAINS_IDE_CODES) {
    const ideDir = join(base, ideCode);
    if (!existsSync(ideDir)) continue;

    for (const { dir, dbFile } of JB_SESSION_SUBDIRS) {
      const subdirPath = join(ideDir, dir);
      if (!existsSync(subdirPath)) continue;

      let entries: string[];
      try { entries = readdirSync(subdirPath); } catch { continue; }

      for (const entry of entries) {
        const sessionDir = join(subdirPath, entry);
        try { if (!statSync(sessionDir).isDirectory()) continue; } catch { continue; }
        try {
          if (processJBSession(db, ideCode, entry, sessionDir, dbFile, globalMeta)) extracted++;
        } catch (err) {
          logger.error("extraction.copilot-jb", "session_error", {
            ideCode,
            sessionId: entry,
            error: err instanceof Error ? err.message : String(err),
          });
          reportRecordError(entry, sessionDir, err);
        }
      }
    }
  }

  logger.info("extraction.copilot-jb", "extraction_complete", {
    durationMs: Date.now() - startTime,
    newOrChangedConversations: extracted,
  });
  return extracted;
}

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════════

/**
 * Extracts GitHub Copilot conversations from all supported sources:
 *   - VS Code / VS Code Insiders chat sessions (macOS)
 *   - GitHub Copilot CLI session state (~/.copilot/session-state/)
 *   - JetBrains IDEs via Nitrite DB binary parsing
 *
 * All sources are stored under ideType="copilot" in the local DB.
 */
export function extractCopilot(db: SessionSink): number {
  const startTime = Date.now();
  logger.info("extraction.copilot", "extraction_start");

  const vscodeCount   = extractVSCode(db);
  const cliCount      = extractCLI(db);
  const jetbrainsCount = extractJetBrains(db);

  const total = vscodeCount + cliCount + jetbrainsCount;
  logger.info("extraction.copilot", "extraction_complete", {
    durationMs: Date.now() - startTime,
    vscodeCount,
    cliCount,
    jetbrainsCount,
    total,
  });

  return total;
}
