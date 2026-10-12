// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Codex (OpenAI Codex CLI) asset reader. Mirrors cursor.ts / claudeCode.ts: scan
 * Codex's installed assets and hand each to the session's sink.
 *
 * Sources mirror Codex's on-disk layout:
 *   - user ($HOME/.agents/skills):   skills (SKILL.md dirs) — the cross-tool,
 *     HOME-relative skills standard, NOT under ~/.codex.
 *   - per-project (.codex): agents (*.md, *.toml), rules (*.md, *.mdc, *.rules), hooks (hooks.json);
 *     per-project skills under <repo>/.agents/skills (same cross-tool standard);
 *     plus repo-root AGENTS.md (its own agents_md kind).
 *
 * Codex's hooks.json uses Claude's NESTED matcher-group shape (event -> matcher
 * groups -> `hooks: [{command}]`), NOT Cursor's flat one — so hooks are walked
 * with the shared `walkSettingsHooks` and inventoried one asset per wired hook,
 * file-backed (resolved script) or inline (command string), following the same
 * committed/baseline handling as the Cursor hooks.json path.
 *
 * No plugins (Codex has none) and no command/claude_md kinds.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { realpath } from "node:fs/promises";
import { join, basename, relative, sep } from "node:path";
import {
  parseFrontmatter,
  bestDescription,
  fileNameToDisplayName,
  readBody,
  type FileBody,
  safeReaddir,
  readRootEntries,
  isDirectory,
  isFile,
  parseJson,
  rootGitContext,
  samePath,
  canonicalRoots,
  canonicalDir,
  isGitWorktree,
  baselineContentHash,
  baselineContent,
  resolveScope,
  walkSkillsDir,
  resolveRepoWinners,
  withReadRoots,
  type GitContext,
} from "./scanShared";
import { resolveHookScript, inlineHookSubKey, commandNamesAScript, wiredHookKey } from "./hookResolution";
import { hookInlineAssetName, hookFileAssetName } from "./hookAssetName";
// Reuse the nested-shape walker: Codex's hooks.json has the Claude settings.json shape.
import { walkSettingsHooks } from "./claudeCode";
import { reportProblem } from "./log";
import type { CollectSession } from "./session";
import { allInScope, type CollectOptions } from "./collectOptions";
import type { CollectedAsset, HarnessAssetPayload, HarnessAssetType } from "./types";

export const CODEX_IDE = "codex";
const IDE = CODEX_IDE;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

type CollectorState = CollectSession;

const push = (state: CollectorState, asset: CollectedAsset): Promise<void> =>
  state.push(asset);

interface ProjectContext {
  projectKey: string;
  git: GitContext;
}

async function pushProjectFile(
  state: CollectorState,
  ctx: ProjectContext,
  type: HarnessAssetType,
  name: string,
  filePath: string,
  body: FileBody,
  extra: Partial<HarnessAssetPayload>,
): Promise<void> {
  const { scope, baseline } = await resolveScope(ctx.git, filePath);
  await push(state, {
    ideType: IDE,
    type,
    name,
    scope,
    projectPath: ctx.projectKey,
    filePath,
    contentHash: body.hash,
    payload: {
      source: basename(ctx.projectKey),
      operational_state: "enabled",
      active_in_agents: ["Codex"],
      ...(ctx.git.remoteUrl !== "" ? { repo_remote_url: ctx.git.remoteUrl } : {}),
      ...(baseline !== undefined ? { baseline_content_hash: baseline } : {}),
      ...extra,
    },
  });
}

/** The `hooks` object of a parsed hooks.json, or null when there is none. */
function hooksMapOf(data: unknown): Record<string, unknown> | null {
  const hooks = (data as { hooks?: unknown } | null)?.hooks;
  return hooks !== null && typeof hooks === "object" && !Array.isArray(hooks)
    ? (hooks as Record<string, unknown>)
    : null;
}

/**
 * The `hooks` map of a Codex hooks.json body, or null if absent/unparseable.
 * Codex's shape is `{ "hooks": { <event>: [ ... ] } }` — same top-level `.hooks`
 * key as Claude's settings.json and Cursor's hooks.json. Pure.
 */
export function parseCodexHooksJson(raw: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  return hooksMapOf(data);
}

/**
 * Codex's committed hook commands wrap the repo root in a shell command
 * substitution: `"$(git rev-parse --show-toplevel)"/.codex/hooks/x.sh`.
 * resolveHookScript does NOT run a shell, so the literal `$(…)` never expands —
 * the sole path token resolves to the filesystem root (`/.codex/hooks/x.sh`),
 * fails, and the hook is misfiled as inline (the command string as its body, not
 * the script). Rewrite the wrapper (quoted or not) to the actual repo root so
 * the script resolves file-backed. Trailing args are preserved. Returns the
 * command unchanged when the wrapper is absent. Exported for tests.
 */
export function normalizeGitToplevelHookCommand(command: string, repoRoot: string): string {
  // Replacer function, not a string: a repoRoot containing `$1`/`$&` would be
  // mis-expanded as a replacement pattern; this inserts the path verbatim.
  // When the wrapper was quoted, re-wrap the WHOLE resulting path (root + the
  // trailing `/…` segment) in the same quote so tokenizeCommand keeps a
  // whitespace-containing repoRoot as ONE script token — dropping the quotes
  // would split `/repo root/x.sh` into args and the script would never resolve
  // (misfiled as inline). Bare when unquoted.
  return command.replace(
    /(["'])?\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)(["'])?(\S*)/,
    (_m, open: string | undefined, close: string | undefined, suffix: string) => {
      const path = repoRoot + suffix;
      const quote = open ?? close;
      return quote ? `${quote}${path}${quote}` : path;
    },
  );
}

/**
 * Wired-hook keys ({@link wiredHookKey}) of a committed (default-branch) hooks.json body —
 * membership classifies a live hook's wiring as committed. A null/unparseable body yields
 * the empty set (nothing can prove itself committed).
 */
export function committedCodexHookKeys(baselineBody: string | null): Set<string> {
  const keys = new Set<string>();
  if (baselineBody === null) return keys;
  const map = parseCodexHooksJson(baselineBody);
  if (map === null) return keys;
  for (const { eventType, matcher, command } of walkSettingsHooks(map)) {
    keys.add(wiredHookKey(eventType, matcher, command));
  }
  return keys;
}

/**
 * Inventory hooks from a repo's `.codex/hooks.json`. Commands resolve and
 * scope-check against the scanned directory (a hook script may live anywhere in
 * it); a command resolving to an in-scope script is file-backed, anything else
 * inline. An inline hook's source path is sub-keyed on event+matcher+command; a
 * file-backed hook's is the script, and its name carries the event, the matcher and the
 * command's arguments, so two different wirings of one script stay two assets. A hook whose wiring is
 * committed on the default branch is repo-committed (keyed on the wiring, not the
 * script file's own git status), else repo-local.
 */
async function collectCodexHooksJson(state: CollectorState, dir: string, ctx: ProjectContext): Promise<void> {
  const codexDir = join(dir, ".codex");
  const hooksJsonPath = join(codexDir, "hooks.json");
  const rawBody = await readBody(hooksJsonPath);
  if (rawBody === null) return;
  const raw = rawBody.text;
  const data = parseJson(raw, hooksJsonPath);
  if (data === undefined) return;
  const hooksMap = hooksMapOf(data);
  if (hooksMap === null) {
    reportProblem({ severity: "warning", path: hooksJsonPath, message: "has no `hooks` object; skipped" });
    return;
  }

  const scopeRoot = dir; // a hook script may live anywhere in the scanned directory
  // `$(git rev-parse --show-toplevel)` is the repo's top level even when `dir` is a
  // package subdirectory.
  const toplevel = ctx.git.isRepo ? ctx.git.topLevel : dir;
  const source = basename(ctx.projectKey);
  const anchor = ctx.projectKey;
  const remote = ctx.git.remoteUrl !== "" ? { repo_remote_url: ctx.git.remoteUrl } : {};

  // Hooks wired on the default branch -> repo-committed. Keyed on the wiring, so
  // it survives a local reorder but not a local move to a different event.
  const committedKeys = ctx.git.isRepo
    ? committedCodexHookKeys(
        await baselineContent(ctx.git.topLevel, ctx.git.defaultBranch, relative(ctx.git.topLevel, hooksJsonPath)),
      )
    : new Set<string>();

  for (const { eventType, matcher, command, timeoutSeconds } of walkSettingsHooks(hooksMap)) {
    const wiredKey = wiredHookKey(eventType, matcher, command);
    const wiringCommitted = committedKeys.has(wiredKey);
    const sourceSubKey = `${eventType}:${inlineHookSubKey(matcher, command).slice(0, 12)}`;
    const hookConfig = { event: eventType, matcher, timeoutSeconds };
    const resolved = await resolveHookScript(
      normalizeGitToplevelHookCommand(command, toplevel),
      scopeRoot,
      scopeRoot,
      command,
    );
    if (resolved) {
      // File-backed. repo-committed requires BOTH committed wiring AND a
      // resolvable script baseline on the default branch (repo-committed always
      // carries a baseline). The source path is the plain script path, so its
      // baseline is `git show <branch>:<source path>`.
      const baseline =
        wiringCommitted && ctx.git.isRepo
          ? await baselineContentHash(ctx.git.topLevel, ctx.git.defaultBranch, relative(ctx.git.topLevel, resolved.absPath))
          : null;
      const committed = wiringCommitted && baseline !== null;
      await push(state, {
        ideType: IDE,
        type: "hook",
        name: hookFileAssetName(eventType, resolved.absPath, matcher, resolved.argsHash),
        scope: committed ? "repo-committed" : "repo-local",
        projectPath: ctx.projectKey,
        filePath: resolved.absPath,
        contentHash: resolved.hash,
        payload: {
          source,
          operational_state: "enabled",
          active_in_agents: ["Codex"],
          description: `Hook for ${eventType} event`,
          hook_command: command,
          hook_config: hookConfig,
          ...remote,
          ...(committed ? { baseline_content_hash: baseline } : {}),
        },
      });
    } else {
      // Inline command — the command string IS the body. Committed only when the
      // wiring is committed AND the command is genuinely inline: a command that
      // NAMES a script but didn't resolve is a locally-missing file-backed hook,
      // not a committed inline one.
      const committed = wiringCommitted && !commandNamesAScript(command);
      await push(state, {
        ideType: IDE,
        type: "hook",
        name: hookInlineAssetName(eventType, command),
        scope: committed ? "repo-committed" : "repo-local",
        projectPath: ctx.projectKey,
        filePath: hooksJsonPath,
        sourcePathOverride: `${relative(anchor, hooksJsonPath)}#${sourceSubKey}`,
        contentHash: sha256(command),
        payload: {
          source,
          operational_state: "enabled",
          active_in_agents: ["Codex"],
          description: `Hook for ${eventType} event`,
          inline_body: command,
          hook_config: hookConfig,
          ...remote,
          ...(committed ? { baseline_content_hash: sha256(command) } : {}),
        },
      });
    }
  }
}

/** The top-level `name = "..."` value from a TOML body, or undefined. */
function tomlName(content: string): string | undefined {
  // Only the blanks on the name's own line: `^\s*` would also cross blank lines, and so rescan
  // the blank lines below each line start. The first match is the same either way.
  const m = content.match(/^[^\S\n\r\u2028\u2029]*name\s*=\s*["']([^"']+)["']/m);
  return m ? m[1] : undefined;
}

/** True when `dir` carries its OWN Codex assets: a `.codex/` dir, an AGENTS.md, or a
 *  `.agents/skills` dir (a package whose only Codex asset is a cross-tool skill). */
async function hasOwnCodexAssets(dir: string): Promise<boolean> {
  return (
    (await isDirectory(join(dir, ".codex"))) ||
    (await isFile(join(dir, "AGENTS.md"))) ||
    (await isDirectory(join(dir, ".agents", "skills")))
  );
}

/** realpath(p), falling back to the raw path when it can't be canonicalized. */
async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/**
 * Scan the Codex assets under a single scope root (`scanDir`), keying every asset
 * on `ctx.projectKey`. Split from collectProjectAssets so the repo-root scope
 * and a monorepo package scope reuse the exact same collection.
 */
async function collectScopeAssets(state: CollectorState, scanDir: string, ctx: ProjectContext): Promise<void> {
  // .codex/agents/*.md|*.toml — project-scoped subagents. Markdown carries YAML
  // frontmatter (name/description); TOML carries a `name = "..."` line.
  const agentsDir = join(scanDir, ".codex", "agents");
  for (const entry of await safeReaddir(agentsDir)) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const isMd = entry.name.endsWith(".md");
    if (!isMd && !entry.name.endsWith(".toml")) continue;
    const agentPath = join(agentsDir, entry.name);
    const contentBody = await readBody(agentPath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    const fm = isMd ? parseFrontmatter(content) : {};
    const desc = isMd ? bestDescription(fm) : undefined;
    const name =
      fm.name ?? (isMd ? undefined : tomlName(content)) ?? fileNameToDisplayName(entry.name.replace(/\.(md|toml)$/, ""));
    await pushProjectFile(
      state,
      ctx,
      "agent",
      name,
      agentPath,
      contentBody,
      desc !== undefined ? { description: desc } : {},
    );
  }

  // .codex/rules/*.md|*.mdc|*.rules — md/mdc carry frontmatter; `.rules` is
  // plain text (name from the filename).
  const rulesDir = join(scanDir, ".codex", "rules");
  for (const entry of await safeReaddir(rulesDir)) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    if (!/\.(md|mdc|rules)$/.test(entry.name)) continue;
    const rulePath = join(rulesDir, entry.name);
    const contentBody = await readBody(rulePath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    const isFrontmattered = entry.name.endsWith(".md") || entry.name.endsWith(".mdc");
    const fm = isFrontmattered ? parseFrontmatter(content) : {};
    const ruleName = entry.name.replace(/\.(md|mdc|rules)$/, "");
    const desc = isFrontmattered ? bestDescription(fm) : undefined;
    await pushProjectFile(
      state,
      ctx,
      "rule",
      fm.name ?? fileNameToDisplayName(ruleName),
      rulePath,
      contentBody,
      desc !== undefined ? { description: desc } : {},
    );
  }

  // AGENTS.md — Codex's repo instruction file, its own kind.
  const agentsMdPath = join(scanDir, "AGENTS.md");
  const agentsMdBody = await readBody(agentsMdPath);
  if (agentsMdBody !== null) {
    await pushProjectFile(state, ctx, "agents_md", "AGENTS.md", agentsMdPath, agentsMdBody, {});
  }

  // .agents/skills/**/SKILL.md — repo-scoped skills. The cross-tool skills standard
  // (Codex reads `<repo>/.agents/skills`, NOT `.codex/skills`); the source path is
  // the repo-relative `.agents/skills/<slug>/SKILL.md`.
  await walkSkillsDir(join(scanDir, ".agents", "skills"), async (skillKey, filePath, contentBody, files) => {
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const desc = bestDescription(fm);
    await pushProjectFile(state, ctx, "skill", fm.name ?? fileNameToDisplayName(skillKey), filePath, contentBody, {
      invocation: `/${skillKey}`,
      ...(desc !== undefined ? { description: desc } : {}),
      ...(fm.version !== undefined ? { version: fm.version } : {}),
      ...(files && files.length > 0 ? { files } : {}),
    });
  });

  // .codex/hooks.json — project-scoped hooks (event -> matcher groups).
  await collectCodexHooksJson(state, scanDir, ctx);
}

/**
 * Collect one root's Codex assets across BOTH scopes it can carry:
 *   1. Repo-root scope — scan the git top level (keyed on ctx.projectKey), so a
 *      root sitting in a repo SUBDIR still discovers repo-root .codex/AGENTS.md
 *      assets, keyed on the project that is marked scanned.
 *   2. Package scope — when the root is a repo SUBDIR that carries its OWN
 *      .codex/AGENTS.md (a monorepo package), scan it too, keyed on the root as
 *      its own project scope. Its key is added to scannedKeys separately from
 *      the repo-root scope's.
 */
async function collectProjectAssets(state: CollectorState, dir: string, ctx: ProjectContext): Promise<void> {
  const repoRoot = ctx.git.isRepo ? ctx.git.topLevel : dir;
  state.scannedKeys.add(ctx.projectKey);
  await collectScopeAssets(state, repoRoot, ctx);

  // Package scope only for a genuine subdir: compare on the canonical paths so a
  // root that IS the repo root under a different spelling (/var vs /private/var)
  // is not re-scanned as a phantom second scope.
  if (!ctx.git.isRepo) return;
  const [dirReal, rootReal] = await Promise.all([canonical(dir), canonical(repoRoot)]);
  const isSubdir = dirReal !== rootReal && dirReal.startsWith(rootReal + sep);
  if (isSubdir && (await hasOwnCodexAssets(dir))) {
    state.scannedKeys.add(dir);
    await collectScopeAssets(state, dir, { projectKey: ctx.projectKey, git: ctx.git });
  }
}

/** Push a user-scope asset, anchoring its source_path on `userScopeRoot`. */
async function pushUserFile(
  state: CollectorState,
  type: HarnessAssetType,
  name: string,
  filePath: string,
  body: FileBody,
  userScopeRoot: string,
  extra: Partial<HarnessAssetPayload>,
): Promise<void> {
  await push(state, {
    ideType: IDE,
    type,
    name,
    scope: "user",
    projectPath: "",
    userScopeRoot,
    filePath,
    contentHash: body.hash,
    payload: {
      source: "codex",
      operational_state: "enabled",
      active_in_agents: ["Codex"],
      ...extra,
    },
  });
}

/**
 * Collect user-scope skills from `$HOME/.agents/skills` — the cross-tool,
 * HOME-relative skills standard (NOT `~/.codex/skills`). Anchoring the source path
 * on `home` makes it `.agents/skills/<slug>/SKILL.md`.
 */
export async function collectGlobalCodexAssets(state: CollectorState, home: string): Promise<void> {
  await walkSkillsDir(join(home, ".agents", "skills"), async (skillKey, filePath, contentBody, files) => {
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const desc = bestDescription(fm);
    await pushUserFile(state, "skill", fm.name ?? fileNameToDisplayName(skillKey), filePath, contentBody, home, {
      invocation: `/${skillKey}`,
      ...(desc !== undefined ? { description: desc } : {}),
      ...(fm.version !== undefined ? { version: fm.version } : {}),
      ...(files && files.length > 0 ? { files } : {}),
    });
  });
}

/**
 * Collect every Codex asset: user-scope skills, then each root. Every scanned
 * scope (repo root plus any package subdir) lands in `session.scannedKeys`; a root
 * that cannot be listed is reported as an error and does not.
 */
export async function collectCodexAssets(state: CollectSession, opts: CollectOptions): Promise<void> {
  const roots = canonicalRoots(opts.roots);
  await withReadRoots(roots.map((r) => r.path), () => collectAll(state, { ...opts, roots }));
}

async function collectAll(state: CollectSession, opts: CollectOptions): Promise<void> {
  const home = homedir();

  await collectGlobalCodexAssets(state, home);

  // Project scopes — same scanned-only reconcile + repo-winner selection as the
  // cursor/claude readers: collect the latest-active in-scope checkout per repo
  // first, so a file shared by two checkouts keeps the winner's copy while a
  // file unique to a sibling is still collected. collectProjectAssets records
  // every scope it scans (repo-root + any package subdir) in state.scannedKeys.
  const candidates: Array<{ dir: string; ctx: ProjectContext }> = [];
  for (const { path: root, isWorktree } of opts.roots) {
    if (isWorktree) {
      // A worktree duplicates the main checkout. Skip it, but add it to `scannedKeys`, so a caller that mirrors the inventory deletes what it stored for this path.
      state.scannedKeys.add(root);
      continue;
    }
    if (samePath(root, home)) {
      // $HOME is the user scope, not a repo. Skip it, but add it to `scannedKeys`, so a caller that mirrors the inventory deletes what it stored for this path.
      state.scannedKeys.add(root);
      continue;
    }
    if ((await readRootEntries(root)) === null) continue;
    const git = await rootGitContext(root);
    // A root deep inside a worktree slips past the per-root isWorktree check but
    // resolves to a worktree topLevel — skip and reconcile against it.
    if (git.isRepo && (await isGitWorktree(git.topLevel))) {
      state.scannedKeys.add(git.topLevel);
      continue;
    }
    candidates.push({ dir: root, ctx: { projectKey: git.isRepo ? git.topLevel : root, git } });
  }

  const winners = await resolveRepoWinners(
    candidates.map((c) => ({ remoteUrl: c.ctx.git.remoteUrl, projectKey: c.ctx.projectKey })),
    opts.inScope ?? allInScope,
  );
  const ordered = [
    ...candidates.filter((c) => winners.has(c.ctx.projectKey)),
    ...candidates.filter((c) => !winners.has(c.ctx.projectKey)),
  ];
  for (const { dir, ctx } of ordered) {
    await collectProjectAssets(state, dir, ctx);
  }
}

/**
 * Collect ONE repo's Codex assets — the real per-repo inventory path
 * (`readGitContext` + `collectProjectAssets`), without the user scope or the
 * multi-root winner selection. A non-git dir collects at repo-local scope
 * (projectKey = dir).
 */
export async function collectCodexRepoAssets(state: CollectSession, dir: string): Promise<void> {
  dir = canonicalDir(dir);
  await withReadRoots([dir], async () => {
    const git = await rootGitContext(dir);
    await collectProjectAssets(state, dir, { projectKey: git.isRepo ? git.topLevel : dir, git });
  });
}

