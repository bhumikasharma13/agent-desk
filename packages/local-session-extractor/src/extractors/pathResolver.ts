// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { platform, homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { currentScanScope } from "../seams/scanContext";

/**
 * The vendor locations a caller may point elsewhere. The getters below return
 * an override when one is set, and otherwise resolve under the home root: every
 * default below, and every extractor-local read of the home directory, resolves
 * under it, so moving the root moves every read. One default lives outside the
 * home: Cursor's agent logs (`getCursorAgentLogsPath`), under the system temp
 * directory unless a home root is set. The only environment the getters read is
 * Codex's own `CODEX_HOME` and `CODEX_SQLITE_HOME` (and `HOME` / the temp
 * directory through the OS), and only when neither their key nor the home root
 * is overridden.
 */
export const PATH_KEYS = [
  "ANTIGRAVITY_DB_PATH",
  "CLAUDE_CODE_CONFIG_PATH",
  "CLAUDE_CODE_PROJECTS_PATH",
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "COPILOT_CLI_PATH",
  "COPILOT_VSCODE_DB_PATH",
  "COPILOT_VSCODE_USER_DATA_PATH",
  "COPILOT_VSCODE_WORKSPACE_STORAGE_PATH",
  "COWORK_AGENT_MODE_SESSIONS_PATH",
  "COWORK_CLAUDE_CODE_SESSIONS_PATH",
  "CURSOR_AGENT_LOGS_PATH",
  "CURSOR_CLI_CHATS_PATH",
  "CURSOR_CLI_CONFIG_PATH",
  "CURSOR_DB_PATH",
  "CURSOR_LOGS_PATH",
  "CURSOR_PROJECTS_PATH",
  "CURSOR_STATSIG_CACHE_PATH",
  "KIRO_CLI_DB_PATH",
  "KIRO_CLI_SESSIONS_PATH",
  "KIRO_CREW_PATH",
  "KIRO_DB_PATH",
  "KIRO_IDE_SESSIONS_PATH",
  "KIRO_SESSIONS_PATH",
  "KIRO_USER_MCP_PATH",
] as const;

export type PathKey = (typeof PATH_KEYS)[number];

/**
 * The key the process-wide home root is kept under. Not a `PathKey`: a caller
 * sets a home root as `ScanOptions.home`.
 */
const HOME_KEY = "HOME";

type OverrideKey = PathKey | typeof HOME_KEY;

const PATH_KEY_SET: ReadonlySet<string> = new Set(PATH_KEYS);

/** Thrown when a path override names a location this build does not resolve. */
export class UnknownPathKeyError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`unknown path key: ${key}; this build resolves ${PATH_KEYS.join(", ")}`);
    this.key = key;
    this.name = "UnknownPathKeyError";
  }
}

/** Throws {@link UnknownPathKeyError} unless `key` is a `PathKey`. */
export function assertPathKey(key: string): asserts key is PathKey {
  if (!PATH_KEY_SET.has(key)) throw new UnknownPathKeyError(key);
}

const overrides = new Map<OverrideKey, string>();

/**
 * Sets or clears path overrides. A key mapped to `undefined` or `""` is
 * cleared; keys not named are left as they are. Throws
 * {@link UnknownPathKeyError} for a key that is not a `PathKey`, before
 * changing anything.
 */
export function setPathOverrides(next: Partial<Record<PathKey, string | undefined>>): void {
  const entries = Object.entries(next) as [string, string | undefined][];
  for (const [key] of entries) assertPathKey(key);
  for (const [key, value] of entries as [PathKey, string | undefined][]) {
    if (value === undefined || value.length === 0) overrides.delete(key);
    else overrides.set(key, value);
  }
}

/** Sets the process-wide home root, or clears it with `undefined`. Internal: callers use `ScanOptions.home`. */
export function setHomeOverride(root: string | undefined): void {
  if (root === undefined || root.length === 0) overrides.delete(HOME_KEY);
  else overrides.set(HOME_KEY, root);
}

/** Clears every path override. */
export function resetPathOverrides(): void {
  overrides.clear();
}

/**
 * A scan's own override for the key, then the process-wide one. A scan with a
 * home root shadows the process-wide overrides: the scan reads under its root
 * and its own `paths`, never a location the host set for other scans.
 */
function override(key: PathKey): string | undefined {
  const scope = currentScanScope();
  const own = scope?.paths.get(key);
  if (own !== undefined) return own;
  if (scope?.home !== undefined) return undefined;
  return overrides.get(key);
}

/** The overridden home root, the scan's or else the process-wide one, or undefined when neither is set. */
export function homeRootOverride(): string | undefined {
  return currentScanScope()?.home ?? overrides.get(HOME_KEY);
}

/** The home root every default path resolves under. */
export function homeDir(): string {
  return homeRootOverride() ?? homedir();
}

/** The location a caller redirected this key to, or undefined. */
export function getPathOverride(key: PathKey): string | undefined {
  return override(key);
}

/** Whether a caller has redirected this location. */
export function hasPathOverride(key: PathKey): boolean {
  return override(key) !== undefined;
}

export function getClaudeCodeProjectsPath(): string {
  return override("CLAUDE_CODE_PROJECTS_PATH") ?? join(homeDir(), ".claude", "projects");
}

/**
 * Returns the path to Claude Code's root config file (~/.claude.json).
 * Note: this lives at the HOME root, NOT inside ~/.claude/. It holds the
 * authoritative `oauthAccount` record (seat tier, org type, etc.).
 */
export function getClaudeCodeConfigPath(): string {
  return override("CLAUDE_CODE_CONFIG_PATH") ?? join(homeDir(), ".claude.json");
}

/** Returns the path to Claude Code's session-meta directory. */
export function getClaudeCodeSessionMetaPath(): string {
  return join(homeDir(), ".claude", "usage-data", "session-meta");
}

/** Returns the path to Claude Code's facets directory. */
export function getClaudeCodeFacetsPath(): string {
  return join(homeDir(), ".claude", "usage-data", "facets");
}

// ── Cowork (the Claude app's agent-mode audit stores) ────────────────
// Cowork writes a per-run `audit.jsonl` (Claude Code transcript shape, but
// snake_case fields + `_audit_timestamp`) nested several levels deep under a
// session tree. The vendor is mid-rename, so BOTH base dir names are live and
// both are globbed. macOS only.

/**
 * Root of Cowork's `local-agent-mode-sessions` store. `audit.jsonl` lives
 * several levels down, e.g. `<uuid>/<uuid>/local_<uuid>/audit.jsonl`.
 */
export function getCoworkAgentModeSessionsPath(): string {
  const redirected = override("COWORK_AGENT_MODE_SESSIONS_PATH");
  if (redirected) return redirected;
  return join(homeDir(), "Library", "Application Support", "Claude", "local-agent-mode-sessions");
}

/**
 * Root of Cowork's `claude-code-sessions` store — the same audit tree under the
 * vendor's newer directory name. Globbed alongside `local-agent-mode-sessions`
 * so the rename never drops a surface.
 */
export function getCoworkClaudeCodeSessionsPath(): string {
  const redirected = override("COWORK_CLAUDE_CODE_SESSIONS_PATH");
  if (redirected) return redirected;
  return join(homeDir(), "Library", "Application Support", "Claude", "claude-code-sessions");
}

export function getCursorWorkspaceStoragePath(): string {
  const home = homeDir();
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "Cursor", "User", "workspaceStorage");
  }
  if (platform() === "win32") {
    return join(home, "AppData", "Roaming", "Cursor", "User", "workspaceStorage");
  }
  return join(home, ".config", "Cursor", "User", "workspaceStorage");
}

export function getCursorDbPath(): string {
  const redirected = override("CURSOR_DB_PATH");
  if (redirected) return redirected;
  const home = homeDir();
  if (platform() === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb"
    );
  }
  if (platform() === "win32") {
    return join(
      home,
      "AppData",
      "Roaming",
      "Cursor",
      "User",
      "globalStorage",
      "state.vscdb"
    );
  }
  // Linux
  return join(
    home,
    ".config",
    "Cursor",
    "User",
    "globalStorage",
    "state.vscdb"
  );
}

// ── Cursor CLI (cursor-agent terminal) + Agent desktop native stores ─────────
// Both live under ~/.cursor regardless of platform (the terminal CLI and the
// Agent window write here, not into the IDE's platform-specific globalStorage).
// The Agent desktop app also dual-writes to state.vscdb composerData, which
// getCursorDbPath() already covers — the projects/ store is a mirror.

/** Path to the terminal CLI's per-session store: ~/.cursor/chats/<wsHash>/<uuid>/. */
export function getCursorCliChatsPath(): string {
  return override("CURSOR_CLI_CHATS_PATH") ?? join(homeDir(), ".cursor", "chats");
}

/**
 * Both roots the terminal CLI has ever written its per-session stores under: the
 * current `chats` and the legacy `cli-chats` (Cursor renamed the dir; reading only
 * `chats` silently drops pre-rename sessions). Identical store.db layout.
 * The rename yields DISJOINT trees — a session lives under one name, never both —
 * which is what keeps the usage/load consumers from double-counting; only the
 * conversation extractor additionally dedups by conversation id. An overridden
 * location names one directory, so only that directory is read.
 */
export function getCursorCliChatsRoots(): string[] {
  const primary = getCursorCliChatsPath();
  if (override("CURSOR_CLI_CHATS_PATH") !== undefined) return [primary];
  return [primary, join(dirname(primary), "cli-chats")];
}

/**
 * Path to the cursor-agent CLI's per-process debug logs: `$TMPDIR/cursor-agent-logs-<uid>/`,
 * holding one `session-<UTC-ts>-<pid>.log` per run with the `cli.hook.executed`
 * events. This is an OS-temp dir (macOS `dirhelper` purges it — see the hook-usage
 * parser), and its `<uid>` suffix is the numeric user id. Unlike the other Cursor
 * paths this is NOT under ~/.cursor. With a home root overridden it resolves
 * directly under that root instead, so a scan of another home never reads this
 * machine's temp dir.
 */
export function getCursorAgentLogsPath(): string {
  const redirected = override("CURSOR_AGENT_LOGS_PATH");
  if (redirected) return redirected;
  const uid = typeof process.getuid === "function" ? process.getuid() : "";
  return join(homeRootOverride() ?? tmpdir(), `cursor-agent-logs-${uid}`);
}

/** Path to the Agent desktop app's per-project store: ~/.cursor/projects/<slug>/. */
export function getCursorProjectsPath(): string {
  return override("CURSOR_PROJECTS_PATH") ?? join(homeDir(), ".cursor", "projects");
}

/** Path to the terminal CLI's config file (auth email, privacy mode): ~/.cursor/cli-config.json. */
export function getCursorCliConfigPath(): string {
  return override("CURSOR_CLI_CONFIG_PATH") ?? join(homeDir(), ".cursor", "cli-config.json");
}

/** Path to the CLI's Statsig cache: ~/.cursor/statsig-cache.json. Carries the
 *  account's team/enterprise fields (`data.user.custom`), which cli-config.json
 *  has no equivalent of, so it is the CLI's own seat-identifying source. */
export function getCursorStatsigCachePath(): string {
  return override("CURSOR_STATSIG_CACHE_PATH") ?? join(homeDir(), ".cursor", "statsig-cache.json");
}

export function getAntigravityDbPath(): string {
  const redirected = override("ANTIGRAVITY_DB_PATH");
  if (redirected) return redirected;
  const home = homeDir();
  // Antigravity runs on macOS only
  if (platform() === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "Antigravity",
      "User",
      "globalStorage",
      "state.vscdb"
    );
  }
  if (platform() === "win32") {
    return join(
      home,
      "AppData",
      "Roaming",
      "Antigravity",
      "User",
      "globalStorage",
      "state.vscdb"
    );
  }
  return join(
    home,
    ".config",
    "Antigravity",
    "User",
    "globalStorage",
    "state.vscdb"
  );
}

export function getAntigravityBrainPath(): string {
  // Antigravity stores brain data at ~/.gemini regardless of platform.
  return join(homeDir(), ".gemini", "antigravity", "brain");
}

export function getAntigravityWorkspaceStoragePath(): string {
  const home = homeDir();
  if (platform() === "darwin") {
    return join(
      home,
      "Library",
      "Application Support",
      "Antigravity",
      "User",
      "workspaceStorage"
    );
  }
  if (platform() === "win32") {
    return join(
      home,
      "AppData",
      "Roaming",
      "Antigravity",
      "User",
      "workspaceStorage"
    );
  }
  return join(
    home,
    ".config",
    "Antigravity",
    "User",
    "workspaceStorage"
  );
}

/**
 * Returns the path to the GitHub Copilot CLI session-state directory.
 * The standalone Copilot CLI persists each session under
 * ~/.copilot/session-state/<session-id>/ with an events.jsonl file.
 */
export function getCopilotCLISessionStatePath(): string {
  return override("COPILOT_CLI_PATH") ?? join(homeDir(), ".copilot", "session-state");
}

/**
 * Returns the VS Code User data root for the given variant (macOS only).
 * variant: "Code" (stable) or "Code - Insiders"
 */
export function getCopilotVSCodeUserDataPath(variant: "Code" | "Code - Insiders" = "Code"): string {
  return override("COPILOT_VSCODE_USER_DATA_PATH") ??
    join(homeDir(), "Library", "Application Support", variant, "User");
}

export function getCopilotVSCodeGlobalDbPath(variant: "Code" | "Code - Insiders" = "Code"): string {
  const redirected = override("COPILOT_VSCODE_DB_PATH");
  if (redirected) return redirected;
  return join(getCopilotVSCodeUserDataPath(variant), "globalStorage", "state.vscdb");
}

export function getCopilotVSCodeWorkspaceStoragePath(variant: "Code" | "Code - Insiders" = "Code"): string {
  return override("COPILOT_VSCODE_WORKSPACE_STORAGE_PATH") ??
    join(getCopilotVSCodeUserDataPath(variant), "workspaceStorage");
}

// ── Codex (CLI / VS Code extension / Desktop App) ───────────────────────────

/**
 * Codex's own environment variable, read only when neither the key nor the home
 * root is overridden: an override is the caller's statement of where to read,
 * and a home-root scan must not reach a Codex tree outside that root.
 */
function codexEnv(key: "CODEX_HOME" | "CODEX_SQLITE_HOME"): string | undefined {
  if (homeRootOverride() !== undefined) return undefined;
  const value = process.env[key];
  return value ? value : undefined;
}

/**
 * Returns the Codex storage root: the `CODEX_HOME` override, else Codex's own
 * `CODEX_HOME` variable, else `~/.codex/` on macOS, Linux, and Windows.
 */
export function getCodexHomePath(): string {
  return override("CODEX_HOME") ?? codexEnv("CODEX_HOME") ?? join(homeDir(), ".codex");
}

/**
 * Returns the path to state_5.sqlite, under the `CODEX_SQLITE_HOME` override,
 * else Codex's own `CODEX_SQLITE_HOME` variable (independent of `CODEX_HOME`),
 * else the Codex root.
 */
export function getCodexSqlitePath(): string {
  const sqliteHome = override("CODEX_SQLITE_HOME") ?? codexEnv("CODEX_SQLITE_HOME");
  if (sqliteHome) return join(sqliteHome, "state_5.sqlite");
  return join(getCodexHomePath(), "state_5.sqlite");
}

/** Returns the path to active session rollout files. */
export function getCodexSessionsPath(): string {
  return join(getCodexHomePath(), "sessions");
}

/** Returns the path to zstd-compressed archived sessions. */
export function getCodexArchivedSessionsPath(): string {
  return join(getCodexHomePath(), "archived_sessions");
}

/** Returns the path to Codex version.json (contains latest_version). */
export function getCodexVersionJsonPath(): string {
  return join(getCodexHomePath(), "version.json");
}

/** Returns the path to Codex config.toml (contains [mcp_servers.*] sections). */
export function getCodexConfigTomlPath(): string {
  return join(getCodexHomePath(), "config.toml");
}

/** Returns the path to ~/.codex/auth.json (auth mode, plan claims, API key). */
export function getCodexAuthJsonPath(): string {
  return join(getCodexHomePath(), "auth.json");
}

// ── Kiro (Desktop App + CLI) ─────────────────────────────────────────────────

export function getKiroGlobalStoragePath(): string {
  const redirected = override("KIRO_DB_PATH");
  if (redirected) return redirected;
  const home = homeDir();
  if (platform() === "darwin")
    return join(home, "Library", "Application Support", "kiro", "User", "globalStorage");
  if (platform() === "win32")
    return join(home, "AppData", "Roaming", "kiro", "User", "globalStorage");
  return join(home, ".config", "kiro", "User", "globalStorage");
}

export function getKiroWorkspaceSessionsPath(): string {
  return (
    override("KIRO_SESSIONS_PATH") ??
    join(getKiroGlobalStoragePath(), "kiro.kiroagent", "workspace-sessions")
  );
}

export function getKiroStateDbPath(): string {
  return join(getKiroGlobalStoragePath(), "state.vscdb");
}

export function getKiroStorageJsonPath(): string {
  return join(getKiroGlobalStoragePath(), "storage.json");
}

export function getKiroCliSessionsPath(): string {
  return (
    override("KIRO_CLI_SESSIONS_PATH") ??
    join(homeDir(), ".kiro", "sessions", "cli")
  );
}

/**
 * Returns the root path for Kiro IDE sessions in the new format.
 * Sessions are stored at ~/.kiro/sessions/<workspace-hash>/sess_<uuid>/
 * with session.json + messages.jsonl per session.
 */
export function getKiroIdeSessionsPath(): string {
  return (
    override("KIRO_IDE_SESSIONS_PATH") ??
    join(homeDir(), ".kiro", "sessions")
  );
}

/**
 * Root of Kiro's crew surface — the autonomous-agent runtime, separate from the
 * IDE and CLI. `<root>/sessions/<surface>_<slot>.jsonl` are its transcripts;
 * `<root>/usage/tokens/<date>.jsonl` is the only place Kiro reports cost.
 */
export function getKiroCrewPath(): string {
  return override("KIRO_CREW_PATH") ?? join(homeDir(), ".kiro", "crew");
}

/**
 * User-level MCP config. Applies to EVERY Kiro session regardless of workspace,
 * so it is unioned with the workspace file rather than being a fallback.
 * Test-overridable so a fixture run never reads the developer's real ~/.kiro.
 */
export function getKiroUserMcpPath(): string {
  return (
    override("KIRO_USER_MCP_PATH") ??
    join(homeDir(), ".kiro", "settings", "mcp.json")
  );
}

export function getKiroCliDbPath(): string {
  const redirected = override("KIRO_CLI_DB_PATH");
  if (redirected) return redirected;
  const home = homeDir();
  if (platform() === "darwin")
    return join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3");
  if (platform() === "linux")
    return join(home, ".local", "share", "kiro-cli", "data.sqlite3");
  return join(home, "AppData", "Roaming", "kiro-cli", "data.sqlite3");
}

// ── Copilot JetBrains global config ─────────────────────────────────────────

/** Returns the path to ~/.config/github-copilot/apps.json (GitHub username + app IDs). */
export function getCopilotJBAppsJsonPath(): string {
  return join(homeDir(), ".config", "github-copilot", "apps.json");
}

/** Returns the path to ~/.config/github-copilot/versions.json (plugin versions per IDE). */
export function getCopilotJBVersionsJsonPath(): string {
  return join(homeDir(), ".config", "github-copilot", "versions.json");
}

/**
 * Returns the path to the per-IDE MCP config file for a JetBrains IDE code.
 * e.g. ~/.config/github-copilot/go/mcp.json
 */
export function getCopilotJBMcpJsonPath(ideCode: string): string {
  return join(homeDir(), ".config", "github-copilot", ideCode, "mcp.json");
}