// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, basename, dirname } from "node:path";
import type { ConversationPrompt, ConversationRow, PromptMetadata, SessionMetaPayload, SessionFacetsPayload, InstallationMetadata, SessionLineagePayload } from "../types/session";
import type { SessionSink } from "../types/store";
import { conversationId } from "../store/ids";
import { reportRecordError, reportSourceError } from "../seams/scanScope";
import { redactPrompts, redactPath, redactText, sanitizeSessionMeta } from "../redaction";
import {
  getClaudeCodeProjectsPath,
  getClaudeCodeSessionMetaPath,
  getClaudeCodeFacetsPath,
  getClaudeCodeConfigPath,
  getCoworkAgentModeSessionsPath,
  getCoworkClaudeCodeSessionsPath,
  homeDir,
} from "./pathResolver";
import { resolveProjectAndRepo, resolveSessionBranch } from "./gitUtils";
import { detectClaudeCodeTier, detectClaudeCodeSessionKinds, detectClaudeCodeOAuthAccount } from "./planTierDetector";
import { SessionEventBuilder, promptReferenceAuthor, promptAuthorship } from "./sessionEvents";
import { noteUnknownRecordKind, claudeCodeRecordKind, requireConsumedField, requireConsumedShape } from "./knownRecordKinds";
import {
  COMMAND_NAME_RE,
  COMMAND_ARGS_RE,
  invokedCommandName,
  isInjectedUserMarkup,
} from "./claudeCommandTurn";
import { readStatsCache } from "./statsCacheReader";
import { deriveLanguages } from "./languageMap";
import { writtenLineCount } from "./lineCount";
import { logger } from "../seams/logger";
import { getParsedTranscript, resetTranscriptCache } from "./transcriptCache";
import { lruSet } from "../util/lruMap";

// Tools whose inputs represent real file modifications. Read/Grep/Glob/LS/Bash
// can also carry file_path / path inputs (or a directory in Grep's case), but
// those are browse references — we exclude them from filesEdited to keep the
// per-session file set to actual writes.
const WRITE_TOOL_NAMES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// ── JSONL line shapes ────────────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

interface InnerMessage {
  id?: string;
  role: string;
  content: unknown;
  model?: string;
  usage?: MessageUsage;
}

interface JsonlLine {
  type?: string;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  message?: InnerMessage;
  // Claude marks injected (non-user-authored) turns — command caveats, resume
  // reminders, command output — with isMeta:true.
  isMeta?: boolean;
  // Claude marks a subagent (delegated) transcript's turns with isSidechain:true —
  // the delegated agent's work, authored by no person.
  isSidechain?: boolean;
  // toolUseResult is a top-level object on the user line carrying a tool_result —
  // NOT inside message.content. For an Edit it is {type:"update", structuredPatch};
  // for a Write (creation) {type:"create", content} with an empty structuredPatch.
  // structuredPatch is the universal countable source (present on both update shapes);
  // a creation counts its content lines (a real share of edit results are patch-less creates).
  toolUseResult?: {
    type?: string;
    filePath?: string;
    content?: string;
    structuredPatch?: Array<{ lines?: unknown }>;
  };
}

// editCountsFromToolUseResult derives (added, removed, filePath) for one Edit/Write
// tool result. A create counts its written content as all-added; an update counts the
// +/- lines of its structuredPatch hunks, excluding the +++/--- file headers. Returns
// null when the result is not an edit/write (no filePath / nothing countable).
function editCountsFromToolUseResult(
  tur: NonNullable<JsonlLine["toolUseResult"]>
): { added: number; removed: number; filePath: string } | null {
  const filePath = typeof tur.filePath === "string" ? tur.filePath : "";
  if (!filePath) return null;
  if (tur.type === "create") {
    const added = typeof tur.content === "string" ? writtenLineCount(tur.content) : 0;
    return { added, removed: 0, filePath };
  }
  if (!Array.isArray(tur.structuredPatch)) return null;
  let added = 0;
  let removed = 0;
  for (const hunk of tur.structuredPatch) {
    const lines = (hunk as { lines?: unknown }).lines;
    if (!Array.isArray(lines)) continue;
    for (const l of lines) {
      if (typeof l !== "string") continue;
      // Skip the unified-diff file headers; count only content +/- lines.
      if (l.startsWith("+++") || l.startsWith("---")) continue;
      if (l.startsWith("+")) added++;
      else if (l.startsWith("-")) removed++;
    }
  }
  return { added, removed, filePath };
}

// toolUseIdsInAssistant returns the ids of the Edit/Write tool_use blocks an assistant
// message issued, so a following tool_result (which carries the toolUseResult) can be
// joined back to the assistant turn that made the edit.
function toolUseIdsInAssistant(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: unknown; id?: unknown };
      if (b.type === "tool_use" && typeof b.id === "string") ids.push(b.id);
    }
  }
  return ids;
}

// toolResultUseIdsInUser returns the tool_use_id of each tool_result block on a user
// message — the reverse join key back to the assistant turn that issued the tool_use.
function toolResultUseIdsInUser(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: unknown; tool_use_id?: unknown };
      if (b.type === "tool_result" && typeof b.tool_use_id === "string") ids.push(b.tool_use_id);
    }
  }
  return ids;
}

const CONTINUATION_PREFIX =
  "This session is being continued from a previous conversation";

// The closed set of Claude Code permissionMode values. The HITL mode is captured verbatim and
// stored (per-turn permission_mode and session_meta.approval_mode), so an unknown token — a
// corrupt line or a future vendor value we have not vetted — is rejected rather than stored, and
// the field is left empty (a consumer reads empty as UNSPECIFIED).
const CLAUDE_PERMISSION_MODES = new Set(["default", "plan", "acceptEdits", "auto", "bypassPermissions"]);

// allowedPermissionMode returns the value only if it is a known Claude permissionMode, else undefined.
function allowedPermissionMode(value: unknown): string | undefined {
  return typeof value === "string" && CLAUDE_PERMISSION_MODES.has(value) ? value : undefined;
}

// first_prompt is a display label (a session's opening prompt stands in for a
// missing title). A consumer truncates it to ~150 chars, and the full text
// already ships in prompts[], so cap the session_meta copy to avoid duplicating a
// large opening message into the payload.
const FIRST_PROMPT_MAX_CHARS = 500;

// A slash-command turn is genuine user input but is stored as XML-ish markup (many
// sessions start with a command such as /review or /pr); surface a readable
// "<command> <args>" label. Injected non-prompt turns are filtered by isMeta at the
// call site, so no tag-stripping is done here.
function readableFirstPrompt(content: string): string {
  // Anchored first: a prompt that merely QUOTES the markup is prose about commands, and
  // labelling the session from a mention would discard the real opening message. Once the
  // anchor says this turn is an invocation, the unanchored readers are safe for its parts.
  if (!invokedCommandName(content)) return content.trim();
  const name = COMMAND_NAME_RE.exec(content)?.[1]?.trim();
  if (!name) return content.trim();
  const args = COMMAND_ARGS_RE.exec(content)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

// Single source of truth for the Claude Code root on disk. Consumed by every
// helper in this file that pokes at `~/.claude/...` so the literal path is
// not redrawn at each call site. Resolved per call, so a home-root override
// set after this module loads still applies.
function claudeHomeDir(): string {
  return join(homeDir(), ".claude");
}

// ── Session-meta / facets helpers ─────────────────────────────────────────────

/**
 * Reads and parses a JSON file keyed by session UUID from the given directory.
 * Returns null if the file doesn't exist. Logs and returns null on parse errors.
 */
function readSessionJsonFile<T>(dir: string, sessionId: string, label: string): T | null {
  const uuid = sessionId.includes("::") ? sessionId.split("::")[1]! : sessionId;
  const filePath = join(dir, `${uuid}.json`);
  try {
    if (!existsSync(filePath)) return null;
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch (err) {
    logger.warn("extraction.claude_code", `${label}_parse_error`, {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function readSessionMeta(sessionId: string): SessionMetaPayload | null {
  return readSessionJsonFile<SessionMetaPayload>(getClaudeCodeSessionMetaPath(), sessionId, "session_meta");
}

function readSessionFacets(sessionId: string): SessionFacetsPayload | null {
  return readSessionJsonFile<SessionFacetsPayload>(getClaudeCodeFacetsPath(), sessionId, "session_facets");
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Scans ~/.claude/projects for JSONL conversation files and upserts them
 * into the local database. A file whose mtime and size match the stored row is
 * skipped; a changed file is re-read whole, because the row holds the complete
 * conversation.
 */
export function extractClaudeCode(db: SessionSink, captureLineage = false): number {
  // Fresh cycle: drop the shared transcript parse cache so parsed lines never
  // outlive the cycle that reads them (this pass and the usage parser both read
  // this cycle's changed transcripts, then the entries are dead weight).
  resetTranscriptCache();
  const projectsPath = getClaudeCodeProjectsPath();
  const startTime = Date.now();

  logger.info("extraction.claude_code", "extraction_start", {
    projectsPath,
  });

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(projectsPath, d.name));
  } catch (err) {
    // A folder that is there but cannot be read (EACCES, EIO) is a failed source, not
    // an empty one: report it, then carry on with the Cowork stores below.
    if (!isMissing(err)) reportSourceError(projectsPath, err);
    // ~/.claude/projects doesn't exist — Claude Code proper not installed. This is
    // NOT a reason to skip Cowork: the Cowork audit stores live under their own base
    // dirs and are never mirrored into the projects store, so continue with no
    // project dirs and still drain the Cowork stores below (a Cowork-only install).
    logger.info("extraction.claude_code", "projects_dir_not_found", {
      projectsPath,
    });
    projectDirs = [];
  }

  let totalFiles = 0;
  let extracted = 0;

  // Tier detection reads ~/.claude/telemetry/ (install-level auth/model
  // signals). Run it once here and pass the result into each session processor
  // so we don't re-scan megabytes of telemetry N times per extraction.
  const runInstallMeta = detectClaudeCodeTier(claudeHomeDir());

  // session_kind is per-session, so it is read into a sessionId→kind map once
  // per run and looked up per session — not stamped run-wide off the newest
  // sessions file, which mislabeled every session in a batch.
  const runSessionKinds = detectClaudeCodeSessionKinds(claudeHomeDir());

  // Authoritative ~/.claude.json oauthAccount record (raw fields only, no
  // plan_tier mapping). Computed once; merged onto each session's finalized
  // install metadata AFTER the inferred cascade so it never blanks plan_tier.
  // A consumer derives the canonical plan_tier from these raw fields.
  const runOauthRaw = detectClaudeCodeOAuthAccount(getClaudeCodeConfigPath());

  // MCP server names (~/.claude/settings.json) and the stats cache
  // (~/.claude/stats-cache) are global — identical for every session — so read
  // them once per run and thread them into each session, not per file.
  const runMcpNames = readMcpServerNames(claudeHomeDir());
  const runStatsCache = readStatsCache(claudeHomeDir());

  // Index every main session's uuid → its projectDir, so a subagent can resolve
  // its parent's REAL projectDir even when the parent session lives in a
  // different dir than the subagent (git-worktree case). Built before any
  // subagent is processed, since a parent may sit in a later projectDir.
  const uuidToProjectDir = new Map<string, string>();
  if (captureLineage) {
    for (const projectDir of projectDirs) {
      try {
        for (const f of readdirSync(projectDir, { withFileTypes: true })) {
          if (f.isFile() && f.name.endsWith(".jsonl") && !f.name.startsWith("agent-")) {
            uuidToProjectDir.set(basename(f.name, ".jsonl"), basename(projectDir));
          }
        }
      } catch { /* unreadable dir — skip */ }
    }
  }

  // Deterministic child→parent link for hook-spawned sessions: a hook that ran
  // `claude -p … --output-format json` leaves the child's session_id in the parent
  // transcript's hook_* stdout. Built before processing so a child in an earlier
  // dir still resolves its parent. Off = no HOOK parent attribution (HOOK stays NONE).
  const hookChildToParent = captureLineage ? buildHookChildToParent(projectDirs) : new Map<string, HookParentRef>();

  for (const projectDir of projectDirs) {
    const projectDirName = basename(projectDir);

    let files: string[];
    try {
      files = readdirSync(projectDir, { withFileTypes: true })
        .filter(
          (f) =>
            f.isFile() &&
            f.name.endsWith(".jsonl") &&
            !f.name.startsWith("agent-")
        )
        .map((f) => join(projectDir, f.name));
    } catch (err) {
      // Gone since the listing above: nothing to read. Unreadable: say so.
      if (!isMissing(err)) reportSourceError(projectDir, err);
      continue;
    }

    totalFiles += files.length;

    for (const filePath of files) {
      const sessionId = basename(filePath, ".jsonl");
      const compositeId = `${projectDirName}::${sessionId}`;

      try {
        if (processJsonlFile(db, filePath, compositeId, projectDirName, runInstallMeta, runOauthRaw, runMcpNames, runStatsCache, runSessionKinds, undefined, captureLineage, hookChildToParent)) {
          extracted++;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error("extraction.claude_code", "file_processing_error", {
          filePath,
          error: errorMsg,
        });
        reportRecordError(compositeId, filePath, err);
      }
    }

    // Subagent transcripts live at <projectDir>/<parentUuid>/subagents/agent-*.jsonl
    // (a subdir the main-session readdir above never reaches). Capture each as its
    // own lineage-tagged conversation so a consumer folds it onto its parent
    // instead of analyzing it as a standalone session. Gated by the
    // `captureLineage` scan option; off, sub-agent transcripts are not captured.
    for (const sessionDir of captureLineage ? readdirSyncSafe(projectDir).filter((d) => d.isDirectory()) : []) {
      const parentUuid = sessionDir.name;
      const subagentsDir = join(projectDir, parentUuid, "subagents");
      for (const agentDirent of readdirSyncSafe(subagentsDir)) {
        if (!agentDirent.isFile() || !agentDirent.name.startsWith("agent-") || !agentDirent.name.endsWith(".jsonl")) {
          continue;
        }
        const agentFile = join(subagentsDir, agentDirent.name);
        totalFiles++;
        const childComposite = `${projectDirName}::${parentUuid}::${basename(agentFile, ".jsonl")}`;
        try {
          const lineage = buildSubagentLineage(agentFile, parentUuid, uuidToProjectDir);
          if (processJsonlFile(db, agentFile, childComposite, projectDirName, runInstallMeta, runOauthRaw, runMcpNames, runStatsCache, runSessionKinds, lineage, captureLineage)) {
            extracted++;
          }
        } catch (err) {
          logger.error("extraction.claude_code", "subagent_processing_error", {
            agentFile,
            error: err instanceof Error ? err.message : String(err),
          });
          reportRecordError(childComposite, agentFile, err);
        }
      }
    }
  }

  // Cowork (Claude desktop agent-mode) audit stores share this vendor and parse
  // path, and land as claude-code rows tagged session_meta.source="cowork" (Cowork
  // is a surface of Claude Code, not a distinct IDE). Drain them in the same pass so
  // the transcript cache and run-level install metadata are reused.
  extracted += extractCoworkAudits(
    db,
    { runInstallMeta, runOauthRaw, runMcpNames, runStatsCache, runSessionKinds },
    captureLineage,
  );

  const durationMs = Date.now() - startTime;
  logger.info("extraction.claude_code", "extraction_complete", {
    durationMs,
    projectDirs: projectDirs.length,
    totalFiles,
    newOrChangedConversations: extracted,
  });

  return extracted;
}

// ── Internals ────────────────────────────────────────────────────────────────

/** True for a path that is not there (or not a folder), as against one that cannot be read. */
function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

// readdirSyncSafe returns dir entries, or an empty list if the path is missing or
// unreadable (a session's subagents/ subdir is optional — most sessions have none).
function readdirSyncSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// buildSubagentLineage builds the lineage for a Claude Code subagent transcript at
// <projectDir>/<parentUuid>/subagents/agent-*.jsonl. The parent's record_key is
// computed from the parent's REAL projectDir (resolved worktree-safe by uuid), so
// a subagent whose parent session lives in a different projectDir (git worktree)
// still links — a key built from the subagent's own dir would miss those. The
// sibling .meta.json carries agentType + toolUseId; an agentType with a
// "<plugin>:" prefix marks a plugin-spawned child. tokens are filled in by
// processJsonlFile from the parsed transcript.
function buildSubagentLineage(
  agentFile: string,
  parentUuid: string,
  uuidToProjectDir: Map<string, string>,
): SessionLineagePayload {
  let agentType: string | undefined;
  let toolUseId: string | undefined;
  const metaPath = agentFile.replace(/\.jsonl$/, ".meta.json");
  if (existsSync(metaPath)) {
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as {
        agentType?: string;
        toolUseId?: string;
      };
      agentType = meta.agentType;
      toolUseId = meta.toolUseId;
    } catch {
      /* malformed .meta.json — leave agentType/toolUseId undefined */
    }
  }
  // Plugin classification is a heuristic on the only signal Claude Code exposes:
  // a plugin subagent's agentType is namespaced "<plugin>:<agent>", a built-in is
  // a bare name. .meta.json carries no explicit plugin field. This only sets the
  // per-agent breakdown (relation_type PLUGIN vs SUBAGENT, plugin_name) — both
  // still fold, so a misclassified namespaced-but-not-plugin name mis-labels the
  // breakdown, never the token/cost total.
  const pluginName =
    agentType && agentType.includes(":") ? agentType.split(":")[0] : undefined;
  const parentProjectDir = uuidToProjectDir.get(parentUuid);
  return {
    relation_type: pluginName ? "PLUGIN" : "SUBAGENT",
    parent_record_key: parentProjectDir
      ? conversationId("claude-code", `${parentProjectDir}::${parentUuid}`)
      : undefined,
    linkage_confidence: parentProjectDir ? "STRONG" : "NONE",
    origin_agent_type: agentType,
    plugin_name: pluginName,
    tool_use_id: toolUseId,
  };
}

/**
 * Processes a single JSONL file. Returns true if the conversation was
 * inserted/updated, false if skipped (unchanged).
 */
// A hook that runs `claude -p … --output-format json` echoes the spawned child
// session's JSON result — which contains its session_id — to stdout, and Claude
// Code captures that stdout verbatim in the PARENT transcript's hook_* attachment.
// Scanning those attachments yields a deterministic child-session → parent-session
// link: it is per-transcript, so the same hook firing from many parent sessions
// never collides (each parent names its own child). POC-validated. Only hooks that
// emit the child's json to stdout are linkable; others stay parent-less (HOOK/NONE).
const HOOK_CHILD_SESSION_ID_RE = /"session_id"\s*:\s*"([0-9a-fA-F-]{36})"/g;

interface HookParentRef {
  uuid: string;
  projectDirName: string;
}

// buildHookChildToParent indexes child-session-uuid → its parent session across all
// main transcripts, from the child session_id captured in parent hook_* attachment
// stdout (see HOOK_CHILD_SESSION_ID_RE). Cheap: files with no hook fire + embedded
// session id are skipped without a JSON parse.
function buildHookChildToParent(projectDirs: string[]): Map<string, HookParentRef> {
  const map = new Map<string, HookParentRef>();
  // A child claimed by two different parents (e.g. `claude --resume <child>` fired
  // from both) is ambiguous — drop it rather than pick by scan order.
  const ambiguous = new Set<string>();
  for (const projectDir of projectDirs) {
    const projectDirName = basename(projectDir);
    let entries: Dirent[];
    try {
      entries = readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.isFile() || !f.name.endsWith(".jsonl") || f.name.startsWith("agent-")) continue;
      const parentUuid = basename(f.name, ".jsonl");
      let content: string;
      try {
        content = readFileSync(join(projectDir, f.name), "utf-8");
      } catch {
        continue;
      }
      if (!content.includes('"hook_') || !content.includes("session_id")) continue;
      for (const raw of content.split("\n")) {
        if (!raw.includes('"hook_') || !raw.includes("session_id")) continue;
        let line: { attachment?: { type?: unknown; stdout?: unknown; command?: unknown } };
        try {
          line = JSON.parse(raw) as typeof line;
        } catch {
          continue;
        }
        const att = line.attachment;
        if (!att || typeof att.type !== "string" || !att.type.startsWith("hook_")) continue;
        // Trust a scraped session_id only from the stdout of a `claude -p …
        // --output-format json` command hook — that invocation's stdout IS the
        // spawned child's JSON result, which is the only case the parent→child
        // invariant holds for. A context hook (which carries injected `content`,
        // not command stdout) or any other command whose text merely contains a
        // session_id would otherwise be mis-recorded as a STRONG parent edge, so
        // gate on the command shape and read stdout only.
        const command = typeof att.command === "string" ? att.command : "";
        const isClaudePrintJson =
          /\bclaude\b/.test(command) &&
          (command.includes(" -p") || command.includes("--print")) &&
          command.includes("--output-format") &&
          command.includes("json");
        if (!isClaudePrintJson) continue;
        const out = typeof att.stdout === "string" ? att.stdout : "";
        // The stdout may hold several session_ids (a hook echoing its own/the
        // parent's id before the child's, or spawning >1 child): take the first
        // that is NOT the parent's own id.
        let childId: string | undefined;
        for (const m of out.matchAll(HOOK_CHILD_SESSION_ID_RE)) {
          if (m[1] && m[1] !== parentUuid) {
            childId = m[1];
            break;
          }
        }
        if (!childId || ambiguous.has(childId)) continue;
        const existing = map.get(childId);
        if (existing && existing.uuid !== parentUuid) {
          ambiguous.add(childId); // two parents claim it — drop, don't guess
          map.delete(childId);
          continue;
        }
        if (!existing) map.set(childId, { uuid: parentUuid, projectDirName });
      }
    }
  }
  return map;
}

function processJsonlFile(
  db: SessionSink,
  filePath: string,
  sessionId: string,
  projectDirName: string,
  runInstallMeta: InstallationMetadata | null,
  runOauthRaw: InstallationMetadata | null,
  // Global reads resolved once per run by the caller and threaded in (same for
  // every session): MCP server names and the parsed stats cache.
  runMcpNames: string[],
  runStatsCache: ReturnType<typeof readStatsCache>,
  // sessionId → session_kind for the whole run; looked up per session below.
  runSessionKinds: Map<string, string>,
  lineage?: SessionLineagePayload,
  captureLineage = false,
  hookChildToParent?: Map<string, HookParentRef>,
  // Cowork audit files (Claude desktop agent-mode) reuse this exact parse path.
  // `coworkMode` makes the loop map each raw audit line into the Claude Code shape it
  // reads — `_audit_timestamp`->`timestamp` and the session `cwd` (injected from the
  // system/init line, resolved below from the size-fused, dedup-gated transcript, so an
  // unchanged file is never re-read and the size fuse still guards it).
  // `sourceOverride` stamps `session_meta.source`, which names the surface that ran it.
  coworkMode = false,
  sourceOverride?: string,
): boolean {
  let fileStat: { mtimeMs: number; size: number };
  try {
    const s = statSync(filePath);
    fileStat = { mtimeMs: Math.floor(s.mtimeMs), size: s.size };
  } catch (err) {
    logger.warn("extraction.claude_code", "file_stat_error", {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  const eventBuilder = new SessionEventBuilder();

  const tracking = db.getTracking("claude-code", sessionId);

  // Unchanged — skip full re-extraction.
  // But patch project_path/repo_name if we can now resolve a better one
  // (e.g., "example-org" → "example-org/example-repo" via findGitRoot + file path inference).
  if (
    tracking &&
    tracking.last_mtime_ms === fileStat.mtimeMs &&
    tracking.last_size === fileStat.size
  ) {
    patchProjectMetadata(
      db,
      filePath,
      sessionId,
      projectDirName,
      tracking,
      `${fileStat.mtimeMs}:${fileStat.size}`,
    );
    return false;
  }

  // Read + parse the full file through the shared cache — JSONL is append-only
  // but upsert needs the complete conversation array, so we read from the start.
  // Other readers of the same changed transcript in this scan share the parse. null = read failure or a file past the
  // pathological-size fuse; skip it (retried when its stat next moves).
  const parsedTranscript = getParsedTranscript(filePath);
  if (parsedTranscript === null) return false;
  // A file with lines and none readable is a broken session, not an empty one.
  if (parsedTranscript.lines.length === 0 && parsedTranscript.malformedLines > 0) {
    reportRecordError(sessionId, filePath, new Error(`none of the transcript's ${parsedTranscript.malformedLines} line(s) is a JSON object`));
    return false;
  }

  // Cowork audit lines differ in shape from a ~/.claude/projects transcript, so build
  // the per-line normalizer HERE — after the stat/dedup skip and the size fuse above —
  // from the already-parsed transcript, resolving the session `cwd` from its first
  // cwd-bearing (system/init) line. Doing it here (not before processJsonlFile) means an
  // unchanged file is never re-read every cycle and a pathological file is still fused.
  const lineNormalizer = coworkMode
    ? buildCoworkLineNormalizer(parsedTranscript.lines)
    : undefined;

  const prompts: ConversationPrompt[] = [];
  // Joins an Edit/Write tool_use id to the assistant prompt that issued it, so the
  // following user line's toolUseResult can stamp files_edited + line counts on the
  // turn that made the edit (per-message attribution, mirroring the Codex extractor).
  const toolUseIdToPrompt = new Map<string, ConversationPrompt>();
  let lastAssistantPrompt: ConversationPrompt | undefined;
  let projectPath: string | undefined;
  const toolFilePaths = new Set<string>();

  // JSONL event tracking.
  let compactionCount = 0;
  let manualCompactionCount = 0;
  let preCompactionTokensSum = 0;
  // Scalars hold the FIRST pr-link event (kept for backward compat with
  // readers that pre-date pr_references). prReferencesInOrder tracks every
  // distinct (repo, number) reference the session emitted, in first-seen
  // order — consumed by a consumer to attribute the session to
  // every PR it touched.
  let prUrl: string | undefined;
  let prNumber: number | undefined;
  let prRepository: string | undefined;
  const prReferencesInOrder: Array<{ pr_url: string; pr_number: number; pr_repository: string }> = [];
  const prReferenceKeys = new Set<string>();
  // Two title signals from Claude Code — `ai-title` (model-generated) and
  // `custom-title` (the user's manual rename) — resolved into session_title below.
  let aiTitle: string | undefined;
  let customTitle: string | undefined;
  // Track every distinct gitBranch observed across user messages, preserving
  // first-seen order. The session's final gitBranch is resolved after the loop:
  // prefer the last non-trunk branch seen so a session that starts on master
  // and switches to a feature branch is attributed to the feature branch.
  const branchesSeenInOrder: string[] = [];
  const trackedFilePaths = new Set<string>();
  let lastPromptText: string | undefined;
  let firstPromptText: string | undefined;
  let bridgeSessionUrl: string | undefined;
  // The launch surface CC stamps on each line. Interactive turns are "cli"; a
  // headless run (claude -p, Agent SDK) is "sdk-cli"/"sdk-py"/…. Tracked across
  // ALL turns, not the first: a session started headlessly and later resumed
  // interactively (claude --resume) carries both, and is only HOOK below if it
  // NEVER went interactive — so a real human turn is never hidden.
  let sawSdkEntrypoint = false;
  let sawInteractiveEntrypoint = false;
  // The session's launch surface, captured verbatim for session_meta.source: "cli" / "claude-vscode" / "claude-desktop" are the human-facing
  // entrypoints, "sdk-cli"/"sdk-py"/… the headless ones. A human-facing entrypoint wins over a
  // headless one (a session resumed interactively is interactive), and the first such value is
  // kept — a session rarely mixes human-facing surfaces.
  let sessionEntrypoint: string | undefined;
  // The HITL posture Claude Code stamps top-level as `permissionMode` (values: default, plan,
  // acceptEdits, auto, bypassPermissions). It arrives two ways — a dedicated `permission-mode`
  // switch event, and inline on `user` lines (sparsely — only around mode changes) — so we track
  // the last value across ALL lines and treat it as the active mode. It feeds two things: the
  // session-level session_meta.approval_mode (the mode the session ended in, matching how the final
  // gitBranch is resolved above), and the per-turn stamp below — each user turn carries the active
  // (forward-filled) mode, so a switch delivered by an event line between two user turns still lands
  // on the following turn. A consumer forward-fills any remaining gaps and covers other sources.
  let lastPermissionMode: string | undefined;

  for (const parsedLine of parsedTranscript.lines) {
    const line = (lineNormalizer ? lineNormalizer(parsedLine) : parsedLine) as JsonlLine;

    // Count any record kind the corpus has never shown us — the vendor-drift
    // tripwire. A no-op for every recognized kind (acted-on or skipped below).
    noteUnknownRecordKind("claude-code", claudeCodeRecordKind(line));

    {
      const ep = (line as Record<string, unknown>).entrypoint;
      if (typeof ep === "string" && ep.length > 0) {
        if (ep.startsWith("sdk")) sawSdkEntrypoint = true;
        else sawInteractiveEntrypoint = true;
        if (sessionEntrypoint === undefined || (sessionEntrypoint.startsWith("sdk") && !ep.startsWith("sdk"))) {
          sessionEntrypoint = ep;
        }
      }
    }

    // permissionMode is authoritative for the turn that carries it. A known value sets the mode; a
    // present-but-unrecognized one means the mode changed to a value we can't vet, so clear it rather
    // than forward-fill the previous line's mode — the schema promises unset when unknown, and an
    // unvetted string never ships. An absent field is a gap, not a change, so the last known stays.
    const rawPermissionMode = (line as Record<string, unknown>).permissionMode;
    if (typeof rawPermissionMode === "string") {
      lastPermissionMode = allowedPermissionMode(rawPermissionMode);
    }

    // Extract JSONL events beyond user/assistant.
    if (line.type === "system" && (line as Record<string, unknown>).subtype === "compact_boundary") {
      compactionCount++;
      const trigger = (line as Record<string, unknown>).trigger;
      if (trigger === "manual") manualCompactionCount++;
      const preTokens = (line as Record<string, unknown>).preTokens;
      if (typeof preTokens === "number") preCompactionTokensSum += preTokens;
      // Emit the boundary as a positional timeline event too — the session totals
      // above discard where in the run it happened, which is what a turn grouper needs.
      eventBuilder.addCompaction(safeTimestamp(line.timestamp));
      continue;
    }
    if (line.type === "system" && (line as Record<string, unknown>).subtype === "api_error") {
      // Claude Code logs each API/network retry as its own `system/api_error` record
      // (`source: request_retry | connection_retry`, `retryAttempt`, `maxRetries`).
      // Emit one positional API_RETRY event per record so a turn grouper can place the
      // retry inside the turn it interrupted; the raw `error` text is never read.
      const rec = line as Record<string, unknown>;
      // `source` rides into the stored `operation_name`, so admit ONLY the closed
      // vocabulary rather than any string — an unrecognized/renamed value is dropped,
      // never stored raw (defense-in-depth against a vendor renaming the field).
      const source = rec.source === "request_retry" || rec.source === "connection_retry" ? rec.source : undefined;
      eventBuilder.addApiRetry({
        source,
        retryAttempt: typeof rec.retryAttempt === "number" ? rec.retryAttempt : undefined,
        maxRetries: typeof rec.maxRetries === "number" ? rec.maxRetries : undefined,
        at: safeTimestamp(line.timestamp),
      });
      continue;
    }
    if (line.type === "pr-link") {
      const prLine = line as Record<string, unknown>;
      const url = typeof prLine.prUrl === "string" ? prLine.prUrl : "";
      const num = typeof prLine.prNumber === "number" ? prLine.prNumber : 0;
      const repo = typeof prLine.prRepository === "string" ? prLine.prRepository : "";
      if (num > 0 && repo !== "") {
        const key = `${repo}#${num}`;
        if (!prReferenceKeys.has(key)) {
          prReferenceKeys.add(key);
          prReferencesInOrder.push({ pr_url: url, pr_number: num, pr_repository: repo });
          // Populate scalars from the FIRST reference only for backward compat.
          if (prNumber === undefined) {
            prUrl = url;
            prNumber = num;
            prRepository = repo;
          }
        }
      }
      continue;
    }
    if (line.type === "ai-title") {
      // `ai-title` lines carry the title under `aiTitle` (there is no `title` key).
      // Guard non-blank so an empty/whitespace title never suppresses the other
      // signal below (`customTitle ?? aiTitle` only falls through on null/undefined).
      const titleLine = line as Record<string, unknown>;
      if (typeof titleLine.aiTitle === "string" && titleLine.aiTitle.trim() !== "") {
        aiTitle = titleLine.aiTitle;
      }
      continue;
    }
    if (line.type === "custom-title") {
      // `custom-title` is the user's manual rename, under `customTitle`.
      const titleLine = line as Record<string, unknown>;
      if (typeof titleLine.customTitle === "string" && titleLine.customTitle.trim() !== "") {
        customTitle = titleLine.customTitle;
      }
      continue;
    }
    if (line.type === "file-history-snapshot") {
      // Claude CLI emits two shapes over time:
      //   new (observed on 2.1.114+): { snapshot: { trackedFileBackups: { "<abs-path>": {...}, ... } } }
      //   old: { trackedFileBackups: [ { filePath }, ... ] }
      // Read both: reading only the old shape silently returns zero matches on
      // new-shape events (nested object, not array).
      const raw = line as Record<string, unknown>;
      const innerSnap = raw.snapshot as Record<string, unknown> | undefined;
      const nested = innerSnap?.trackedFileBackups;
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        for (const filePath of Object.keys(nested)) {
          if (filePath.length > 0) trackedFilePaths.add(filePath);
        }
      } else {
        const legacy = raw.trackedFileBackups;
        if (Array.isArray(legacy)) {
          for (const entry of legacy) {
            if (typeof entry === "object" && entry !== null) {
              const filePath = (entry as Record<string, unknown>).filePath;
              if (typeof filePath === "string" && filePath.length > 0) {
                trackedFilePaths.add(filePath);
              }
            }
          }
        }
      }
      continue;
    }
    if (line.type === "last-prompt") {
      const lp = line as Record<string, unknown>;
      if (typeof lp.text === "string") lastPromptText = lp.text;
      continue;
    }
    if (line.type === "system" && (line as Record<string, unknown>).subtype === "bridge_status") {
      const bs = line as Record<string, unknown>;
      if (typeof bs.url === "string") bridgeSessionUrl = bs.url;
      continue;
    }

    // Only process user and assistant messages for prompts.
    if (line.type !== "user" && line.type !== "assistant") continue;

    const role = line.type as "user" | "assistant";
    // Drift guard on the message-bearing field: `message.content` is present on
    // EVERY real user and assistant record (a rename of `message` or `content`
    // reads as absent and silently drops the turn). `role` is the record kind for
    // these two — no subtype. See requireConsumedField for the presence semantics.
    const messageContent = requireConsumedField("claude-code", role, "message.content", line.message?.content);
    const { text: contentText, hasImage, relevantFiles: msgFiles } = extractContent(messageContent, role);

    // Shape guard on the token-bearing field — the whole point of the tripwire is
    // silent token loss. `message.usage` is an OBJECT of token counts on EVERY
    // assistant record (including an interrupted zero-token turn, where it carries
    // zeros — verified against the fixtures), and the token reads below index into it;
    // an absent usage OR a scalar in its place drops the turn's tokens to zero
    // unnoticed. Guarded ONLY on assistant (a `user` record never carries usage —
    // guarding it there would cry wolf), and placed HERE, before the
    // continuation/empty-content skips below, so a thinking-only assistant record
    // (empty extracted text but real usage) is still monitored.
    if (role === "assistant") {
      requireConsumedShape("claude-code", "assistant", "message.usage", line.message?.usage, "object");
    }

    // Collect file paths from assistant tool_use blocks for repo inference
    if (role === "assistant") {
      collectToolFilePaths(line.message?.content, toolFilePaths);
    }

    // Timeline capture runs BEFORE the prompt skips below. A tool_result arrives as a
    // user message whose content is only tool_result blocks, which extractContent
    // deliberately keeps out of contentText — so such a line is "empty" as a prompt but
    // carries the check OUTCOME loop detection needs. Skipping it here would cap every
    // session's coverage at PARTIAL and leave no pass/fail for validation to ground on.
    eventBuilder.addMessageEvents(line, safeTimestamp(line.timestamp));

    // Per-message files_edited + line counts: a user line's toolUseResult carries the
    // edit outcome; join it back to the assistant turn that issued the tool_use and
    // accumulate onto that turn (a turn may make several edits). Runs before the skips
    // below because a tool_result user line has no prompt text and is skipped as a prompt.
    if (role === "user" && line.toolUseResult) {
      const counts = editCountsFromToolUseResult(line.toolUseResult);
      if (counts) {
        for (const useID of toolResultUseIdsInUser(line.message?.content)) {
          // The exact turn that issued the tool_use; fall back to the most recent
          // assistant turn when that message was text-less and so skipped as a prompt.
          const target = toolUseIdToPrompt.get(useID) ?? lastAssistantPrompt;
          if (!target) continue;
          const md = (target.metadata ??= {});
          const files = new Set(md.filesEdited ?? []);
          files.add(counts.filePath);
          md.filesEdited = [...files];
          md.linesAdded = (md.linesAdded ?? 0) + counts.added;
          md.linesRemoved = (md.linesRemoved ?? 0) + counts.removed;
          break; // one toolUseResult belongs to one tool_result/turn
        }
      }
    }

    // Skip continuation summaries
    if (role === "user" && contentText.startsWith(CONTINUATION_PREFIX)) continue;

    // Skip empty
    if (contentText.trim().length === 0) continue;

    // Capture the first genuine user prompt as the fallback session name
    // (continuations/empties already skipped). Skip isMeta turns so the first real
    // prompt after any injected turn wins. Redact before capping — session_meta is stored
    // separately from the redacted prompts[], so scrub secrets/paths here too.
    if (role === "user" && line.isMeta !== true && firstPromptText === undefined) {
      firstPromptText = redactText(readableFirstPrompt(contentText)).slice(0, FIRST_PROMPT_MAX_CHARS);
    }

    // Extract project path from first user line; record every branch we see.
    if (projectPath === undefined && typeof line.cwd === "string" && line.cwd.length > 0) {
      projectPath = line.cwd;
    }
    {
      const branch = (line as Record<string, unknown>).gitBranch;
      if (typeof branch === "string" && branch.length > 0) {
        const last = branchesSeenInOrder[branchesSeenInOrder.length - 1];
        if (branch !== last) {
          branchesSeenInOrder.push(branch);
        }
      }
    }

    const timestamp = safeTimestamp(line.timestamp);

    const metadata = buildMetadata(line);
    if (hasImage) {
      metadata.isImageAdded = true;
    }
    applyUsage(metadata, line.message?.usage);
    if (msgFiles.length > 0) {
      metadata.relevantFiles = msgFiles;
    }
    // A subagent transcript's turns are the delegated agent's work — flag them so the
    // author stamp below reads DELEGATED_AGENT instead of HUMAN. `isSidechain` is Claude's
    // marker; without this the delegation is dropped and the turn inflates human activity.
    if (line.isSidechain === true) {
      metadata.isSubAgent = true;
    }

    // authorship (message-level): injected = isMeta (skill bodies, caveats, hook feedback) OR the
    // command / stdout / task-notification markup isMeta does not flag. Deliberately a BROADER injected
    // signal than the event-level promptReferenceAuthor below (isMeta only): authorship is about
    // whose WORDS the bytes are — command markup is machine boilerplate, so INJECTED — while the
    // event author is a steering signal, and a person invoking a command still steered the run.
    // So the two legitimately differ on a slash-command turn; see promptAuthorship for the rest.
    const authorship = promptAuthorship(
      { role, metadata },
      { injected: line.isMeta === true || isInjectedUserMarkup(contentText) }
    );
    if (authorship !== "PROMPT_AUTHORSHIP_UNSPECIFIED") {
      metadata.authorship = authorship;
    }

    // Stamp the active (forward-filled) HITL gate on this user turn — the last mode seen on any
    // prior line, so a switch delivered by a standalone `permission-mode` event still reaches the
    // next user turn (the inline value is sparse). A consumer forward-fills any leading gap.
    if (role === "user" && lastPermissionMode !== undefined) {
      metadata.permission_mode = lastPermissionMode;
    }

    const prompt: ConversationPrompt = {
      role,
      content: contentText,
      timestamp,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    };
    prompts.push(prompt);
    // Track the edit-attribution targets: map this assistant turn's Edit/Write tool_use
    // ids to it, and remember it as the fallback for a following tool_result whose own
    // tool_use message was text-less (skipped).
    if (role === "assistant") {
      lastAssistantPrompt = prompt;
      for (const useID of toolUseIdsInAssistant(line.message?.content)) {
        toolUseIdToPrompt.set(useID, prompt);
      }
    }

    // In step with the prompt list: the reference uses the ordinal this message just
    // took (1-based), so a consumer dereferences it back to exactly this content. The
    // message's tool/command events were already recorded above, before the skips.
    //
    // The author comes from that same object rather than from the local `role`, so the two
    // cannot describe different messages. Most of a Claude Code session's references are the
    // assistant's, which is the whole reason the event has to say so.
    //
    // `isMeta` is passed because Claude injects caveats, resume reminders and command output as
    // `user` turns. They carry text, so they reach the prompt list, and stamping them HUMAN
    // would let a harness-injected line disqualify a run the person never touched.
    eventBuilder.addPromptReference(
      prompts.length,
      timestamp,
      promptReferenceAuthor(prompt, { injected: line.isMeta === true })
    );
  }

  // Fill missing model on user messages from the nearest assistant message
  fillMissingModels(prompts);

  // Read session-meta and facets files.
  const sessionMeta = readSessionMeta(sessionId);
  const sessionFacets = readSessionFacets(sessionId);

  // Merge JSONL-derived signals into session_meta.
  const mergedMeta: SessionMetaPayload = { ...sessionMeta };
  // Per-session kind. First choice is CC's live sessions file (authoritative,
  // keyed by the session's uuid — the composite id strips to the same uuid
  // readSessionMeta uses; for a subagent that resolves to the PARENT's uuid, so
  // the child inherits the parent's kind, consistent with the rest of its
  // session_meta). That file is pruned on process exit, so a session that starts
  // and ends between polls is absent from the run map; fall back to the DURABLE
  // per-session signal in the transcript — the entrypoint stamped on each turn
  // ("cli" interactive, "sdk-*" headless), already accumulated above. A human
  // turn is never hidden: any interactive entrypoint makes it interactive, only
  // an sdk-only session is background. Db.upsert additionally preserves a value
  // captured on an earlier live extraction, so a re-extraction never erases it.
  const sessionUuid = sessionId.includes("::") ? sessionId.split("::")[1]! : sessionId;
  const transcriptSessionKind = sawInteractiveEntrypoint
    ? "interactive"
    : sawSdkEntrypoint
      ? "background"
      : undefined;
  const sessionKind = runSessionKinds.get(sessionUuid) ?? transcriptSessionKind;
  if (sessionKind) {
    mergedMeta.session_kind = sessionKind;
  }
  if (compactionCount > 0) {
    mergedMeta.compaction_count = compactionCount;
    mergedMeta.manual_compaction_count = manualCompactionCount;
    mergedMeta.avg_pre_compaction_tokens = Math.round(preCompactionTokensSum / compactionCount);
  }
  if (prUrl !== undefined) {
    mergedMeta.pr_url = prUrl;
    mergedMeta.pr_number = prNumber;
    mergedMeta.pr_repository = prRepository;
  }
  if (prReferencesInOrder.length > 0) {
    mergedMeta.pr_references = prReferencesInOrder;
  }
  // A manual rename is the user's explicit choice, so it beats the AI-generated
  // title; either real title beats one a consumer infers.
  const sessionTitle = customTitle ?? aiTitle;
  if (sessionTitle !== undefined) {
    mergedMeta.session_title = sessionTitle;
  }
  if (branchesSeenInOrder.length > 0) {
    mergedMeta.git_branches = branchesSeenInOrder;
    // Scalar git_branch for readers that only read the scalar: the last
    // non-trunk branch seen (resolveSessionBranch).
    const scalar = resolveSessionBranch(branchesSeenInOrder);
    if (scalar !== undefined) {
      mergedMeta.git_branch = scalar;
    }
  }
  if (trackedFilePaths.size > 0) {
    mergedMeta.tracked_file_paths = Array.from(trackedFilePaths);
  }
  // Claude Code — unlike Cursor/Kiro — never self-reports languages, so without
  // this almost every CC session carries no language signal and per-language
  // counts undercount. Derive from the files the session
  // already captured (write-tool relevantFiles ∪ file-history-snapshot tracked
  // paths), stored as session_meta.languages.
  const languageFilePaths = new Set<string>(trackedFilePaths);
  for (const p of prompts) {
    for (const f of p.metadata?.relevantFiles ?? []) {
      languageFilePaths.add(f);
    }
  }
  if (languageFilePaths.size > 0) {
    const languages = deriveLanguages(languageFilePaths);
    if (Object.keys(languages).length > 0) {
      mergedMeta.languages = languages;
    }
  }
  if (lastPromptText !== undefined) {
    mergedMeta.last_prompt = lastPromptText;
  }
  if (firstPromptText !== undefined) {
    // Redacted at capture, before the FIRST_PROMPT_MAX_CHARS cap — a secret must not
    // straddle the truncation bound, so this one field is scrubbed pre-cap rather
    // than relying on the choke point (which re-redacts it as a no-op).
    mergedMeta.first_prompt = firstPromptText;
  }
  if (bridgeSessionUrl !== undefined) {
    mergedMeta.bridge_session_url = bridgeSessionUrl;
  }

  if (lastPermissionMode !== undefined) {
    mergedMeta.approval_mode = lastPermissionMode;
  }

  if (runMcpNames.length > 0) {
    mergedMeta.mcp_server_names = runMcpNames;
  }

  // Derive user_message_timestamps from JSONL timestamps when session-meta
  // doesn't provide them (session-meta file missing or has no timestamps).
  // This ensures a consumer can compute active duration for sessions where
  // CC didn't write a session-meta JSON.
  if (!mergedMeta.user_message_timestamps || mergedMeta.user_message_timestamps.length < 2) {
    const userTimestamps = prompts
      .filter((p) => p.role === "user" && p.timestamp)
      .map((p) => p.timestamp!)
      .filter((ts) => ts.length > 0);
    if (userTimestamps.length >= 2) {
      mergedMeta.user_message_timestamps = userTimestamps;
    }
  }

  // Session lineage. Either the caller-computed subagent lineage, or — for a
  // top-level session with no subagent lineage — a HOOK tag when the session is
  // non-interactive: a headless run (claude -p, Agent SDK) stamps an "sdk-*"
  // entrypoint ("cli" is interactive), so its machine-authored prompt is never
  // analyzed as a standalone session. HOOK is parentless (mark-and-skip). Gated
  // on the captureLineage scan option.
  let effectiveLineage = lineage;
  if (!effectiveLineage && captureLineage && sawSdkEntrypoint && !sawInteractiveEntrypoint) {
    // Attribute to the parent session that fired the hook when the deterministic
    // stdout link resolved it (STRONG); otherwise the hook run is parent-less (NONE).
    const parent = hookChildToParent?.get(basename(filePath, ".jsonl"));
    // origin_agent_type "hook" labels the fold bucket: a consumer aggregates a
    // folded child's usage by (origin_agent_type, plugin_name), so without it a
    // Claude hook's cost lands in the empty-agent bucket instead of a distinct
    // "hook" one — same tag the Codex hook path sets.
    effectiveLineage = parent
      ? {
          relation_type: "HOOK",
          origin_agent_type: "hook",
          parent_record_key: conversationId("claude-code", `${parent.projectDirName}::${parent.uuid}`),
          linkage_confidence: "STRONG",
          tokens: 0,
        }
      : { relation_type: "HOOK", origin_agent_type: "hook", linkage_confidence: "NONE", tokens: 0 };
  }
  if (effectiveLineage) {
    let childTokens = 0;
    for (const p of prompts) {
      const m = p.metadata;
      if (m) {
        childTokens +=
          (m.inputTokens ?? 0) +
          (m.outputTokens ?? 0) +
          (m.cacheCreationInputTokens ?? 0) +
          (m.cacheReadInputTokens ?? 0);
      }
    }
    mergedMeta.lineage = { ...effectiveLineage, tokens: childTokens };
  }

  // Surface stamp: a Cowork audit runs through this Claude Code parse path, and
  // session_meta.source says which surface ran it. "source" is "structured" in the
  // redaction map, so it ships as-is.
  if (sourceOverride) {
    mergedMeta.source = sourceOverride;
  } else if (sessionEntrypoint) {
    // Non-Cowork sessions: the launch surface is the per-line entrypoint (cli / claude-vscode /
    // claude-desktop / sdk-*), read from THIS session's own transcript lines — so it reflects how
    // this session was launched, not an install-global default.
    mergedMeta.source = sessionEntrypoint;
  }

  const hasMetaFields = Object.keys(mergedMeta).length > 0;
  const sessionMetaJson = hasMetaFields ? JSON.stringify(sanitizeSessionMeta(mergedMeta)) : undefined;
  const sessionFacetsJson = sessionFacets ? JSON.stringify(sessionFacets) : undefined;

  // Skip files with no user prompts
  if (prompts.filter((p) => p.role === "user").length === 0) return false;

  // Resolve project path to git root and determine repo name.
  // Central logic: try findGitRoot(path), fallback to file paths from tool_use blocks.
  const rawPath = projectPath ?? decodeProjectDirName(projectDirName);
  const resolved = resolveProjectAndRepo(rawPath, Array.from(toolFilePaths));
  const resolvedPath = resolved?.projectPath ?? rawPath;
  const repoName = resolved?.repoName;

  // Redact PII (secrets, paths, usernames) before persisting
  const redactedPrompts = redactPrompts(prompts);
  const redactedProjectPath = redactPath(resolvedPath);

  const newOffset = fileStat.size;

  // Prefer the run-level install metadata (computed once per extraction from
  // telemetry + sessions dirs). When telemetry detection returned null — fresh
  // installs, users with an OTel override that disables local writes — use
  // per-session model data from the JSONL we just parsed so every stored
  // conversation still carries *some* plan signal.
  let installMeta: InstallationMetadata | null = runInstallMeta;
  if (!installMeta) {
    let sawOpus = false;
    let sawAnyModel = false;
    for (const p of prompts) {
      const m = p.metadata?.model;
      if (typeof m === "string" && m.length > 0) {
        sawAnyModel = true;
        if (m.toLowerCase().includes("opus")) {
          sawOpus = true;
          break;
        }
      }
    }
    if (sawAnyModel) {
      installMeta = {
        plan_tier: sawOpus ? "pro" : "pro_or_free",
        plan_tier_source: "cc_model_inferred",
      };
    }
  }

  // Merge the authoritative oauthAccount raw fields onto the finalized install
  // metadata. This runs AFTER the inferred cascade above, so plan_tier is always
  // already set by telemetry/model first; oauth only ADDS raw fields (seat_tier,
  // etc.). A consumer derives the canonical plan_tier from those raw fields, so
  // no code path here can leave plan_tier blank.
  //
  // Precedence on the two overlapping keys (organization_uuid / account_uuid):
  // spread oauth FIRST so the telemetry-derived values win when present — those
  // were the IDs used to infer this session's tier, so oauth only fills
  // fields telemetry left empty. When telemetry is absent (installMeta null), oauth
  // is the sole source and fills them. Spreading into a fresh object also keeps
  // the merge per-session (never mutates the shared run-level runInstallMeta).
  if (runOauthRaw) {
    installMeta = installMeta ? { ...runOauthRaw, ...installMeta } : { ...runOauthRaw };
    // login_email is the ONE overlapping key where oauth must win over telemetry
    // (detectClaudeCodeTier also sets it from the telemetry `data.email`). The
    // fallback seat key — used when account_uuid is absent — hashes login_email,
    // so a stale/different telemetry email would split one Claude account's
    // sessions across distinct fallback seats. The authoritative
    // oauthAccount.emailAddress overrides it here. (account_uuid /
    // organization_uuid intentionally keep the telemetry value from the spread
    // above — those are the IDs the tier was inferred from.)
    if (runOauthRaw.login_email !== undefined) {
      installMeta.login_email = runOauthRaw.login_email;
    }
  }

  const installMetaJson = installMeta ? JSON.stringify(installMeta) : undefined;

  const statsCacheJson = runStatsCache ? JSON.stringify(runStatsCache) : undefined;

  db.upsert({
    ideType: "claude-code",
    sessionId,
    conversation: redactedPrompts,
    projectPath: redactedProjectPath,
    repoName,
    lastMtimeMs: fileStat.mtimeMs,
    lastSize: fileStat.size,
    lastOffset: newOffset,
    sessionMeta: sessionMetaJson,
    sessionFacets: sessionFacetsJson,
    installationMetadata: installMetaJson,
    statsCache: statsCacheJson,
    // The timeline is derived from the same lines the prompts came from, so it is
    // always in step with them. Coverage is the builder's own honest rating.
    sessionEvents: eventBuilder.build().length > 0 ? JSON.stringify(eventBuilder.build()) : undefined,
    eventCoverage: eventBuilder.coverage(),
  });

  return true;
}

function extractContent(
  content: unknown,
  role: "user" | "assistant"
): { text: string; hasImage: boolean; relevantFiles: string[] } {
  if (typeof content === "string") return { text: content, hasImage: false, relevantFiles: [] };
  if (!Array.isArray(content)) return { text: "", hasImage: false, relevantFiles: [] };

  const parts: string[] = [];
  let hasImage = false;
  const relevantFiles: string[] = [];

  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as ContentBlock;

    switch (b.type) {
      case "text":
        if (typeof b.text === "string" && b.text.length > 0) {
          parts.push(b.text);
        }
        break;
      case "image":
        hasImage = true;
        break;
      case "tool_use":
        if (role === "assistant") {
          const toolName = typeof b.name === "string" ? b.name : "unknown";
          parts.push(`[Tool: ${toolName}]`);
          // Only pull file paths from write-class tools. Read/Grep/Glob/LS/Bash
          // also carry file_path / path inputs, but those are browse references —
          // including them inflates filesEdited with non-edit noise that depresses
          // file-overlap scores against PRs.
          if (WRITE_TOOL_NAMES.has(toolName) && typeof b.input === "object" && b.input !== null) {
            const input = b.input as Record<string, unknown>;
            for (const key of ["file_path", "path", "filePath", "notebook_path"]) {
              const val = input[key];
              if (typeof val === "string" && val.length > 0) {
                relevantFiles.push(val);
              }
            }
            // MultiEdit carries edits[] with per-edit file_path.
            const edits = input["edits"];
            if (Array.isArray(edits)) {
              for (const e of edits) {
                if (typeof e === "object" && e !== null) {
                  for (const key of ["file_path", "filePath", "path"]) {
                    const val = (e as Record<string, unknown>)[key];
                    if (typeof val === "string" && val.length > 0) {
                      relevantFiles.push(val);
                    }
                  }
                }
              }
            }
          }
        }
        break;
      // Skip tool_result, thinking
    }
  }

  return { text: parts.join("\n"), hasImage, relevantFiles };
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return value;
}

function applyUsage(metadata: PromptMetadata, usage: MessageUsage | undefined): void {
  if (!usage || typeof usage !== "object") return;

  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const cacheCreation =
    typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0;
  const cacheRead =
    typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0;
  // Preserve presence: a split Anthropic reports as 0 is a measured zero, distinct
  // from an absent split (field left unset). Emit whenever it was reported.
  const cacheCreation5m = usage.cache_creation?.ephemeral_5m_input_tokens;
  const cacheCreation1h = usage.cache_creation?.ephemeral_1h_input_tokens;

  if (input > 0) metadata.inputTokens = input;
  if (output > 0) metadata.outputTokens = output;
  if (cacheCreation > 0) metadata.cacheCreationInputTokens = cacheCreation;
  if (cacheRead > 0) metadata.cacheReadInputTokens = cacheRead;
  if (typeof cacheCreation5m === "number") metadata.cacheCreation5mInputTokens = cacheCreation5m;
  if (typeof cacheCreation1h === "number") metadata.cacheCreation1hInputTokens = cacheCreation1h;

  // Claude reports exact per-message usage, so a token-bearing message is MEASURED.
  // (Claude Code context-percent is deferred: it needs an accurate model→window
  // map the transcript does not carry, and the window is genuinely model-specific
  // — a real opus-4-8 message reads 988K cached tokens, so its window is ~1M, not
  // the 200K a naive map would assume, which would report a >100% occupancy.)
  if (input > 0 || output > 0) metadata.tokenFidelity = "TOKEN_FIDELITY_MEASURED";
}

function buildMetadata(line: JsonlLine): PromptMetadata {
  const metadata: PromptMetadata = {};
  const model = line.message?.model;
  if (typeof model === "string" && model.length > 0) {
    metadata.model = model;
  }
  // Capture message.id faithfully — one prompt per line, no dedup here; a
  // consumer that sums tokens dedups by message id.
  const messageId = line.message?.id;
  if (typeof messageId === "string" && messageId.length > 0) {
    metadata.messageId = messageId;
  }
  return metadata;
}

/**
 * Fills missing model on prompts by looking at the next assistant message's model.
 * User messages don't carry model in the JSONL — inherit from the assistant that responds.
 */
function fillMissingModels(prompts: ConversationPrompt[]): void {
  // Forward pass: carry model from previous prompt
  let lastModel: string | undefined;
  for (const p of prompts) {
    if (p.metadata?.model) {
      lastModel = p.metadata.model;
    } else if (lastModel) {
      p.metadata = { ...p.metadata, model: lastModel };
    }
  }

  // Backward pass: fill any remaining gaps at the start (before first assistant)
  lastModel = undefined;
  for (let i = prompts.length - 1; i >= 0; i--) {
    const p = prompts[i]!;
    if (p.metadata?.model) {
      lastModel = p.metadata.model;
    } else if (lastModel) {
      p.metadata = { ...p.metadata, model: lastModel };
    }
  }
}

/**
 * Scans content blocks for tool_use inputs that contain file paths.
 * Used to infer the git repo when cwd is a parent directory (e.g., ~/src/).
 */
function collectToolFilePaths(content: unknown, paths: Set<string>): void {
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as ContentBlock;
    if (b.type !== "tool_use" || typeof b.input !== "object" || b.input === null) continue;

    const input = b.input as Record<string, unknown>;
    for (const key of ["file_path", "path"]) {
      const val = input[key];
      if (typeof val === "string" && val.startsWith("/")) {
        paths.add(val);
      }
    }
  }
}

/**
 * Patches project_path and repo_name on an unchanged conversation.
 * Runs the same resolution logic (findGitRoot + file path inference) so that a
 * conversation stored without a resolved repo gets one once it resolves
 * (e.g., "example-org" → "example-org/example-repo").
 */
// A row still missing repo_name+project_path re-reads its UNCHANGED transcript
// every cycle otherwise. Remember the (mtime,size) we last attempted a patch at
// — plus the resolution inputs that attempt derived (cwd and a capped sample of
// tool-touched paths) — and skip while the stat matches: the file changing
// takes the full re-extraction path and naturally retries. A new process ⇒
// one retry, fine. LRU-bounded so a large backlog can't grow it without
// limit.
const patchAttempts = new Map<string, { key: string; cwd: string | null; toolPaths: string[]; probedAtMs: number }>();

const MAX_PATCH_ATTEMPTS = 1024;
// Tool paths kept per memo entry — enough for the git-root inference to land
// on the dominant repo while bounding memo memory.
const MAX_PROBE_TOOL_PATHS = 8;
// Minimum gap between probes of one memo entry. Repo-metadata backfill is a
// soft refinement, so the trade is bounded steady-state syscalls (the probe's
// findGitRoot walks run at most once per entry per window, not per cycle)
// against backfill latency of at most this window.
const PATCH_PROBE_THROTTLE_MS = 30 * 60 * 1000;

function patchProjectMetadata(
  db: SessionSink,
  filePath: string,
  sessionId: string,
  projectDirName: string,
  tracking: Pick<ConversationRow, "project_path" | "repo_name">,
  fileStatKey: string,
): void {
  // Already resolved — nothing to patch, and nothing below re-reads the transcript.
  if (tracking.repo_name && tracking.project_path) {
    return;
  }

  const prior = patchAttempts.get(filePath);
  if (prior && prior.key === fileStatKey) {
    // Unchanged transcript ⇒ a re-parse reaches the same inputs — but
    // resolution also depends on external git state (checkout restored, git
    // init, a remote added later — under the cwd OR under a tool-touched
    // path). Probe with the SAME inputs the full attempt uses (cwd-or-decoded
    // dir name + the memoized tool-path sample) — fs-only (findGitRoot walks +
    // a config read), no spawn, no file re-parse. Rerun the full attempt only
    // when the probe now yields a repo identity the row is missing: requiring
    // a NEW repoName — not merely a git root — keeps a remote-less repo
    // skipped instead of re-parsing every cycle.
    // No transcript-derived input (no cwd, no tool paths — incl. every
    // unreadable/fuse-tripped transcript) ⇒ nothing external can change the
    // outcome; skip outright rather than re-probing a static decoded path.
    if (prior.cwd === null && prior.toolPaths.length === 0) {
      return;
    }
    // Throttled: the probe walks up to MAX_PROBE_TOOL_PATHS+1 paths, and a
    // large dormant backlog would otherwise pay that every cycle.
    const now = Date.now();
    if (now - prior.probedAtMs < PATCH_PROBE_THROTTLE_MS) {
      return;
    }
    prior.probedAtMs = now;
    const probe = resolveProjectAndRepo(prior.cwd ?? decodeProjectDirName(projectDirName), prior.toolPaths);
    // The probe is fs-only (findGitRoot + a config read).
    if (!probe?.repoName || probe.repoName === tracking.repo_name) {
      return;
    }
    patchAttempts.delete(filePath);
  }

  // Read the JSONL to get cwd (most reliable) and tool_use file paths (fallback).
  // decodeProjectDirName is lossy (github.com → github/com, tender-tesla → tender/tesla),
  // so cwd from the JSONL is always preferred. Parsed through the shared
  // transcript cache (same tolerance, same size fuse). null ⇒ unreadable or
  // pathological — record the attempt (cwd-less, so no probe can revive it)
  // before skipping, else an oversize file re-trips the fuse every cycle.
  const parsedTranscript = getParsedTranscript(filePath);
  if (parsedTranscript === null) {
    lruSet(patchAttempts, filePath, { key: fileStatKey, cwd: null, toolPaths: [], probedAtMs: Date.now() }, MAX_PATCH_ATTEMPTS);
    return;
  }

  let cwd: string | undefined;
  const toolFilePaths = new Set<string>();

  for (const parsedLine of parsedTranscript.lines) {
    const line = parsedLine as JsonlLine;
    if (!cwd && typeof line.cwd === "string" && line.cwd.length > 0) {
      cwd = line.cwd;
    }
    if (line.type === "assistant") {
      collectToolFilePaths(line.message?.content, toolFilePaths);
    }
  }

  // Record the attempt (with the resolution inputs it derived) so the next
  // cycle can skip the re-parse and just probe those inputs for
  // newly-materialized git state.
  lruSet(
    patchAttempts,
    filePath,
    {
      key: fileStatKey,
      cwd: cwd ?? null,
      toolPaths: [...toolFilePaths].slice(0, MAX_PROBE_TOOL_PATHS),
      probedAtMs: Date.now(),
    },
    MAX_PATCH_ATTEMPTS,
  );

  const rawPath = cwd ?? decodeProjectDirName(projectDirName);
  const resolved = resolveProjectAndRepo(rawPath, Array.from(toolFilePaths));
  if (!resolved) return;

  const redactedPath = redactPath(resolved.projectPath);
  if (redactedPath !== tracking.project_path) {
    db.updateProjectPath("claude-code", sessionId, redactedPath);
  }
  if (resolved.repoName && resolved.repoName !== tracking.repo_name) {
    db.updateRepoName("claude-code", sessionId, resolved.repoName);
  }
}

/**
 * Reads MCP server names from Claude Code's settings.json.
 * Returns only the server name keys — never command args or env variables (which may contain secrets).
 */
function readMcpServerNames(claudeDir: string): string[] {
  try {
    const settingsPath = join(claudeDir, "settings.json");
    if (!existsSync(settingsPath)) return [];
    const content = readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(content) as Record<string, unknown>;
    const servers = settings.mcpServers;
    if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
      return Object.keys(servers as Record<string, unknown>);
    }
  } catch {
    // settings file absent or malformed.
  }
  return [];
}

/**
 * Decodes a Claude Code project directory name back to a filesystem path.
 * Claude Code encodes paths by replacing "/" with "-", e.g.:
 *   /Users/dev/projects/repo → -Users-dev-projects-repo
 *
 * This encoding is lossy — dots in path segments become ambiguous:
 *   /Users/dev/github.com/org/repo → -Users-dev-github-com-org-repo
 * which decodes to /Users/dev/github/com/org/repo (wrong).
 *
 * To handle this, we validate the decoded path exists on disk. If not,
 * we return it as-is (the caller's findGitRoot will handle resolution).
 */
function decodeProjectDirName(dirName: string): string {
  if (!dirName.startsWith("-")) return dirName;
  const decoded = dirName.replace(/-/g, "/");

  // Fast path: decoded path exists → no ambiguity
  if (existsSync(decoded)) return decoded;

  // Try restoring common dotted segments (github.com, gitlab.com, bitbucket.org)
  const dotFixPatterns = [
    ["/github/com/", "/github.com/"],
    ["/gitlab/com/", "/gitlab.com/"],
    ["/bitbucket/org/", "/bitbucket.org/"],
  ] as const;

  for (const [from, to] of dotFixPatterns) {
    if (decoded.includes(from)) {
      const fixed = decoded.replace(from, to);
      if (existsSync(fixed)) return fixed;
    }
  }

  return decoded;
}


// ── Cowork (Claude desktop agent-mode) ───────────────────────────────────────
//
// Cowork is Claude Code's desktop agent-mode surface. Each run appends an
// `audit.jsonl` — the SAME message shape as a ~/.claude/projects transcript, but
// with snake_case envelope fields (`session_id`, `_audit_timestamp`) and `cwd`
// present only on the `system/init` line. We normalize each line back to the
// Claude Code shape and feed it through the exact same `processJsonlFile` parse
// (ideType "claude-code"), tagging every conversation `session_meta.source =
// "cowork"`, which names the surface. The vendor is mid-rename,
// so both base dir names are globbed.

const COWORK_SOURCE = "cowork";
const COWORK_AUDIT_FILENAME = "audit.jsonl";

interface CoworkRunMeta {
  runInstallMeta: InstallationMetadata | null;
  runOauthRaw: InstallationMetadata | null;
  runMcpNames: string[];
  runStatsCache: ReturnType<typeof readStatsCache>;
  runSessionKinds: Map<string, string>;
}

/**
 * Enumerates audit.jsonl across both Cowork base dirs (deep glob) and runs each
 * through the shared Claude Code parse, tagged session_meta.source="cowork".
 * Returns the count of new/changed conversations. Called from extractClaudeCode
 * with the run-level install metadata it already computed. A missing base dir
 * (Cowork not installed) is normal — it contributes zero, never an error.
 */
function extractCoworkAudits(
  db: SessionSink,
  runMeta: CoworkRunMeta,
  captureLineage: boolean,
): number {
  // `local-agent-mode-sessions` is the vendor's OLDER store name and
  // `claude-code-sessions` the newer one; the rename is mid-flight so both are live.
  // A migration can leave the same `local_<uuid>` session under BOTH roots. Both map
  // to one `COWORK_SOURCE::<sessionDir>` conversation key backed by one tracking row,
  // so processing both copies flaps that row every poll (each poll reprocesses the
  // copy the previous poll's stat didn't match) and can overwrite the current
  // conversation with a stale copy. Deduplicate by session dir before processing,
  // newer store winning — it is the migration target and the canonical location.
  const stores = [
    { baseDir: getCoworkAgentModeSessionsPath(), newer: false },
    { baseDir: getCoworkClaudeCodeSessionsPath(), newer: true },
  ];
  // sessionDir (the innermost dir that names the conversation) -> chosen file.
  const chosenBySession = new Map<string, string>();
  let duplicateSessions = 0;
  for (const { baseDir, newer } of stores) {
    for (const filePath of findCoworkAuditFiles(baseDir)) {
      const sessionDir = basename(dirname(filePath));
      if (chosenBySession.has(sessionDir)) {
        duplicateSessions++;
        // Older store is visited first, so only the newer store overrides a prior pick.
        if (newer) chosenBySession.set(sessionDir, filePath);
      } else {
        chosenBySession.set(sessionDir, filePath);
      }
    }
  }

  let extracted = 0;
  for (const filePath of chosenBySession.values()) {
    try {
      if (processCoworkAuditFile(db, filePath, runMeta, captureLineage)) {
        extracted++;
      }
    } catch (err) {
      logger.error("extraction.claude_code", "cowork_file_processing_error", {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      reportRecordError(null, filePath, err);
    }
  }
  logger.info("extraction.claude_code", "cowork_extraction_complete", {
    baseDirs: stores.length,
    totalFiles: chosenBySession.size,
    duplicateSessions,
    newOrChangedConversations: extracted,
  });
  return extracted;
}

/**
 * Deep-globs every `audit.jsonl` under a Cowork base dir. Walks manually (not
 * readdirSync{recursive}) so a single unreadable SUBDIR (EACCES, a race) is logged
 * and skipped rather than zeroing the whole store, and so an absent BASE dir (Cowork
 * not installed) stays distinct from that partial failure. Builds each path from the
 * walk dir, so it does not rely on Dirent.parentPath (Node >=20.12 only).
 */
function findCoworkAuditFiles(baseDir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [baseDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (dir === baseDir) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          // Absent base dir — Cowork not installed / never used. Normal; contribute nothing.
          return out;
        }
        // The base dir EXISTS but is unreadable (EACCES, an I/O error): that silently
        // drops the whole store, which is a real failure — not an uninstalled store.
        // Log it distinctly so a permission/IO fault is diagnosable, then contribute nothing.
        logger.warn("extraction.claude_code", "cowork_base_dir_unreadable", {
          dir,
          error: err instanceof Error ? err.message : String(err),
        });
        return out;
      }
      // A single unreadable subdir must not zero the whole store — log distinctly, continue.
      logger.warn("extraction.claude_code", "cowork_subdir_unreadable", {
        dir,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name === COWORK_AUDIT_FILENAME) {
        out.push(full);
      }
    }
  }
  return out;
}

/** Parses one Cowork audit.jsonl through the shared Claude Code parse. */
function processCoworkAuditFile(
  db: SessionSink,
  filePath: string,
  runMeta: CoworkRunMeta,
  captureLineage: boolean,
): boolean {
  // Stable per-audit-file id: the innermost session directory (e.g.
  // `local_<uuid>`), namespaced so it can never collide with a ~/.claude/projects
  // Claude Code session. The audit lines' own `session_id` is NOT usable — a user
  // turn and the agent turns it drives carry different session_ids in one file.
  const sessionDir = basename(dirname(filePath));
  const compositeId = `${COWORK_SOURCE}::${sessionDir}`;
  // coworkMode makes processJsonlFile normalize each line and resolve the session
  // cwd from the parsed transcript itself — after its stat/dedup skip + size fuse.
  return processJsonlFile(
    db,
    filePath,
    compositeId,
    sessionDir,
    runMeta.runInstallMeta,
    runMeta.runOauthRaw,
    runMeta.runMcpNames,
    runMeta.runStatsCache,
    runMeta.runSessionKinds,
    undefined, // lineage — Cowork has no subagent-file lineage
    captureLineage,
    undefined, // hookChildToParent — not applicable
    true, // coworkMode
    COWORK_SOURCE,
  );
}

/**
 * Builds the per-line normalizer for a Cowork audit transcript, resolving the
 * session `cwd` from the first cwd-bearing (system/init) line of the already-parsed
 * transcript — `cwd` lives ONLY on that line, so it is injected onto the
 * user/assistant lines the parse reads project_path from.
 */
function buildCoworkLineNormalizer(lines: unknown[]): (raw: unknown) => unknown {
  let cwd: string | undefined;
  for (const raw of lines) {
    if (raw !== null && typeof raw === "object") {
      const c = (raw as Record<string, unknown>).cwd;
      if (typeof c === "string" && c.length > 0) {
        cwd = c;
        break;
      }
    }
  }
  return (raw: unknown): unknown => normalizeCoworkLine(raw, cwd);
}

/**
 * Maps one raw Cowork audit line to the Claude Code line shape the parse reads:
 * `_audit_timestamp` -> `timestamp`, and injects the session `cwd` (resolved by
 * buildCoworkLineNormalizer) so `project_path` resolves from the user/assistant
 * lines. Leaves the `message` object untouched — it is already Claude Code-shaped
 * (role/content/model/usage/id).
 *
 * Cowork has NO injected-turn concept: audit user lines never carry `isMeta`
 * (verified across real data), and their content is CC-shaped (string / text /
 * image / tool_result blocks). So the shared parser skips machine `tool_result`
 * turns exactly as it does for Claude Code, and the user prompts that survive are
 * the genuine human turns — no isMeta mapping is needed or correct here.
 */
function normalizeCoworkLine(raw: unknown, cwd: string | undefined): unknown {
  if (raw === null || typeof raw !== "object") return raw;
  const o = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...o };
  if (out["timestamp"] === undefined && typeof o["_audit_timestamp"] === "string") {
    out["timestamp"] = o["_audit_timestamp"];
  }
  if (out["cwd"] === undefined && cwd !== undefined) {
    out["cwd"] = cwd;
  }
  return out;
}
