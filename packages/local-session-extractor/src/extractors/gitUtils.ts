// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { join, dirname, posix } from "node:path";
import { findPRUrlInText, parsePRUrl } from "./prUrlParser";
import { validateBranch } from "./cursorAttributionSignals";
import { logger } from "../seams/logger";
import { homeDir, homeRootOverride } from "./pathResolver";

// Trunk branch names: a session that starts on trunk and checks out a feature
// branch is attributed to the feature branch.
const TRUNK_BRANCH_NAMES = new Set(["master", "main", "develop", "dev", "release", "staging"]);

/**
 * The single branch to attribute a session to, from the distinct branches it
 * was seen on, in order: the last non-trunk branch, else the last branch, else
 * undefined when none was seen. Shared by every extractor that reports one.
 */
export function resolveSessionBranch(seen: string[]): string | undefined {
  if (seen.length === 0) return undefined;
  for (let i = seen.length - 1; i >= 0; i--) {
    if (!TRUNK_BRANCH_NAMES.has(seen[i]!)) return seen[i];
  }
  return seen[seen.length - 1];
}

/**
 * The folders to look for a `.git` in, from startPath up. A folder inside the home
 * folder stops below it: home or a folder above it (a dotfiles repo at ~/.git) is
 * never the repo of a project in home, and the walk reads nothing outside home.
 * Home itself looks in itself only (it may be its own repo, never one above it),
 * and a path outside home walks up to /. Both paths are normalized first, so a
 * `<home>/../x` is outside home rather than a folder below it.
 */
function repoRootCandidates(startPath: string): string[] {
  const start = posix.normalize(startPath);
  // normalize turns an empty path into ".", which names no folder.
  const segments = start.split("/").filter((s) => s !== "" && s !== ".");
  const home = posix.normalize(homeDir()).replace(/\/+$/, "");
  const homeDepth = home.split("/").filter(Boolean).length;
  const trimmed = start.replace(/\/+$/, "");
  const floor = trimmed === home ? homeDepth : trimmed.startsWith(home + "/") ? homeDepth + 1 : 1;
  const out: string[] = [];
  for (let depth = segments.length; depth >= floor; depth--) out.push("/" + segments.slice(0, depth).join("/"));
  return out;
}

/**
 * Walks up the directory tree from startPath looking for a .git directory or file.
 * For git worktrees, .git is a file containing "gitdir: <path>". This function
 * detects worktrees and resolves to the actual parent repo root.
 * Returns the repo root path if found, or undefined.
 */
export function findGitRoot(startPath: string): string | undefined {
  for (const candidate of repoRootCandidates(startPath)) {
    const dotGit = join(candidate, ".git");
    try {
      if (!existsSync(dotGit)) continue;

      // .git is a directory → this is a normal repo root
      const stat = statSync(dotGit);
      if (stat.isDirectory()) return candidate;

      // .git is a file → this is a git worktree.
      // The file contains "gitdir: /path/to/parent/.git/worktrees/<name>".
      // Resolve to the actual parent repo root.
      const parentRoot = resolveWorktreeParent(dotGit);
      if (parentRoot) return parentRoot;

      // Couldn't resolve worktree parent — treat as a normal root
      return candidate;
    } catch {
      // existsSync/statSync can throw on permission errors — skip
    }
  }
  return undefined;
}

/**
 * The nearest ancestor of startPath containing a `.git` entry, resolved through
 * symlinks — a filesystem stand-in for `git rev-parse --show-toplevel` when the
 * git binary is unavailable. Unlike findGitRoot it does NOT resolve a worktree
 * to its parent: a worktree's own root is returned (its `.git` is a file), so
 * callers that special-case worktrees behave identically with or without git.
 * Returns undefined when no `.git` is found.
 */
function findGitToplevel(startPath: string): string | undefined {
  for (const candidate of repoRootCandidates(startPath)) {
    try {
      if (!existsSync(join(candidate, ".git"))) continue;
      try {
        return realpathSync(candidate);
      } catch (err) {
        // realpath can fail on a broken symlink — fall back to the lexical path
        logger.warn("extraction.git_utils", "toplevel_realpath_failed", {
          candidate,
          error: err instanceof Error ? err.message : String(err),
        });
        return candidate;
      }
    } catch (err) {
      // existsSync can throw on permission errors — log and keep walking up
      logger.warn("extraction.git_utils", "toplevel_walk_error", {
        candidate,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return undefined;
}

/**
 * Reads a worktree .git file and resolves to the parent repo root.
 * Worktree .git files contain: "gitdir: /path/to/repo/.git/worktrees/<name>"
 * The parent repo root is two levels up from the worktrees dir.
 */
function resolveWorktreeParent(dotGitFile: string): string | undefined {
  try {
    const content = readFileSync(dotGitFile, "utf-8").trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) return undefined;

    const gitdir = match[1]!.trim();
    // gitdir is like: /path/to/repo/.git/worktrees/<name>
    // Parent repo root is dirname(dirname(dirname(gitdir))) = /path/to/repo
    if (gitdir.includes("/worktrees/")) {
      const repoGitDir = gitdir.slice(0, gitdir.indexOf("/worktrees/"));
      const repoRoot = dirname(repoGitDir);
      if (existsSync(join(repoRoot, ".git"))) return repoRoot;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the git remote "origin" URL from a repo's .git/config file.
 * Returns the raw URL string, or undefined if it can't be read.
 */
function readGitRemoteOrigin(gitRoot: string): string | undefined {
  const configPath = join(gitRoot, ".git", "config");
  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch {
    return undefined;
  }
  return parseGitConfigRemoteUrl(content);
}

/**
 * Parses a .git/config file content and extracts the [remote "origin"] url.
 * Exported for testing.
 */
export function parseGitConfigRemoteUrl(configContent: string): string | undefined {
  const lines = configContent.split("\n");
  let inOriginSection = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith("[")) {
      inOriginSection = line === '[remote "origin"]';
      continue;
    }

    if (inOriginSection && line.startsWith("url")) {
      const eqIdx = line.indexOf("=");
      if (eqIdx !== -1) {
        return line.slice(eqIdx + 1).trim();
      }
    }
  }

  return undefined;
}

/**
 * Extracts "org/repo" from a git remote URL.
 *
 * Supported formats:
 *   git@github.com:example-org/example-repo.git       → example-org/example-repo
 *   https://github.com/example-org/example-repo.git   → example-org/example-repo
 *   ssh://git@github.com/example-org/example-repo.git → example-org/example-repo
 *   https://github.com/example-org/example-repo       → example-org/example-repo
 */
export function parseRepoName(remoteUrl: string): string | undefined {
  if (!remoteUrl) return undefined;

  let path: string | undefined;

  // SSH colon format: git@github.com:org/repo.git
  const sshColonMatch = remoteUrl.match(/^[^@]+@[^:]+:(.+)$/);
  if (sshColonMatch) {
    path = sshColonMatch[1];
  }

  // URL format: https://... or ssh://...
  if (!path) {
    try {
      const url = new URL(remoteUrl);
      path = url.pathname.replace(/^\//, "");
    } catch {
      // Not a valid URL and not SSH colon format
      return undefined;
    }
  }

  if (!path) return undefined;

  // Strip trailing .git
  path = path.replace(/\.git$/, "");

  // Expect at least "org/repo"
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return undefined;

  // Take the last two segments (handles enterprise GitHub with extra path prefix)
  return segments.slice(-2).join("/");
}

/**
 * canonicalRepoKey reduces a repo path to the cross-source comparison key:
 * the last two path segments, lowercased. A PR/MR repo from a parsed URL may
 * carry a full GitLab subgroup path (group/sub/proj) while parseRepoName yields
 * the git-remote last-2 (sub/proj); reducing both sides lets them compare equal.
 * Returns undefined when there are fewer than two segments.
 */
export function canonicalRepoKey(repo: string | undefined): string | undefined {
  if (!repo) return undefined;
  const segments = repo.split("/").filter(Boolean);
  if (segments.length < 2) return undefined;
  return segments.slice(-2).join("/").toLowerCase();
}

export interface ResolvedProject {
  projectPath: string;
  repoName: string | undefined;
}

/**
 * Central resolution logic for all extractors:
 *   1. Try findGitRoot(rawPath) — works when the path is inside a git repo
 *   2. If no git root found, infer from file paths referenced in the conversation
 *   3. Resolve repo_name (org/repo) from the git remote origin
 *
 * @param rawPath   - The raw project path from the IDE (cwd, workspace URI, etc.)
 * @param filePaths - Absolute file paths referenced in the conversation (tool_use, file URIs, etc.)
 */
export function resolveProjectAndRepo(
  rawPath: string | undefined,
  filePaths: string[] = []
): ResolvedProject | undefined {
  if (!rawPath && filePaths.length === 0) return undefined;

  // Try direct git root from the raw path
  if (rawPath) {
    const gitRoot = findGitRoot(rawPath);
    if (gitRoot) {
      return { projectPath: gitRoot, repoName: repoNameFromRoot(gitRoot) };
    }
  }

  // Fallback: infer from file paths referenced in the conversation
  if (filePaths.length > 0) {
    const inferred = inferRepoFromFilePaths(filePaths);
    if (inferred) return inferred;
  }

  // No git root found at all — return raw path without repo_name
  if (rawPath) {
    return { projectPath: rawPath, repoName: undefined };
  }

  return undefined;
}

function repoNameFromRoot(gitRoot: string): string | undefined {
  const remoteUrl = readGitRemoteOrigin(gitRoot);
  return remoteUrl ? parseRepoName(remoteUrl) : undefined;
}

/**
 * Given a list of absolute file paths, infers the git root and project path
 * by finding the most frequently referenced repo.
 */
function inferRepoFromFilePaths(
  filePaths: string[]
): ResolvedProject | undefined {
  const rootCounts = new Map<string, number>();
  for (const fp of filePaths) {
    const root = findGitRoot(fp);
    if (root) {
      rootCounts.set(root, (rootCounts.get(root) ?? 0) + 1);
    }
  }

  if (rootCounts.size === 0) return undefined;

  // Pick the git root with the most file references
  let bestRoot = "";
  let bestCount = 0;
  for (const [root, count] of rootCounts) {
    if (count > bestCount) {
      bestRoot = root;
      bestCount = count;
    }
  }

  return { projectPath: bestRoot, repoName: repoNameFromRoot(bestRoot) };
}

// ── Git diff utilities ────────────────────────────────────────────────────────

export interface GitDiffStats {
  linesAdded: number;
  linesRemoved: number;
  filesModified: number;
  /** Number of commits that fell within the session window. */
  gitCommits: number;
}

const EMPTY_DIFF: GitDiffStats = { linesAdded: 0, linesRemoved: 0, filesModified: 0, gitCommits: 0 };

const GIT_TIMEOUT_MS = 5000;

// How many reflog entries the windowed-branch walk reads. Generous for one session's
// window while keeping stdout bounded.
const REFLOG_SCAN_LIMIT = 2000;

/**
 * True when a scan has a home root. That tree is untrusted, and git executes
 * what a repository names in its config and attributes (fsmonitor, hooks,
 * filter drivers), which `-c` flags cannot fully disable. So under a home root
 * no git process runs: every lookup below returns its empty or unknown result.
 */
function gitDisabled(): boolean {
  return homeRootOverride() !== undefined;
}

/**
 * On every git call, what a repository's own config would otherwise make git run or
 * write: its fsmonitor (`core.fsmonitor`), the index `git diff` writes back after a
 * stat-only change (which also runs the `post-index-change` hook), the other optional
 * index writes, and the `gpg.program` that `log.showSignature` runs per signed commit.
 * A filter driver the repository's `.gitattributes` names (`filter.<name>.clean` or
 * `.process`) still runs when `git diff` reads a changed working-tree file: no flag
 * turns that off.
 */
const GIT_GUARD_ARGS = [
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "-c", "diff.autoRefreshIndex=false",
  "-c", "log.showSignature=false",
];

/** On a diff: no external diff command and no textconv filter. */
const DIFF_GUARD_ARGS = ["--no-ext-diff", "--no-textconv"];

/**
 * The three `GIT_*` variables kept: they only choose which config files git reads, as
 * HOME does, and the isolation harnesses (tests, examples, the app's acceptance test)
 * use them to keep git off the machine's own config. The same list as harness-discovery's.
 */
const KEPT_GIT_VARS = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]);

/**
 * This process's environment without its other `GIT_*` variables, which could point git
 * at another repository (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`) or name a command
 * (`GIT_EXTERNAL_DIFF`, `GIT_CONFIG_PARAMETERS`), and with no credential prompt.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") || KEPT_GIT_VARS.has(key)) env[key] = value;
  }
  env["GIT_TERMINAL_PROMPT"] = "0";
  return env;
}

function runGit(args: string[], cwd: string, timeout = GIT_TIMEOUT_MS): string {
  if (gitDisabled()) throw new Error("git is not run under a home root");
  return execFileSync("git", [...GIT_GUARD_ARGS, ...args], {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "ignore"],
    // Node defaults stdout to 1 MiB and throws ENOBUFS past it. A long-lived
    // clone's reflog clears that on its own, and the throw is indistinguishable
    // from "this clone has no reflog" at the call site.
    maxBuffer: 10 * 1024 * 1024,
  });
}

export interface NumstatEntry {
  added: number;
  removed: number;
  file: string;
}

/**
 * Parses `git diff --numstat` output into structured entries.
 * Binary files produce "-\t-\tfile" — added/removed are set to 0 but the file
 * is still counted toward filesModified.
 * Exported for unit testing.
 */
export function parseNumstat(output: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const [addedStr, removedStr, file] = parts as [string, string, string];
    if (addedStr === "-" || removedStr === "-") {
      entries.push({ added: 0, removed: 0, file });
      continue;
    }
    const added = parseInt(addedStr, 10);
    const removed = parseInt(removedStr, 10);
    if (!isNaN(added) && !isNaN(removed)) {
      entries.push({ added, removed, file });
    }
  }
  return entries;
}

function getCommittedDiffStats(
  gitRoot: string,
  startMs: number,
  endMs: number
): { stats: GitDiffStats; files: Set<string> } {
  const files = new Set<string>();
  let linesAdded = 0;
  let linesRemoved = 0;
  let commitCount: number;

  try {
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();

    // Find commits in the session window (newest-first).
    // Cap at 100 commits to bound the number of subsequent git diff calls, which
    // block the event loop; active repos with very long session windows would otherwise
    // trigger O(N) blocking execFileSync calls.
    const logOutput = runGit(
      ["log", "--format=%H", "--max-count=100", `--after=${startIso}`, `--until=${endIso}`],
      gitRoot
    ).trim();
    if (!logOutput) return { stats: EMPTY_DIFF, files };

    const commits = logOutput.split("\n").map((c) => c.trim()).filter(Boolean);
    commitCount = commits.length;

    // Diff each commit against its own parent so that only changes made during
    // this session window are counted, regardless of how long ago the previous
    // pre-session commit was.  A range diff (base..lastCommit) would capture
    // every commit since the last pre-session baseline — which can be hours of
    // unrelated commits if there was a long gap between sessions.
    //
    // diff-tree -r --root handles both regular commits (diffs against parent) and
    // the initial commit (diffs against the empty tree) without requiring separate
    // parent resolution — avoids the fragile empty-tree-SHA approach.
    for (const commit of commits) {
      const numstat = runGit(["diff-tree", ...DIFF_GUARD_ARGS, "-r", "--numstat", "--root", commit], gitRoot);
      for (const entry of parseNumstat(numstat)) {
        linesAdded += entry.added;
        linesRemoved += entry.removed;
        files.add(entry.file);
      }
    }
  } catch {
    return { stats: EMPTY_DIFF, files: new Set() };
  }

  return { stats: { linesAdded, linesRemoved, filesModified: files.size, gitCommits: commitCount }, files };
}

/**
 * The working tree's diff against HEAD, limited to files last modified inside
 * `[windowStart, windowEnd]` (either bound optional): a dirty file edited outside
 * the session's window is not that session's work. A file that no longer exists
 * (a deletion) has no modification time and is counted.
 */
function getUncommittedDiffStats(
  gitRoot: string,
  windowStart: number | undefined,
  windowEnd: number,
): { stats: GitDiffStats; files: Set<string> } {
  const files = new Set<string>();
  let linesAdded = 0;
  let linesRemoved = 0;

  try {
    const numstat = runGit(["diff", ...DIFF_GUARD_ARGS, "HEAD", "--numstat"], gitRoot);
    for (const entry of parseNumstat(numstat)) {
      let mtimeMs: number | undefined;
      try {
        mtimeMs = statSync(join(gitRoot, entry.file)).mtimeMs;
      } catch {
        mtimeMs = undefined;
      }
      if (mtimeMs !== undefined && (mtimeMs > windowEnd || (windowStart !== undefined && mtimeMs < windowStart))) continue;
      linesAdded += entry.added;
      linesRemoved += entry.removed;
      files.add(entry.file);
    }
  } catch {
    return { stats: EMPTY_DIFF, files: new Set() };
  }

  return { stats: { linesAdded, linesRemoved, filesModified: files.size, gitCommits: 0 }, files };
}

/**
 * Computes combined git diff stats (committed + uncommitted) for a session window.
 *
 * Walks up from `startPath` to find the git root, then:
 *   1. If `startMs` is provided: diffs all commits between startMs and endMs.
 *   2. Always: diffs the current dirty working tree against HEAD, counting only
 *      files last modified inside the same buffered window (no lower bound when
 *      `startMs` is undefined).
 *   3. Merges file sets (dedup) and sums line counts.
 *
 * Returns all-zeros on any error (git not found, not a repo, permission denied, etc.).
 *
 * @param startPath - Any path inside the target git repo
 * @param startMs   - Session start time (unix ms). Pass `undefined` to skip committed diff.
 * @param endMs     - Session end time (unix ms)
 */
export function getFullSessionDiffStats(
  startPath: string,
  startMs: number | undefined,
  endMs: number
): GitDiffStats {
  if (gitDisabled()) return EMPTY_DIFF;
  try {
    // The session's own checkout: a linked worktree has its own HEAD and working tree.
    const gitRoot = findGitToplevel(startPath);
    if (!gitRoot) return EMPTY_DIFF;

    let committedFiles = new Set<string>();
    let committedStats: GitDiffStats = EMPTY_DIFF;
    // Buffer the window: 60 s before start (catches commits just before the session),
    // 120 s after end (covers the typical "ask → code → commit" flow without risking
    // overlap with back-to-back sessions).
    const windowStart = startMs === undefined ? undefined : startMs - 60_000;
    const windowEnd = endMs + 120_000;

    if (windowStart !== undefined) {
      const committed = getCommittedDiffStats(gitRoot, windowStart, windowEnd);
      committedFiles = committed.files;
      committedStats = committed.stats;
    }

    const { files: uncommittedFiles, stats: uncommittedStats } = getUncommittedDiffStats(gitRoot, windowStart, windowEnd);

    const allFiles = new Set([...committedFiles, ...uncommittedFiles]);
    return {
      linesAdded: committedStats.linesAdded + uncommittedStats.linesAdded,
      linesRemoved: committedStats.linesRemoved + uncommittedStats.linesRemoved,
      filesModified: allFiles.size,
      gitCommits: committedStats.gitCommits,
    };
  } catch {
    return EMPTY_DIFF;
  }
}

/**
 * Recovers every branch the session actually ran on, from the HEAD reflog bounded
 * to the session's own window.
 *
 * It is used instead of reading `HEAD` at extraction time. A live read answers
 * "what is checked out now", which on a session extracted hours later is
 * whatever the developer moved on to — and a matcher cannot tell that from the
 * branch the work happened on. The reflog can, because each entry carries when
 * it happened.
 *
 * Two properties matter. It is time-bound by construction, so it cannot drift
 * onto a later branch. And it is idempotent: re-extraction yields the same
 * answer, so one wrong branch cannot stack into two.
 *
 * The window's bounds are the session's own — first message to DECLARED last
 * message. Deliberately not the wider bounds the extractors use elsewhere
 * (`lookupEnd`, or the +120s slack the PR scan adds): either would admit a checkout
 * made after the last message but before the scan, which is precisely the drift
 * this removes, surviving inside a bound that merely looks time-bounded.
 *
 * Limits, and they bound what this can promise: the reflog is per-clone, is never
 * shared, and expires per `gc.reflogExpire` (90 days for reachable entries). So it
 * is reliable going forward, and for already-stored sessions it recovers only those
 * still inside that window on the machine that extracted them.
 *
 * Emits nothing when the reflog yields nothing — a fresh clone, a worktree with no
 * checkouts, or an expired reflog must produce absence, never an ambient guess.
 */
export function recoverWindowedBranches(
  startPath: string,
  sessionStartMs: number,
  sessionEndMs: number,
): string[] {
  if (!Number.isFinite(sessionStartMs) || !Number.isFinite(sessionEndMs)) return [];
  if (gitDisabled()) return [];
  try {
    if (!findGitRoot(startPath)) return [];
    // Run from the session's OWN path, not from findGitRoot's result: that resolves a
    // linked worktree to its parent repo, and a worktree keeps its own HEAD reflog
    // under .git/worktrees/<name>. Reading the parent's would answer for a checkout
    // the session never touched. Git resolves the right context from any directory
    // inside the worktree, so the raw path is the correct cwd here.
    const cwd = statSync(startPath, { throwIfNoEntry: false })?.isDirectory()
      ? startPath
      : dirname(startPath);
    // --date=iso-strict renders %gd as the entry's OWN event time. It must not be
    // %cI, which is the committer date of the commit the entry points at: checking
    // out an existing branch writes an entry now while pointing at a commit
    // authored arbitrarily long ago, so windowing on %cI would discard exactly the
    // checkout entries this walk depends on.
    //
    // Bounded because the output is read into memory: a long-lived clone's reflog
    // can exceed the child-process buffer, and that failure is silent. A session
    // whose opening checkout sits further back than this yields nothing rather than
    // a wrong branch, which is the direction to fail in.
    const out = runGit(
      [
        "reflog",
        "show",
        "-n",
        String(REFLOG_SCAN_LIMIT),
        // Filter in git, not here: the entry cap counts every commit, rebase, pull
        // and reset too, so an unfiltered scan spends the cap on entries this walk
        // discards and reaches back a shorter distance than the cap implies.
        "--grep-reflog=^checkout: moving from",
        "--date=iso-strict",
        "--format=%gd|%gs",
      ],
      cwd,
    );
    const entries = parseCheckoutReflog(out);
    if (entries.length === 0) return [];

    const names: string[] = [];
    const add = (n: string | null): void => {
      if (n && !names.includes(n)) names.push(n);
    };
    // `git checkout <sha>` writes "moving from feat/x to <40-hex>", and the reverse
    // move writes the SHA as moved_from — verified against real git. validateBranch
    // rejects the literal HEAD (which is what a bare `--detach` writes) but not a hex
    // id, so the id would otherwise enter the branch set as a name no candidate can
    // ever match. Checked HERE rather than inside validateBranch because a bare SHA is
    // an artifact of this source: widening the shared rule would also change how a
    // command's or prose's branch token is read.
    const admissible = (n: string): string | null =>
      /^[0-9a-f]{7,40}$/i.test(n) ? null : validateBranch(n);

    // Every branch in effect at any point during the session, not just the last: a
    // session that moved feat/a → feat/b worked on both, and the branch set is
    // repeated precisely so both can be recorded.
    const inWindow = entries.filter((e) => e.atMs >= sessionStartMs && e.atMs <= sessionEndMs);
    for (const e of inWindow) add(admissible(e.movedTo));

    // The branch already in effect when the session began — the common case, since a
    // session that switched nothing has no in-window entry at all yet plainly ran
    // somewhere. validateBranch applies here too: a developer who detached before
    // the session leaves "moving from feat/x to HEAD", and admitting it would inject
    // the literal HEAD this walk exists to exclude.
    // The NEWEST pre-session entry, judged after it is chosen — not the newest
    // that happens to be admissible. Conjoining the two would walk PAST an
    // inadmissible branch-in-effect (a trunk, or a detached HEAD) and return an
    // arbitrarily older branch as one the session ran on, which is unbounded in
    // time and so defeats the windowing this walk exists to provide.
    const before = entries.find((e) => e.atMs < sessionStartMs);
    const beforeName = before ? admissible(before.movedTo) : null;
    if (beforeName) {
      add(beforeName);
    } else if (inWindow.length > 0) {
      // When that entry has expired, the OLDEST in-window checkout still names what
      // it moved OFF, which is the branch the session started on. Without it a
      // session that began on the work branch and switched to a trunk mid-window
      // reports only the trunk.
      add(admissible(inWindow[inWindow.length - 1]!.movedFrom));
    }
    return names;
  } catch (err) {
    // An empty return is also the legitimate "nothing to recover" answer, so a
    // swallowed failure here is indistinguishable from it — and an
    // empty branch set is what makes a stored branch match unreproducible and
    // therefore withdrawable. The path is omitted deliberately: a host may ship these
    // logs off the machine, and the error message is what separates a timeout or an ENOBUFS
    // from a clone that genuinely has no reflog.
    logger.warn("extraction.git_utils", "reflog_walk_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** One `checkout:` reflog entry, newest-first as git emits them. */
interface CheckoutEntry {
  movedFrom: string;
  movedTo: string;
  atMs: number;
}

/**
 * Parses `git reflog show --date=iso-strict --format=%gd|%gs` into checkout entries,
 * preserving git's newest-first order.
 *
 * The timestamp comes out of the selector — `HEAD@{2026-08-06T14:03:11+09:00}` —
 * and is compared as an instant, not as a wall-clock string, so an entry written
 * under a different UTC offset still lands on the right side of a window edge.
 */
export function parseCheckoutReflog(raw: string): CheckoutEntry[] {
  const out: CheckoutEntry[] = [];
  for (const line of raw.split("\n")) {
    const sep = line.indexOf("|");
    if (sep < 0) continue;
    const selector = line.slice(0, sep);
    const subject = line.slice(sep + 1);
    const at = selector.match(/@\{([^}]+)\}/);
    if (!at) continue;
    const atMs = Date.parse(at[1]!);
    if (Number.isNaN(atMs)) continue;
    // "checkout: moving from <x> to <y>". A bare `--detach` writes "... to HEAD";
    // `git checkout <sha>` writes the resolved id. Neither names a branch, and the
    // walk's own `admissible` rejects both — validateBranch alone catches only HEAD.
    const move = subject.match(/^checkout:\s+moving from\s+(\S+)\s+to\s+(\S+)\s*$/);
    if (!move) continue;
    out.push({ movedFrom: move[1]!, movedTo: move[2]!, atMs });
  }
  return out;
}

/**
 * Returns the current HEAD commit SHA for the git repo containing startPath.
 * Returns undefined if the path is not in a git repo or git is unavailable.
 */
export function getGitHeadSha(startPath: string): string | undefined {
  if (gitDisabled()) return undefined;
  try {
    const gitRoot = findGitToplevel(startPath);
    if (!gitRoot) return undefined;
    const sha = runGit(["rev-parse", "HEAD"], gitRoot, 3000).trim();
    return sha.length === 40 ? sha : undefined;
  } catch {
    return undefined;
  }
}

export interface SessionPRLink {
  prUrl: string;
  prNumber: number;
  prRepository: string;
}

/**
 * The PR/MR number a commit message records, across the platforms we ingest.
 *
 * Each vendor writes its own footer, so matching only GitHub's would miss a PR a
 * GitLab or Bitbucket repo records here:
 *   GitHub    `Merge pull request #123`, `Fixes #123`, `(#123)`
 *   GitLab    `See merge request group/project!123`
 *   Bitbucket `Merged in feature/x (pull request #123)`
 *
 * `!123` is matched only after `merge request`, never bare — a bare `!` is too
 * common in prose to spend a full-confidence reference on.
 *
 * Takes ONE commit block (`%s%n%b`), because the two kinds of reference live in
 * different places and only splitting them tells a real merge from prose:
 *   - A **merge subject** — GitHub's `Merge pull request #N`, Bitbucket's
 *     `Merged in x (pull request #N)`, GitHub's squash `(#N)` suffix — is matched
 *     only against the FIRST line. A body sentence that opens with "Merge pull
 *     request #123 broke…" or wraps a citation in `(pull request #123)` is prose
 *     and must not count.
 *   - A **trailer** — `Closes/Fixes/Resolves #N`, GitLab's `See merge request !N`
 *     — legitimately lives in the body, so it is matched against the whole block,
 *     but only WITH its lead-in keyword; a bare `#N` or `!N` is prose.
 */
export function findPRNumberInCommitText(commitBlock: string): number | undefined {
  const toN = (raw: string | undefined): number | undefined => {
    if (!raw) return undefined;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) || n <= 0 ? undefined : n;
  };
  const subject = commitBlock.trimStart().split("\n", 1)[0] ?? "";
  const subj = subject.match(
    /^merge pull request\s+#(\d+)|^merged in\s+\S+\s+\(pull request\s+#(\d+)\)|\(#(\d+)\)\s*$/i,
  );
  if (subj) {
    const n = toN(subj[1] ?? subj[2] ?? subj[3]);
    if (n !== undefined) return n;
  }
  const trailer = commitBlock.match(
    /(?:closes|fixes|resolves)\s+#(\d+)|(?:see|closes)\s+merge request\s+\S*!(\d+)/i,
  );
  if (trailer) return toN(trailer[1] ?? trailer[2]);
  return undefined;
}

/**
 * Builds the PR/MR link for a number recovered from a commit message, using the
 * checkout's own remote to decide the host and the URL shape.
 *
 * A bare number names no host, which is why this takes the remote rather than
 * assuming one: hardcoding `github.com` fabricated a wrong-host link for every
 * GitLab and Bitbucket org, and a fabricated URL is worse than no URL because it
 * resolves to a real page belonging to someone else.
 *
 * The result is round-tripped through `parsePRUrl` — the same parser that reads a
 * literal URL out of a commit — and dropped if it does not parse. That is what
 * keeps the two paths from disagreeing about `prRepository` (GitLab subgroups
 * preserved, Bitbucket Server reduced to `KEY/NAME`), and it means a remote shape
 * this function guesses wrong yields nothing instead of a plausible fiction.
 */
export function prLinkFromCommitRef(remoteUrl: string, prNumber: number): SessionPRLink | null {
  const hostPath = remoteHostAndPath(remoteUrl);
  if (!hostPath) return null;
  const { host, path } = hostPath;

  let url: string;
  if (/(?:^|\.)gitlab\./i.test(host)) {
    url = `https://${host}/${path}/-/merge_requests/${prNumber}`;
  } else if (/(?:^|\.)bitbucket\.org$/i.test(host)) {
    url = `https://${host}/${path}/pull-requests/${prNumber}`;
  } else if (path.startsWith("scm/")) {
    // Bitbucket Server clones from /scm/<KEY>/<NAME>, but browses at
    // /projects/<KEY>/repos/<NAME> — the only vendor whose clone path and web
    // path differ, so a naive substitution would 404.
    const parts = path.slice("scm/".length).split("/").filter(Boolean);
    if (parts.length < 2) return null;
    url = `https://${host}/projects/${parts[0]}/repos/${parts.slice(1).join("/")}/pull-requests/${prNumber}`;
  } else {
    // GitHub and GitHub Enterprise, and the default for an unrecognised host.
    //
    // The limit worth knowing: a self-hosted GitLab or Bitbucket on a host that
    // does not say so (`git.corp.example.com`) lands here and gets the GitHub
    // shape, and the round-trip below cannot catch it because a `/pull/N` URL
    // parses cleanly. The host is the only platform signal this package holds;
    // a consumer that knows the repo's platform can rebuild the URL.
    url = `https://${host}/${path}/pull/${prNumber}`;
  }

  const parsed = parsePRUrl(url);
  if (!parsed || parsed.pr_number !== prNumber) return null;
  return { prUrl: parsed.pr_url, prNumber: parsed.pr_number, prRepository: parsed.pr_repository };
}

/**
 * Splits a git remote into its host and repo path, keeping every path segment.
 *
 * Distinct from `parseRepoName`, which reduces to the last two segments: that
 * loses a GitLab subgroup, and a subgroup is part of the URL a browser needs.
 */
function remoteHostAndPath(remoteUrl: string): { host: string; path: string } | undefined {
  if (!remoteUrl) return undefined;
  let host: string | undefined;
  let path: string | undefined;

  // Scheme first, scp-colon second. The scp regex also matches `ssh://git@h:7999/p`
  // — it captures the PORT as the first path segment, which then reads as an extra
  // namespace level and fails the two-segment check. Anything carrying `://` is a
  // URL and must be parsed as one.
  const sshColon = remoteUrl.includes("://") ? null : remoteUrl.match(/^[^@]+@([^:]+):(.+)$/);
  if (sshColon) {
    host = sshColon[1];
    path = sshColon[2];
  } else {
    try {
      const u = new URL(remoteUrl);
      // hostname, not host: an ssh:// remote carries the SSH port (Bitbucket
      // Server's 7999), and carrying it into an https:// browse URL points at a
      // port that serves no web UI. A web remote's own port is lost with it,
      // which is the lesser error — a nonstandard-port self-hosted install over
      // HTTPS is rarer than SSH cloning, and this path only ever builds a
      // display URL whose (repo, number) is what attribution actually compares.
      host = u.protocol === "ssh:" ? u.hostname : u.host;
      path = u.pathname.replace(/^\//, "");
    } catch {
      return undefined;
    }
  }
  if (!host || !path) return undefined;
  path = path.replace(/\.git$/, "");
  const segments = path.split("/").filter(Boolean);
  if (segments.length < 2) return undefined;
  return { host, path: segments.join("/") };
}

/**
 * Scans git commit messages in the session window for PR references.
 * Returns the first match, or null if none found.
 *
 * Checks in order:
 *   1. Direct PR/MR URL in commit body — GitHub, GitLab, or Bitbucket (via
 *      findPRUrlInText), e.g. from `gh pr create` / `glab mr create` output
 *   2. "(#NNN)" pattern in commit subject
 *   3. "Closes/Fixes/Resolves/Merge pull request #NNN" patterns
 *
 * Uses the same time window as getFullSessionDiffStats (start-60s to end+120s),
 * and returns null when the session start is unknown.
 */
export function getSessionPRLink(
  startPath: string,
  startMs: number | undefined,
  endMs: number,
  // urlOnly skips the `#NNN` commit-message fallback (Priority 2): a bare `Fixes
  // #123` is an *issue* reference as often as a PR, so a caller that must not
  // mistake an issue for a PR (a direct PR reference, full confidence) passes true.
  //
  // The fallback is retained rather than removed because commit-message
  // conventions are how some orgs record the PR at all — for those the reference
  // exists nowhere else. What it must NOT do is guess a host: see
  // prLinkFromCommitRef, which derives the URL from the checkout's own remote and
  // validates it, so a GitLab or Bitbucket org gets its own shape rather than a
  // fabricated github.com link.
  opts?: { urlOnly?: boolean }
): SessionPRLink | null {
  if (gitDisabled()) return null;
  // No session start means no window: the last commits could name any earlier PR.
  if (startMs === undefined || !Number.isFinite(startMs)) return null;
  try {
    // Commits are read in the session's own checkout; the remote lives in the main repo's config.
    const gitRoot = findGitToplevel(startPath);
    const repoRoot = findGitRoot(startPath);
    if (!gitRoot || !repoRoot) return null;

    const startIso = new Date(startMs - 60_000).toISOString();
    const endIso = new Date(endMs + 120_000).toISOString();

    const args = [
      "log",
      "--format=%s%n%b%n---END---",
      `--until=${endIso}`,
      `--after=${startIso}`,
      "--max-count=20",
    ];

    let output: string;
    try {
      output = runGit(args, gitRoot);
    } catch {
      return null;
    }

    // Priority 1: a PR/MR URL in the commit messages (highest confidence — from
    // `gh pr create` / `glab mr create` / Bitbucket output). Scan per-commit
    // (newest first) so a stale URL in an older commit body cannot pre-empt the
    // URL from the session's actual PR commit.
    const fromUrl = output
      .split("---END---")
      .map(block => findPRUrlInText(block))
      .find(r => r !== null) ?? null;
    if (fromUrl) {
      return { prUrl: fromUrl.pr_url, prNumber: fromUrl.pr_number, prRepository: fromUrl.pr_repository };
    }

    // Priority 2: #NNN reference in commit messages (skipped for url-only callers —
    // a bare #NNN can be an issue, not a PR).
    if (opts?.urlOnly) return null;
    // Per-block newest-first, like the URL scan above: findPRNumberInCommitText
    // anchors a merge subject to a block's first line, so it must see one commit
    // at a time — and a newer commit's reference must win over an older one's.
    const prNumber = output
      .split("---END---")
      .map((block) => findPRNumberInCommitText(block))
      .find((n) => n !== undefined);
    if (prNumber !== undefined) {
      const remoteUrl = readGitRemoteOrigin(repoRoot);
      // No remote means no host, and a number alone cannot name a PR. Returning
      // null is the honest answer.
      if (remoteUrl) return prLinkFromCommitRef(remoteUrl, prNumber);
    }

    return null;
  } catch {
    return null;
  }
}
