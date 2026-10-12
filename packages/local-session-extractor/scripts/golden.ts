// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Golden capture: runs today's extractors over both committed fixture corpora and
 * returns every `conversations` row, the parity baseline at
 * `fixtures/golden.jsonl`. `scripts/capture-golden.ts` writes it;
 * `src/__tests__/goldenParity.test.ts` compares against it by plain equality.
 *
 * Three things make the output the same on every machine:
 *
 *  1. Both corpora are copied to a temp tree and every copied file's mtime and
 *     atime are pinned to PINNED_TIME before any extractor stats it, so
 *     `last_mtime_ms` does not depend on checkout time. The committed files are
 *     never touched.
 *  2. The caller points HOME at an empty temp dir, and every path override is
 *     set to a guaranteed-absent path unless a corpus fixture stands in for
 *     it. The rows therefore never carry this machine's installs, MCP servers or
 *     plan tier.
 *  3. Sources are staged into trees shaped like the vendor layout the extractor
 *     walks, with Codex rollouts keyed by a UUID derived from their corpus path,
 *     so two fixtures sharing a vendor thread id do not overwrite each other.
 *
 * The same stagers write the HOME-shaped trees of `stageHomes` (the `stage`
 * script), which differ only in where each input lands, so a scan of a staged
 * home reads exactly the golden's inputs.
 *
 * The wall-clock columns `created_at`, `updated_at`, `synced_at` and
 * `last_reextract_at` are excluded; JSON-string columns are parsed so a reviewer
 * diffs structure, not escaped strings. Rows are ordered by (ide_type, session_id).
 */
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { rowRecord } from "../src/export";
import { toConversation } from "../src/sessionIntelligence";
import {
  getAntigravityDbPath,
  getClaudeCodeProjectsPath,
  getCodexHomePath,
  getCodexSqlitePath,
  getCopilotCLISessionStatePath,
  getCopilotVSCodeGlobalDbPath,
  getCopilotVSCodeUserDataPath,
  getCopilotVSCodeWorkspaceStoragePath,
  getCoworkAgentModeSessionsPath,
  getCursorDbPath,
  getCursorProjectsPath,
  getKiroIdeSessionsPath,
  homeDir,
  setPathOverrides,
  type PathKey,
} from "../src/extractors/pathResolver";
import { runInScanScope } from "../src/seams/scanScope";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
export const GOLDEN_PATH = join(PACKAGE_ROOT, "fixtures", "golden.jsonl");
/** The same sessions as Session Intelligence Conversations, one per golden row, in its order. */
export const GOLDEN_CONVERSATION_PATH = join(PACKAGE_ROOT, "fixtures", "golden-conversation.jsonl");

/** The two corpora every stager copies from; staging never writes into them. */
const CORPORA = {
  extraction: join(PACKAGE_ROOT, "fixtures", "extraction"),
  turnTelemetry: join(PACKAGE_ROOT, "fixtures", "turn-telemetry"),
} as const;

/**
 * The Codex rollout ids in the golden are derived from each rollout's path under
 * these fixed prefixes, not from where the corpora sit on disk, so the ids stay
 * the same wherever the repository is checked out.
 */
const CORPUS_KEY_PREFIX = {
  extraction: "fixtures/extraction",
  turnTelemetry: "fixtures/turn-telemetry",
} as const;

/** One fixed instant for every staged file's mtime and atime. */
const PINNED_TIME = new Date("2026-01-01T00:00:00Z");

/**
 * Wall-clock bookkeeping a parity comparison must ignore, and `last_message_ms`, which is derived
 * from the conversation and `last_mtime_ms` the golden holds (its rule is pinned by
 * `src/store/__tests__/sessionSummaries.test.ts`).
 */
export const EXCLUDED_COLUMNS: ReadonlySet<string> = new Set(["created_at", "updated_at", "synced_at", "last_reextract_at", "last_message_ms"]);

/**
 * Every path override the resolver takes, except the home root (the caller
 * isolates HOME) and Codex's two roots (set per Codex pass).
 */
const PATH_KEYS: readonly PathKey[] = [
  "CLAUDE_CODE_PROJECTS_PATH", "CLAUDE_CODE_CONFIG_PATH", "COWORK_AGENT_MODE_SESSIONS_PATH",
  "COWORK_CLAUDE_CODE_SESSIONS_PATH", "CURSOR_DB_PATH", "CURSOR_LOGS_PATH", "CURSOR_CLI_CHATS_PATH",
  "CURSOR_AGENT_LOGS_PATH", "CURSOR_PROJECTS_PATH", "CURSOR_CLI_CONFIG_PATH", "CURSOR_STATSIG_CACHE_PATH",
  "ANTIGRAVITY_DB_PATH", "COPILOT_CLI_PATH", "COPILOT_VSCODE_USER_DATA_PATH", "COPILOT_VSCODE_DB_PATH",
  "COPILOT_VSCODE_WORKSPACE_STORAGE_PATH", "KIRO_DB_PATH", "KIRO_SESSIONS_PATH", "KIRO_CLI_SESSIONS_PATH",
  "KIRO_IDE_SESSIONS_PATH", "KIRO_CREW_PATH", "KIRO_USER_MCP_PATH", "KIRO_CLI_DB_PATH",
];

// ── Filesystem helpers ────────────────────────────────────────────────────────

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

/** Pin every file and directory under `root` to PINNED_TIME (mtime and atime). */
function pinTree(root: string): number {
  let count = 0;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) visit(p);
      utimesSync(p, PINNED_TIME, PINNED_TIME);
      count++;
    }
    utimesSync(dir, PINNED_TIME, PINNED_TIME);
  };
  visit(root);
  return count;
}

function copyFileInto(src: string, dst: string): void {
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

function corpusKey(corpus: keyof typeof CORPUS_KEY_PREFIX, file: string): string {
  return `${CORPUS_KEY_PREFIX[corpus]}/${relative(CORPORA[corpus], file)}`;
}

/** A stable UUID-shaped id from a corpus-relative path. */
function uuidFromPath(rel: string): string {
  const h = createHash("sha256").update(rel).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The first top-level `timestamp` in a JSONL file, or PINNED_TIME when none parses. */
function firstTimestamp(jsonlPath: string): Date {
  for (const line of readFileSync(jsonlPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const ts = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
      if (typeof ts === "string" && !Number.isNaN(Date.parse(ts))) return new Date(ts);
    } catch {
      // A malformed line is the fixture's business; keep looking.
    }
  }
  return PINNED_TIME;
}

// ── Staging: one vendor-shaped tree per source ────────────────────────────────

/**
 * Where each staged input lands. The golden's temp tree and a staged home run
 * the same stagers over different layouts.
 */
interface StageLayout {
  claudeCodeProjects: string;
  coworkAgentModeSessions: string;
  /** The directory `state_5.sqlite` is written into. */
  codexSqliteHome: string;
  /** The file the SQLite thread row's `rollout_path` names. */
  codexSqliteRollout: string;
  /** The Codex root the directory scan walks, holding `sessions/`. */
  codexHome: string;
  copilotUserData: string;
  copilotDb: string;
  copilotWorkspaceStorage: string;
  copilotCli: string;
  cursorDb: string;
  /** Cursor's `~/.cursor`, where the stop-hook ledgers live. */
  cursorHome: string;
  cursorProjects: string;
  antigravityDb: string;
  kiroIdeSessions: string;
}

/** Claude Code: every extraction-corpus project dir plus one project dir per turn-telemetry case. */
function stageClaudeCode(projects: string): void {
  cpSync(join(CORPORA.extraction, "claude-code"), projects, { recursive: true });
  const ccCases = join(CORPORA.turnTelemetry, "claude-code");
  for (const entry of readdirSync(ccCases, { withFileTypes: true })) {
    // cowork is a separate audit store, staged by stageCowork.
    if (!entry.isDirectory() || entry.name === "cowork") continue;
    cpSync(join(ccCases, entry.name), join(projects, `project_${entry.name.replace(/-/g, "_")}`), { recursive: true });
  }
}

/** Cowork: the audit file at the vendor's real nesting `<base>/<uuid>/<uuid>/local_<uuid>/audit.jsonl`. */
function stageCowork(base: string): void {
  const sessionDir = join(
    base,
    "99ad6f49-53b3-4efc-a915-fc7c4dd26497",
    "939c46a0-ac16-4357-bb66-4c8da3a06328",
    "local_7b095ce9-92e5-68d8-93f5-fe909bc08363",
  );
  copyFileInto(join(CORPORA.turnTelemetry, "claude-code", "cowork", "audit.jsonl"), join(sessionDir, "audit.jsonl"));
}

/**
 * Codex, SQLite mode: the committed `state_5.sqlite` (rollout_path null for
 * portability) copied and pointed at a copy of the corpus rollout, as
 * codexExtractor.test does.
 */
function stageCodexSqlite(dir: string, rollout: string): void {
  const dst = join(dir, "state_5.sqlite");
  copyFileInto(join(CORPORA.extraction, "codex", "state_5.sqlite"), dst);
  copyFileInto(join(CORPORA.extraction, "codex", "rollout-fixture.jsonl"), rollout);
  const sqlite = new DatabaseSync(dst);
  const { changes } = sqlite.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(rollout, "thread-fixture-001");
  sqlite.close();
  if (changes !== 1) throw new Error(`state_5.sqlite has no thread-fixture-001 row (updated ${changes}); the Codex SQLite row would silently drop`);
}

/**
 * Codex, directory-scan mode: every rollout in both corpora but the SQLite one, laid out as
 * `sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`. The UUID comes from the corpus
 * path (the extractor keys the row on it), the timestamp from the file's first record.
 */
function stageCodexHome(home: string): void {
  const rollouts: Array<{ src: string; rel: string }> = [];
  for (const f of walkFiles(join(CORPORA.extraction, "codex"))) {
    if (f.endsWith(".jsonl") && basename(f) !== "rollout-fixture.jsonl") rollouts.push({ src: f, rel: corpusKey("extraction", f) });
  }
  for (const f of walkFiles(join(CORPORA.turnTelemetry, "codex"))) {
    if (basename(f).startsWith("rollout-") && f.endsWith(".jsonl")) rollouts.push({ src: f, rel: corpusKey("turnTelemetry", f) });
  }
  for (const { src, rel } of rollouts) {
    const iso = firstTimestamp(src).toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
    const day = join(home, "sessions", iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10));
    const stamp = `${iso.slice(0, 10)}T${iso.slice(11, 13)}-${iso.slice(14, 16)}-${iso.slice(17, 19)}`;
    copyFileInto(src, join(day, `rollout-${stamp}-${uuidFromPath(rel)}.jsonl`));
  }
}

/** Copilot: the VS Code state db and workspace storage plus the CLI session-state dir. */
function stageCopilot(layout: StageLayout): void {
  mkdirSync(layout.copilotUserData, { recursive: true });
  copyFileInto(join(CORPORA.extraction, "copilot", "vscode_state.vscdb"), layout.copilotDb);
  cpSync(join(CORPORA.extraction, "copilot", "workspaceStorage"), layout.copilotWorkspaceStorage, { recursive: true });
  cpSync(join(CORPORA.extraction, "copilot", "cli-sessions"), layout.copilotCli, { recursive: true });
}

/**
 * Cursor: the IDE state db from the extraction corpus; the turn-telemetry stop-hook
 * ledgers and agent transcripts placed where the vendor writes them. The
 * transcripts yield no row today (the Cursor row is built only from the IDE store,
 * see fixtures/turn-telemetry/README.md), so they are staged for fidelity, not rows.
 */
function stageCursor(layout: StageLayout): void {
  copyFileInto(join(CORPORA.extraction, "cursor", "state_happy.vscdb"), layout.cursorDb);
  const ledgerDir = join(layout.cursorHome, "token-events-raw");
  mkdirSync(ledgerDir, { recursive: true });
  const cursorCases = join(CORPORA.turnTelemetry, "cursor");
  const stop: string[] = [];
  const subagentStop: string[] = [];
  const transcripts = join(layout.cursorProjects, "Users-user-src-example-repo", "agent-transcripts");
  for (const entry of readdirSync(cursorCases, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const caseDir = join(cursorCases, entry.name);
    for (const f of readdirSync(caseDir, { withFileTypes: true })) {
      const p = join(caseDir, f.name);
      if (f.name === "stop.jsonl") stop.push(readFileSync(p, "utf8"));
      else if (f.name === "subagentStop.jsonl") subagentStop.push(readFileSync(p, "utf8"));
      else if (f.isDirectory()) cpSync(p, join(transcripts, f.name), { recursive: true });
    }
  }
  writeFileSync(join(ledgerDir, "stop.jsonl"), stop.join(""));
  writeFileSync(join(ledgerDir, "subagentStop.jsonl"), subagentStop.join(""));
}

function stageAntigravity(db: string): void {
  copyFileInto(join(CORPORA.extraction, "antigravity", "state.vscdb"), db);
}

/** Kiro IDE: one workspace dir per case holding its `sess_*` dir, as the Kiro payload test builds it. */
function stageKiro(sessionsRoot: string): void {
  const kiroCases = join(CORPORA.turnTelemetry, "kiro");
  for (const entry of readdirSync(kiroCases, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const caseDir = join(kiroCases, entry.name);
    const sess = readdirSync(caseDir).find((n) => n.startsWith("sess_"));
    if (!sess) throw new Error(`no sess_ dir in ${caseDir}`);
    cpSync(join(caseDir, sess), join(sessionsRoot, `ws_${entry.name.replace(/-/g, "_")}`, sess), { recursive: true });
  }
}

function stageAll(layout: StageLayout): void {
  stageClaudeCode(layout.claudeCodeProjects);
  stageCowork(layout.coworkAgentModeSessions);
  stageCodexSqlite(layout.codexSqliteHome, layout.codexSqliteRollout);
  stageCodexHome(layout.codexHome);
  stageCopilot(layout);
  stageCursor(layout);
  stageAntigravity(layout.antigravityDb);
  stageKiro(layout.kiroIdeSessions);
}

/**
 * Every Kiro row must carry the session.json `createdAt`, never the file's birth
 * time (kiroIdeExtractor falls back to `birthtimeMs` when the field is absent), or
 * the golden would differ per checkout.
 */
function assertKiroCreatedFromSession(rows: Record<string, unknown>[]): void {
  const declared = new Set<number>();
  for (const f of walkFiles(join(CORPORA.turnTelemetry, "kiro"))) {
    if (basename(f) !== "session.json") continue;
    const createdAt = (JSON.parse(readFileSync(f, "utf8")) as { createdAt?: string }).createdAt;
    if (createdAt) declared.add(Date.parse(createdAt));
  }
  for (const r of rows) {
    if (r["ide_type"] !== "kiro") continue;
    const ms = r["conversation_source_created_at_ms"];
    if (typeof ms !== "number" || !declared.has(ms)) {
      throw new Error(
        `kiro row ${String(r["session_id"])} has conversation_source_created_at_ms=${String(ms)}, ` +
          "not a session.json createdAt — a fixture is missing its explicit created timestamp",
      );
    }
  }
}

export interface GoldenCapture {
  /** One JSON line per row, in golden order. */
  lines: string[];
  /** What each extractor call returned, for the capture log. */
  counts: Record<string, number>;
}

/** Where `stageGolden` put the inputs the path overrides do not already point at. */
export interface GoldenStage {
  /** The temp tree holding the staged corpora; `cleanup` removes it. */
  tmp: string;
  /** Codex SQLite mode: `CODEX_SQLITE_HOME` for the first Codex pass. */
  codexSqliteHome: string;
  /** Codex directory-scan mode: `CODEX_HOME` for the second Codex pass. */
  codexHome: string;
  /** A guaranteed-absent directory, for the Codex location a pass must not find. */
  absent: string;
  cleanup(): void;
}

/**
 * Stages both corpora into a temp tree and points every process-wide path
 * override at them, or at a guaranteed-absent path, so a scan reads exactly the
 * golden's inputs. Codex's two roots are left to each pass, because the
 * extractor runs SQLite mode or directory mode per call, never both.
 */
export function stageGolden(home: string): GoldenStage {
  const tmp = mkdtempSync(join(tmpdir(), "local-session-extractor-golden-"));
  const absent = join(tmp, "absent");
  setPathOverrides(Object.fromEntries(PATH_KEYS.map((k) => [k, join(absent, k.toLowerCase())])));

  const layout: StageLayout = {
    claudeCodeProjects: join(tmp, "claude-code-projects"),
    coworkAgentModeSessions: join(tmp, "cowork-agent-mode-sessions"),
    codexSqliteHome: join(tmp, "codex-sqlite"),
    codexSqliteRollout: join(tmp, "codex-sqlite-rollout", "rollout-fixture.jsonl"),
    codexHome: join(tmp, "codex-home"),
    copilotUserData: join(tmp, "copilot-vscode-user-data"),
    copilotDb: join(tmp, "copilot", "vscode_state.vscdb"),
    copilotWorkspaceStorage: join(tmp, "copilot", "workspaceStorage"),
    copilotCli: join(tmp, "copilot", "cli-sessions"),
    cursorDb: join(tmp, "cursor", "state_happy.vscdb"),
    cursorHome: join(home, ".cursor"),
    cursorProjects: join(tmp, "cursor-projects"),
    antigravityDb: join(tmp, "antigravity", "state.vscdb"),
    kiroIdeSessions: join(tmp, "kiro-ide-sessions"),
  };
  stageAll(layout);
  pinTree(tmp);
  setPathOverrides({
    CLAUDE_CODE_PROJECTS_PATH: layout.claudeCodeProjects,
    COWORK_AGENT_MODE_SESSIONS_PATH: layout.coworkAgentModeSessions,
    COPILOT_VSCODE_USER_DATA_PATH: layout.copilotUserData,
    COPILOT_VSCODE_DB_PATH: layout.copilotDb,
    COPILOT_VSCODE_WORKSPACE_STORAGE_PATH: layout.copilotWorkspaceStorage,
    COPILOT_CLI_PATH: layout.copilotCli,
    CURSOR_DB_PATH: layout.cursorDb,
    CURSOR_PROJECTS_PATH: layout.cursorProjects,
    ANTIGRAVITY_DB_PATH: layout.antigravityDb,
    KIRO_IDE_SESSIONS_PATH: layout.kiroIdeSessions,
  });

  return {
    tmp,
    codexSqliteHome: layout.codexSqliteHome,
    codexHome: layout.codexHome,
    absent,
    cleanup() {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

/** The two HOME-shaped trees `stageHomes` writes. */
export interface StagedHomes {
  /** Every source's inputs, with Codex in directory-scan layout only. */
  home: string;
  /** Only Codex, in SQLite layout: `.codex/state_5.sqlite` naming a rollout outside `.codex`. */
  codexSqliteHome: string;
}

/** Calls `fn` with every default location resolving under `home`, as a scan with that home root does. */
function underHome<T>(home: string, fn: () => T): T {
  return runInScanScope(
    {
      source: "claude-code",
      logger: undefined,
      metrics: undefined,
      home,
      paths: new Map(),
      errors: [],
      unknownRecordKinds: new Map(),
      sourceFailed: false,
      loggedOnce: new Set(),
    },
    fn,
  );
}

/**
 * Writes `<out>/home` and `<out>/codex-sqlite-home`, placing each golden input
 * where the package's own getters resolve it for a scan with that home root, on
 * this platform. Two homes because the Codex extractor runs SQLite mode or
 * directory mode per call: a scan of `home`, then a Codex-only scan of
 * `codex-sqlite-home`, reads exactly the golden's inputs. The SQLite row names
 * its rollout by absolute path, so the trees are not relocatable. `out` must be
 * missing or empty.
 */
export function stageHomes(out: string): StagedHomes {
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`refusing to stage into ${out}: it is not empty`);
  const home = join(out, "home");
  const codexSqliteHome = join(out, "codex-sqlite-home");
  const sqlite = underHome(codexSqliteHome, () => ({
    codexSqliteHome: dirname(getCodexSqlitePath()),
    codexSqliteRollout: join(codexSqliteHome, "rollouts", "rollout-fixture.jsonl"),
  }));
  const layout: StageLayout = underHome(home, () => ({
    claudeCodeProjects: getClaudeCodeProjectsPath(),
    coworkAgentModeSessions: getCoworkAgentModeSessionsPath(),
    ...sqlite,
    codexHome: getCodexHomePath(),
    copilotUserData: getCopilotVSCodeUserDataPath("Code"),
    copilotDb: getCopilotVSCodeGlobalDbPath("Code"),
    copilotWorkspaceStorage: getCopilotVSCodeWorkspaceStoragePath("Code"),
    copilotCli: getCopilotCLISessionStatePath(),
    cursorDb: getCursorDbPath(),
    cursorHome: join(homeDir(), ".cursor"),
    cursorProjects: getCursorProjectsPath(),
    antigravityDb: getAntigravityDbPath(),
    kiroIdeSessions: getKiroIdeSessionsPath(),
  }));
  mkdirSync(out, { recursive: true });
  stageAll(layout);
  pinTree(out);
  return { home, codexSqliteHome };
}

/** Golden order and columns for a set of store rows, parsed from their JSON strings. */
export function goldenLines(rows: Record<string, unknown>[]): string[] {
  const cmp = (x: unknown, y: unknown): number => (String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0);
  const sorted = [...rows].sort((a, b) => cmp(a["ide_type"], b["ide_type"]) || cmp(a["session_id"], b["session_id"]));
  return sorted.map((r) => JSON.stringify(rowRecord(r, EXCLUDED_COLUMNS, true)));
}

/**
 * Stages both corpora, runs every extractor into a fresh SessionStore, and
 * returns the rows as golden lines. The caller must have pointed HOME at an
 * empty directory with `isolateHome` first.
 */
export async function captureGolden(home: string): Promise<GoldenCapture> {
  const stage = stageGolden(home);
  try {
    const { SessionStore } = await import("../src/store/SessionStore");
    const { extractAntigravity, extractClaudeCode, extractCodex, extractCopilot, extractCursor, extractKiro } =
      await import("../src/internal");
    const store = new SessionStore(join(stage.tmp, "golden.db"));
    const counts: Record<string, number> = {};
    try {
      counts["claude-code"] = extractClaudeCode(store);
      counts["cursor"] = await extractCursor(store);
      counts["copilot"] = extractCopilot(store);
      counts["antigravity"] = await extractAntigravity(store);
      // SQLite mode first (state_5.sqlite present), then the directory-scan fallback
      // (no state db under CODEX_HOME): the extractor runs one or the other per call.
      setPathOverrides({ CODEX_HOME: join(stage.absent, "codex-home"), CODEX_SQLITE_HOME: stage.codexSqliteHome });
      counts["codex (sqlite)"] = await extractCodex(store);
      setPathOverrides({ CODEX_HOME: stage.codexHome, CODEX_SQLITE_HOME: join(stage.absent, "codex-sqlite-home") });
      counts["codex (directory)"] = await extractCodex(store);
      counts["kiro"] = extractKiro(store);
      const rows = store.raw().prepare("SELECT * FROM conversations").all() as Record<string, unknown>[];
      assertKiroCreatedFromSession(rows);
      return { lines: goldenLines(rows), counts };
    } finally {
      store.close();
    }
  } finally {
    stage.cleanup();
  }
}

/** Points HOME at an empty temp directory; call before the first scan. */
export function isolateHome(): string {
  const home = mkdtempSync(join(tmpdir(), "local-session-extractor-golden-home-"));
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  return home;
}

/**
 * Golden rows as Conversations. A row the golden holds has no `created_at`, so a
 * session with no prompt time and no source time gets no `conversationStartedAt`
 * here, while an export gives it the store's wall-clock `created_at`.
 */
export function conversationLines(goldenRowLines: readonly string[]): string[] {
  return goldenRowLines.map((l) => JSON.stringify(toConversation(JSON.parse(l) as Record<string, unknown>)));
}

/** Writes a capture to the committed goldens: the rows, and the rows as Conversations. */
export function writeGolden(capture: GoldenCapture): void {
  mkdirSync(dirname(GOLDEN_PATH), { recursive: true });
  writeFileSync(GOLDEN_PATH, capture.lines.map((l) => `${l}\n`).join(""));
  writeFileSync(GOLDEN_CONVERSATION_PATH, conversationLines(capture.lines).map((l) => `${l}\n`).join(""));
}

export function readGolden(): string[] {
  return readFileSync(GOLDEN_PATH, "utf8").split("\n").filter((l) => l.length > 0);
}

export function readConversationGolden(): string[] {
  return readFileSync(GOLDEN_CONVERSATION_PATH, "utf8").split("\n").filter((l) => l.length > 0);
}

/**
 * Exported Conversations in the conversation golden's terms: sorted as it is
 * sorted here, and without the wall-clock `conversationStartedAt` where the golden
 * has none. Returns both sides, ready for a row-by-row comparison.
 */
export function comparableConversations(exported: readonly Record<string, unknown>[]): { got: Record<string, unknown>[]; want: Record<string, unknown>[] } {
  const key = (c: Record<string, unknown>): string => `${String(c["ideType"])}\u0000${String(c["sessionId"])}`;
  const byKey = (a: Record<string, unknown>, b: Record<string, unknown>): number => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  const want = readConversationGolden().map((l) => JSON.parse(l) as Record<string, unknown>).sort(byKey);
  const got = exported.map((c) => ({ ...c })).sort(byKey);
  got.forEach((c, i) => {
    if (want[i] !== undefined && !("conversationStartedAt" in want[i]!)) delete c["conversationStartedAt"];
  });
  return { got, want };
}
