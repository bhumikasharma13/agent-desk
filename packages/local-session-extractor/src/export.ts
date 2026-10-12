// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * `exportSessions`: the store's sessions as Session Intelligence `Conversation`
 * objects, or as the stored rows, one JSON object per line or one JSON array,
 * or one `Conversation` per file in a folder.
 */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { redactPrompts, redactText, sanitizeSessionMeta } from "./redaction";
import { anonymizePath, anonymizeText, withHomeOwners } from "./redaction/anonymizer";
import { toConversation } from "./sessionIntelligence";
import { readHomeOwners } from "./store/homeOwners";
import type { SessionStore } from "./store/SessionStore";
import { IDE_TYPES } from "./types/session";
import type { ConversationPrompt, ConversationRow, IdeType, SessionLineagePayload, SessionMetaPayload } from "./types/session";

export const EXPORT_FORMATS = ["jsonl", "json"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_SHAPES = ["conversation", "row"] as const;
/**
 * `conversation`: Session Intelligence's `Conversation` (see `toConversation`).
 * `row`: the stored row, its JSON columns parsed.
 */
export type ExportShape = (typeof EXPORT_SHAPES)[number];

/** Which rows to export; every field given must match. */
export interface ExportFilter {
  ideType?: IdeType;
  projectPath?: string;
  repoName?: string;
  /** Compared against `updated_at`, SQLite `datetime` text. */
  updatedSince?: string;
  syncStatus?: ConversationRow["sync_status"];
}

/** An export to one file or stream. */
export interface ExportToOutOptions {
  /** `jsonl`: one object per line. `json`: one array of them. */
  format: ExportFormat;
  /** Defaults to `conversation`. */
  shape?: ExportShape;
  /**
   * Where the rows go: a file path or a Node writable stream.
   *
   * A path is replaced whole, at mode 0600, by a rename from a temp file
   * beside it, so its directory must be writable and a failed export leaves an
   * existing file as it was. A symlink here is refused.
   *
   * A stream (`process.stdout`, say) is written directly and left open; the
   * caller ends it. The whole snapshot is read into memory and the read
   * transaction ends before the first write, so the export holds every
   * exported row in memory at once.
   */
  out: string | NodeJS.WritableStream;
  filter?: ExportFilter;
  /** With `shape: "row"`, keeps `sync_status` and `synced_at`, which are dropped by default. */
  includeSyncState?: boolean;
  split?: undefined;
  force?: undefined;
}

/**
 * An export to a folder, one Session Intelligence `Conversation` per file, the
 * form Session Intelligence's `ReadConversationDir` and `analyze-real` read.
 * It takes no `format`, `out`, `includeSyncState` or `shape: "row"`.
 */
export interface ExportSplitOptions {
  /**
   * The folder, created at mode 0700 when missing. Each session is written to
   * `<ide_type>/<name>.json` under it, where the name is the first 32 hex
   * digits of the SHA-256 of the session's redacted id. Each file is written at
   * mode 0600 by a rename from a temp file beside it, and a symlink in place of
   * the folder, a source folder or a file is refused.
   */
  split: string;
  /** Writes into a folder that is not empty, replacing a file of the same name and leaving the others. */
  force?: boolean;
  filter?: ExportFilter;
  shape?: "conversation";
  format?: undefined;
  out?: undefined;
  includeSyncState?: undefined;
}

export type ExportOptions = ExportToOutOptions | ExportSplitOptions;

/** The columns the store keeps as JSON strings. */
export const JSON_COLUMNS: ReadonlySet<string> = new Set([
  "conversation",
  "session_meta",
  "session_facets",
  "installation_metadata",
  "stats_cache",
  "ai_attribution",
  "session_events",
]);

const SYNC_COLUMNS: ReadonlySet<string> = new Set(["sync_status", "synced_at"]);
/** The list view's order, derived from the exported messages and `last_mtime_ms`: never exported. */
const INDEX_COLUMNS: readonly string[] = ["last_message_ms"];

const PAGE_SIZE = 500;

/**
 * A store row as a plain record: `drop` columns left out and the JSON columns
 * parsed. A JSON column that does not parse is kept as its raw string, or,
 * with `strict`, throws.
 */
export function rowRecord(
  row: Record<string, unknown>,
  drop: ReadonlySet<string>,
  strict = false,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [column, stored] of Object.entries(row)) {
    if (drop.has(column)) continue;
    // A BLOB (a Uint8Array from node:sqlite) is read as the UTF-8 text it holds, so it is
    // parsed and redacted as that text would be.
    const value = stored instanceof Uint8Array ? new TextDecoder().decode(stored) : stored;
    if (!JSON_COLUMNS.has(column) || typeof value !== "string") {
      out[column] = value;
      continue;
    }
    try {
      out[column] = JSON.parse(value) as unknown;
    } catch (err) {
      if (strict) {
        throw new Error(`column ${column} of ${String(row["ide_type"])}/${String(row["session_id"])} is not JSON: ${String(err)}`, { cause: err });
      }
      out[column] = value;
    }
  }
  return out;
}

/**
 * Writes every matching row, most recently updated first, and returns how many
 * it wrote. Every page is read inside one read transaction, so the export is
 * one snapshot of the store even while another connection writes to it. On a
 * connection already inside a transaction, the pages are read in that one.
 */
export function exportSessions(store: SessionStore, opts: ExportOptions): Promise<{ written: number }> {
  try {
    if (opts.split !== undefined) return Promise.resolve(writeSplit(store, opts));
    if (typeof opts.out !== "string") return writeExportToStream(store, { ...opts, out: opts.out });
    return Promise.resolve(writeExport(store, { ...opts, out: opts.out }));
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/** Test seams: the page size, and a hook run between pages. */
interface ExportSeams {
  pageSize?: number;
  afterPage?: () => void;
}

/** The export to a file path. */
export function writeExport(
  store: SessionStore,
  opts: ExportToOutOptions & { out: string },
  seams: ExportSeams = {},
): { written: number } {
  assertOptions(opts);
  refuseSymlink(opts.out);
  const temp = join(dirname(opts.out), `.${basename(opts.out)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  let open = true;
  let written = 0;
  try {
    const db = store.raw();
    const own = beginRead(db);
    try {
      for (const page of pages(store, opts, seams)) {
        writeAll(fd, page.text);
        written += page.rows;
      }
      writeAll(fd, closing(opts.format, written));
    } catch (err) {
      if (own) endReadQuietly(db);
      throw err;
    }
    if (own) db.exec("COMMIT");
    fsyncSync(fd);
    open = false;
    closeSync(fd);
    refuseSymlink(opts.out);
    renameSync(temp, opts.out);
  } catch (err) {
    try {
      if (open) closeSync(fd);
    } finally {
      rmSync(temp, { force: true });
    }
    throw err;
  }
  return { written };
}

/**
 * The export to a writable stream, which is left open. The snapshot is read in
 * full before the first write: holding the read transaction across the stream's
 * drain would pull every other use of the store's connection into it.
 */
export async function writeExportToStream(
  store: SessionStore,
  opts: ExportToOutOptions & { out: NodeJS.WritableStream },
  seams: ExportSeams = {},
): Promise<{ written: number }> {
  assertOptions(opts);
  if (typeof opts.out?.write !== "function") throw new TypeError("export out must be a file path or a writable stream");
  const db = store.raw();
  const own = beginRead(db);
  const chunks: string[] = [];
  let written = 0;
  try {
    for (const page of pages(store, opts, seams)) {
      chunks.push(page.text);
      written += page.rows;
    }
    chunks.push(closing(opts.format, written));
  } catch (err) {
    if (own) endReadQuietly(db);
    throw err;
  }
  if (own) db.exec("COMMIT");
  await writeChunks(opts.out, chunks);
  return { written };
}

/**
 * The export to a folder, one `Conversation` per file. Each file is complete or
 * absent: a failed export leaves the files written before it and no temp file.
 */
export function writeSplit(store: SessionStore, opts: ExportSplitOptions, seams: ExportSeams = {}): { written: number } {
  assertSplitOptions(opts);
  const dir = opts.split;
  prepareSplitFolder(dir, opts.force === true);
  const pageSize = seams.pageSize ?? PAGE_SIZE;
  const owners = readHomeOwners(store);
  const drop = new Set([...INDEX_COLUMNS, ...SYNC_COLUMNS]);
  const names = new Set<string>();
  const folders = new Set<string>();
  let written = 0;
  const db = store.raw();
  const own = beginRead(db);
  try {
    for (let offset = 0; ; offset += pageSize) {
      const rows = store.listConversations({ ...opts.filter, limit: pageSize, offset });
      for (const row of rows) {
        const record = exportRecord(row, drop, owners);
        const folder = join(dir, splitFolder(record["ide_type"]));
        if (!folders.has(folder)) {
          ensureFolder(folder);
          folders.add(folder);
        }
        const path = join(folder, splitFileName(record, names));
        writeFileAtomic(path, `${JSON.stringify(toConversation(record))}\n`);
        written++;
      }
      if (rows.length < pageSize) break;
      seams.afterPage?.();
    }
  } catch (err) {
    if (own) endReadQuietly(db);
    throw err;
  }
  if (own) db.exec("COMMIT");
  return { written };
}

function assertSplitOptions(opts: ExportSplitOptions): void {
  const given = opts as unknown as Record<string, unknown>;
  for (const option of ["out", "format", "includeSyncState"] as const) {
    if (given[option] !== undefined) throw new Error(`split writes one Conversation per file; it takes no ${option}`);
  }
  if (given["shape"] !== undefined && given["shape"] !== "conversation") {
    throw new Error('split writes one Conversation per file; it takes no shape "row"');
  }
  if (typeof opts.split !== "string" || opts.split.length === 0) throw new Error("split needs a folder path");
}

/** Creates the folder, or checks an existing one is a real, empty folder unless `force`. */
function prepareSplitFolder(dir: string, force: boolean): void {
  if (!ensureFolder(dir) && !force && readdirSync(dir).length > 0) {
    throw new Error(`refusing to export to ${dir}: it is not empty; pass force to write into it`);
  }
}

/** Creates `dir` at mode 0700 and returns true, or returns false when it is already a folder. */
function ensureFolder(dir: string): boolean {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return true;
  }
  if (stat.isSymbolicLink()) throw new Error(`refusing to export to ${dir}: it is a symlink`);
  if (!stat.isDirectory()) throw new Error(`refusing to export to ${dir}: it is not a folder`);
  return false;
}

/** The source's folder: the stored ide type, which the export keeps only when it is a known source. */
function splitFolder(ideType: unknown): string {
  return typeof ideType === "string" && (IDE_TYPES as readonly string[]).includes(ideType) ? ideType : "unknown";
}

/**
 * A file name from the redacted session id's SHA-256, so it is stable across
 * exports, safe on any file system and says nothing the file does not. Two rows
 * whose ids redact alike get the store row id mixed in, so neither overwrites
 * the other.
 */
function splitFileName(record: Record<string, unknown>, used: Set<string>): string {
  const sessionId = typeof record["session_id"] === "string" ? record["session_id"] : "";
  const folder = splitFolder(record["ide_type"]);
  let name = `${sha256Prefix(sessionId)}.json`;
  if (used.has(`${folder}/${name}`)) name = `${sha256Prefix(`${sessionId}\0${String(record["id"])}`)}.json`;
  used.add(`${folder}/${name}`);
  return name;
}

const sha256Prefix = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** Replaces `path` whole at mode 0600 by a rename from a temp file beside it; a symlink is refused. */
function writeFileAtomic(path: string, text: string): void {
  refuseSymlink(path);
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", 0o600);
  let open = true;
  try {
    writeAll(fd, text);
    fsyncSync(fd);
    open = false;
    closeSync(fd);
    refuseSymlink(path);
    renameSync(temp, path);
  } catch (err) {
    try {
      if (open) closeSync(fd);
    } finally {
      rmSync(temp, { force: true });
    }
    throw err;
  }
}

function assertOptions(opts: ExportToOutOptions): void {
  if (!(EXPORT_FORMATS as readonly string[]).includes(opts.format)) {
    throw new Error(`unsupported export format: ${String(opts.format)}; supported: ${EXPORT_FORMATS.join(", ")}`);
  }
  const shape = opts.shape ?? "conversation";
  if (!(EXPORT_SHAPES as readonly string[]).includes(shape)) {
    throw new Error(`unsupported export shape: ${String(shape)}; supported: ${EXPORT_SHAPES.join(", ")}`);
  }
  if (opts.includeSyncState === true && shape !== "row") {
    throw new Error('includeSyncState applies only to shape "row": a Conversation has no sync state');
  }
}

/** What follows the last record: the array's end for `json`, nothing for `jsonl`. */
function closing(format: ExportFormat, written: number): string {
  if (format === "jsonl") return "";
  return written === 0 ? "[]\n" : "\n]\n";
}

/** Opens a read transaction unless one is already open; true when it opened one. */
function beginRead(db: DatabaseSync): boolean {
  if (db.isTransaction) return false;
  db.exec("BEGIN");
  return true;
}

/** Ends the read transaction after a failure; its own failure must not replace the one being thrown. */
function endReadQuietly(db: DatabaseSync): void {
  try {
    db.exec("COMMIT");
  } catch {
    // The original error is the one the caller needs.
  }
}

/**
 * The matching rows as export text, one page at a time. For `json`, each record
 * is written with the separator before it, so `closing` ends the array.
 */
function* pages(store: SessionStore, opts: ExportToOutOptions, seams: ExportSeams): Generator<{ text: string; rows: number }> {
  const pageSize = seams.pageSize ?? PAGE_SIZE;
  const drop = new Set([...INDEX_COLUMNS, ...(opts.includeSyncState === true ? [] : SYNC_COLUMNS)]);
  const owners = readHomeOwners(store);
  const asRow = opts.shape === "row";
  let first = true;
  for (let offset = 0; ; offset += pageSize) {
    const rows = store.listConversations({ ...opts.filter, limit: pageSize, offset });
    if (rows.length === 0) return;
    const text = rows
      .map((row) => {
        const record = exportRecord(row, drop, owners);
        const json = JSON.stringify(asRow ? record : toConversation(record));
        if (opts.format === "jsonl") return `${json}\n`;
        const separator = first ? "[\n" : ",\n";
        first = false;
        return `${separator}${json}`;
      })
      .join("");
    yield { text, rows: rows.length };
    if (rows.length < pageSize) return;
    seams.afterPage?.();
  }
}

/**
 * Writes each chunk once the stream has accepted the one before. Rejects on a
 * write error or an `error` event. Node emits the event after the write callback,
 * so after a failure the listener stays attached to absorb it: a closed pipe
 * (EPIPE) is then a rejection rather than an uncaught exception.
 */
async function writeChunks(stream: NodeJS.WritableStream, chunks: readonly string[]): Promise<void> {
  let failure: Error | undefined;
  const onError = (err: Error): void => {
    failure ??= err;
  };
  stream.on("error", onError);
  for (const text of chunks) {
    await new Promise<void>((resolve, reject) => {
      stream.write(text, (err?: Error | null) => {
        const cause = err ?? failure;
        if (cause) reject(cause);
        else resolve();
      });
    });
  }
  stream.removeListener("error", onError);
}

function writeAll(fd: number, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at, bytes.length - at);
}

/** Throws when `path` is a symlink; a missing path is fine. */
function refuseSymlink(path: string): void {
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (isLink) throw new Error(`refusing to export to ${path}: it is a symlink`);
}

/**
 * A stored session id as the export writes it: the running user's name and
 * every `owners` name hashed in its path and dash-encoded forms. Only the
 * username is rewritten: the secret scrubber reads `token::<uuid>` as a secret.
 */
export function redactSessionId(sessionId: string, owners: readonly string[]): string {
  return withHomeOwners(owners, () => anonymizeText(sessionId));
}

/**
 * One exported row, redacted again on the way out, so a
 * row an older writer stored unredacted never leaves the machine as it was
 * stored. `owners` are the store's recorded scanned-home owners
 * ({@link readHomeOwners}), hashed in paths alongside the running user.
 *
 * - `session_id` is redacted only here: a Claude Code id embeds the encoded
 *   project dir (`-Users-<user>-…::<uuid>`), and the stored id is the store's
 *   dedup key, so it stays raw at rest.
 * - `session_meta`, `conversation`, event summaries and every string in
 *   `session_facets` get the full redaction, secrets included.
 * - every other string column (`project_path`, `repo_name`, `event_coverage`,
 *   and any column a newer schema adds) gets the full redaction too.
 * - {@link KEPT_COLUMNS} (ids, hashes, enums and timestamps) are kept as stored
 *   when they hold the shape the store writes, and fully redacted otherwise.
 * - `installation_metadata` is structured account data and is kept as stored.
 */
export function exportRecord(row: ConversationRow, drop: ReadonlySet<string>, owners: readonly string[] = []): Record<string, unknown> {
  return withHomeOwners(owners, () => redactRecord(rowRecord(row as unknown as Record<string, unknown>, drop)));
}

function redactRecord(out: Record<string, unknown>): Record<string, unknown> {
  if (typeof out["session_id"] === "string") out["session_id"] = anonymizeText(out["session_id"]);
  // A column that did not parse, or parsed to a shape this writer does not produce,
  // still has every string in it redacted.
  const meta = out["session_meta"];
  if (meta !== null && typeof meta === "object" && !Array.isArray(meta)) {
    out["session_meta"] = sanitizeSessionMeta(meta as SessionMetaPayload);
  } else if ("session_meta" in out) {
    out["session_meta"] = mapStrings(meta, fullRedact);
  }
  const conversation = out["conversation"];
  if (Array.isArray(conversation)) {
    out["conversation"] = conversation.map((prompt: unknown) =>
      prompt !== null && typeof prompt === "object" && typeof (prompt as { content?: unknown }).content === "string"
        ? redactPrompts([prompt as ConversationPrompt])[0]
        : mapStrings(prompt, fullRedact),
    );
  } else if ("conversation" in out) {
    out["conversation"] = mapStrings(conversation, fullRedact);
  }
  const events = out["session_events"];
  if (Array.isArray(events)) {
    out["session_events"] = events.map((event: unknown) =>
      event !== null && typeof event === "object" && typeof (event as { redacted_summary?: unknown }).redacted_summary === "string"
        ? { ...event, redacted_summary: redactText((event as { redacted_summary: string }).redacted_summary) }
        : event !== null && typeof event === "object"
          ? event
          : mapStrings(event, fullRedact),
    );
  } else if ("session_events" in out) {
    out["session_events"] = mapStrings(events, fullRedact);
  }
  if ("session_facets" in out) out["session_facets"] = mapStrings(out["session_facets"], redactText);
  for (const column of ["stats_cache", "ai_attribution"]) {
    if (column in out) out[column] = mapStrings(out[column], (s) => anonymizeText(anonymizePath(s)));
  }
  // Whatever shape a column holds, every string and every object key in it is redacted. Structured values (ids, names, timestamps) usually come out unchanged,
  // and one that holds a user name, a path or a secret is masked: the safe direction.
  for (const column of REDACTED_COLUMNS) {
    if (column in out) out[column] = redactDeep(out[column]);
  }
  for (const [column, value] of Object.entries(out)) {
    if (typeof value !== "string" || column === "session_id" || JSON_COLUMNS.has(column)) continue;
    if (!(Object.hasOwn(KEPT_COLUMNS, column) && KEPT_COLUMNS[column]!(value))) out[column] = fullRedact(value);
  }
  return out;
}

/** Every JSON column but `installation_metadata`, which is exported as stored. */
const REDACTED_COLUMNS = ["conversation", "session_meta", "session_events", "session_facets", "stats_cache", "ai_attribution"] as const;

const RELATION_TYPES = ["PRIMARY", "SUBAGENT", "PLUGIN", "HOOK"] as const satisfies readonly SessionLineagePayload["relation_type"][];
const SYNC_STATUSES = ["pending", "syncing", "synced", "failed", "skipped_out_of_scope"] as const satisfies readonly ConversationRow["sync_status"][];
// `satisfies` proves each member is valid; these prove every union member is listed.
const _relationTypesExhaustive: (typeof RELATION_TYPES)[number] = null as unknown as SessionLineagePayload["relation_type"];
const _syncStatusesExhaustive: (typeof SYNC_STATUSES)[number] = null as unknown as ConversationRow["sync_status"];
void _relationTypesExhaustive;
void _syncStatusesExhaustive;

const oneOf = (values: readonly string[]) => (v: string): boolean => values.includes(v);
/** `conversationId` and `contentHashFor` write a SHA-256 hex digest. */
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** SQLite's `datetime('now')`. */
const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const isSha256 = (v: string): boolean => SHA256_HEX.test(v);
const isDatetime = (v: string): boolean => SQLITE_DATETIME.test(v);

/**
 * The string columns exported as stored when the value has the shape the store
 * writes there; any other value, and every other string column but `session_id`,
 * is fully redacted. `installation_metadata` is kept whatever it holds.
 */
const KEPT_COLUMNS: Readonly<Record<string, (v: string) => boolean>> = {
  id: isSha256,
  content_hash: isSha256,
  ide_type: oneOf(IDE_TYPES),
  relation_type: oneOf(RELATION_TYPES),
  sync_status: oneOf(SYNC_STATUSES),
  synced_at: isDatetime,
  updated_at: isDatetime,
  created_at: isDatetime,
};

/**
 * `value` with every string and every object key fully redacted. Two keys that redact
 * to the same key are both kept: the later ones get ` #2`, ` #3` and so on.
 */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return fullRedact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const base = fullRedact(k);
      let key = base;
      for (let i = 2; Object.hasOwn(out, key); i++) key = `${base} #${i}`;
      // A data property, so a `__proto__` key stays an entry rather than setting the prototype.
      Object.defineProperty(out, key, { value: redactDeep(v), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

/**
 * Secrets, emails, user names and home paths masked. Anonymized again after the
 * mask, which can end a name's segment (`/Users/<name><token>/`) and expose it.
 */
function fullRedact(s: string): string {
  return anonymizeText(redactText(s));
}

/** `value` with `fn` applied to every string in it, keys kept. */
function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  }
  return value;
}
