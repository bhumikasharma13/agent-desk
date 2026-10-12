// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Cursor asset reader. Follows the claudeCode.ts pattern: scan Cursor's
 * installed assets and hand each to the session's sink.
 *
 * Sources mirror Cursor's on-disk layout, which parallels Claude's under
 * `.cursor/` instead of `.claude/`:
 *   - user (~/.cursor):   skills-cursor + skills (SKILL.md dirs), commands,
 *     agents, rules (.md/.mdc), hooks (hooks.json)
 *   - per-project (.cursor): rules (.md/.mdc), commands, agents, skills, hooks;
 *     plus legacy .cursorrules and repo AGENTS.md (its own agents_md kind).
 *
 * Hooks are inventoried from `hooks.json` (event -> commands), NOT by globbing
 * `.cursor/hooks/*`: the manifest is the source of truth for what is actually a
 * hook and which event it runs on. Globbing the dir both loses that event wiring
 * and inventories non-hook helpers (e.g. a shared `lib.sh`) as bogus assets. One asset per wired hook,
 * file-backed (the resolved script) or inline (the command string), mirroring
 * the Claude settings.json path (claudeCode.ts).
 *
 * Cursor plugins are not collected.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, basename, relative } from "node:path";
import {
  parseFrontmatter,
  bestDescription,
  fileNameToDisplayName,
  readBody,
  type FileBody,
  safeReaddir,
  readRootEntries,
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
import { reportProblem } from "./log";
import type { CollectSession } from "./session";
import { allInScope, type CollectOptions } from "./collectOptions";
import type { CollectedAsset, HarnessAssetPayload, HarnessAssetType } from "./types";

export const CURSOR_IDE = "cursor";
const IDE = CURSOR_IDE;

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
      active_in_agents: ["Cursor"],
      ...(ctx.git.remoteUrl !== "" ? { repo_remote_url: ctx.git.remoteUrl } : {}),
      ...(baseline !== undefined ? { baseline_content_hash: baseline } : {}),
      ...extra,
    },
  });
}

/**
 * Walk Cursor's hooks.json `hooks` map into flat (event, matcher, command)
 * entries. Cursor's shape is FLAT — `hooks[event]` is an array of
 * `{command, matcher?}` — unlike Claude's nested matcher-groups (walkSettingsHooks).
 * Pure so the parsing can be unit-tested without fs.
 */
export function* walkCursorHooks(
  hooks: Record<string, unknown>,
): Generator<{ eventType: string; matcher: string; command: string; timeoutSeconds: number }> {
  for (const [eventType, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const command = (entry as { command?: unknown })?.command;
      if (typeof command !== "string" || command === "") continue;
      const matcher =
        typeof (entry as { matcher?: unknown })?.matcher === "string" ? (entry as { matcher: string }).matcher : "";
      // Per-entry timeout in seconds; absent or not positive → 0, meaning unset.
      const rawTimeout = (entry as { timeout?: unknown })?.timeout;
      const timeoutSeconds = typeof rawTimeout === "number" && rawTimeout > 0 ? rawTimeout : 0;
      yield { eventType, matcher, command, timeoutSeconds };
    }
  }
}

/** The `hooks` object of a parsed hooks.json, or null when there is none. */
function hooksMapOf(data: unknown): Record<string, unknown> | null {
  const hooks = (data as { hooks?: unknown } | null)?.hooks;
  return hooks !== null && typeof hooks === "object" ? (hooks as Record<string, unknown>) : null;
}

/** The `hooks` map of a hooks.json body, or null if absent/unparseable. */
export function parseCursorHooksJson(raw: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  return hooksMapOf(data);
}

/**
 * Wired-hook keys ({@link wiredHookKey}) of a committed (default-branch) hooks.json
 * body — membership classifies a live hook's *wiring* as committed. A null/unparseable
 * body yields the empty set (nothing can prove itself committed).
 */
export function committedCursorHookKeys(baselineBody: string | null): Set<string> {
  const keys = new Set<string>();
  if (baselineBody === null) return keys;
  const map = parseCursorHooksJson(baselineBody);
  if (map === null) return keys;
  for (const { eventType, matcher, command } of walkCursorHooks(map)) {
    keys.add(wiredHookKey(eventType, matcher, command));
  }
  return keys;
}

/**
 * Inventory hooks from a `hooks.json` (project when `ctx` is set, else user).
 * `fsDir` is the directory `.cursor/` sits under (the repo root or home).
 *
 * Commands resolve and scope-check against `scopeRoot`: the repo root for a
 * project (a repo hook script may live anywhere in it), or `~/.cursor` for the
 * user manifest. The user containment is deliberately `~/.cursor`, NOT `$HOME`:
 * a command naming an arbitrary home file (`bash ~/.ssh/id_rsa`) must fall out
 * of scope and be treated as inline, never read and hashed as a file-backed hook.
 * A command that resolves to an in-scope script is file-backed (the script is
 * the asset); anything else (a bare `jq …` one-liner) is inline.
 *
 * Identity is the *wired* hook, not the file: the source path is sub-keyed by
 * event+matcher+command, so the same script wired to two events — or twice on
 * one event with different matchers — stays distinct assets (one per wired hook).
 *
 * Scope: a hook whose wiring is committed on the default branch is `repo-committed`,
 * else `repo-local` (user manifest → `user`). Committed status keys on the *wiring*
 * (`committedCursorHookKeys`, event+matcher+command), not the script file's own git
 * status — a committed script wired only locally is not a committed hook. A
 * locally-missing file-backed script (command names a script that didn't resolve)
 * is never mistaken for a committed *inline* hook.
 */
async function collectCursorHooksJson(
  state: CollectorState,
  fsDir: string,
  ctx: ProjectContext | null,
): Promise<void> {
  const cursorDir = join(fsDir, ".cursor");
  const hooksJsonPath = join(cursorDir, "hooks.json");
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

  const scopeRoot = ctx ? fsDir : cursorDir; // repo root for a project; ~/.cursor for the user manifest
  const source = ctx ? basename(ctx.projectKey) : "cursor";
  const anchor = ctx ? ctx.projectKey : homedir();
  const remote = ctx && ctx.git.remoteUrl !== "" ? { repo_remote_url: ctx.git.remoteUrl } : {};

  // Hooks wired on the default branch → repo-committed. Keyed on the wiring
  // (event+matcher+command), so it survives a local reorder but not a local
  // move to a different event / a local-only addition.
  const committedKeys = ctx
    ? committedCursorHookKeys(
        await baselineContent(ctx.git.topLevel, ctx.git.defaultBranch, relative(ctx.git.topLevel, hooksJsonPath)),
      )
    : new Set<string>();

  for (const { eventType, matcher, command, timeoutSeconds } of walkCursorHooks(hooksMap)) {
    // Identity: an inline command's source path is sub-keyed on event+matcher+command; a
    // file-backed hook's is the script, and its name carries the event, the matcher and the
    // command's arguments. Either way two different wirings stay two assets.
    const wiredKey = wiredHookKey(eventType, matcher, command);
    const wiringCommitted = ctx !== null && committedKeys.has(wiredKey);
    const sourceSubKey = `${eventType}:${inlineHookSubKey(matcher, command).slice(0, 12)}`;
    const hookConfig = { event: eventType, matcher, timeoutSeconds };
    const resolved = await resolveHookScript(command, scopeRoot, scopeRoot);
    if (resolved) {
      // File-backed. repo-committed requires BOTH committed wiring AND a
      // resolvable script baseline on the default branch (repo-committed always
      // carries a baseline), so a committed wiring whose script is missing or
      // untracked on the default branch stays repo-local. The source path is the
      // plain script path (NOT sub-keyed), so its baseline is
      // `git show <branch>:<source path>`, which a `#event:subkey` suffix would break.
      const baseline =
        wiringCommitted && ctx
          ? await baselineContentHash(ctx.git.topLevel, ctx.git.defaultBranch, relative(ctx.git.topLevel, resolved.absPath))
          : null;
      const committed = ctx !== null && wiringCommitted && baseline !== null;
      await push(state, {
        ideType: IDE,
        type: "hook",
        name: hookFileAssetName(eventType, resolved.absPath, matcher, resolved.argsHash),
        scope: !ctx ? "user" : committed ? "repo-committed" : "repo-local",
        projectPath: ctx ? ctx.projectKey : "",
        filePath: resolved.absPath,
        contentHash: resolved.hash,
        payload: {
          source,
          operational_state: "enabled",
          active_in_agents: ["Cursor"],
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
      // not a committed inline one, so it must not carry an inline baseline.
      const committed = wiringCommitted && !commandNamesAScript(command);
      await push(state, {
        ideType: IDE,
        type: "hook",
        name: hookInlineAssetName(eventType, command),
        scope: !ctx ? "user" : committed ? "repo-committed" : "repo-local",
        projectPath: ctx ? ctx.projectKey : "",
        filePath: hooksJsonPath,
        sourcePathOverride: `${relative(anchor, hooksJsonPath)}#${sourceSubKey}`,
        contentHash: sha256(command),
        payload: {
          source,
          operational_state: "enabled",
          active_in_agents: ["Cursor"],
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

async function collectProjectAssets(state: CollectorState, ctx: ProjectContext): Promise<void> {
  // Scan from the repo top level (ctx.projectKey), NOT the given root: a root
  // sitting in a repo SUBDIR still inventories the repo-root .cursor/… files,
  // with repo-root-relative source paths. For a non-git dir, projectKey is that
  // dir.
  const dir = ctx.projectKey;

  // .cursor/rules/*.md|*.mdc
  const rulesDir = join(dir, ".cursor", "rules");
  for (const entry of await safeReaddir(rulesDir)) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    if (!entry.name.endsWith(".md") && !entry.name.endsWith(".mdc")) continue;
    const rulePath = join(rulesDir, entry.name);
    const contentBody = await readBody(rulePath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const ruleName = entry.name.replace(/\.(md|mdc)$/, "");
    const desc = bestDescription(fm);
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

  // Legacy single-file .cursorrules
  const cursorrulesPath = join(dir, ".cursorrules");
  const cursorrulesBody = await readBody(cursorrulesPath);
  if (cursorrulesBody !== null) {
    await pushProjectFile(state, ctx, "rule", ".cursorrules", cursorrulesPath, cursorrulesBody, {});
  }

  // AGENTS.md — Cursor's repo instruction file, its own kind.
  const agentsMdPath = join(dir, "AGENTS.md");
  const agentsMdBody = await readBody(agentsMdPath);
  if (agentsMdBody !== null) {
    await pushProjectFile(state, ctx, "agents_md", "AGENTS.md", agentsMdPath, agentsMdBody, {});
  }

  // CLAUDE.md — the Cursor CLI reads a repo-root CLAUDE.md as rules; its own kind,
  // at the bare repo-root source path `CLAUDE.md`.
  const claudeMdPath = join(dir, "CLAUDE.md");
  const claudeMdBody = await readBody(claudeMdPath);
  if (claudeMdBody !== null) {
    await pushProjectFile(state, ctx, "claude_md", "CLAUDE.md", claudeMdPath, claudeMdBody, {});
  }

  // .cursor/commands/*.md
  const commandsDir = join(dir, ".cursor", "commands");
  for (const entry of await safeReaddir(commandsDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
    const cmdPath = join(commandsDir, entry.name);
    const contentBody = await readBody(cmdPath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const cmdName = entry.name.replace(/\.md$/, "");
    const desc = bestDescription(fm);
    await pushProjectFile(state, ctx, "command", fm.name ?? fileNameToDisplayName(cmdName), cmdPath, contentBody, {
      invocation: `/${cmdName}`,
      ...(desc !== undefined ? { description: desc } : {}),
    });
  }

  // .cursor/agents/*.md — project-scoped subagents (same markdown+frontmatter
  // shape as Claude's; Cursor also reads .claude/agents as a compat fallback).
  const agentsDir = join(dir, ".cursor", "agents");
  for (const entry of await safeReaddir(agentsDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
    const agentPath = join(agentsDir, entry.name);
    const contentBody = await readBody(agentPath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const desc = bestDescription(fm);
    await pushProjectFile(
      state,
      ctx,
      "agent",
      fm.name ?? fileNameToDisplayName(entry.name.replace(/\.md$/, "")),
      agentPath,
      contentBody,
      desc !== undefined ? { description: desc } : {},
    );
  }

  // .cursor/skills/**/SKILL.md — project-scoped skills.
  await walkSkillsDir(join(dir, ".cursor", "skills"), async (skillKey, filePath, contentBody, files) => {
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

  // .cursor/hooks.json — project-scoped hooks (event -> commands).
  await collectCursorHooksJson(state, dir, ctx);
}

/** Push a user-scope (~/.cursor) asset. Mirrors pushProjectFile for global files. */
async function pushUserFile(
  state: CollectorState,
  type: HarnessAssetType,
  name: string,
  filePath: string,
  body: FileBody,
  extra: Partial<HarnessAssetPayload>,
): Promise<void> {
  await push(state, {
    ideType: IDE,
    type,
    name,
    scope: "user",
    projectPath: "",
    filePath,
    contentHash: body.hash,
    payload: {
      source: "cursor",
      operational_state: "enabled",
      active_in_agents: ["Cursor"],
      ...extra,
    },
  });
}

/** Collect user-scope (~/.cursor) skills, commands, and agents. */
async function collectGlobalCursorAssets(state: CollectorState, home: string): Promise<void> {
  // Skills: Cursor's managed set (skills-cursor) + the user skills dir (skills).
  for (const skillsDirName of ["skills-cursor", "skills"]) {
    await walkSkillsDir(join(home, ".cursor", skillsDirName), async (skillKey, filePath, contentBody, files) => {
      const content = contentBody.text;
      const fm = parseFrontmatter(content);
      const desc = bestDescription(fm);
      await pushUserFile(state, "skill", fm.name ?? fileNameToDisplayName(skillKey), filePath, contentBody, {
        invocation: `/${skillKey}`,
        ...(desc !== undefined ? { description: desc } : {}),
        ...(fm.version !== undefined ? { version: fm.version } : {}),
        ...(files && files.length > 0 ? { files } : {}),
      });
    });
  }

  // ~/.cursor/commands/*.md
  const commandsDir = join(home, ".cursor", "commands");
  for (const entry of await safeReaddir(commandsDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
    const cmdPath = join(commandsDir, entry.name);
    const contentBody = await readBody(cmdPath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const cmdName = entry.name.replace(/\.md$/, "");
    const desc = bestDescription(fm);
    await pushUserFile(state, "command", fm.name ?? fileNameToDisplayName(cmdName), cmdPath, contentBody, {
      invocation: `/${cmdName}`,
      ...(desc !== undefined ? { description: desc } : {}),
    });
  }

  // ~/.cursor/agents/*.md
  const agentsDir = join(home, ".cursor", "agents");
  for (const entry of await safeReaddir(agentsDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
    const agentPath = join(agentsDir, entry.name);
    const contentBody = await readBody(agentPath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const desc = bestDescription(fm);
    await pushUserFile(
      state,
      "agent",
      fm.name ?? fileNameToDisplayName(entry.name.replace(/\.md$/, "")),
      agentPath,
      contentBody,
      desc !== undefined ? { description: desc } : {},
    );
  }

  // ~/.cursor/rules/*.md|*.mdc — user-scope rules.
  const rulesDir = join(home, ".cursor", "rules");
  for (const entry of await safeReaddir(rulesDir)) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    if (!entry.name.endsWith(".md") && !entry.name.endsWith(".mdc")) continue;
    const rulePath = join(rulesDir, entry.name);
    const contentBody = await readBody(rulePath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const ruleName = entry.name.replace(/\.(md|mdc)$/, "");
    const desc = bestDescription(fm);
    await pushUserFile(
      state,
      "rule",
      fm.name ?? fileNameToDisplayName(ruleName),
      rulePath,
      contentBody,
      desc !== undefined ? { description: desc } : {},
    );
  }

  // ~/.cursor/hooks.json — user-scope hooks (event -> commands).
  await collectCursorHooksJson(state, home, null);
}

/**
 * Collect every Cursor asset: user scope under ~/.cursor, then each root. Every
 * scanned project key lands in `session.scannedKeys`; a root that cannot be listed
 * is reported as an error and does not.
 */
export async function collectCursorAssets(state: CollectSession, opts: CollectOptions): Promise<void> {
  const roots = canonicalRoots(opts.roots);
  await withReadRoots(roots.map((r) => r.path), () => collectAll(state, { ...opts, roots }));
}

async function collectAll(state: CollectSession, opts: CollectOptions): Promise<void> {
  const home = homedir();

  await collectGlobalCursorAssets(state, home);

  // Project scopes — same scanned-only reconcile + repo-winner selection as the
  // claude reader: collect the latest-active in-scope checkout per repo first,
  // so a file shared by two checkouts keeps the winner's copy while a file
  // unique to a sibling is still collected.
  const scannedProjectKeys = state.scannedKeys;
  const candidates: Array<{ dir: string; ctx: ProjectContext }> = [];
  for (const { path: root, isWorktree } of opts.roots) {
    if (isWorktree) {
      // A worktree duplicates the main checkout. Skip it, but add it to `scannedKeys`, so a caller that mirrors the inventory deletes what it stored for this path.
      scannedProjectKeys.add(root);
      continue;
    }
    if (samePath(root, home)) {
      // $HOME is the user scope, not a repo. Skip it, but add it to `scannedKeys`, so a caller that mirrors the inventory deletes what it stored for this path.
      scannedProjectKeys.add(root);
      continue;
    }
    if ((await readRootEntries(root)) === null) continue;
    const git = await rootGitContext(root);
    // A root deep inside a worktree slips past the per-root isWorktree check but
    // resolves to a worktree topLevel — skip and reconcile against it. See the
    // claude reader for the full rationale.
    if (git.isRepo && (await isGitWorktree(git.topLevel))) {
      scannedProjectKeys.add(git.topLevel);
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
  // Scan each repo top level once: several roots can resolve to the same top
  // level (the scan root is ctx.projectKey), so dedupe the scan while still
  // recording every projectKey as scanned.
  const scannedThisRun = new Set<string>();
  for (const { ctx } of ordered) {
    scannedProjectKeys.add(ctx.projectKey);
    if (scannedThisRun.has(ctx.projectKey)) continue;
    scannedThisRun.add(ctx.projectKey);
    await collectProjectAssets(state, ctx);
  }
}

/**
 * Collect ONE repo's Cursor assets — the real per-repo inventory path
 * (`readGitContext` + `collectProjectAssets`), without the user scope or the
 * multi-root winner selection. A non-git dir collects at repo-local scope
 * (projectKey = dir).
 */
export async function collectCursorRepoAssets(state: CollectSession, dir: string): Promise<void> {
  dir = canonicalDir(dir);
  await withReadRoots([dir], async () => {
    const git = await rootGitContext(dir);
    const ctx = { projectKey: git.isRepo ? git.topLevel : dir, git };
    state.scannedKeys.add(ctx.projectKey);
    await collectProjectAssets(state, ctx);
  });
}
