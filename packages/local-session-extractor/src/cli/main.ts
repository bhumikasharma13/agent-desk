// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The `local-session-extractor` command line: argument parsing, the seven commands and
 * their output. `bin.ts` runs it against the process; tests run the built or
 * source binary as a child process.
 *
 * Exit codes: 0 on success; 2 when a scan finished but some source failed as a
 * whole (`ScanResult.partial`); 1 on a usage error or any other failure,
 * with the reason on stderr.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { capabilities } from "../capabilities";
import { exportRecord, exportSessions, redactSessionId, type ExportFormat } from "../export";
import { toConversation } from "../sessionIntelligence";
import { readAll, type ScanResult } from "../scan";
import { readHomeOwners } from "../store/homeOwners";
import { defaultStorePath, openStore, type SessionStore } from "../store/SessionStore";
import type { IdeType } from "../types/session";

export interface CliIo {
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream & { isTTY?: boolean };
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
}

/** A bad invocation: printed with a pointer to `--help`, exit 1. */
class UsageError extends Error {}

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_PARTIAL = 2;

const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 1_000_000;

const OPTIONS = {
  db: { type: "string" },
  home: { type: "string" },
  sources: { type: "string" },
  json: { type: "boolean" },
  limit: { type: "string" },
  format: { type: "string" },
  out: { type: "string", short: "o" },
  split: { type: "string" },
  force: { type: "boolean" },
  "include-sync-state": { type: "boolean" },
  raw: { type: "boolean" },
  all: { type: "boolean" },
  dedup: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

type OptionName = keyof typeof OPTIONS;
type Values = { [K in OptionName]?: (typeof OPTIONS)[K]["type"] extends "string" ? string : boolean };

/** The flags each command takes, beyond `--help` and `--version`. */
const COMMAND_FLAGS: Record<string, readonly OptionName[]> = {
  scan: ["db", "home", "sources", "json"],
  status: ["db", "json"],
  list: ["db", "sources", "limit", "json"],
  show: ["db", "json", "raw"],
  export: ["db", "sources", "format", "out", "split", "force", "raw", "include-sync-state"],
  capabilities: ["json"],
  reset: ["db", "all", "dedup", "sources", "yes"],
};

export function usage(): string {
  const caps = capabilities();
  return `local-session-extractor ${caps.packageVersion}: reads AI coding sessions from local agent and IDE files into a local SQLite store.

Usage: local-session-extractor <command> [options]

Commands:
  scan                       Read every source (or --sources) into the store
  status                     Sessions per source and per sync state
  list                       The most recently updated sessions
  show <source> <session-id> One session in full, as a Session Intelligence Conversation
                             (JSON). Takes the id as list prints it or as stored
  export                     Every session as Session Intelligence Conversations, to
                             --out, stdout, or one file each under --split
  capabilities               The sources, formats, platforms and versions this build supports
  reset                      Delete every stored session (--all, the default), or clear
                             only the change tracking so the next scan re-reads every
                             file (--dedup). Asks first unless --yes. Without --yes it
                             refuses to run when input is not a terminal

Options:
  --db <path>                The store file (default ${defaultStorePath()})
  --home <dir>               scan: read under this home directory instead of yours, with no git and no ps
  --sources <a,b,...>        scan, reset --dedup: these sources, in this order
                             list, export: one source to filter by
  --json                     Machine-readable output (scan, status, list, show, capabilities)
  --limit <n>                list: at most n sessions (default ${LIST_DEFAULT_LIMIT}, at most ${LIST_MAX_LIMIT})
  --format <format>          export: jsonl, one per line (the default), or json, one array
  -o, --out <file>           export: write to this file instead of stdout
  --split <folder>           export: one Conversation per file, <source>/<hash>.json, for
                             Session Intelligence's folder reader. Not with --out,
                             --format or --raw
  --force                    export --split: write into a folder that is not empty
  --raw                      show, export: the stored row instead of the Conversation
  --include-sync-state       export --raw: keep sync_status and synced_at
  --all | --dedup            reset: what to clear
  -y, --yes                  reset: do not ask for confirmation
  -h, --help                 Show this help
  -v, --version              Print the version

Sources: ${caps.sources.join(", ")}

A session id that begins with '-' (a Claude Code id does) goes after '--', so it
is not read as an option. Options go before '--':
  local-session-extractor show --db <path> claude-code -- -Users-user_1a2b3c4d-repo::0f8e…

Exit codes: 0 on success, 1 on a usage error or failure, 2 when a source failed as a whole.
`;
}

/** Runs one invocation and returns its exit code; never throws. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    return await run(argv, io);
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr.write(`local-session-extractor: ${err.message}\nRun 'local-session-extractor --help' for usage.\n`);
    } else {
      io.stderr.write(`local-session-extractor: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return EXIT_FAILURE;
  }
}

async function run(argv: readonly string[], io: CliIo): Promise<number> {
  let parsed: { values: Values; positionals: string[]; tokens: Array<{ kind: string; name?: string }> };
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true, tokens: true }) as typeof parsed;
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;
  // parseArgs keeps the last of a repeated string flag; a second value is a mistake, not an override.
  const given = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option" || token.name === undefined || OPTIONS[token.name as OptionName]?.type !== "string") continue;
    if (given.has(token.name)) throw new UsageError(`--${token.name} was given more than once`);
    given.add(token.name);
  }
  if (values.help === true) {
    io.stdout.write(usage());
    return EXIT_OK;
  }
  if (values.version === true) {
    io.stdout.write(`${capabilities().packageVersion}\n`);
    return EXIT_OK;
  }
  const [command, ...args] = positionals;
  if (command === undefined) {
    io.stderr.write(usage());
    return EXIT_FAILURE;
  }
  const allowed = COMMAND_FLAGS[command];
  if (allowed === undefined) throw new UsageError(`unknown command: ${command}`);
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined || name === "help" || name === "version") continue;
    if (!allowed.includes(name as OptionName)) throw new UsageError(`${command} does not take --${name}`);
  }
  if (command !== "show" && args.length > 0) throw new UsageError(`${command} takes no arguments, got: ${args.join(" ")}`);

  const dbPath = storePath(values.db);
  switch (command) {
    case "scan":
      return scan(io, values, dbPath);
    case "status":
      return withExistingStore(dbPath, (store) => status(io, values, store));
    case "list": {
      // Validated before the store is opened, so a bad flag reads as a usage error.
      const ideType = parseOneSource(values.sources, "list");
      const limit = parseLimit(values.limit);
      return withExistingStore(dbPath, (store) => list(io, values, store, ideType, limit));
    }
    case "show":
      return show(io, values, dbPath, args);
    case "export":
      return exportCommand(io, values, dbPath);
    case "capabilities":
      return capabilitiesCommand(io, values);
    case "reset":
      return reset(io, values, dbPath);
    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

// ── Argument helpers ──────────────────────────────────────────────────────────

function storePath(db: string | undefined): string {
  if (db === undefined) return defaultStorePath();
  if (db.length === 0) throw new UsageError("--db needs a path");
  return resolve(db);
}

/** `--sources` as an ordered, validated list, or undefined when absent. */
function parseSources(raw: string | undefined): IdeType[] | undefined {
  if (raw === undefined) return undefined;
  const known = capabilities().sources;
  const sources = raw.split(",").map((s) => s.trim());
  const seen = new Set<string>();
  for (const source of sources) {
    if (source.length === 0) throw new UsageError("--sources needs a comma-separated list of sources");
    if (!(known as readonly string[]).includes(source)) {
      throw new UsageError(`unknown source: ${source}; sources are ${known.join(", ")}`);
    }
    if (seen.has(source)) throw new UsageError(`--sources lists ${source} twice`);
    seen.add(source);
  }
  return sources as IdeType[];
}

/** `--sources` for a command that filters by one source. */
function parseOneSource(raw: string | undefined, command: string): IdeType | undefined {
  const sources = parseSources(raw);
  if (sources === undefined) return undefined;
  if (sources.length !== 1) throw new UsageError(`${command} filters by one source; --sources got ${sources.length}`);
  return sources[0];
}

/** `show`'s positional source: exactly one known source. */
function parseSource(raw: string): IdeType {
  if (raw.length === 0 || raw.includes(",")) {
    throw new UsageError(`show's <source> argument is one source, got: '${raw}'; sources are ${capabilities().sources.join(", ")}`);
  }
  return parseSources(raw)![0]!;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return LIST_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n === 0 || n > LIST_MAX_LIMIT) {
    throw new UsageError(`--limit needs a whole number from 1 to ${LIST_MAX_LIMIT}, got: ${raw}`);
  }
  return n;
}

function storeExists(dbPath: string): boolean {
  return existsSync(dbPath) && statSync(dbPath).size > 0;
}

/** Opens a store that must already exist; the read commands and reset never create or migrate one. */
async function withExistingStore(dbPath: string, fn: (store: SessionStore) => number | Promise<number>): Promise<number> {
  if (!storeExists(dbPath)) throw new Error(`no store at ${dbPath}; run 'local-session-extractor scan' first`);
  const store = openStore(dbPath, { mustExist: true });
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value)}\n`);
}

function table(rows: readonly (readonly string[])[]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => `  ${row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ")}`.trimEnd()).join("\n");
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function scan(io: CliIo, values: Values, dbPath: string): Promise<number> {
  const sources = parseSources(values.sources);
  let home: string | undefined;
  if (values.home !== undefined) {
    if (values.home.length === 0) throw new UsageError("--home needs a directory");
    home = resolve(values.home);
    if (!existsSync(home) || !statSync(home).isDirectory()) throw new UsageError(`--home is not a directory: ${home}`);
    // The real path, so a symlinked home's owner is the name redaction hashes.
    home = realpathSync(home);
  }
  const json = values.json === true;
  const progress = !json && io.stderr.isTTY === true;

  const store = openStore(dbPath);
  let result: ScanResult;
  try {
    result = await readAll(store, {
      ...(sources === undefined ? {} : { sources }),
      ...(home === undefined ? {} : { home }),
      ...(progress
        ? {
            onProgress: (event) => {
              if (event.state === "start") io.stderr.write(`scanning ${event.source}...\n`);
            },
          }
        : {}),
    });
  } finally {
    store.close();
  }

  const partial = Object.entries(result.partial).filter(([, isPartial]) => isPartial === true).map(([source]) => source);
  if (json) {
    writeJson(io, { store: dbPath, ...result });
  } else {
    const rows = Object.entries(result.counts).map(([source, n]) => [
      source,
      String(n),
      result.partial[source as IdeType] === true ? "partial" : "",
    ]);
    io.stdout.write(`Scanned into ${dbPath} in ${(result.durationMs / 1000).toFixed(1)}s\n${table(rows)}\n`);
    const sessionErrors = result.errors.filter((e) => e.scope === "session").length;
    if (sessionErrors > 0) io.stdout.write(`${sessionErrors} session(s) could not be read; --json lists them\n`);
    for (const e of result.errors.filter((e) => e.scope === "source")) {
      io.stderr.write(`local-session-extractor: ${e.source} failed as a whole: ${e.message}\n`);
    }
  }
  return partial.length > 0 ? EXIT_PARTIAL : EXIT_OK;
}

/** Primary sessions per source and in total: sub-agent, plugin and hook runs are not counted. */
function primarySessions(store: SessionStore): Record<string, number> {
  const byIde = store.countByIde() as unknown as Record<string, number>;
  const sessions: Record<string, number> = {};
  for (const source of capabilities().sources) {
    sessions[source] = byIde[source.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] ?? 0;
  }
  sessions["total"] = byIde["total"] ?? 0;
  return sessions;
}

/** Primary sessions per source, and every row per sync state. */
function status(io: CliIo, values: Values, store: SessionStore): number {
  const sessions = primarySessions(store);
  const db = store.raw();
  const syncStatus = Object.fromEntries(
    (db.prepare("SELECT sync_status, COUNT(*) AS n FROM conversations GROUP BY sync_status ORDER BY sync_status").all() as Array<{
      sync_status: string;
      n: number;
    }>).map((r) => [r.sync_status, r.n]),
  );
  const schemaVersion = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  if (values.json === true) {
    writeJson(io, { store: store.path, schemaVersion, sessions, syncStatus });
    return EXIT_OK;
  }
  const sync = Object.entries(syncStatus).map(([state, n]) => `${state} ${n}`).join(", ");
  io.stdout.write(
    `Store: ${store.path} (schema ${schemaVersion})\nSessions (sub-agent, plugin and hook runs not counted):\n` +
      `${table(Object.entries(sessions).map(([source, n]) => [source, String(n)]))}\n` +
      `Sync state of every row: ${sync.length > 0 ? sync : "empty"}\n`,
  );
  return EXIT_OK;
}

/** The number of stored prompts, or null when the stored conversation does not parse. */
function promptCount(conversation: string): number | null {
  try {
    const parsed = JSON.parse(conversation) as unknown;
    return Array.isArray(parsed) ? parsed.length : null;
  } catch {
    return null;
  }
}

function list(io: CliIo, values: Values, store: SessionStore, ideType: IdeType | undefined, limit: number): number {
  const rows = store.listConversations({ ...(ideType === undefined ? {} : { ideType }), limit });
  const owners = readHomeOwners(store);
  const summaries = rows.map((r) => ({
    ide_type: r.ide_type,
    session_id: redactSessionId(r.session_id, owners),
    updated_at: r.updated_at,
    prompts: promptCount(r.conversation),
    project_path: r.project_path,
    repo_name: r.repo_name,
    sync_status: r.sync_status,
  }));
  if (values.json === true) {
    writeJson(io, summaries);
    return EXIT_OK;
  }
  if (summaries.length === 0) {
    io.stdout.write("No sessions stored.\n");
    return EXIT_OK;
  }
  const header = ["UPDATED", "SOURCE", "SESSION", "PROMPTS", "PROJECT"];
  const body = summaries.map((s) => [s.updated_at, s.ide_type, s.session_id, s.prompts === null ? "?" : String(s.prompts), s.project_path ?? "-"]);
  io.stdout.write(`${table([header, ...body])}\n`);
  return EXIT_OK;
}

function show(io: CliIo, values: Values, dbPath: string, args: readonly string[]): Promise<number> {
  if (args.length !== 2) throw new UsageError("show takes <source> <session-id>");
  const source = parseSource(args[0]!);
  const sessionId = args[1]!;
  return withExistingStore(dbPath, (store) => {
    const owners = readHomeOwners(store);
    const row = store.getConversation(source, sessionId) ?? findByRedactedId(store, source, sessionId, owners);
    if (row === null) throw new Error(`no ${source} session ${sessionId} in ${dbPath}`);
    const record = exportRecord(row, new Set(), owners);
    const shown = values.raw === true ? record : toConversation(record);
    io.stdout.write(`${values.json === true ? JSON.stringify(shown) : JSON.stringify(shown, null, 2)}\n`);
    return EXIT_OK;
  });
}

/** The one row of `source` whose redacted id is `sessionId`, or null; two matches is an error. */
function findByRedactedId(store: SessionStore, source: IdeType, sessionId: string, owners: readonly string[]) {
  const ids = (store.raw().prepare("SELECT session_id FROM conversations WHERE ide_type = ?").all(source) as Array<{ session_id: string }>)
    .map((r) => r.session_id)
    .filter((id) => redactSessionId(id, owners) === sessionId);
  if (ids.length > 1) throw new Error(`${ids.length} ${source} sessions share the redacted id ${sessionId}; pass the stored id`);
  return ids.length === 1 ? store.getConversation(source, ids[0]!) : null;
}

async function exportCommand(io: CliIo, values: Values, dbPath: string): Promise<number> {
  const formats = capabilities().formats;
  const format = values.format ?? formats[0]!;
  if (!(formats as readonly string[]).includes(format)) {
    throw new UsageError(`unknown export format: ${format}; formats are ${formats.join(", ")}`);
  }
  const ideType = parseOneSource(values.sources, "export");
  if (values.out !== undefined && values.out.length === 0) throw new UsageError("--out needs a file path");
  if (values["include-sync-state"] === true && values.raw !== true) {
    throw new UsageError("--include-sync-state applies only with --raw: a Conversation has no sync state");
  }
  if (values.split !== undefined) return exportSplit(values, dbPath, ideType, io);
  if (values.force === true) throw new UsageError("--force applies only with --split");
  const out = values.out === undefined ? undefined : resolve(values.out);
  return withExistingStore(dbPath, async (store) => {
    try {
      const { written } = await exportSessions(store, {
        format: format as ExportFormat,
        shape: values.raw === true ? "row" : "conversation",
        out: out ?? io.stdout,
        includeSyncState: values["include-sync-state"] === true,
        ...(ideType === undefined ? {} : { filter: { ideType } }),
      });
      if (out !== undefined) io.stderr.write(`Wrote ${written} session(s) to ${out}\n`);
    } catch (err) {
      // A reader that closed stdout early (`| head`) has everything it asked for.
      if ((err as NodeJS.ErrnoException).code === "EPIPE") return EXIT_OK;
      throw err;
    }
    return EXIT_OK;
  });
}

/** `export --split`: one Conversation per file under a folder. */
function exportSplit(values: Values, dbPath: string, ideType: IdeType | undefined, io: CliIo): Promise<number> {
  for (const option of ["out", "format", "raw"] as const) {
    if (values[option] !== undefined) throw new UsageError(`--split writes one Conversation per file; it does not take --${option}`);
  }
  if (values.split!.length === 0) throw new UsageError("--split needs a folder path");
  const dir = resolve(values.split!);
  return withExistingStore(dbPath, async (store) => {
    const { written } = await exportSessions(store, {
      split: dir,
      force: values.force === true,
      ...(ideType === undefined ? {} : { filter: { ideType } }),
    });
    io.stderr.write(`Wrote ${written} session(s) to ${dir}\n`);
    return EXIT_OK;
  });
}

function capabilitiesCommand(io: CliIo, values: Values): number {
  const caps = capabilities();
  if (values.json === true) {
    writeJson(io, caps);
    return EXIT_OK;
  }
  io.stdout.write(
    `Package version: ${caps.packageVersion}\nStore schema version: ${caps.schemaVersion}\n` +
      `Platforms: ${caps.platforms.join(", ")}\nExport formats: ${caps.formats.join(", ")}\n` +
      `Sources, in scan order, with extractor code versions:\n` +
      `${table(caps.sources.map((s) => [s, String(caps.extractorCodeVersion[s])]))}\n`,
  );
  return EXIT_OK;
}

async function reset(io: CliIo, values: Values, dbPath: string): Promise<number> {
  if (values.all === true && values.dedup === true) throw new UsageError("reset takes --all or --dedup, not both");
  const dedup = values.dedup === true;
  const sources = parseSources(values.sources);
  if (sources !== undefined && !dedup) throw new UsageError("--sources applies only to reset --dedup");
  if (!storeExists(dbPath)) {
    io.stdout.write(`No store at ${dbPath}; nothing to reset.\n`);
    return EXIT_OK;
  }
  if (values.yes !== true && io.stdin.isTTY !== true) {
    throw new UsageError("refusing to prompt on a non-interactive input; pass --yes");
  }
  const scope = dedup ? (sources ?? capabilities().sources) : undefined;
  const question = dedup
    ? `Clear the change tracking of ${scope!.join(", ")} in ${dbPath}, so the next scan re-reads every file? [y/N] `
    : `Delete every stored session and the plan-tier cache in ${dbPath}? [y/N] `;
  // Opened before asking, so a file that is not a store is refused without a prompt.
  return withExistingStore(dbPath, async (store) => {
    if (values.yes !== true && !(await confirm(io, question))) {
      io.stderr.write("Aborted; nothing changed.\n");
      return EXIT_FAILURE;
    }
    if (dedup) {
      store.resetFileDedupTracking([...scope!]);
      io.stdout.write(`Cleared the change tracking of ${scope!.join(", ")}; the next scan re-reads every file.\n`);
    } else {
      // Counted as status counts; the sub-agent, plugin and hook runs go too.
      const total = primarySessions(store)["total"];
      store.clearAll();
      io.stdout.write(`Deleted ${total} session(s), with their sub-agent, plugin and hook runs, from ${dbPath}.\n`);
    }
    return EXIT_OK;
  });
}

/** Asks on stderr and reads one line of stdin; anything but y or yes, or end of input, is no. */
function confirm(io: CliIo, question: string): Promise<boolean> {
  io.stderr.write(question);
  const rl = createInterface({ input: io.stdin, terminal: false });
  return new Promise((resolveAnswer) => {
    let answered = false;
    rl.once("line", (line) => {
      answered = true;
      rl.close();
      resolveAnswer(/^\s*y(es)?\s*$/i.test(line));
    });
    rl.once("close", () => {
      if (!answered) resolveAnswer(false);
    });
  });
}
