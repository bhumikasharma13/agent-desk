// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Claude Code asset reader: scans Claude Code's installed assets (plugins,
 * skills, commands, rules, hooks, agents, instruction files) and hands each to
 * the session's sink.
 *
 * It owns these rules:
 *  - 3-way scope: user (under HOME), repo-committed (tracked and on the
 *    default branch), repo-local (in a repo but not on its default branch) —
 *    resolved per file by resolveScope.
 *  - Disabled-plugin propagation: a disabled plugin's skills/commands/rules/
 *    hooks/agents each carry operational_state=disabled, not just the plugin.
 *  - Instruction files as their own kinds: CLAUDE.md → claude_md,
 *    AGENTS.md → agents_md (never collapsed into `rule`).
 *  - Credential-stripped repo remote in identity/payload; committed baseline
 *    hash read from the repo default branch.
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, basename, dirname, relative, resolve, isAbsolute, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { agentSkillPaths } from "./agentSkillPaths";
import { reportProblem } from "./log";
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
  loadJsonFile,
  rootGitContext,
  samePath,
  canonicalRoots,
  canonicalDir,
  isTracked,
  collectArtifactManifest,
  isGitWorktree,
  baselineContent,
  resolveScope,
  untrackedPaths,
  walkSkillsDir,
  resolveRepoWinners,
  withReadRoots,
  type GitContext,
} from "./scanShared";
import { hookInlineAssetName, hookFileAssetName } from "./hookAssetName";
import { resolveHookScript, inlineHookSubKey, normalizeMatcher, wiredHookKey } from "./hookResolution";
import { deriveSourcePath } from "./identity";
import type { CollectSession } from "./session";
import { allInScope, type CollectOptions } from "./collectOptions";
import type { CollectedAsset, HarnessAssetPayload, HarnessAssetType, HarnessAssetScope } from "./types";

export const CLAUDE_CODE_IDE = "claude-code";
const IDE = CLAUDE_CODE_IDE;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface ClaudeCollectorState {
  session: CollectSession;
  /** realpaths already collected via plugins — dedups symlinked global copies. */
  pluginRealPaths: Set<string>;
}
type CollectorState = ClaudeCollectorState;

async function push(state: CollectorState, asset: CollectedAsset): Promise<void> {
  await state.session.push(asset);
}

/** activeInAgents cross-reference: which agents carry a same-named skill. */
function computeActiveInAgents(
  agentSkillSets: Map<string, Set<string>>,
  skillFolderName: string,
): string[] {
  const active = ["Claude Code"];
  for (const [agentName, nameSet] of agentSkillSets) {
    if (agentName === "Claude Code") continue;
    if (nameSet.has(skillFolderName.toLowerCase())) active.push(agentName);
  }
  return active;
}

// ─── Global (user-scope) collection ─────────────────────────────────────────

async function collectPlugins(
  state: CollectorState,
  claudeDir: string,
  enabledPlugins: Record<string, boolean>,
  settings: Record<string, unknown> | null,
  agentSkillSets: Map<string, Set<string>>,
): Promise<void> {
  const pluginsFile = join(claudeDir, "plugins", "installed_plugins.json");
  const pluginsData = await loadJsonFile(pluginsFile);
  if (!pluginsData) return;

  const pluginsMap = (pluginsData.plugins ?? pluginsData) as Record<string, unknown>;
  if (typeof pluginsMap !== "object" || pluginsMap === null) return;

  // marketplace-name → source URL from extraKnownMarketplaces
  const marketplaceUrls = new Map<string, string>();
  const extraMarketplaces = settings?.extraKnownMarketplaces;
  if (Array.isArray(extraMarketplaces)) {
    for (const url of extraMarketplaces) {
      if (typeof url === "string") {
        const name = url.replace(/\.git$/, "").split("/").pop();
        if (name) marketplaceUrls.set(name, url);
      }
    }
  }

  const pluginsBase = resolve(join(claudeDir, "plugins"));

  for (const [pluginKey, entries] of Object.entries(pluginsMap)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as unknown[]) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        reportProblem({ severity: "warning", path: pluginsFile, message: `plugin "${pluginKey}" has an entry that is not an object; skipped` });
        continue;
      }
      const record = entry as Record<string, unknown>;
      const rawInstall = record.installPath;
      if (typeof rawInstall !== "string" || rawInstall === "") continue;
      // A relative installPath is relative to the plugins directory, never to the process's cwd.
      const installPath = resolve(pluginsBase, rawInstall);
      if (!installPath.startsWith(pluginsBase + sep) && installPath !== pluginsBase) {
        reportProblem({
          severity: "warning",
          path: rawInstall,
          message: `plugin "${pluginKey}" is installed outside ${pluginsBase}; not read`,
        });
        continue;
      }
      if (!(await isDirectory(installPath))) continue;
      try {
        await collectSinglePlugin(state, pluginKey, record, installPath, enabledPlugins, marketplaceUrls, agentSkillSets);
      } catch (err) {
        reportProblem({
          severity: "warning",
          path: installPath,
          message: `plugin "${pluginKey}" could not be scanned (${err instanceof Error ? err.message : String(err)}); its assets may be incomplete`,
        });
      }
    }
  }
}

/**
 * A plugin's agent definition files: the manifest's `agents` array unioned with
 * the conventional `agents/` directory, deduped by resolved path. Official
 * marketplace plugins (feature-dev, …) ship agents ONLY as the directory, with
 * no manifest declaration — reading just the manifest misses them entirely.
 * Exported for tests.
 */
export async function discoverPluginAgentFiles(
  installPath: string,
  manifest: Record<string, unknown> | null,
): Promise<string[]> {
  // Canonical root for containment checks AND as the base for every returned
  // path — a single representation (realpath) so a manifest-declared file and
  // its agents/-dir duplicate dedupe even when installPath crosses a symlink
  // (e.g. macOS /var → /private/var).
  let root: string;
  try {
    root = await realpath(resolve(installPath));
  } catch {
    return []; // install dir gone — nothing to discover
  }

  const files = new Set<string>();
  const declared = Array.isArray(manifest?.agents) ? (manifest.agents as string[]) : [];
  for (const agentPath of declared) {
    if (typeof agentPath !== "string" || agentPath === "") continue;
    // SECURITY: the manifest is third-party content — a declared agent must
    // resolve INSIDE the plugin install dir (realpath, so a symlink can't
    // smuggle a target out), mirroring resolveHookScript's scope check. An
    // absolute or `..`-escaping entry is dropped, not read.
    let real: string;
    try {
      real = await realpath(resolve(root, agentPath.replace(/^\.\//, "")));
    } catch {
      continue; // declared file missing/unreadable
    }
    const rel = relative(root, real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    files.add(real);
  }
  // The agents/ dir and each file in it get the same containment check as
  // declared entries: git can commit `agents`, or a file in it, as a symlink.
  let agentsDir: string;
  try {
    agentsDir = await realpath(join(root, "agents"));
  } catch {
    return [...files].sort(); // no agents/ dir
  }
  const dirRel = relative(root, agentsDir);
  if (dirRel === "" || dirRel.startsWith("..") || isAbsolute(dirRel)) return [...files].sort();
  for (const entry of await safeReaddir(agentsDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
    let real: string;
    try {
      real = await realpath(resolve(agentsDir, entry.name));
    } catch {
      continue;
    }
    const rel = relative(root, real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue; // a link out of the plugin
    files.add(real);
  }
  return [...files].sort();
}

/** Exported for tests. */
export async function collectSinglePlugin(
  state: CollectorState,
  pluginKey: string,
  entry: Record<string, unknown>,
  installPath: string,
  enabledPlugins: Record<string, boolean>,
  marketplaceUrls: Map<string, string>,
  agentSkillSets: Map<string, Set<string>>,
): Promise<void> {
  const manifestPath = join(installPath, ".claude-plugin", "plugin.json");
  const manifest = await loadJsonFile(manifestPath);

  const keyParts = pluginKey.split("@");
  const pluginNameFromKey = keyParts[0] ?? pluginKey;
  const marketplaceFromKey = keyParts.length > 1 ? keyParts[keyParts.length - 1] : undefined;

  const pluginName = (manifest?.name as string) ?? pluginNameFromKey;
  const pluginVersion = (manifest?.version as string) ?? (entry.version as string) ?? "unknown";
  const marketplace =
    marketplaceFromKey ?? (entry.marketplace as string) ?? (manifest?.marketplace as string) ?? "unknown";
  const sourceUrl = marketplaceUrls.get(marketplace);

  // Default to enabled if not specified. This state propagates to EVERY asset
  // the plugin contributes — a disabled plugin's skills are not "enabled".
  const enabled = enabledPlugins[pluginKey] !== false;
  const opState = enabled ? "enabled" : "disabled";

  const assetCounts = { skills: 0, commands: 0, rules: 0, hooks: 0, agents: 0 };

  const base = (
    type: HarnessAssetType,
    name: string,
    filePath: string,
    contentHash: string,
    extra: Partial<HarnessAssetPayload>,
  ): CollectedAsset => ({
    ideType: IDE,
    type,
    name,
    scope: "user",
    projectPath: "",
    filePath,
    contentHash,
    payload: {
      source: pluginName,
      operational_state: opState,
      plugin_name: pluginName,
      marketplace,
      active_in_agents: ["Claude Code"],
      ...(sourceUrl !== undefined ? { source_url: sourceUrl } : {}),
      ...extra,
    },
  });

  // skills/ and .agents/skills/ (alternate layout)
  for (const skillsDir of [join(installPath, "skills"), join(installPath, ".agents", "skills")]) {
    const skillEntries = await safeReaddir(skillsDir);
    for (const skillEntry of skillEntries) {
      if (!skillEntry.isDirectory() || skillEntry.name.startsWith(".")) continue;
      const skillMdPath = join(skillsDir, skillEntry.name, "SKILL.md");
      const contentBody = await readBody(skillMdPath);
      if (contentBody === null) continue;
      const content = contentBody.text;
      const fm = parseFrontmatter(content);
      const name = fm.name ?? fileNameToDisplayName(skillEntry.name);
      const desc = bestDescription(fm);
      const files = await collectArtifactManifest(join(skillsDir, skillEntry.name), skillMdPath);
      await push(
        state,
        base("skill", name, skillMdPath, contentBody.hash, {
          active_in_agents: computeActiveInAgents(agentSkillSets, skillEntry.name),
          invocation: `/${skillEntry.name}`,
          ...(desc !== undefined ? { description: desc } : {}),
          ...(fm.version !== undefined ? { version: fm.version } : {}),
          ...(files.length > 0 ? { files } : {}),
        }),
      );
      try {
        state.pluginRealPaths.add(await realpath(skillMdPath));
      } catch {
        state.pluginRealPaths.add(skillMdPath);
      }
      assetCounts.skills++;
    }
  }

  // commands/
  const commandsDir = join(installPath, "commands");
  for (const cmdEntry of await safeReaddir(commandsDir)) {
    if (!cmdEntry.isFile() || !cmdEntry.name.endsWith(".md") || cmdEntry.name.startsWith(".")) continue;
    const cmdPath = join(commandsDir, cmdEntry.name);
    const contentBody = await readBody(cmdPath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const cmdName = cmdEntry.name.replace(/\.md$/, "");
    const desc = bestDescription(fm);
    await push(
      state,
      base("command", fm.name ?? fileNameToDisplayName(cmdName), cmdPath, contentBody.hash, {
        invocation: `/${pluginName}:${cmdName}`,
        ...(desc !== undefined ? { description: desc } : {}),
      }),
    );
    assetCounts.commands++;
  }

  // rules in the plugin's known rule homes
  for (const ruleDir of [
    join(installPath, ".cursor", "rules"),
    join(installPath, ".claude", "rules"),
    join(installPath, "rules"),
  ]) {
    for (const ruleEntry of await safeReaddir(ruleDir)) {
      if (!ruleEntry.isFile() || !ruleEntry.name.endsWith(".md") || ruleEntry.name.startsWith(".")) continue;
      const rulePath = join(ruleDir, ruleEntry.name);
      const contentBody = await readBody(rulePath);
      if (contentBody === null) continue;
      const content = contentBody.text;
      const fm = parseFrontmatter(content);
      const ruleName = ruleEntry.name.replace(/\.md$/, "");
      const desc = bestDescription(fm);
      await push(
        state,
        base("rule", fm.name ?? fileNameToDisplayName(ruleName), rulePath, contentBody.hash, {
          ...(desc !== undefined ? { description: desc } : {}),
        }),
      );
      assetCounts.rules++;
    }
  }

  // hooks/hooks.json — ONE ASSET PER NESTED COMMAND.
  //
  // A plugin's hooks.json carries the same nested shape as a settings.json hooks
  // block (event → matcher groups → an inner command list), so one entry can wire
  // several commands. Each command is its own asset, named `${event}: ${label}`
  // through the same two helpers the settings path uses, so a plugin hook and a
  // settings hook that run the same command get the same name.
  const hooksJsonPath = join(installPath, "hooks", "hooks.json");
  const hooksData = await loadJsonFile(hooksJsonPath);
  if (hooksData && typeof hooksData === "object") {
    for (const { eventType, matcher, command, timeoutSeconds } of walkPluginHooks(hooksData)) {
      const hookConfig = { event: eventType, matcher, timeoutSeconds };

      // A plugin's script paths are written against its own install root
      // (`${CLAUDE_PLUGIN_ROOT}`), so that is the root a resolve must be scoped to.
      const resolved = await resolveHookScript(command, installPath, installPath);

      // Sub-key on (matcher, command) so several commands under one event stay
      // distinct assets — without the sub-key they would share hooks.json's source
      // path and collapse into one.
      const subKey = inlineHookSubKey(matcher, command);
      const asset = resolved
        ? base("hook", hookFileAssetName(eventType, resolved.absPath, matcher, resolved.argsHash), resolved.absPath, resolved.hash, {
            description: `Hook for ${eventType} event`,
            hook_command: command,
            hook_config: hookConfig,
          })
        : base("hook", hookInlineAssetName(eventType, command), hooksJsonPath, sha256(command), {
            description: `Hook for ${eventType} event`,
            inline_body: command,
            hook_config: hookConfig,
          });

      await push(state, {
        ...asset,
        ...(resolved ? {} : { sourcePathOverride: `${deriveSourcePath(hooksJsonPath, "")}#${eventType}:${subKey.slice(0, 12)}` }),
      });
      assetCounts.hooks++;
    }
  }

  // agents — manifest-declared and/or the conventional agents/ directory
  for (const absPath of await discoverPluginAgentFiles(installPath, manifest)) {
    const contentBody = await readBody(absPath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const fileName = basename(absPath, ".md");
    const desc = bestDescription(fm);
    await push(
      state,
      base("agent", fm.name || fileNameToDisplayName(fileName), absPath, contentBody.hash, {
        // Plugin-qualified token (the form Claude Code's `subagent_type` uses), so
        // two plugins that ship a same-slug agent stay distinct — mirrors the
        // command assets' invocation.
        invocation: `${pluginName}:${fileName}`,
        ...(desc !== undefined ? { description: desc } : {}),
      }),
    );
    assetCounts.agents++;
  }

  // The plugin itself, with its version, install path and per-kind counts. Two facets:
  //
  // Identity — always the canonical `.claude-plugin/plugin.json` path
  // (`sourcePathOverride`), even when that file is absent. It is file-like and
  // unique per plugin, so the asset keys the same whether or not a manifest
  // exists (a plugin that later gains/loses one keeps its id), and identity is
  // never anchored on the bare install DIRECTORY.
  //
  // Body — never empty. Prefer the manifest, else the README, else the
  // registry line as an inline body; empty files count as absent. `filePath`
  // points at whichever real file supplies the bytes — the install dir only
  // when the body is inline (`inline_body`), which has no file to read.
  const nonEmpty = (b: FileBody | null): FileBody | null => (b !== null && b.size > 0 ? b : null);
  const manifestContent = nonEmpty(await readBody(manifestPath));
  const readmePath = join(installPath, "README.md");
  const readmeContent = manifestContent === null ? nonEmpty(await readBody(readmePath)) : null;
  const inlineBody = manifestContent === null && readmeContent === null ? `${pluginKey}@${pluginVersion}` : null;
  await push(state, {
    ideType: IDE,
    type: "plugin",
    name: pluginName,
    scope: "user",
    projectPath: "",
    filePath: manifestContent !== null ? manifestPath : readmeContent !== null ? readmePath : installPath,
    sourcePathOverride: deriveSourcePath(manifestPath, ""),
    contentHash: (manifestContent ?? readmeContent)?.hash ?? sha256(inlineBody ?? ""),
    payload: {
      source: marketplace,
      operational_state: opState,
      marketplace,
      version: pluginVersion,
      active_in_agents: ["Claude Code"],
      plugin_install_path: installPath,
      plugin_asset_counts: assetCounts,
      ...(sourceUrl !== undefined ? { source_url: sourceUrl } : {}),
      ...(inlineBody !== null ? { inline_body: inlineBody } : {}),
    },
  });
}

/**
 * Walk a skills directory and hand each discovered skill to `pushSkill`, keyed
 * by its folder/file name. Handles the three Claude Code skill layouts: a flat
 * `<name>.md`, a `<name>/SKILL.md`, and level-2 grouped `<group>/<name>/SKILL.md`.
 * Scope-specific concerns (user vs repo, dedup, payload) live in the callback so
 * user- and repo-scope skill scanning share one walk and never drift.
 */
async function collectGlobalSkills(
  state: CollectorState,
  claudeDir: string,
  agentSkillSets: Map<string, Set<string>>,
): Promise<void> {
  await walkSkillsDir(join(claudeDir, "skills"), async (skillKey, filePath, contentBody, files) => {
    const content = contentBody.text;
    // A ~/.claude/skills entry symlinked from an installed plugin is the same
    // asset already collected under the plugin — skip the duplicate.
    try {
      if (state.pluginRealPaths.has(await realpath(filePath))) return;
    } catch {
      // realpath failure → treat as distinct
    }
    const fm = parseFrontmatter(content);
    const desc = bestDescription(fm);
    await push(state, {
      ideType: IDE,
      type: "skill",
      name: fm.name ?? fileNameToDisplayName(skillKey),
      scope: "user",
      projectPath: "",
      filePath,
      contentHash: contentBody.hash,
      payload: {
        source: "claude",
        operational_state: "enabled",
        active_in_agents: computeActiveInAgents(agentSkillSets, skillKey),
        invocation: `/${skillKey}`,
        ...(desc !== undefined ? { description: desc } : {}),
        ...(fm.version !== undefined ? { version: fm.version } : {}),
        // The file manifest of a multi-file skill: SKILL.md alone is often not the whole
        // definition, since it references helper files beside it. Absent for a single-file
        // skill, whose primary IS the whole install.
        ...(files && files.length > 0 ? { files } : {}),
      },
    });
  });
}

async function collectGlobalRules(state: CollectorState, claudeDir: string): Promise<void> {
  const rulesDir = join(claudeDir, "rules");
  for (const entry of await safeReaddir(rulesDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
    const rulePath = join(rulesDir, entry.name);
    const contentBody = await readBody(rulePath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const desc = bestDescription(fm);
    await push(state, {
      ideType: IDE,
      type: "rule",
      name: fm.name ?? fileNameToDisplayName(entry.name.replace(/\.md$/, "")),
      scope: "user",
      projectPath: "",
      filePath: rulePath,
      contentHash: contentBody.hash,
      payload: {
        source: "claude",
        operational_state: "enabled",
        active_in_agents: ["Claude Code"],
        ...(desc !== undefined ? { description: desc } : {}),
      },
    });
  }
}

/**
 * Flatten one plugin `hooks/hooks.json` into the same (event, matcher, command)
 * entries a settings.json hooks block yields.
 *
 * A plugin file wraps its event map in `hooks` and may carry sibling metadata
 * keys (`description`, a `"//"` comment) beside it, so the event map is read from
 * `hooks` when that is an object, and from the root otherwise.
 */
export function* walkPluginHooks(
  hooksData: Record<string, unknown>,
): Generator<{ eventType: string; matcher: string; command: string; timeoutSeconds: number }> {
  const inner = (hooksData as { hooks?: unknown }).hooks;
  const eventMap = (
    inner && typeof inner === "object" && !Array.isArray(inner) ? inner : hooksData
  ) as Record<string, unknown>;
  yield* walkSettingsHooks(eventMap);
}

/**
 * Walk one settings.json `hooks` block into flat (event, matcher, command)
 * entries. Claude Code's shape is nested — `hooks[event]` is an array of
 * matcher groups, each with a `hooks: [{type, command}]` list — with a
 * defensive fallback for a flat entry that carries `command` directly. Shared
 * by the live scan and the committed-baseline lookup so the two traversals
 * (and therefore inline-hook identity) can never drift.
 */
export function* walkSettingsHooks(
  hooks: Record<string, unknown>,
): Generator<{ eventType: string; matcher: string; command: string; timeoutSeconds: number }> {
  for (const [eventType, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      // The matcher distinguishes two groups under the same event that run the
      // same command — part of an inline hook's identity so they don't collide.
      const matcher = normalizeMatcher((group as { matcher?: unknown })?.matcher);
      const inner = Array.isArray((group as { hooks?: unknown })?.hooks)
        ? ((group as { hooks: unknown[] }).hooks)
        : [group];
      for (const entry of inner) {
        const command = (entry as { command?: unknown })?.command;
        if (typeof command !== "string" || command === "") continue;
        // Per-entry timeout in seconds; absent or not positive → 0, meaning unset.
        const rawTimeout = (entry as { timeout?: unknown })?.timeout;
        const timeoutSeconds = typeof rawTimeout === "number" && rawTimeout > 0 ? rawTimeout : 0;
        yield { eventType, matcher, command, timeoutSeconds };
      }
    }
  }
}

/**
 * Wired-hook keys ({@link wiredHookKey}: event, matcher, command) of every hook entry in a
 * committed settings.json body. Purely textual — membership is what classifies a live
 * inline entry as committed, so a committed command moved to another event locally is not;
 * no script resolution. A null/unparseable body yields the empty set (no entry can prove
 * itself committed).
 */
export function committedInlineHookKeys(committedBody: string | null): Set<string> {
  const keys = new Set<string>();
  if (committedBody === null) return keys;
  let parsed: unknown;
  try {
    parsed = JSON.parse(committedBody);
  } catch {
    return keys;
  }
  const hooks = (parsed as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return keys;
  for (const { eventType, matcher, command } of walkSettingsHooks(hooks as Record<string, unknown>)) {
    keys.add(wiredHookKey(eventType, matcher, command));
  }
  return keys;
}

/**
 * Capture hooks from one settings.json (walked via {@link walkSettingsHooks}).
 * A command that resolves to a real script file is captured as that file
 * (hashed and git-scoped like any asset); an inline command is captured with
 * the command string as its body, sub-keyed so multiple inline hooks in one
 * file stay distinct artifacts. `ctx` is the repo context, or null for the
 * user-global settings.json.
 */
async function collectSettingsHooks(
  state: CollectorState,
  settingsPath: string,
  settings: Record<string, unknown> | null,
  ctx: ProjectContext | null = null,
): Promise<void> {
  const hooks = settings?.hooks as Record<string, unknown> | undefined;
  if (!hooks || typeof hooks !== "object") return;

  const projectDir = ctx?.projectKey ?? "";
  // A hook script must resolve INSIDE this root or it is not treated as a file
  // (see resolveHookScript's SECURITY note): the repo for repo scope, ~/.claude
  // (the settings file's own dir) for user scope.
  const scopeRoot = ctx ? ctx.projectKey : dirname(settingsPath);
  const sourceLabel = ctx ? basename(ctx.projectKey) : "claude-settings";
  const settingsRel = ctx ? relative(ctx.projectKey, settingsPath) : relative(homedir(), settingsPath);
  // An inline hook is a fragment of settings.json, so its git state is
  // per-entry, not per-file: it is repo-committed only if the same
  // (event, matcher, command) entry exists in the settings.json body on the repo
  // default branch — its baseline is then its own body (identity is
  // content-addressed, so an edited command is a new artifact, never a
  // drifted one). Anything else — entry added locally, settings.json
  // untracked or absent from the default branch — is repo-local. This keeps
  // the scope invariant (repo-committed ⇔ baseline set) true for fragments,
  // where whole-file baselines are underivable.
  let committedKeys = new Set<string>();
  if (ctx?.git.isRepo) {
    const rel = relative(ctx.git.topLevel, settingsPath);
    if (isTracked(ctx.git, rel)) {
      committedKeys = committedInlineHookKeys(
        await baselineContent(ctx.git.topLevel, ctx.git.defaultBranch, rel),
      );
    }
  }

  for (const { eventType, matcher, command, timeoutSeconds } of walkSettingsHooks(hooks)) {
    const hookConfig = { event: eventType, matcher, timeoutSeconds };

    const resolved = await resolveHookScript(command, projectDir, scopeRoot);
    if (resolved) {
      // File-backed hook → the real script is the asset. repo-committed needs BOTH the wiring
      // in the committed settings file AND the script on the default branch, as the Codex and
      // Cursor readers decide: a committed script wired only in settings.local.json is local.
      const wiringCommitted = committedKeys.has(wiredHookKey(eventType, matcher, command));
      const { scope, baseline } = !ctx
        ? { scope: "user" as HarnessAssetScope, baseline: undefined }
        : wiringCommitted
          ? await resolveScope(ctx.git, resolved.absPath)
          : { scope: "repo-local" as HarnessAssetScope, baseline: undefined };
      await push(state, {
        ideType: IDE,
        type: "hook",
        name: hookFileAssetName(eventType, resolved.absPath, matcher, resolved.argsHash),
        scope,
        projectPath: ctx ? ctx.projectKey : "",
        filePath: resolved.absPath,
        contentHash: resolved.hash,
        payload: {
          source: sourceLabel,
          operational_state: "enabled",
          active_in_agents: ["Claude Code"],
          description: `Hook for ${eventType} event`,
          hook_command: command,
          hook_config: hookConfig,
          ...(ctx?.git.remoteUrl ? { repo_remote_url: ctx.git.remoteUrl } : {}),
          ...(baseline !== undefined ? { baseline_content_hash: baseline } : {}),
        },
      });
    } else {
      // Inline command → the command string IS the body. Sub-key on a
      // stable hash of the command so N inline hooks in one settings.json
      // are distinct assets (each gets its own source path) and stay stable
      // across reordering. A committed entry's baseline is that
      // same body — see the committedKeys note above.
      const subKey = inlineHookSubKey(matcher, command);
      const committed = committedKeys.has(wiredHookKey(eventType, matcher, command));
      const scope: HarnessAssetScope = !ctx ? "user" : committed ? "repo-committed" : "repo-local";
      await push(state, {
        ideType: IDE,
        type: "hook",
        name: hookInlineAssetName(eventType, command),
        scope,
        projectPath: ctx ? ctx.projectKey : "",
        filePath: settingsPath,
        sourcePathOverride: `${settingsRel}#${eventType}:${subKey.slice(0, 12)}`,
        contentHash: sha256(command),
        payload: {
          source: sourceLabel,
          operational_state: "enabled",
          active_in_agents: ["Claude Code"],
          // Same wording as a file-backed hook: `inline_body` versus
          // `hook_command` already tells the two apart.
          description: `Hook for ${eventType} event`,
          inline_body: command,
          hook_config: hookConfig,
          ...(ctx?.git.remoteUrl ? { repo_remote_url: ctx.git.remoteUrl } : {}),
          ...(ctx && committed ? { baseline_content_hash: sha256(command) } : {}),
        },
      });
    }
  }
}

async function collectStandaloneAgents(state: CollectorState, claudeDir: string): Promise<void> {
  const agentsDir = join(claudeDir, "agents");
  for (const entry of await safeReaddir(agentsDir)) {
    if (entry.name.startsWith(".") || !entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = join(agentsDir, entry.name);
    const contentBody = await readBody(filePath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const desc = bestDescription(fm);
    await push(state, {
      ideType: IDE,
      type: "agent",
      name: fm.name || fileNameToDisplayName(entry.name),
      scope: "user",
      projectPath: "",
      filePath,
      contentHash: contentBody.hash,
      payload: {
        source: "standalone",
        operational_state: "enabled",
        active_in_agents: ["Claude Code"],
        ...(desc !== undefined ? { description: desc } : {}),
      },
    });
  }
}

// ─── Project (repo-scope) collection ─────────────────────────────────────────

interface ProjectContext {
  /** Canonical project key: the git toplevel when in a repo, else the scanned dir. */
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
      active_in_agents: ["Claude Code"],
      ...(ctx.git.remoteUrl !== "" ? { repo_remote_url: ctx.git.remoteUrl } : {}),
      ...(baseline !== undefined ? { baseline_content_hash: baseline } : {}),
      ...extra,
    },
  });
}

async function collectSingleProject(state: CollectorState, dir: string, ctx: ProjectContext): Promise<void> {
  // .claude/rules/*.md
  const rulesDir = join(dir, ".claude", "rules");
  for (const entry of await safeReaddir(rulesDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
    const rulePath = join(rulesDir, entry.name);
    const contentBody = await readBody(rulePath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const desc = bestDescription(fm);
    await pushProjectFile(
      state,
      ctx,
      "rule",
      fm.name ?? fileNameToDisplayName(entry.name.replace(/\.md$/, "")),
      rulePath,
      contentBody,
      desc !== undefined ? { description: desc } : {},
    );
  }

  // .claude/templates/*.md — prompt-template files (repo scope only), reported
  // as `prompt_template` at the repo-relative `.claude/templates/<slug>.md`.
  //
  // Scanned from ctx.projectKey (the git top level for a repo, else dir), NOT
  // dir, so a template at the repo root is found even when the scan entered
  // through a subdirectory; the rules, commands, agents and skills blocks scan
  // `dir`. Idempotent across subdirectories that share one projectKey: push()
  // dedups on the asset id, which derives from the projectKey-relative source path.
  const templatesDir = join(ctx.projectKey, ".claude", "templates");
  for (const entry of await safeReaddir(templatesDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
    const tmplPath = join(templatesDir, entry.name);
    const contentBody = await readBody(tmplPath);
    if (contentBody === null) continue;
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const desc = bestDescription(fm);
    await pushProjectFile(
      state,
      ctx,
      "prompt_template",
      fm.name ?? fileNameToDisplayName(entry.name.replace(/\.md$/, "")),
      tmplPath,
      contentBody,
      desc !== undefined ? { description: desc } : {},
    );
  }

  // .claude/commands/*.md
  const commandsDir = join(dir, ".claude", "commands");
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

  // .claude/agents/*.md — project-scoped subagents. User-scope agents come from
  // collectStandaloneAgents. pushProjectFile resolves repo-committed vs repo-local.
  const agentsDir = join(dir, ".claude", "agents");
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

  // .claude/skills/**/SKILL.md — project-scoped skills. User-scope skills come
  // from collectGlobalSkills. pushProjectFile resolves repo-committed vs repo-local.
  await walkSkillsDir(join(dir, ".claude", "skills"), async (skillKey, filePath, contentBody, files) => {
    const content = contentBody.text;
    const fm = parseFrontmatter(content);
    const desc = bestDescription(fm);
    await pushProjectFile(state, ctx, "skill", fm.name ?? fileNameToDisplayName(skillKey), filePath, contentBody, {
      invocation: `/${skillKey}`,
      ...(desc !== undefined ? { description: desc } : {}),
      ...(fm.version !== undefined ? { version: fm.version } : {}),
      // Same manifest contract as user scope — a project skill is the more likely one to
      // span several files, so reading SKILL.md alone misses the definition most often here.
      ...(files && files.length > 0 ? { files } : {}),
    });
  });

  // Instruction files keep their own kinds (never collapsed to `rule`).
  const claudeMdPath = join(dir, "CLAUDE.md");
  const claudeMdBody = await readBody(claudeMdPath);
  if (claudeMdBody !== null) {
    await pushProjectFile(state, ctx, "claude_md", "CLAUDE.md", claudeMdPath, claudeMdBody, {});
  }
  const agentsMdPath = join(dir, "AGENTS.md");
  const agentsMdBody = await readBody(agentsMdPath);
  if (agentsMdBody !== null) {
    await pushProjectFile(state, ctx, "agents_md", "AGENTS.md", agentsMdPath, agentsMdBody, {});
  }

  // Repo-scoped hooks: .claude/settings.json (committed) + settings.local.json
  // (personal). Same nested-shape parse + script-file resolution as user scope.
  for (const name of ["settings.json", "settings.local.json"]) {
    const settingsPath = join(dir, ".claude", name);
    const settings = await loadJsonFile(settingsPath);
    if (settings) await collectSettingsHooks(state, settingsPath, settings, ctx);
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Collect every Claude Code asset: user scope under ~/.claude, then each root.
 * Every scanned project key lands in `session.scannedKeys`; a root that cannot be
 * listed is reported as an error and does not.
 */
export async function collectClaudeCodeAssets(session: CollectSession, opts: CollectOptions): Promise<void> {
  const roots = canonicalRoots(opts.roots);
  await withReadRoots(roots.map((r) => r.path), () => collectAll(session, { ...opts, roots }));
}

async function collectAll(session: CollectSession, opts: CollectOptions): Promise<void> {
  const state: CollectorState = { session, pluginRealPaths: new Set() };
  const home = homedir();
  const claudeDir = join(home, ".claude");

  // Cross-agent skill dirs for activeInAgents: one set per tool, in probe order, so a tool
  // with several folders is listed once and the order does not depend on which read ends first.
  const agentSkillSets = new Map<string, Set<string>>();
  const probes = agentSkillPaths(home);
  for (const [agentName] of probes) if (!agentSkillSets.has(agentName)) agentSkillSets.set(agentName, new Set());
  await Promise.all(
    probes.map(async ([agentName, dir]) => {
      const names = agentSkillSets.get(agentName)!;
      for (const e of await safeReaddir(dir)) names.add(e.name.toLowerCase());
    }),
  );

  const settingsPath = join(claudeDir, "settings.json");
  const settings = await loadJsonFile(settingsPath);
  const enabledPlugins = (settings?.enabledPlugins as Record<string, boolean>) ?? {};

  // User scope. Plugins first so symlinked global copies dedup against them.
  await collectPlugins(state, claudeDir, enabledPlugins, settings, agentSkillSets);
  await collectGlobalSkills(state, claudeDir, agentSkillSets);
  await collectGlobalRules(state, claudeDir);
  await collectSettingsHooks(state, settingsPath, settings);
  await collectStandaloneAgents(state, claudeDir);

  // User-global instruction file.
  const globalClaudeMdPath = join(claudeDir, "CLAUDE.md");
  const globalClaudeMdBody = await readBody(globalClaudeMdPath);
  if (globalClaudeMdBody !== null) {
    await push(state, {
      ideType: IDE,
      type: "claude_md",
      name: "CLAUDE.md",
      scope: "user",
      projectPath: "",
      filePath: globalClaudeMdPath,
      contentHash: globalClaudeMdBody.hash,
      payload: { source: "claude", operational_state: "enabled", active_in_agents: ["Claude Code"] },
    });
  }

  // Repo scopes. A project counts as scanned (it goes into `scannedKeys`)
  // only when its directory was actually readable in this scan, so a caller
  // does not delete what it stored for a folder it could not read. Resolve every
  // candidate checkout first, then collect the per-repo WINNERS before their
  // siblings (resolveRepoWinners): a file shared by two checkouts of one repo
  // is claimed by the winning checkout (via push's seenIds), while a file
  // unique to a sibling is still collected. Winner = latest-active in-scope
  // checkout, so a shared file never lands on a checkout the caller ignores.
  const scannedProjectKeys = session.scannedKeys;
  const candidates: Array<{ dir: string; ctx: ProjectContext }> = [];
  for (const { path: root, isWorktree } of opts.roots) {
    if (isWorktree) {
      // A worktree mirrors the main checkout's config, so its assets are duplicates.
      // Skip it, but add it to `scannedKeys`, so a caller that mirrors the inventory deletes what it stored for this path.
      scannedProjectKeys.add(root);
      continue;
    }
    if (samePath(root, home)) {
      // $HOME/.claude IS the user scope (already collected above); scanning
      // $HOME as a project would re-file those user skills/commands under a
      // phantom repo. Skip it, but add it to `scannedKeys`, so a caller that mirrors the inventory deletes what it stored for this path.
      scannedProjectKeys.add(root);
      continue;
    }
    const entries = await readRootEntries(root);
    if (entries === null) continue;
    const git = await rootGitContext(root);
    // A root DEEP inside a worktree has no .git of its own, so the
    // per-root isWorktree check misses it while readGitContext still
    // resolves topLevel to the worktree. Skip (its assets duplicate the main
    // checkout), but add that topLevel to `scannedKeys`, so a caller that mirrors
    // the inventory deletes what it stored for the worktree.
    if (git.isRepo && (await isGitWorktree(git.topLevel))) {
      scannedProjectKeys.add(git.topLevel);
      continue;
    }
    // A root inside a repo also reads the repo's top level, as the other readers do.
    if (git.isRepo && git.topLevel !== root) candidates.push({ dir: git.topLevel, ctx: { projectKey: git.topLevel, git } });
    candidates.push({ dir: root, ctx: { projectKey: git.isRepo ? git.topLevel : root, git } });

    // Immediate subdirectories with their own agent config (monorepo support).
    for (const sub of entries) {
      if (!sub.isDirectory() || sub.name.startsWith(".") || sub.name === "node_modules") continue;
      const subPath = join(root, sub.name);
      if (samePath(subPath, home)) {
        reportProblem({ severity: "warning", root: subPath, message: "is the home directory: its config is scanned as user scope, not as a repo" });
        continue;
      }
      // A link to a folder already read (alias -> pkg) would report its files again.
      if (candidates.some((c) => samePath(c.dir, subPath))) continue;
      if (
        (await isDirectory(join(subPath, ".claude"))) ||
        (await isFile(join(subPath, "CLAUDE.md"))) ||
        (await isFile(join(subPath, "AGENTS.md")))
      ) {
        // A root already found to sit in the HOME repo was warned about once; its subfolders reuse that.
        const subGit = await rootGitContext(subPath, !git.isRepo);
        // A worktree or submodule is its own checkout: the same skip as for a root.
        if (subGit.isRepo && subGit.topLevel !== git.topLevel && (await isGitWorktree(subGit.topLevel))) {
          reportProblem({
            severity: "warning",
            root: subPath,
            message: "skipped: its git top level has a .git file (a linked worktree or a submodule), which is not scanned",
          });
          scannedProjectKeys.add(subGit.topLevel);
          continue;
        }
        candidates.push({
          dir: subPath,
          ctx: { projectKey: subGit.isRepo ? subGit.topLevel : subPath, git: subGit },
        });
      }
    }
  }

  const winners = await resolveRepoWinners(
    candidates.map((c) => ({ remoteUrl: c.ctx.git.remoteUrl, projectKey: c.ctx.projectKey })),
    opts.inScope ?? allInScope,
  );
  // Every winning copy finishes, folder passes then deep passes, before any losing copy runs,
  // so a losing copy never claims a file the copies share. The deep pass (CLAUDE.md at any
  // depth, once per repo or plain folder) runs after its group's folder passes, so the files
  // they report keep their ids and are not reported twice.
  // Real paths, so the walk also leaves out a candidate folder it reaches through a link.
  const candidateDirs = new Set(await Promise.all(candidates.map((c) => realpath(c.dir).catch(() => c.dir))));
  const reported = await realClaudeMdPaths(candidates.map((c) => c.dir));
  const nestedDone = new Set<string>();
  for (const group of [
    candidates.filter((c) => winners.has(c.ctx.projectKey)),
    candidates.filter((c) => !winners.has(c.ctx.projectKey)),
  ]) {
    for (const { dir, ctx } of group) {
      scannedProjectKeys.add(ctx.projectKey);
      await collectSingleProject(state, dir, ctx);
    }
    for (const { dir, ctx } of group) {
      if (nestedDone.has(ctx.projectKey)) continue;
      nestedDone.add(ctx.projectKey);
      await collectNestedClaudeMd(state, ctx.git.isRepo ? ctx.git.topLevel : dir, ctx, candidateDirs, reported);
    }
  }
}

/** At most this many CLAUDE.md files per repo; past it, a warning. */
let nestedClaudeMdCap = 1000;
/** Lower the cap, so a test can reach it without a thousand files. */
export function __setNestedClaudeMdCapForTest(cap: number): void {
  nestedClaudeMdCap = cap;
}
/** Depth bound for the walk of a folder outside git. */
const PLAIN_WALK_MAX_DEPTH = 8;
const skippedFolder = (name: string): boolean => name.startsWith(".") || name === "node_modules";

/**
 * Every CLAUDE.md under a repo's top level, at any depth: Claude Code loads one as it works in
 * that folder. A repo's candidates come from git's own file list (tracked, plus untracked
 * files that are not ignored), so ignored folders are skipped and no tree is walked. A folder
 * outside git, or a repo git could not list, gets a bounded walk. Dot folders, `node_modules`
 * and nested repos are skipped. The file is the one Claude Code opens, `CLAUDE.md` as the disk
 * resolves that name, so a `claude.md` counts on a case-insensitive disk, as in the folder pass.
 */
async function collectNestedClaudeMd(
  state: CollectorState,
  base: string,
  ctx: ProjectContext,
  candidateDirs: Set<string>,
  reported: Set<string>,
): Promise<void> {
  let found: string[];
  if (ctx.git.isRepo && ctx.git.listed) {
    const untracked = await untrackedPaths(base, [":(icase)CLAUDE.md", ":(icase)*/CLAUDE.md"]);
    if (untracked === null) {
      reportProblem({ severity: "warning", root: base, message: "git could not list its untracked files; untracked CLAUDE.md files below the top level are not reported" });
    }
    found = [...ctx.git.tracked, ...(untracked ?? [])].filter(isClaudeMdPath);
  } else {
    // Outside git, or git could not list the repo: its files then read as repo-local, as the
    // repo's warning says. Inside a repo the candidate folders share its key, so none is left
    // to a pass of its own.
    found = await walkForClaudeMd(base, ctx.git.isRepo ? new Set() : candidateDirs, reported);
  }
  const rels = [...new Set(found.map((p) => join(dirname(p), "CLAUDE.md")))].sort();
  let count = 0;
  for (const rel of rels) {
    const folders = rel.split("/").slice(0, -1);
    if (folders.some(skippedFolder)) continue;
    if (ctx.git.isRepo && (await insideNestedRepo(base, folders))) continue;
    const abs = join(base, rel);
    // Already reported by a folder pass, perhaps through a linked folder (alias -> pkg).
    if (reported.has(await realpath(abs).catch(() => abs))) continue;
    if (count >= nestedClaudeMdCap) {
      // Warn only when a file the pass would report is left out.
      if ((await readBody(abs)) !== null) {
        reportProblem({ severity: "warning", root: base, message: `more than ${nestedClaudeMdCap} CLAUDE.md files; the rest are not reported` });
        return;
      }
      continue;
    }
    const body = await readBody(abs);
    if (body === null) continue;
    count++;
    await pushProjectFile(state, ctx, "claude_md", "CLAUDE.md", abs, body, {});
  }
}

/** Real paths of the CLAUDE.md files the folder passes read in `dirs`. */
async function realClaudeMdPaths(dirs: string[]): Promise<Set<string>> {
  return new Set(await Promise.all(dirs.map((d) => realpath(join(d, "CLAUDE.md")).catch(() => ""))));
}

const isClaudeMdPath = (p: string): boolean => basename(p).toLowerCase() === "claude.md";

/** Whether a folder between the top level and the file has its own `.git` (a nested repo or
 *  submodule, whose files are its own). */
async function insideNestedRepo(base: string, folders: string[]): Promise<boolean> {
  for (let i = 1; i <= folders.length; i++) {
    if (await lstat(join(base, ...folders.slice(0, i), ".git")).then(() => true, () => false)) return true;
  }
  return false;
}

/** CLAUDE.md paths below a folder, breadth-first, at most PLAIN_WALK_MAX_DEPTH folders deep
 *  (with a warning when deeper folders are left out) and one past the cap, leaving out the
 *  files the folder passes reported. Another candidate folder is left to its own pass, HOME is
 *  user scope, and a folder reached again through a link is walked once.
 *  Note: only the depth is bounded; bound the folders visited if a huge plain tree shows up. */
async function walkForClaudeMd(base: string, candidateDirs: Set<string>, reported: Set<string>): Promise<string[]> {
  const out: string[] = [];
  const home = homedir();
  const baseReal = await realpath(base).catch(() => base);
  const walked = new Set<string>([baseReal]);
  let level = [base];
  for (let depth = 0; level.length > 0; depth++) {
    if (depth > PLAIN_WALK_MAX_DEPTH) {
      reportProblem({ severity: "warning", root: base, message: `folders more than ${PLAIN_WALK_MAX_DEPTH} levels down are not searched for CLAUDE.md` });
      break;
    }
    const next: string[] = [];
    for (const dir of level) {
      const entries = await safeReaddir(dir);
      if (dir !== base && entries.some((e) => e.name === ".git")) continue;
      for (const e of entries) {
        const abs = join(dir, e.name);
        if (e.isFile() && isClaudeMdPath(e.name)) {
          if (!reported.has(await realpath(abs).catch(() => abs))) out.push(relative(base, abs));
        } else if (e.isDirectory() && !skippedFolder(e.name) && !samePath(abs, home)) {
          const real = await realpath(abs).catch(() => abs);
          // A link out of the folder leads to files that are not its own.
          if (walked.has(real) || candidateDirs.has(real) || !real.startsWith(baseReal + sep)) continue;
          walked.add(real);
          next.push(abs);
        }
      }
    }
    level = next;
  }
  return out.sort();
}

/**
 * Collect ONE repo's Claude Code assets — the real per-repo inventory path
 * (`readGitContext` + `collectSingleProject`), without the user scope or the
 * multi-root winner selection. A non-git dir collects at repo-local scope
 * (projectKey = dir).
 */
export async function collectClaudeCodeRepoAssets(session: CollectSession, dir: string): Promise<void> {
  dir = canonicalDir(dir);
  await withReadRoots([dir], async () => {
    const state: CollectorState = { session, pluginRealPaths: new Set() };
    const git = await rootGitContext(dir);
    const ctx = { projectKey: git.isRepo ? git.topLevel : dir, git };
    session.scannedKeys.add(ctx.projectKey);
    // A package inside a repo also reads the repo's top level, as collectAll does.
    if (git.isRepo && git.topLevel !== dir) await collectSingleProject(state, git.topLevel, ctx);
    await collectSingleProject(state, dir, ctx);
    const dirs = git.isRepo && git.topLevel !== dir ? [git.topLevel, dir] : [dir];
    await collectNestedClaudeMd(state, git.isRepo ? git.topLevel : dir, ctx, new Set(), await realClaudeMdPaths(dirs));
  });
}