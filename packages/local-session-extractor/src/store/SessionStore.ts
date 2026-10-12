// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The package's session store: the `conversations` and `meta` tables in a
 * plain SQLite file the package owns, opened through the built-in
 * binding and marked as the package's by its `application_id`. Every open sets
 * a five-second busy timeout; a writable open also sets WAL and normal
 * synchronous mode, and migrations run inside `BEGIN IMMEDIATE`, so two
 * processes opening one file serialise instead of interleaving DDL.
 */
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IDE_TYPES } from "../types/session";
import type { ConversationPrompt, ConversationRow, IdeType, SessionLineagePayload, SessionMetaPayload } from "../types/session";
import type { SessionSink, SessionSummary, SessionSummaryFilter, TranscriptMessage, UpsertParams } from "../types/store";
import { sanitizeSessionMeta } from "../redaction";
import { SIGNAL_SOURCE, outranksSource, type SignalSource } from "../extractors/signalSource";
import { logger } from "../seams/logger";
import { conversationId, sumPromptTokens } from "./ids";
import { MIGRATIONS } from "./migrations";

/** The default store location when a caller names none. */
export function defaultStorePath(): string {
  return join(homedir(), ".local-session-extractor", "sessions.db");
}

/**
 * The `PRAGMA application_id` of every store the package creates ("SRDR"). An
 * existing non-empty file without it is not opened, so a path that names
 * another program's SQLite file is never migrated or cleared.
 */
export const STORE_APPLICATION_ID = 0x53524452;

/**
 * Raised when a store file cannot be used: it is not a local-session-extractor store,
 * its schema is newer than this package and lacks a column the package reads,
 * or, when opened with `mustExist`, it is missing, empty or older than the package.
 */
export class StoreOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreOpenError";
  }
}

/** How many rows `listConversations` returns when the caller names no limit. */
export const LIST_DEFAULT_LIMIT = 500;

/** How long an open waits on another process's lock. */
const BUSY_TIMEOUT_MS = 5000;
const SQLITE_BUSY = 5;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

/**
 * The columns the package reads and writes. A store whose schema is newer than
 * the package opens as long as every one of these exists.
 */
const REQUIRED_CONVERSATION_COLUMNS = [
  "id", "ide_type", "session_id", "relation_type", "conversation", "session_meta", "session_facets",
  "installation_metadata", "stats_cache", "ai_attribution", "session_events", "event_coverage",
  "last_mtime_ms", "last_size", "last_offset", "conversation_source_created_at_ms", "content_hash",
  "last_reextract_at", "tokens_observed", "project_path", "repo_name", "extractor_version",
  "sync_status", "synced_at", "created_at", "updated_at", "last_message_ms",
] as const;

type SqlValue = string | number | bigint | null | Uint8Array;

interface Statement {
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
  run(...params: SqlValue[]): { changes: number };
}

/** The built-in connection, returning ordinary row objects. */
class Connection {
  readonly handle: DatabaseSync;
  constructor(handle: DatabaseSync) {
    this.handle = handle;
  }

  prepare(sql: string): Statement {
    const stmt = this.handle.prepare(sql);
    return {
      get: (...params) => {
        const row = stmt.get(...params);
        return row === undefined ? undefined : { ...row };
      },
      all: (...params) => stmt.all(...params).map((row) => ({ ...row })),
      run: (...params) => {
        const result = stmt.run(...params);
        return { changes: Number(result.changes) };
      },
    };
  }

  exec(sql: string): void {
    this.handle.exec(sql);
  }
}

export interface OpenStoreOptions {
  /**
   * The file must already be a store at the package's schema or newer: nothing
   * is created, migrated or switched to WAL, and a missing, empty or older store
   * throws {@link StoreOpenError}. For a caller that only reads or clears rows.
   */
  mustExist?: boolean;
}

/**
 * Opens (creating if absent) the store at `path`, or at the default location.
 * A directory it creates is made at mode 0700 and a file it creates at mode
 * 0600 before the first write; SQLite gives the `-wal` and `-shm` files the
 * database file's mode. An existing directory, such as a host's own data
 * directory, keeps the mode its owner gave it. A zero-byte file is initialised
 * as a new store; any other file must carry {@link STORE_APPLICATION_ID}, which
 * is checked before anything is written to it.
 */
/**
 * Creates a missing store file at 0600, so it is never readable by others, and
 * returns whether this call created it. Another process can create the file between
 * the check and the open: that is no error, the call returns false, and the header
 * probe that follows decides whether the file is opened. `exists` is a test seam for
 * that window.
 */
export function createStoreFile(path: string, exists: (p: string) => boolean = existsSync): boolean {
  if (exists(path)) return false;
  try {
    closeSync(openSync(path, "wx", 0o600));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return false;
  }
}

/** Test seams for a store open: the existence check before the create, and a hook run just before SQLite opens the file. */
interface StoreOpenSeams {
  exists?: (p: string) => boolean;
  beforeOpen?: (p: string) => void;
}

let storeOpenSeams: StoreOpenSeams = {};

/** Replaces the store-open seams; `null` restores the defaults. */
export function setStoreOpenSeamsForTests(seams: StoreOpenSeams | null): void {
  storeOpenSeams = seams ?? {};
}

export function openStore(path: string = defaultStorePath(), opts: OpenStoreOptions = {}): SessionStore {
  return new SessionStore(path, opts);
}

// session_meta fields derived from workspace-GLOBAL Cursor state (~/.cursor mcp.json +
// projectSignals), computed once per extraction cycle and identical for every composer in
// that cycle. They drift between cycles independently of any one session, so they are
// stripped before hashing (see contentHashFor) — otherwise an unchanged session would hash
// differently across cycles and re-sync spuriously. Same reasoning that excludes
// ai_attribution / installation_metadata (which are not part of the hashed payload at all).
// NOTE: sub_agent_count is deliberately NOT here — the Cursor extractor sets it per-session
// from the composer's own subagentComposerIds, so it is real session content that must hash.
const CURSOR_GLOBAL_META_KEYS = [
  "mcp_server_names",
  "project_mcp_server_names",
  "agent_transcript_count",
  "tool_output_count",
  "terminal_session_count",
] as const;

// Content hash over the session-specific payload: the conversation, session_meta with
// the workspace-global fields removed, the project path, the repo name, the event
// timeline, the event coverage, the facets and the stats cache. Gates the
// sync_status→pending flip on Cursor re-extraction,
// so an identical re-read never re-queues a redundant sync and any change to a stored
// field does. Falls back to the raw session_meta string if it does not parse as an object.
interface HashedFields {
  projectPath?: string | null;
  repoName?: string | null;
  sessionEvents?: string | null;
  eventCoverage?: string | null;
  sessionFacets?: string | null;
  statsCache?: string | null;
}

function contentHashFor(conversationJson: string, sessionMeta: string | undefined, fields: HashedFields): string {
  let hashableMeta = "";
  if (sessionMeta) {
    try {
      const parsed = JSON.parse(sessionMeta) as Record<string, unknown>;
      for (const key of CURSOR_GLOBAL_META_KEYS) delete parsed[key];
      hashableMeta = JSON.stringify(parsed);
    } catch {
      hashableMeta = sessionMeta;
    }
  }
  return createHash("sha256")
    .update(conversationJson)
    .update(" ")
    .update(hashableMeta)
    .update(" ")
    .update(
      JSON.stringify([
        fields.projectPath ?? null,
        fields.repoName ?? null,
        fields.sessionEvents ?? null,
        fields.eventCoverage ?? null,
        fields.sessionFacets ?? null,
        fields.statsCache ?? null,
      ]),
    )
    .digest("hex");
}

function sumStoredPromptTokens(conversationJson: string, ideType: IdeType, sessionId: string): number {
  try {
    const prompts = JSON.parse(conversationJson) as ConversationPrompt[];
    if (!Array.isArray(prompts)) return 0;
    return sumPromptTokens(prompts);
  } catch (err) {
    // A folded child with an unparseable stored blob would silently fold with
    // zero weight; surface it so a systematic zero-weight fold is observable.
    logger.warn("db", "sum_stored_prompt_tokens_parse_failed", {
      ideType,
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Refuses a file that is not a local-session-extractor store by reading its 100-byte
 * SQLite header, before SQLite opens it: opening a WAL-mode database read-write
 * replays its log and checkpoints it on close, which would change a file this
 * package does not own. A missing or zero-byte file, or a blank database (no
 * schema, user_version 0), may become a new store.
 */
function probeStoreFile(path: string): void {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  if (size === 0) return;
  const header = Buffer.alloc(100);
  const fd = openSync(path, "r");
  let read: number;
  try {
    read = readSync(fd, header, 0, 100, 0);
  } finally {
    closeSync(fd);
  }
  if (read < 100 || header.toString("latin1", 0, 16) !== "SQLite format 3\u0000") {
    throw new StoreOpenError(`${path} is not a local-session-extractor store: not a SQLite database`);
  }
  const applicationId = header.readUInt32BE(68);
  if (applicationId === STORE_APPLICATION_ID) return;
  const schemaCookie = header.readUInt32BE(40);
  const userVersion = header.readUInt32BE(60);
  // A blank header with a live write-ahead log may hold schema the header does not show yet.
  const wal = `${path}-wal`;
  const walHasFrames = existsSync(wal) && statSync(wal).size > 0;
  if (applicationId === 0 && schemaCookie === 0 && userVersion === 0 && !walHasFrames) return;
  throw new StoreOpenError(
    `${path} is not a local-session-extractor store (application_id ${applicationId}); ` +
      "a store from an earlier build can be deleted and rebuilt with a scan",
  );
}

/** The newest message timestamp in Unix ms, else `fallback`: the session's last activity. */
export function lastMessageMs(conversation: readonly ConversationPrompt[], fallback: number): number {
  let newest = Number.NEGATIVE_INFINITY;
  for (const prompt of conversation) {
    const at = typeof prompt?.timestamp === "string" ? Date.parse(prompt.timestamp) : Number.NaN;
    if (at > newest) newest = at;
  }
  return Number.isFinite(newest) ? newest : fallback;
}

/** SQL for the text at `path` in a JSON column, or NULL when the column does not parse or holds no text there. */
function textAt(column: string, path: string): string {
  return `CASE WHEN json_valid(${column}) THEN CASE json_type(${column}, '${path}') WHEN 'text' THEN json_extract(${column}, '${path}') END END`;
}

export class SessionStore implements SessionSink {
  private readonly db: Connection;

  readonly path: string;

  constructor(path: string, opts: OpenStoreOptions = {}) {
    this.path = path;
    if (opts.mustExist === true) {
      if (!existsSync(path) || statSync(path).size === 0) throw new StoreOpenError(`no local-session-extractor store at ${path}`);
    } else {
      const dir = dirname(path);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    // The file is created first and probed last, right before SQLite opens it, so a
    // file another process put there in between is probed rather than opened.
    const created = opts.mustExist !== true && createStoreFile(path, storeOpenSeams.exists);
    if (!existsSync(path)) {
      const link = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true;
      throw new StoreOpenError(link ? `${path} is a symlink to a missing file; point it at an existing store or remove it` : `no store file at ${path}`);
    }
    probeStoreFile(path);
    // A file this call created, or a zero-byte one it initialises, gets the store's mode
    // once it is known to be ours; any other file keeps the mode its owner gave it.
    const initialising = opts.mustExist !== true && (created || statSync(path).size === 0);
    storeOpenSeams.beforeOpen?.(path);
    const handle = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
    this.db = new Connection(handle);
    try {
      // Read-only probe first: nothing is written to a file that is not ours.
      this.assertOwnStore();
      if (initialising) chmodSync(path, 0o600);
      if (opts.mustExist === true) {
        if (this.userVersion() < MIGRATIONS.length) {
          throw new StoreOpenError(`store schema v${this.userVersion()} at ${path} is older than this package (v${MIGRATIONS.length}); a scan migrates it`);
        }
        this.assertReadableSchema();
      } else {
        this.migrate();
        this.switchToWal();
        this.db.exec("PRAGMA synchronous = NORMAL");
      }
    } catch (err) {
      handle.close();
      throw err;
    }
  }

  /**
   * Get tracking info for a conversation (for dedup checks).
   * Returns null if the conversation hasn't been extracted yet.
   */
  getTracking(
    ideType: IdeType,
    sessionId: string
  ): Pick<
    ConversationRow,
    | "last_mtime_ms"
    | "last_size"
    | "last_offset"
    | "project_path"
    | "repo_name"
    | "last_reextract_at"
    | "tokens_observed"
  > | null {
    const row = this.db
      .prepare(
        `SELECT last_mtime_ms, last_size, last_offset, project_path, repo_name,
                last_reextract_at, tokens_observed
         FROM conversations WHERE ide_type = ? AND session_id = ?`
      )
      .get(ideType, sessionId) as
      | Pick<
          ConversationRow,
          | "last_mtime_ms"
          | "last_size"
          | "last_offset"
          | "project_path"
          | "repo_name"
          | "last_reextract_at"
          | "tokens_observed"
        >
      | undefined;
    return row ?? null;
  }

  /**
   * Update the project_path for an existing conversation without re-extracting content.
   * Used when the extracted path improves (null → git root, or subdirectory → git root).
   */
  /** Returns the stored session_meta JSON string for a conversation, or null. */
  getSessionMeta(ideType: IdeType, sessionId: string): string | null {
    const row = this.db
      .prepare(`SELECT session_meta FROM conversations WHERE ide_type = ? AND session_id = ?`)
      .get(ideType, sessionId) as { session_meta: string | null } | undefined;
    return row?.session_meta ?? null;
  }

  updateProjectPath(ideType: IdeType, sessionId: string, projectPath: string): void {
    this.db
      .prepare(
        // Preserve an out-of-scope park: never resurrect a skipped_out_of_scope
        // row to pending here — applyScope re-queues it once it is back in scope.
        `UPDATE conversations
         SET project_path = ?, updated_at = datetime('now'),
             sync_status = CASE WHEN sync_status = 'skipped_out_of_scope'
                                THEN 'skipped_out_of_scope' ELSE 'pending' END
         WHERE ide_type = ? AND session_id = ?`
      )
      .run(projectPath, ideType, sessionId);
  }

  /**
   * Update the repo_name for an existing conversation without re-extracting content.
   * Used when the repo name becomes available or improves.
   */
  updateRepoName(ideType: IdeType, sessionId: string, repoName: string): void {
    this.db
      .prepare(
        // Preserve an out-of-scope park (see updateProjectPath).
        `UPDATE conversations
         SET repo_name = ?, updated_at = datetime('now'),
             sync_status = CASE WHEN sync_status = 'skipped_out_of_scope'
                                THEN 'skipped_out_of_scope' ELSE 'pending' END
         WHERE ide_type = ? AND session_id = ?`
      )
      .run(repoName, ideType, sessionId);
  }

  /**
   * Patch SUBAGENT lineage onto a conversation that has never been ingested
   * (synced_at IS NULL), without rewriting conversation JSON. Match is on
   * parent_record_key, not only relation_type. A row that has ever synced
   * stays PRIMARY even if a later path/repo patch flipped it back to pending.
   */
  stampPendingSubagentLineage(
    ideType: IdeType,
    sessionId: string,
    parentRecordKey: string,
    extras?: Pick<SessionLineagePayload, "origin_agent_type" | "tool_use_id">,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT session_meta, sync_status, relation_type, synced_at
         FROM conversations WHERE ide_type = ? AND session_id = ?`
      )
      .get(ideType, sessionId) as
      | {
          session_meta: string | null;
          sync_status: string;
          relation_type: string;
          synced_at: string | null;
        }
      | undefined;
    if (!row) return false;
    if (row.synced_at != null) return false;
    if (
      row.sync_status !== "pending" &&
      row.sync_status !== "failed" &&
      row.sync_status !== "syncing" &&
      row.sync_status !== "skipped_out_of_scope"
    ) {
      return false;
    }

    let meta: Record<string, unknown> = {};
    if (row.session_meta) {
      try {
        meta = JSON.parse(row.session_meta) as Record<string, unknown>;
      } catch {
        return false;
      }
    }
    const existing = meta["lineage"] as SessionLineagePayload | undefined;
    const existingRel = existing?.relation_type ?? row.relation_type;
    if (existingRel === "PLUGIN" || existingRel === "HOOK") return false;
    if (existingRel === "SUBAGENT" && existing?.parent_record_key === parentRecordKey) {
      return false;
    }

    const conversation = this.db
      .prepare(
        `SELECT conversation, project_path, repo_name, session_events, event_coverage, session_facets, stats_cache
         FROM conversations WHERE ide_type = ? AND session_id = ?`,
      )
      .get(ideType, sessionId) as
      | {
          conversation: string;
          project_path: string | null;
          repo_name: string | null;
          session_events: string | null;
          event_coverage: string | null;
          session_facets: string | null;
          stats_cache: string | null;
        }
      | undefined;
    if (!conversation) return false;

    // Merge onto any existing lineage so a re-stamp/parent-correction keeps
    // sub-fields the tag itself does not set (origin_agent_type, plugin_name, …).
    const lineage: SessionLineagePayload = {
      ...(existing ?? {}),
      relation_type: "SUBAGENT",
      parent_record_key: parentRecordKey,
      linkage_confidence: "STRONG",
    };
    const tokens = sumStoredPromptTokens(conversation.conversation, ideType, sessionId);
    if (tokens > 0) lineage.tokens = tokens;
    if (extras?.origin_agent_type) lineage.origin_agent_type = extras.origin_agent_type;
    if (extras?.tool_use_id) lineage.tool_use_id = extras.tool_use_id;
    meta["lineage"] = lineage;

    const sessionMeta = JSON.stringify(sanitizeSessionMeta(meta as SessionMetaPayload));
    const contentHash = contentHashFor(conversation.conversation, sessionMeta, {
      projectPath: conversation.project_path,
      repoName: conversation.repo_name,
      sessionEvents: conversation.session_events,
      eventCoverage: conversation.event_coverage,
      sessionFacets: conversation.session_facets,
      statsCache: conversation.stats_cache,
    });
    const result = this.db
      .prepare(
        // Preserve an out-of-scope park (see updateProjectPath). failed/syncing →
        // pending so a never-ingested PRIMARY retries as a child; markSynced then
        // no-ops (it requires syncing) and the lineage-tagged payload is the one
        // that syncs. synced_at IS NULL is the ingest guard.
        `UPDATE conversations
         SET session_meta = ?, relation_type = 'SUBAGENT', content_hash = ?,
             updated_at = datetime('now'),
             sync_status = CASE
               WHEN sync_status = 'skipped_out_of_scope' THEN 'skipped_out_of_scope'
               WHEN sync_status IN ('failed', 'syncing') THEN 'pending'
               ELSE sync_status
             END
         WHERE ide_type = ? AND session_id = ?
           AND synced_at IS NULL
           AND sync_status IN ('pending', 'failed', 'syncing', 'skipped_out_of_scope')`
      )
      .run(sessionMeta, contentHash, ideType, sessionId);
    return result.changes > 0;
  }

  /** True once a conversation has completed at least one sync (synced_at set). */
  hasBeenIngested(ideType: IdeType, sessionId: string): boolean {
    const row = this.db
      .prepare(`SELECT synced_at FROM conversations WHERE ide_type = ? AND session_id = ?`)
      .get(ideType, sessionId) as { synced_at: string | null } | undefined;
    return row?.synced_at != null;
  }

  /**
   * Merges stored and fresh branch and PR attribution. For Cursor a stored entry
   * is never replaced, because Cursor's own record of it decays. For Kiro new
   * entries are added and a stored entry is never downgraded. Returns the
   * session_meta JSON to persist.
   */
  private preserveAttributionFields(
    ideType: IdeType,
    sessionId: string,
    newMeta: string | undefined
  ): string | undefined {
    if (newMeta == null) return newMeta;
    const mode: "freeze" | "raise" | "off" =
      ideType === "cursor" ? "freeze" : ideType === "kiro" ? "raise" : "off";
    if (mode === "off") return newMeta;
    if (mode === "raise") return this.raiseAttributionProvenance(ideType, sessionId, newMeta);
    const stored = this.db
      .prepare(`SELECT session_meta FROM conversations WHERE ide_type = ? AND session_id = ?`)
      .get(ideType, sessionId) as { session_meta: string | null } | undefined;
    if (!stored?.session_meta) return newMeta;

    const isNonEmpty = (v: unknown): boolean => Array.isArray(v) && v.length > 0;
    try {
      const prev = JSON.parse(stored.session_meta) as Record<string, unknown>;
      const next = JSON.parse(newMeta) as Record<string, unknown>;
      let changed = false;
      for (const field of ["git_branches", "pr_references"] as const) {
        if (isNonEmpty(prev[field])) {
          next[field] = prev[field];
          changed = true;
        }
      }
      // Keep the back-compat scalars consistent with a preserved pr_references —
      // derive them from the array's first ref, not from (possibly-absent) stored scalars.
      const preservedRefs = prev["pr_references"];
      if (changed && Array.isArray(preservedRefs) && preservedRefs.length > 0) {
        const first = preservedRefs[0] as Record<string, unknown>;
        next["pr_url"] = first["pr_url"];
        next["pr_number"] = first["pr_number"];
        next["pr_repository"] = first["pr_repository"];
      }
      if (changed && isNonEmpty(prev["git_branches"]) && prev["git_branch"] !== undefined) {
        next["git_branch"] = prev["git_branch"];
      }
      // Freeze a delegated child's lineage the same way branch/PR attribution is
      // frozen. A re-read does not always re-derive the SUBAGENT tag (the tag is
      // gated off re-ingest, so an already-synced child skips it), and lineage
      // is not carried by the loop above. Without this, relation_type would fall
      // back to PRIMARY on that re-read and the already-folded child would
      // re-sync as a standalone primary session. Carry the stored lineage only
      // when the fresh meta has none, so a freshly re-derived (e.g. parent-
      // corrected) lineage still wins.
      const prevLineage = prev["lineage"] as SessionLineagePayload | undefined;
      if (
        next["lineage"] == null &&
        prevLineage != null &&
        (prevLineage.relation_type === "SUBAGENT" ||
          prevLineage.relation_type === "PLUGIN" ||
          prevLineage.relation_type === "HOOK")
      ) {
        next["lineage"] = prevLineage;
        changed = true;
      }
      return changed ? JSON.stringify(next) : newMeta;
    } catch {
      // Malformed stored/new meta — fall back to the freshly-derived value.
      return newMeta;
    }
  }

  /**
   * Keeps a stored Claude Code session_kind when the fresh one is empty. Claude
   * Code deletes the file that names a session's kind when the session ends, so
   * a later read cannot see it, and a kind never reverts to unknown.
   */
  private preserveSessionKind(
    ideType: IdeType,
    sessionId: string,
    newMeta: string | undefined
  ): string | undefined {
    if (ideType !== "claude-code" || newMeta == null) return newMeta;

    let next: Record<string, unknown>;
    try {
      next = JSON.parse(newMeta) as Record<string, unknown>;
    } catch {
      return newMeta;
    }
    const hasKind = (v: unknown): v is string => typeof v === "string" && v.length > 0;
    if (hasKind(next["session_kind"])) return newMeta; // fresh value present — nothing to preserve

    const stored = this.db
      .prepare(`SELECT session_meta FROM conversations WHERE ide_type = ? AND session_id = ?`)
      .get(ideType, sessionId) as { session_meta: string | null } | undefined;
    if (!stored?.session_meta) return newMeta;

    try {
      const prev = JSON.parse(stored.session_meta) as Record<string, unknown>;
      if (hasKind(prev["session_kind"])) {
        next["session_kind"] = prev["session_kind"];
        return JSON.stringify(next);
      }
    } catch (err) {
      // Malformed stored meta abandons preservation, which can erase a captured
      // session_kind — log it (with the session id) rather than dropping silently.
      logger.warn("db", "preserve_session_kind_parse_error", {
        ideType,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return newMeta;
  }

  /**
   * The `raise` mode: union stored and fresh attribution entries, keeping the
   * stronger provenance where both name the same thing.
   *
   * Identity is what an entry POINTS AT — a branch by name, a PR by
   * (repository, number) — not its provenance, because the whole point is that one
   * thing can be recovered twice with different confidence. A stored entry is
   * therefore never dropped and never lowered; it can only be raised, or joined by
   * something new.
   */
  private raiseAttributionProvenance(
    ideType: IdeType,
    sessionId: string,
    newMeta: string
  ): string {
    const stored = this.db
      .prepare(`SELECT session_meta FROM conversations WHERE ide_type = ? AND session_id = ?`)
      .get(ideType, sessionId) as { session_meta: string | null } | undefined;
    if (!stored?.session_meta) return newMeta;

    try {
      const prev = JSON.parse(stored.session_meta) as Record<string, unknown>;
      const next = JSON.parse(newMeta) as Record<string, unknown>;

      const rows = (v: unknown): Array<Record<string, unknown>> =>
        Array.isArray(v) ? (v.filter((e) => e && typeof e === "object") as Array<Record<string, unknown>>) : [];

      // Stored order first so a merge never churns the blob, then fresh additions.
      const mergeByIdentity = (
        field: string,
        identity: (e: Record<string, unknown>) => string,
        storedOverride?: Array<Record<string, unknown>>
      ): Array<Record<string, unknown>> => {
        const out: Array<Record<string, unknown>> = [];
        const at = new Map<string, number>();
        const stored = storedOverride ?? rows(prev[field]);
        for (const e of [...stored, ...rows(next[field])]) {
          const id = identity(e);
          if (!id) continue;
          const seen = at.get(id);
          if (seen === undefined) {
            at.set(id, out.length);
            out.push({ ...e });
            continue;
          }
          const kept = out[seen]!;
          const candidate = typeof e["source"] === "string" ? (e["source"] as string) : undefined;
          if (candidate && outranksSource(candidate as SignalSource, kept["source"] as string | undefined)) {
            kept["source"] = candidate;
          }
        }
        return out;
      };

      const mergedRefs = mergeByIdentity(
        "pr_references",
        (e) => (e["pr_repository"] && e["pr_number"] ? `${String(e["pr_repository"])}#${String(e["pr_number"])}` : "")
      );
      // A row can carry git_branches and NO branch_signals (written before
      // branch_signals existed). Merging only branch_signals would let a
      // re-extraction that recovers nothing write a row with neither, silently
      // dropping the stored branches: the clobber this guard exists to prevent.
      // Such branches enter unclassified — never as a claim they were ambient.
      const legacyBranchSignals = (v: unknown): Array<Record<string, unknown>> =>
        Array.isArray(v)
          ? v
              .filter((n): n is string => typeof n === "string" && n.length > 0)
              .map((name) => ({ name, source: SIGNAL_SOURCE.UNSPECIFIED }))
          : [];
      const prevBranchSignals = rows(prev["branch_signals"]);
      const mergedBranches = mergeByIdentity(
        "branch_signals",
        (e) => (typeof e["name"] === "string" ? e["name"] : ""),
        prevBranchSignals.length > 0 ? prevBranchSignals : legacyBranchSignals(prev["git_branches"]),
      );

      if (mergedRefs.length > 0) {
        next["pr_references"] = mergedRefs;
        // The deprecated scalars are derived from the merged array rather than
        // preserved on their own: left alone they would keep naming a PR the array
        // no longer leads with, and a matcher's scalar fallback would then read a
        // different PR than the array does.
        const first = mergedRefs[0]!;
        next["pr_url"] = first["pr_url"];
        next["pr_number"] = first["pr_number"];
        next["pr_repository"] = first["pr_repository"];
      }
      if (mergedBranches.length > 0) {
        next["branch_signals"] = mergedBranches;
        // git_branches is the bare-name mirror, so it is re-derived rather than
        // merged separately — two independently-merged lists could disagree about
        // which branches the session touched.
        next["git_branches"] = mergedBranches.map((b) => b["name"]);
      }
      return JSON.stringify(next);
    } catch {
      // Malformed stored/new meta — fall back to the freshly-derived value.
      return newMeta;
    }
  }

  /**
   * Upsert a conversation — insert or update if it already exists.
   */
  upsert(params: UpsertParams): void {
    // Never clobber a populated branch/PR on re-extraction: frozen for Cursor,
    // raise-only-union for Kiro. See preserveAttributionFields.
    let sessionMeta = this.preserveAttributionFields(
      params.ideType,
      params.sessionId,
      params.sessionMeta
    );
    // Never blank a per-session session_kind captured while the session was live
    // (Claude Code prunes its sessions file on exit). See preserveSessionKind.
    sessionMeta = this.preserveSessionKind(params.ideType, params.sessionId, sessionMeta);
    const conversationJson = JSON.stringify(params.conversation);
    const contentHash = contentHashFor(conversationJson, sessionMeta, params);
    const nowMs = Date.now();
    const tokensObservedFlag = params.tokensObserved ? 1 : 0;
    // The caller's applied extractor version, frozen with the row so a later bump
    // cannot relabel data an older extractor produced; absent stamps null.
    const extractorVersion = params.extractorVersion ?? null;
    this.db
      .prepare(
        `INSERT INTO conversations
           (id, ide_type, session_id, conversation, project_path, repo_name,
            last_mtime_ms, last_size, last_offset,
            conversation_source_created_at_ms,
            session_meta, session_facets, installation_metadata,
            stats_cache, ai_attribution,
            session_events, event_coverage,
            content_hash, last_reextract_at, tokens_observed,
            extractor_version, last_message_ms,
            relation_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?,
                 COALESCE(json_extract(?, '$.lineage.relation_type'), 'PRIMARY'))
         ON CONFLICT(ide_type, session_id) DO UPDATE SET
           conversation                      = excluded.conversation,
           project_path                      = excluded.project_path,
           repo_name                         = excluded.repo_name,
           last_mtime_ms                     = excluded.last_mtime_ms,
           last_size                         = excluded.last_size,
           last_offset                       = excluded.last_offset,
           conversation_source_created_at_ms = excluded.conversation_source_created_at_ms,
           session_meta                      = excluded.session_meta,
           session_facets                    = excluded.session_facets,
           installation_metadata             = excluded.installation_metadata,
           stats_cache                       = excluded.stats_cache,
           ai_attribution                    = excluded.ai_attribution,
           session_events                    = excluded.session_events,
           event_coverage                    = excluded.event_coverage,
           content_hash                      = excluded.content_hash,
           last_reextract_at                 = excluded.last_reextract_at,
           relation_type                     = excluded.relation_type,
           -- Recorded verbatim, not stickied (see contentHashFor / shouldForceCursorReextract).
           tokens_observed                   = excluded.tokens_observed,
           extractor_version                 = excluded.extractor_version,
           last_message_ms                   = excluded.last_message_ms,
           updated_at                        = datetime('now'),
           -- bare column refs are the EXISTING row's value (not excluded.). Two guards:
           --  1. preserve an out-of-scope park instead of resurrecting it to pending;
           --  2. (Cursor only) an unchanged content_hash keeps the existing sync_status
           --     (no redundant re-sync — see contentHashFor); other IDEs always flip.
           sync_status                       = CASE
             WHEN sync_status = 'skipped_out_of_scope' THEN 'skipped_out_of_scope'
             WHEN ide_type = 'cursor' AND content_hash IS NOT NULL
                  AND content_hash = excluded.content_hash THEN sync_status
             ELSE 'pending' END`
      )
      .run(
        conversationId(params.ideType, params.sessionId),
        params.ideType,
        params.sessionId,
        conversationJson,
        params.projectPath ?? null,
        params.repoName ?? null,
        params.lastMtimeMs,
        params.lastSize,
        params.lastOffset,
        params.conversationSourceCreatedAtMs ?? null,
        sessionMeta ?? null,
        params.sessionFacets ?? null,
        params.installationMetadata ?? null,
        params.statsCache ?? null,
        params.aiAttribution ?? null,
        params.sessionEvents ?? null,
        params.eventCoverage ?? null,
        contentHash,
        nowMs,
        tokensObservedFlag,
        extractorVersion,
        lastMessageMs(params.conversation, params.lastMtimeMs),
        // relation_type is derived from the same (preserved) session_meta via
        // json_extract, matching the migration backfill exactly.
        sessionMeta ?? null
      );
  }

  /**
   * Count conversations by IDE type.
   */
  countByIde(): { claudeCode: number; cursor: number; copilot: number; antigravity: number; codex: number; kiro: number; total: number } {
    const rows = this.db
      .prepare(
        // Count primary sessions only — delegated children (subagents/plugins)
        // fold onto their parent's usage, and hooks are non-interactive
        // automation runs; neither should inflate the count shown to the user.
        `SELECT ide_type, COUNT(*) as count FROM conversations
         WHERE relation_type NOT IN ('SUBAGENT', 'PLUGIN', 'HOOK')
         GROUP BY ide_type`
      )
      .all() as Array<{ ide_type: string; count: number }>;

    let claudeCode = 0;
    let cursor = 0;
    let copilot = 0;
    let antigravity = 0;
    let codex = 0;
    let kiro = 0;
    for (const row of rows) {
      if (row.ide_type === "claude-code") claudeCode = row.count;
      if (row.ide_type === "cursor") cursor = row.count;
      if (row.ide_type === "copilot") copilot = row.count;
      if (row.ide_type === "antigravity") antigravity = row.count;
      if (row.ide_type === "codex") codex = row.count;
      if (row.ide_type === "kiro") kiro = row.count;
    }

    return { claudeCode, cursor, copilot, antigravity, codex, kiro, total: claudeCode + cursor + copilot + antigravity + codex + kiro };
  }

  /**
   * Count conversations by IDE type and project path, ordered by count desc.
   */
  countByIdeAndProject(): {
    ide_type: string;
    project_path: string | null;
    count: number;
  }[] {
    return this.db
      .prepare(
        // Primary sessions only (see countByIde) — children fold onto their
        // parent and hooks are non-interactive automation runs.
        `SELECT ide_type, project_path, COUNT(*) as count
         FROM conversations
         WHERE relation_type NOT IN ('SUBAGENT', 'PLUGIN', 'HOOK')
         GROUP BY ide_type, project_path
         ORDER BY ide_type, count DESC`
      )
      .all() as { ide_type: string; project_path: string | null; count: number }[];
  }

  /**
   * Distinct project roots the extractor has already identified — the stored
   * `project_path` set, deduped across IDEs and carrying a recency
   * (`last_seen_ms`) for ordering. A project's path is identical to its row's
   * path (the join key) and is git-root-normalized by construction (the
   * extractor resolves it). `conversation_source_created_at_ms` is the
   * IDE-reported session time; fall back to our own `updated_at` when absent.
   * Primary sessions only — sub-agent / plugin children fold onto their parent.
   */
  listDetectedProjects(): { project_path: string; last_seen_ms: number }[] {
    return this.db
      .prepare(
        `SELECT project_path,
                MAX(COALESCE(
                  conversation_source_created_at_ms,
                  CAST(strftime('%s', updated_at) AS INTEGER) * 1000
                )) AS last_seen_ms
         FROM conversations
         WHERE project_path IS NOT NULL AND project_path != ''
           AND relation_type NOT IN ('SUBAGENT', 'PLUGIN', 'HOOK')
         GROUP BY project_path
         ORDER BY last_seen_ms DESC`
      )
      .all() as { project_path: string; last_seen_ms: number }[];
  }

  // ── Host sync methods ──────────────────────────────────────────────────

  /**
   * Fetch conversations ready for a host sync.
   * Includes 'pending' rows and 'syncing' rows stuck for over 30 minutes
   * (stale from a crashed sync).
   */
  getPendingConversations(limit: number): ConversationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM conversations
         WHERE sync_status = 'pending'
            OR (sync_status = 'syncing'
                AND updated_at < datetime('now', '-30 minutes'))
         ORDER BY updated_at ASC
         LIMIT ?`
      )
      .all(limit) as ConversationRow[];
  }

  /**
   * Returns up to `limitPerIdeType` conversations **per `ide_type`**, created at
   * or after the given Unix ms timestamp, preferring the most recent by
   * `created_at` — a bounded, source-balanced sample of freshly extracted rows.
   *
   * The limit is applied **per source, not globally**: sources are extracted one
   * after another, so a single global cap over a mixed backlog could fill
   * entirely with the last source's rows and never sample an earlier one. One
   * bounded branch per `ide_type` keeps every source that produced rows covered
   * while loading at most `limitPerIdeType × IDE_TYPES.length` conversation
   * blobs, however large the backlog.
   *
   * Each branch is `WHERE ide_type = ? AND created_at >= ? ORDER BY created_at
   * DESC LIMIT ?`, which the `(ide_type, created_at)` composite index serves by
   * seek and early termination — O(limitPerIdeType) per source, independent of
   * backlog size. A `ROW_NUMBER()` window over the whole table would instead sort
   * every row since the cutoff: SQLite has no per-partition early stop for a
   * window top-N.
   *
   * `limitPerIdeType` is mandatory and must be a positive integer: SQLite treats a
   * negative `LIMIT` as unbounded.
   *
   * Ordering is best-effort — rows sharing a `created_at` second (a bulk-insert
   * backlog) break ties arbitrarily, so callers must not depend on exact recency.
   */
  getConversationsSince(sinceMs: number, limitPerIdeType: number): Pick<ConversationRow, "id" | "ide_type" | "conversation">[] {
    if (!Number.isInteger(limitPerIdeType) || limitPerIdeType <= 0) {
      throw new Error(`getConversationsSince: limitPerIdeType must be a positive integer, got ${limitPerIdeType}`);
    }
    // created_at is stored by SQLite's datetime('now') as "YYYY-MM-DD HH:MM:SS".
    // Avoid format-mismatch by letting SQLite convert the Unix second timestamp via
    // datetime(?, 'unixepoch') — both sides are in the same SQLite datetime format.
    const sinceSec = Math.floor(sinceMs / 1000);
    // One index-bounded branch per ide_type, UNION ALL'd. ide_type values come
    // from the fixed IDE_TYPES enum and are bound as parameters (never
    // interpolated), so the branch count is static and the query is injection-safe.
    // Each branch is wrapped in a subquery because SQLite only allows ORDER BY /
    // LIMIT on a compound term when it is parenthesised.
    const branch =
      `SELECT * FROM (
         SELECT id, ide_type, conversation FROM conversations
         WHERE ide_type = ? AND created_at >= datetime(?, 'unixepoch')
         ORDER BY created_at DESC
         LIMIT ?
       )`;
    const sql = IDE_TYPES.map(() => branch).join(" UNION ALL ");
    const params = IDE_TYPES.flatMap((ideType) => [ideType, sinceSec, limitPerIdeType]);
    return this.db
      .prepare(sql)
      .all(...params) as Pick<ConversationRow, "id" | "ide_type" | "conversation">[];
  }

  /**
   * Mark conversations as syncing (a sync is in progress).
   */
  markSyncing(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE conversations
         SET sync_status = 'syncing', updated_at = datetime('now')
         WHERE id IN (${placeholders})`
      )
      .run(...ids);
  }

  /**
   * Mark a conversation as synced (the sync succeeded).
   *
   * Guarded on sync_status='syncing' so it only stamps the row-state that was
   * actually synced. A host sync is async, so a re-extraction can upsert the
   * row mid-flight; when its content changed, the upsert flips sync_status back to
   * 'pending' (content_hash differs). Without the guard, markSynced would then
   * stamp that NEW, never-synced content 'synced' — and since a Cursor re-read
   * also latches tokens_observed=1 (terminal), no forced re-read would rescue it,
   * silently losing backfilled tokens. With the guard the UPDATE matches nothing,
   * the row stays 'pending', and its new content syncs again on the next cycle.
   */
  markSynced(id: string): void {
    const info = this.db
      .prepare(
        `UPDATE conversations
         SET sync_status = 'synced',
             synced_at = datetime('now'),
             updated_at = datetime('now')
         WHERE id = ? AND sync_status = 'syncing'`
      )
      .run(id);
    if (info.changes === 0) {
      // The row left 'syncing' during the sync (a mid-flight re-read flipped it
      // to 'pending' with new content). Left as-is to sync again next cycle.
      logger.info("db", "mark_synced_skipped_not_syncing", { id });
    }
  }

  /**
   * Mark a conversation as failed (the sync was rejected).
   *
   * Guarded on sync_status='syncing' for the same reason as markSynced: 'failed'
   * is terminal (getPendingConversations never reselects it), so a stale sync
   * that errors must not clobber a row a mid-flight re-read already flipped to
   * 'pending' with new content — that would strand the fresh content in a terminal
   * state and lose it. When the guard no-ops the row stays 'pending' and retries.
   */
  markFailed(id: string): void {
    const info = this.db
      .prepare(
        `UPDATE conversations
         SET sync_status = 'failed', updated_at = datetime('now')
         WHERE id = ? AND sync_status = 'syncing'`
      )
      .run(id);
    if (info.changes === 0) {
      logger.info("db", "mark_failed_skipped_not_syncing", { id });
    }
  }

  /**
   * Reset conversations back to pending (e.g., after a network error).
   */
  resetToPending(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE conversations
         SET sync_status = 'pending', updated_at = datetime('now')
         WHERE id IN (${placeholders})`
      )
      .run(...ids);
  }

  // ── Project scope filtering ─────────────────────────────────────────────

  /**
   * Returns all distinct non-null project_paths in the conversations table,
   * for a host that decides which projects are in scope (see applyScope).
   */
  getDistinctProjectPaths(): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT project_path FROM conversations WHERE project_path IS NOT NULL`
        )
        .all() as { project_path: string }[]
    ).map((r) => r.project_path);
  }

  /**
   * Atomically applies scope filtering to the conversations table.
   *
   * In "filtered" mode:
   *   - pending rows whose project_path is NOT in eligiblePaths → skipped_out_of_scope
   *   - skipped_out_of_scope rows whose project_path IS in eligiblePaths → pending
   *     (re-queued for sync now that they're in scope)
   *
   * In "unfiltered" mode (no scope configured):
   *   - all skipped_out_of_scope rows → pending
   *
   * Rows already in 'syncing' or 'synced' are NEVER touched — an in-flight
   * sync must not be cancelled by a scope change, and we never re-sync
   * data that has already shipped.
   *
   * Returns the number of rows re-queued from skipped_out_of_scope → pending,
   * so the caller can decide whether to start a sync.
   */
  applyScope(
    eligiblePaths: string[],
    mode: "filtered" | "unfiltered"
  ): { requeued: number } {
    return this.transaction(() => {
      if (mode === "unfiltered") {
        const result = this.db
          .prepare(
            `UPDATE conversations
             SET sync_status = 'pending', updated_at = datetime('now')
             WHERE sync_status = 'skipped_out_of_scope'`
          )
          .run();
        return { requeued: result.changes };
      }

      if (eligiblePaths.length === 0) {
        // Nothing is in scope — park all pending rows. Nothing to re-queue.
        this.db
          .prepare(
            `UPDATE conversations
             SET sync_status = 'skipped_out_of_scope', updated_at = datetime('now')
             WHERE sync_status = 'pending'`
          )
          .run();
        return { requeued: 0 };
      }

      // One bound JSON parameter instead of one placeholder per path: avoids
      // the SQLITE_MAX_VARIABLE_NUMBER ceiling on large project sets and lets
      // sqlite reuse one prepared statement regardless of path count.
      const eligibleJson = JSON.stringify(eligiblePaths);

      // Mark out-of-scope pending → skipped.
      this.db
        .prepare(
          `UPDATE conversations
           SET sync_status = 'skipped_out_of_scope', updated_at = datetime('now')
           WHERE sync_status = 'pending'
             AND (project_path IS NULL OR project_path NOT IN (SELECT value FROM json_each(?)))`
        )
        .run(eligibleJson);

      // Re-queue newly in-scope skipped → pending.
      const requeued = this.db
        .prepare(
          `UPDATE conversations
           SET sync_status = 'pending', updated_at = datetime('now')
           WHERE sync_status = 'skipped_out_of_scope'
             AND project_path IN (SELECT value FROM json_each(?))`
        )
        .run(eligibleJson);

      return { requeued: requeued.changes };
    });
  }

  /**
   * Zeroes per-row file dedup tracking for the listed ide_types, so the next
   * scan re-reads every file of those sources (`reset --dedup`). Other
   * ide_types' rows are untouched, so a fix to (e.g.) the Cursor extractor does
   * not force re-extraction of unrelated Claude Code or Copilot rows. Each row's updated_at is
   * left as it was, so list order and an `updatedSince` filter do not move.
   */
  resetFileDedupTracking(ideTypes: string[]): void {
    if (ideTypes.length === 0) return;
    const placeholders = ideTypes.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE conversations
         SET last_mtime_ms = 0, last_size = 0
         WHERE ide_type IN (${placeholders})`
      )
      .run(...ideTypes);
  }

  // ── Generic key/value meta ───────────────────────────────────────────────

  /** Read a value from the generic `meta` table, or null if the key is unset. */
  getMeta(key: string): string | null {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /** Upsert a value into the generic `meta` table. */
  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, value);
  }

  /** One conversation row by source and vendor session id, or null. */
  getConversation(ideType: IdeType, sessionId: string): ConversationRow | null {
    const row = this.db
      .prepare(`SELECT * FROM conversations WHERE ide_type = ? AND session_id = ?`)
      .get(ideType, sessionId) as ConversationRow | undefined;
    return row ?? null;
  }

  /**
   * Conversation rows matching every filter given, most recently updated first,
   * at most `limit` of them (default {@link LIST_DEFAULT_LIMIT}); each row carries
   * its whole conversation, so a caller reading everything pages with `offset`.
   * `updatedSince` compares against `updated_at` (SQLite `datetime` text).
   */
  listConversations(filter: {
    ideType?: IdeType;
    projectPath?: string;
    repoName?: string;
    updatedSince?: string;
    syncStatus?: ConversationRow["sync_status"];
    limit?: number;
    offset?: number;
  } = {}): ConversationRow[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (filter.ideType !== undefined) { where.push("ide_type = ?"); params.push(filter.ideType); }
    if (filter.projectPath !== undefined) { where.push("project_path = ?"); params.push(filter.projectPath); }
    if (filter.repoName !== undefined) { where.push("repo_name = ?"); params.push(filter.repoName); }
    if (filter.updatedSince !== undefined) { where.push("updated_at >= ?"); params.push(filter.updatedSince); }
    if (filter.syncStatus !== undefined) { where.push("sync_status = ?"); params.push(filter.syncStatus); }
    const limit = filter.limit ?? LIST_DEFAULT_LIMIT;
    const offset = filter.offset ?? 0;
    if (!Number.isInteger(limit) || limit <= 0 || !Number.isInteger(offset) || offset < 0) {
      throw new Error(`listConversations: limit must be a positive integer and offset non-negative, got ${limit}, ${offset}`);
    }
    return this.db
      .prepare(
        `SELECT * FROM conversations${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}
         ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as ConversationRow[];
  }

  /**
   * One page of primary sessions (sub-agent, plugin and hook runs left out, as
   * {@link countByIde} does), most recently active first, with the total that
   * match. Neither the conversation text nor `installation_metadata` is returned;
   * the per-session counts, models and times are read from the conversation in
   * SQLite, for the page's rows only. A row whose stored JSON does not parse lists
   * with no messages instead of failing the page.
   */
  listSessionSummaries(filter: SessionSummaryFilter = {}): { rows: SessionSummary[]; total: number } {
    const where = ["relation_type NOT IN ('SUBAGENT', 'PLUGIN', 'HOOK')"];
    const params: SqlValue[] = [];
    if (filter.ideType !== undefined) { where.push("ide_type = ?"); params.push(filter.ideType); }
    if (filter.projectPath === null) where.push("project_path IS NULL");
    else if (filter.projectPath !== undefined) { where.push("project_path = ?"); params.push(filter.projectPath); }
    if (filter.query !== undefined && filter.query !== "") {
      // SQLite refuses a LIKE pattern over 50,000 bytes; 200 characters is a search, not a document.
      if (filter.query.length > 200) throw new Error(`listSessionSummaries: query must be at most 200 characters, got ${filter.query.length}`);
      const like = `%${filter.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      // Every source of the shown title, the first message included, though that one reads each conversation.
      where.push(
        `(${textAt("session_meta", "$.session_title")} LIKE ? ESCAPE '\\' OR ${textAt("session_meta", "$.first_prompt")} LIKE ? ESCAPE '\\'` +
          ` OR ${textAt("conversation", "$[0].content")} LIKE ? ESCAPE '\\')`,
      );
      params.push(like, like, like);
    }
    const limit = filter.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new Error(`listSessionSummaries: limit must be an integer from 1 to 200, got ${limit}`);
    }
    // Ordered by last_message_ms, each session's last activity (its index serves the order), not
    // updated_at: a first scan writes every row within minutes, so updated_at orders by source.
    // The next page starts after the last row shown, not at an offset, so a row the store gains
    // or moves meanwhile never pushes an unchanged one out of view.
    const pageWhere = [...where];
    const pageParams = [...params];
    if (filter.after !== undefined) {
      const { lastActivityMs, id } = filter.after;
      if (!Number.isFinite(lastActivityMs) || typeof id !== "string" || id === "") {
        throw new Error("listSessionSummaries: after must hold a finite lastActivityMs and a non-empty id");
      }
      pageWhere.push("(last_message_ms < ? OR (last_message_ms = ? AND id > ?))");
      pageParams.push(lastActivityMs, lastActivityMs, id);
    }
    const conversation = "CASE WHEN json_valid(c.conversation) THEN CASE json_type(c.conversation) WHEN 'array' THEN c.conversation END END";
    const field = (path: string): string => `CASE WHEN m.type = 'object' THEN json_extract(m.value, '${path}') END`;
    const text = (path: string): string =>
      `CASE WHEN m.type = 'object' THEN CASE json_type(m.value, '${path}') WHEN 'text' THEN json_extract(m.value, '${path}') END END`;
    // The total and the page come from one read, so the total counts the page's own rows.
    return this.readTransaction(() => {
      const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM conversations WHERE ${where.join(" AND ")}`).get(...params) as { n: number }).n;
      const rows = this.db
        .prepare(
          // The per-message aggregates and the per-session columns are kept in separate
          // steps: an expression on the whole conversation next to the aggregates would be
          // evaluated once per message, re-reading the conversation each time.
          `WITH page AS (
             SELECT id, last_message_ms FROM conversations WHERE ${pageWhere.join(" AND ")}
             ORDER BY last_message_ms DESC, id ASC LIMIT ?
           ),
           per_message AS (
             SELECT page.id AS id,
                    MIN(${text("$.timestamp")}) AS started_at,
                    MAX(${text("$.timestamp")}) AS last_at,
                    COUNT(*) FILTER (WHERE ${field("$.role")} = 'user') AS user_messages,
                    COUNT(*) FILTER (WHERE ${field("$.role")} = 'assistant') AS assistant_messages,
                    json_group_array(DISTINCT ${text("$.metadata.model")})
                      FILTER (WHERE ${text("$.metadata.model")} IS NOT NULL) AS models,
                    MAX(CASE WHEN m.key = 0 THEN ${text("$.content")} END) AS first_content
             FROM page JOIN conversations c ON c.id = page.id
             LEFT JOIN json_each(${conversation}) m
             GROUP BY page.id
           )
           SELECT c.id, c.ide_type, c.session_id, c.project_path, c.repo_name, page.last_message_ms,
                  COALESCE(${textAt("c.session_meta", "$.git_branches[#-1]")}, ${textAt("c.session_meta", "$.git_branch")}) AS branch,
                  substr(COALESCE(NULLIF(${textAt("c.session_meta", "$.session_title")}, ''),
                                  NULLIF(${textAt("c.session_meta", "$.first_prompt")}, ''),
                                  NULLIF(pm.first_content, '')), 1, 200) AS title,
                  CASE WHEN json_valid(c.session_meta) THEN json_extract(c.session_meta, '$.duration_minutes') END AS meta_duration,
                  pm.started_at, pm.last_at, pm.user_messages, pm.assistant_messages, pm.models
           FROM page JOIN per_message pm ON pm.id = page.id JOIN conversations c ON c.id = page.id
           ORDER BY page.last_message_ms DESC, page.id ASC`,
        )
        .all(...pageParams, limit) as Array<{
          id: string;
          ide_type: IdeType;
          session_id: string;
          project_path: string | null;
          repo_name: string | null;
          last_message_ms: number;
          branch: string | null;
          title: string | null;
          meta_duration: unknown;
          started_at: string | null;
          last_at: string | null;
          user_messages: number;
          assistant_messages: number;
          models: string;
        }>;
      return {
        total,
        rows: rows.map((r) => {
          const span = r.started_at && r.last_at ? (Date.parse(r.last_at) - Date.parse(r.started_at)) / 60000 : NaN;
          return {
            id: r.id,
            ideType: r.ide_type,
            sessionId: r.session_id,
            lastActivityMs: r.last_message_ms,
            lastActivityAt: r.last_message_ms > 0 ? new Date(r.last_message_ms).toISOString() : null,
            projectPath: r.project_path,
            repoName: r.repo_name,
            branch: r.branch,
            title: r.title,
            startedAt: r.started_at,
            durationMinutes: typeof r.meta_duration === "number" ? r.meta_duration : Number.isFinite(span) ? span : null,
            userMessages: r.user_messages,
            assistantMessages: r.assistant_messages,
            models: JSON.parse(r.models) as string[],
          };
        }),
      };
    });
  }

  /**
   * One page of a conversation's messages, in order, and how many it has, by the
   * row `id` that {@link listSessionSummaries} returns; null when the store has no
   * such row. SQLite walks the stored JSON, so only the page's messages reach
   * JavaScript. Only user and assistant messages are returned and counted. A
   * message's content that is not text reads as "". A stored conversation that is
   * not a JSON array throws.
   */
  getConversationPage(
    id: string,
    page: { offset?: number; limit?: number } = {},
  ): { total: number; messages: TranscriptMessage[] } | null {
    const offset = page.offset ?? 0;
    const limit = page.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) {
      throw new Error(`getConversationPage: limit must be an integer from 1 to 1000 and offset non-negative, got ${limit}, ${offset}`);
    }
    const text = (path: string): string =>
      `CASE WHEN m.type = 'object' THEN CASE json_type(m.value, '${path}') WHEN 'text' THEN json_extract(m.value, '${path}') END END`;
    const value = (path: string): string => `CASE WHEN m.type = 'object' THEN json_extract(m.value, '${path}') END`;
    // A message with any other role (a malformed row) is left out, as the list's counts leave it out.
    const role = text("$.role");
    return this.readTransaction(() => {
      const head = this.db
        .prepare(
          `SELECT CASE WHEN json_valid(conversation) THEN CASE json_type(conversation) WHEN 'array' THEN
                    (SELECT COUNT(*) FROM json_each(conversation) m WHERE ${role} IN ('user', 'assistant')) END END AS total
           FROM conversations WHERE id = ?`,
        )
        .get(id) as { total: number | null } | undefined;
      if (!head) return null;
      if (head.total === null) throw new Error("getConversationPage: the stored conversation is not a JSON array");
      const rows = this.db
        .prepare(
          `SELECT ${text("$.role")} AS role, ${text("$.content")} AS content, ${text("$.timestamp")} AS timestamp,
                  ${text("$.metadata.model")} AS model, ${value("$.metadata.inputTokens")} AS input_tokens,
                  ${value("$.metadata.outputTokens")} AS output_tokens, ${value("$.metadata.isSubAgent")} AS sub_agent
           FROM conversations c, json_each(c.conversation) m
           WHERE c.id = ? AND ${role} IN ('user', 'assistant')
           ORDER BY m.key LIMIT ? OFFSET ?`,
        )
        .all(id, limit, offset) as Array<{
          role: "user" | "assistant";
          content: string | null;
          timestamp: string | null;
          model: string | null;
          input_tokens: unknown;
          output_tokens: unknown;
          sub_agent: unknown;
        }>;
      const count = (v: unknown): number | null => (typeof v === "number" ? v : null);
      return {
        total: head.total,
        messages: rows.map((r) => ({
          role: r.role,
          content: r.content ?? "",
          timestamp: r.timestamp,
          model: r.model,
          inputTokens: count(r.input_tokens),
          outputTokens: count(r.output_tokens),
          isSubAgent: r.sub_agent === 1,
        })),
      };
    });
  }

  /** Deletes every conversation row and every `meta` entry. */
  clearAll(): void {
    this.transaction(() => {
      this.db.prepare("DELETE FROM conversations").run();
      this.db.prepare("DELETE FROM meta").run();
    });
  }

  /** The underlying connection: the export's read transaction, and tests that assert with SQL. */
  raw(): DatabaseSync {
    return this.db.handle;
  }

  close(): void {
    this.db.handle.close();
  }

  /** Runs reads in one deferred transaction, or in the caller's when one is open. */
  private readTransaction<T>(fn: () => T): T {
    if (this.db.handle.isTransaction) return fn();
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      // SQLite aborts the transaction itself on some failures (a full disk, an I/O
      // error), so ROLLBACK can fail too; the original error is the one to surface.
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  /**
   * Throws unless the file is empty (free to initialise) or carries the
   * package's application id. Reads only. Empty is no pages at all, or, once
   * under the write lock (which can allocate the first page), no schema.
   */
  private assertOwnStore(): "empty" | "own" {
    let empty: boolean;
    let applicationId: number;
    try {
      applicationId = (this.db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id;
      const pageCount = (this.db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count;
      empty =
        applicationId === 0 &&
        (pageCount === 0 ||
          (this.db.handle.isTransaction &&
            (this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema").get() as { n: number }).n === 0 &&
            this.userVersion() === 0));
    } catch (err) {
      throw new StoreOpenError(`${this.path} is not a local-session-extractor store: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (empty) return "empty";
    if (applicationId !== STORE_APPLICATION_ID) {
      throw new StoreOpenError(`${this.path} is not a local-session-extractor store (application_id ${applicationId})`);
    }
    return "own";
  }

  /**
   * The switch to WAL needs an exclusive lock. While another process holds the write
   * lock, SQLite answers busy at once instead of waiting (waiting could deadlock), so
   * the switch is retried until the busy timeout runs out.
   */
  private switchToWal(): void {
    const deadline = Date.now() + BUSY_TIMEOUT_MS;
    for (;;) {
      try {
        this.db.exec("PRAGMA journal_mode = WAL");
        return;
      } catch (err) {
        const code = (err as { errcode?: unknown }).errcode;
        if (typeof code !== "number" || (code & 0xff) !== SQLITE_BUSY || Date.now() >= deadline) throw err;
        Atomics.wait(SLEEP_CELL, 0, 0, 10);
      }
    }
  }

  private userVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  }

  /**
   * Applies forward migrations under `BEGIN IMMEDIATE`, re-reading the version
   * inside the lock so a second opener that waited finds the schema current. A
   * newer schema opens when every column the package reads exists.
   */
  private migrate(): void {
    if (this.userVersion() < MIGRATIONS.length) {
      this.transaction(() => {
        // Re-checked under the lock: another opener may have initialised the file since the probe.
        if (this.assertOwnStore() === "empty") this.db.exec(`PRAGMA application_id = ${STORE_APPLICATION_ID}`);
        const current = this.userVersion();
        for (let i = current; i < MIGRATIONS.length; i++) this.db.exec(MIGRATIONS[i]!);
        if (current < MIGRATIONS.length) this.db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
      });
    }
    this.assertReadableSchema();
  }

  /** A newer schema is readable when every column the package reads exists. */
  private assertReadableSchema(): void {
    if (this.userVersion() > MIGRATIONS.length) {
      const present = new Set(
        (this.db.prepare("PRAGMA table_info(conversations)").all() as { name: string }[]).map((c) => c.name),
      );
      const missing = REQUIRED_CONVERSATION_COLUMNS.filter((c) => !present.has(c));
      if (missing.length > 0) {
        throw new StoreOpenError(
          `store schema v${this.userVersion()} is newer than this package (v${MIGRATIONS.length}) and lacks ${missing.join(", ")}`,
        );
      }
    }
  }
}
