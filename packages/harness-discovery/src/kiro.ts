// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Kiro asset reader. Mirrors codex.ts / cursor.ts: scan Kiro's installed assets at
 * BOTH scopes and hand each to the session's sink.
 *
 * Kiro roots its config plainly at $HOME/.kiro (user scope) and <repo>/.kiro
 * (repo scope) with the SAME relative layout, so every source path is
 * scope-root-relative and the same at both scopes:
 *   - .kiro/steering/<slug>.md        → RULE
 *   - .kiro/skills/<slug>/SKILL.md    → SKILL
 *   - .kiro/agents/<slug>.md          → AGENT (Kiro IDE agent = Markdown+YAML)
 *   - .kiro/agents/<slug>.json        → AGENT (the Kiro CLI manifest, which also
 *     declares the agent's own mcpServers, tools/allowedTools, hooks and resources)
 *   - .kiro/hooks/<slug>.kiro.hook    → HOOK (the manifest file IS the artifact — a
 *     self-contained per-slug file the IDE auto-discovers, hashed like a rule;
 *     repo scope only, since Kiro has no ~/.kiro/hooks/, kirodotdev/Kiro#7737)
 *   - .kiro/hooks/<slug>.json         → HOOK (same manifest, alternate extension;
 *     admitted only when it really declares triggers — see hasHookDeclaration)
 *
 * A Kiro hook has no separate script + activation, so the reader reports the
 * `.kiro.hook` manifest itself, exactly as it reports a rule or agent file. There is NO
 * user-global hook.
 *
 * The agent-agnostic repo root docs (CLAUDE.md / AGENTS.md) are reported by the Claude /
 * Codex / Cursor readers, so this reader does NOT collect them.
 */

import { homedir } from "node:os";
import { join, basename, sep } from "node:path";
import { realpath } from "node:fs/promises";
import {
  parseFrontmatter,
  bestDescription,
  fileNameToDisplayName,
  readBody,
  type FileBody,
  safeReaddir,
  readRootEntries,
  isDirectory,
  parseJson,
  rootGitContext,
  samePath,
  canonicalRoots,
  canonicalDir,
  isGitWorktree,
  resolveScope,
  walkSkillsDir,
  resolveRepoWinners,
  withReadRoots,
  type GitContext,
  type ParsedFrontmatter,
} from "./scanShared";
import type { CollectSession } from "./session";
import { allInScope, type CollectOptions } from "./collectOptions";
import type { CollectedAsset, HarnessAssetPayload, HarnessAssetType } from "./types";

export const KIRO_IDE = "kiro";
const IDE = KIRO_IDE;


type CollectorState = CollectSession;

const push = (state: CollectorState, asset: CollectedAsset): Promise<void> =>
  state.push(asset);

/**
 * True when a parsed `.kiro/hooks/*.json` file really is a hook manifest: a `hooks`
 * array whose entries carry a `trigger`. Kiro hooks fire on SessionStart /
 * PreToolUse / PostToolUse / PostFileSave and act via `{type:"command"}` (run a
 * shell command) or `{type:"agent"}` (inject a prompt into the session).
 *
 * Exported so anything else counting Kiro hooks applies the same test as the
 * inventory, and scratch JSON in the directory is never counted as a hook.
 */
export function hasHookDeclaration(json: unknown): boolean {
  const hooks = (json as { hooks?: unknown } | null)?.hooks;
  return Array.isArray(hooks) && hooks.some((h) => !!h && typeof h === "object" && "trigger" in (h as object));
}

interface ProjectContext {
  projectKey: string;
  git: GitContext;
}

/**
 * Scan Kiro's assets under a single scope root (`scanDir`), keying every asset on
 * `ctx.projectKey`. Split from collectProjectAssets so the repo-root scope and a
 * monorepo package scope reuse the exact same collection. Every source path is
 * scanDir-relative (`.kiro/...`).
 */
async function collectScopeAssets(state: CollectorState, scanDir: string, ctx: ProjectContext): Promise<void> {
  const source = basename(ctx.projectKey);
  const remote = ctx.git.remoteUrl !== "" ? { repo_remote_url: ctx.git.remoteUrl } : {};

  const pushProjectFile = async (
    type: HarnessAssetType,
    name: string,
    filePath: string,
    body: FileBody,
    extra: Partial<HarnessAssetPayload>,
  ): Promise<void> => {
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
        source,
        operational_state: "enabled",
        active_in_agents: ["Kiro"],
        ...remote,
        ...(baseline !== undefined ? { baseline_content_hash: baseline } : {}),
        ...extra,
      },
    });
  };

  // .kiro/steering/*.md → RULE. Kiro steering docs are markdown; a name may ride YAML
  // frontmatter, else the filename slug titled.
  const steeringDir = join(scanDir, ".kiro", "steering");
  for (const entry of await safeReaddir(steeringDir)) {
    if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(".md")) continue;
    const rulePath = join(steeringDir, entry.name);
    const contentBody = await readBody(rulePath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const desc = bestDescription(fm);
    const slug = entry.name.replace(/\.md$/, "");
    await pushProjectFile("rule", fm.name ?? fileNameToDisplayName(slug), rulePath, contentBody, {
      ...(desc !== undefined ? { description: desc } : {}),
      ...steeringInclusionPayload(fm),
    });
  }

  // .kiro/skills/<slug>/SKILL.md → SKILL.
  await walkSkillsDir(join(scanDir, ".kiro", "skills"), async (skillKey, filePath, contentBody, files) => {
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const desc = bestDescription(fm);
    await pushProjectFile("skill", fm.name ?? fileNameToDisplayName(skillKey), filePath, contentBody, {
      invocation: `/${skillKey}`,
      ...(desc !== undefined ? { description: desc } : {}),
      ...(fm.version !== undefined ? { version: fm.version } : {}),
      ...(files && files.length > 0 ? { files } : {}),
    });
  });

  // .kiro/agents/*.md → AGENT. A Kiro IDE agent is Markdown+YAML (kiro.dev/docs); a
  // name may ride YAML frontmatter, else the filename slug titled.
  const agentsDir = join(scanDir, ".kiro", "agents");
  for (const entry of await safeReaddir(agentsDir)) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const isMd = entry.name.endsWith(".md");
    const isJson = entry.name.endsWith(".json");
    if (!isMd && !isJson) continue;
    const agentPath = join(agentsDir, entry.name);
    const contentBody = await readBody(agentPath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    if (isJson) {
      const agent = jsonAgent(parseJson(content, agentPath));
      if (!agent) continue;
      const slug = entry.name.replace(/\.json$/, "");
      await pushProjectFile("agent", agent.name ?? fileNameToDisplayName(slug), agentPath, contentBody, {
        ...(agent.description !== undefined ? { description: agent.description } : {}),
      });
      continue;
    }
    const fm = parseFrontmatter(content);
    const desc = bestDescription(fm);
    const slug = entry.name.replace(/\.md$/, "");
    await pushProjectFile("agent", fm.name ?? fileNameToDisplayName(slug), agentPath, contentBody, {
      ...(desc !== undefined ? { description: desc } : {}),
    });
  }

  // .kiro/hooks/*.kiro.hook and *.json → HOOK. A Kiro hook manifest ships as
  // `<slug>.kiro.hook` OR `<slug>.json`; both are self-contained per-slug files the
  // Kiro IDE auto-discovers (no separate script + activation), so the file IS the
  // artifact, reported like any other hashed file.
  const hooksDir = join(scanDir, ".kiro", "hooks");
  for (const entry of await safeReaddir(hooksDir)) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const isHookManifest = entry.name.endsWith(".kiro.hook");
    const isJsonHook = entry.name.endsWith(".json");
    if (!isHookManifest && !isJsonHook) continue;
    const hookPath = join(hooksDir, entry.name);
    const contentBody = await readBody(hookPath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    // A `.json` here must actually declare hooks — the directory can hold other JSON.
    if (isJsonHook) {
      const json = parseJson(content, hookPath);
      if (json === undefined || !hasHookDeclaration(json)) continue;
    }
    const slug = entry.name.replace(/\.kiro\.hook$/, "").replace(/\.json$/, "");
    await pushProjectFile("hook", fileNameToDisplayName(slug), hookPath, contentBody, {});
  }
}

/**
 * Steering docs declare HOW they enter context, and the three modes behave very
 * differently: `always` is injected into every session, `fileMatch` only when a
 * matching file is read, `manual` only when the user types `#<name>`. Counting
 * the files alone treats a doc nobody ever pulled in the same as one on every
 * turn. Absent frontmatter means Kiro's default, `always`.
 */
function steeringInclusionPayload(fm: ParsedFrontmatter): Partial<HarnessAssetPayload> {
  const raw = fm.raw ?? {};
  const inclusion = raw["inclusion"];
  const pattern = raw["fileMatchPattern"] ?? raw["fileMatch"];
  return {
    inclusion_mode: inclusion && inclusion.length > 0 ? inclusion : "always",
    ...(pattern ? { inclusion_file_match: pattern } : {}),
  };
}

/**
 * A Kiro agent ships in one of two formats and both must be read:
 *  - `.md`  — the IDE's Markdown+YAML agent (name/description in frontmatter)
 *  - `.json` — the Kiro CLI agent manifest, which additionally declares the
 *    agent's own `mcpServers`, `tools`/`allowedTools` (its approval posture),
 *    `hooks`, `resources` (steering wiring) and `model`.
 *
 * Takes the parsed JSON (undefined when it did not parse, already reported); returns
 * null when it is not a usable agent manifest.
 */
function jsonAgent(raw: unknown): { name?: string; description?: string; model?: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  // `name` is what distinguishes an agent manifest from some other JSON that
  // happens to sit in the directory (a lock file, editor state).
  if (typeof obj["name"] !== "string" || obj["name"].length === 0) return null;
  return {
    name: obj["name"],
    ...(typeof obj["description"] === "string" ? { description: obj["description"] } : {}),
    ...(typeof obj["model"] === "string" ? { model: obj["model"] } : {}),
  };
}

/** True when `dir` carries its OWN Kiro assets — a `.kiro/` directory. */
async function hasOwnKiroAssets(dir: string): Promise<boolean> {
  return isDirectory(join(dir, ".kiro"));
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
 * Collect one root's Kiro assets across BOTH scopes it can carry:
 *   1. Repo-root scope — scan the git top level (keyed on ctx.projectKey), so a root in a
 *      repo SUBDIR still discovers repo-root `.kiro` assets, keyed on the project marked
 *      scanned.
 *   2. Package scope — when the root is a repo SUBDIR carrying its OWN `.kiro` (a monorepo
 *      package), scan it too, keyed on the root. Its key is recorded separately.
 */
async function collectProjectAssets(state: CollectorState, dir: string, ctx: ProjectContext): Promise<void> {
  const repoRoot = ctx.git.isRepo ? ctx.git.topLevel : dir;
  state.scannedKeys.add(ctx.projectKey);
  await collectScopeAssets(state, repoRoot, ctx);

  if (!ctx.git.isRepo) return;
  const [dirReal, rootReal] = await Promise.all([canonical(dir), canonical(repoRoot)]);
  const isSubdir = dirReal !== rootReal && dirReal.startsWith(rootReal + sep);
  if (isSubdir && (await hasOwnKiroAssets(dir))) {
    state.scannedKeys.add(dir);
    await collectScopeAssets(state, dir, { projectKey: ctx.projectKey, git: ctx.git });
  }
}

/** Push a user-scope asset, anchoring its source_path on `userScopeRoot` (home). */
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
      source: "kiro",
      operational_state: "enabled",
      active_in_agents: ["Kiro"],
      ...extra,
    },
  });
}

/**
 * Collect Kiro's user-scope assets under `$HOME/.kiro`. Anchoring every source path on
 * `home` keys them `.kiro/steering|skills|agents/...`, the same relative paths as repo
 * scope. There is NO user-global hook — Kiro's hooks are workspace-only.
 */
export async function collectGlobalKiroAssets(state: CollectorState, home: string): Promise<void> {
  const steeringDir = join(home, ".kiro", "steering");
  for (const entry of await safeReaddir(steeringDir)) {
    if (!entry.isFile() || entry.name.startsWith(".") || !entry.name.endsWith(".md")) continue;
    const rulePath = join(steeringDir, entry.name);
    const contentBody = await readBody(rulePath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const desc = bestDescription(fm);
    const slug = entry.name.replace(/\.md$/, "");
    await pushUserFile(state, "rule", fm.name ?? fileNameToDisplayName(slug), rulePath, contentBody, home, {
      ...(desc !== undefined ? { description: desc } : {}),
      ...steeringInclusionPayload(fm),
    });
  }

  await walkSkillsDir(join(home, ".kiro", "skills"), async (skillKey, filePath, contentBody, files) => {
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

  const agentsDir = join(home, ".kiro", "agents");
  for (const entry of await safeReaddir(agentsDir)) {
    if (!entry.isFile() || entry.name.startsWith(".")) continue;
    const isMd = entry.name.endsWith(".md");
    const isJson = entry.name.endsWith(".json");
    if (!isMd && !isJson) continue;
    const agentPath = join(agentsDir, entry.name);
    const contentBody = await readBody(agentPath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    if (isJson) {
      // The Kiro CLI's agents live here as JSON.
      const agent = jsonAgent(parseJson(content, agentPath));
      if (!agent) continue;
      const slug = entry.name.replace(/\.json$/, "");
      await pushUserFile(state, "agent", agent.name ?? fileNameToDisplayName(slug), agentPath, contentBody, home, {
        ...(agent.description !== undefined ? { description: agent.description } : {}),
      });
      continue;
    }
    const fm = parseFrontmatter(content);
    const desc = bestDescription(fm);
    const slug = entry.name.replace(/\.md$/, "");
    await pushUserFile(state, "agent", fm.name ?? fileNameToDisplayName(slug), agentPath, contentBody, home, {
      ...(desc !== undefined ? { description: desc } : {}),
    });
  }
}

/**
 * Collect every Kiro asset: user scope under ~/.kiro, then each root. Every
 * scanned scope (repo root plus any package subdir) lands in `session.scannedKeys`; a
 * root that cannot be listed is reported as an error and does not.
 */
export async function collectKiroAssets(state: CollectSession, opts: CollectOptions): Promise<void> {
  const roots = canonicalRoots(opts.roots);
  await withReadRoots(roots.map((r) => r.path), () => collectAll(state, { ...opts, roots }));
}

async function collectAll(state: CollectSession, opts: CollectOptions): Promise<void> {
  const home = homedir();

  await collectGlobalKiroAssets(state, home);

  // Project scopes — same scanned-only reconcile + repo-winner selection as the
  // codex/cursor readers: collect the latest-active in-scope checkout per repo first, so
  // a file shared by two checkouts keeps the winner's copy while a file unique to a
  // sibling is still collected. collectProjectAssets records every scope it scans
  // (repo-root + any package subdir) in state.scannedKeys.
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
    // A root deep inside a worktree slips past the per-root isWorktree check but resolves
    // to a worktree topLevel — skip and reconcile against it.
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
 * Collect ONE repo's Kiro repo-scope assets — the per-repo inventory path
 * (`readGitContext` + `collectProjectAssets`), without the user scope or the
 * multi-root winner selection. A non-git dir collects at repo-local scope
 * (projectKey = dir).
 */
export async function collectKiroRepoAssets(state: CollectSession, dir: string): Promise<void> {
  dir = canonicalDir(dir);
  await withReadRoots([dir], async () => {
    const git = await rootGitContext(dir);
    await collectProjectAssets(state, dir, { projectKey: git.isRepo ? git.topLevel : dir, git });
  });
}
