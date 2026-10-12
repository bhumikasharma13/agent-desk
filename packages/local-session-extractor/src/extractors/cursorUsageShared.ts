// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Shared helpers for reading which harness artifact a Cursor tool call used,
 * for both the IDE and CLI surfaces: the file-path classifier, the tool-argument
 * reader, and `declaredArtifactOf`, which names the skill or agent a call declares.
 *
 * What a read classifies as, by path:
 *   skill   — a SKILL.md read (incl. a plugin-shipped skill)
 *   agent   — a subagent-dispatch tool call (task_v2 on IDE, Task on CLI)
 *   hook    — a read of a file under a hook dir (.git/hooks, .claude/hooks, …)
 *   rule    — a read under .claude/rules or .cursor/rules
 *   claude_md / agents_md — a read of CLAUDE.md / AGENTS.md
 *
 * NB: hook/rule/claude_md/agents_md are FILE READS, not true tool "invocations" —
 * CLAUDE.md/AGENTS.md are often auto-injected, so they may show zero reads even
 * when fully in effect. A zero means "not read as a tool call", not "not used".
 */

/** An artifact type key (note `agents_md`, not `agent_md`). */
export type CursorAssetType =
  | "skill"
  | "plugin"
  | "command"
  | "agent"
  | "hook"
  | "rule"
  | "claude_md"
  | "agents_md";

export interface ClassifiedAsset {
  assetType: CursorAssetType;
  assetName: string;
  assetPath: string;
}

/**
 * Classify a file path a tool touched into the asset it represents, or null if
 * it isn't a tracked asset. Order matters — most-specific first (a plugin's
 * SKILL.md must win over the generic skill rule). Path-based only; `command` and
 * `agent` are not path-based (handled by each surface's parser).
 */
export function classifyPath(path: string): ClassifiedAsset | null {
  if (!path) return null;

  // skill — any SKILL.md, INCLUDING a plugin-shipped one
  // (…/plugins/cache/…/skills/<name>/SKILL.md). A plugin's contained skill is
  // inventoried as a `type='skill'` row (the `plugin` row is only the bundle
  // manifest), so classify the read as a skill — not `plugin` — or the type-scoped
  // match can't reach it. Emit the SKILL.md FILE path (not its dir), so a
  // consumer matching on the file path hits it.
  if (path.endsWith("SKILL.md")) {
    return { assetType: "skill", assetName: skillDir(path), assetPath: path };
  }
  // rule
  if (path.includes("/.claude/rules/") || path.includes("/.cursor/rules/") || path.includes("/.codex/rules/")) {
    return { assetType: "rule", assetName: baseName(path), assetPath: path };
  }
  // hook — match LOCATION, not extension (git hooks like pre-push have none)
  if (/\/(\.git\/hooks|\.githooks|\.claude\/hooks|\.codex\/hooks|\.cursor\/hooks)\//.test(path)) {
    return { assetType: "hook", assetName: baseName(path), assetPath: path };
  }
  // claude_md / agents_md
  if (path.endsWith("CLAUDE.md")) {
    return { assetType: "claude_md", assetName: "CLAUDE.md", assetPath: path };
  }
  if (path.endsWith("AGENTS.md")) {
    return { assetType: "agents_md", assetName: "AGENTS.md", assetPath: path };
  }
  return null;
}

/** …/skills/<name>/SKILL.md or …/skills-cursor/<name>/SKILL.md -> "<name>". */
export function skillDir(path: string): string {
  const m = path.match(/\/(?:skills|skills-cursor)\/([^/]+)\/SKILL\.md$/);
  if (m?.[1]) return m[1];
  return dirOf(path).split("/").pop() ?? path;
}

/** Read an args object's file-path field across IDE + CLI tool schemas. */
export function pathArg(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const k of ["file_path", "path", "target_file", "notebook_path"]) {
    const v = a[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

/**
 * Parse a Cursor tool call's args, tolerant of which field carries them. Most
 * tools populate `rawArgs`, but `task_v2` leaves `rawArgs` null and puts its
 * args in `params` — so fall back to `params`. rawArgs is preferred so no
 * path-carrying tool reads `params`; the fallback only adds the `task_v2` case.
 */
export function toolArgs(tfd: { rawArgs?: unknown; params?: unknown } | undefined | null): Record<string, unknown> {
  if (!tfd) return {};
  return asObject(tfd.rawArgs) ?? asObject(tfd.params) ?? {};
}

/**
 * Tool names whose call LOADS an artifact's instructions, per harness vocabulary.
 *
 * An ALLOWLIST rather than a list of tools to exclude, because the two directions fail
 * differently and only one of them fabricates. A reader missing from here costs a declaration
 * we could have positioned; a mutator or a searcher admitted by mistake asserts an invocation
 * at a sequence where the artifact was merely edited or matched — and grounding overrides the
 * model, so the fabrication wins. Measured on a real Cursor CLI store, of the 276 tool calls
 * whose args name a `SKILL.md`, 38 are `Grep`, `Glob` or a dispatch: only the read is the
 * invocation.
 */
const INSTRUCTION_LOADING_TOOLS = new Set([
  // Cursor IDE, both the unversioned name and the versioned form beside it.
  "read_file",
  "read_file_v2",
  // Cursor CLI.
  "Read",
]);

/** What one tool call put in play, for the timeline's declaration event. */
export interface DeclaredArtifact {
  /** Always `skill`: it is the only artifact kind a tool call can declare. See below. */
  assetType: "skill";
  assetName: string;
}

/**
 * The artifact one tool call put in play, or null when it put none there.
 *
 * Feeds the timeline's declaration events, and must agree on the NAME with the usage row the
 * same call produces — a consumer joins a positioned event to a declaration by that name, so a
 * differently-spelled derivation would emit events that match nothing and position nothing.
 * Both sides read the name out of `classifyPath`, which is what keeps them equal.
 *
 * ONE channel qualifies: a `SKILL.md` read. On Cursor there is no `Skill` tool, so loading a
 * skill's instructions IS its invocation. Two conditions, both required — the tool must be one
 * that loads instructions, and the path must resolve to a skill.
 *
 * Deliberately NOT here, because each would assert an invocation that did not happen:
 *
 *  - a subagent dispatch. An agent is not a declaring artifact: it arrives as its own delegated
 *    session and is counted where its own cycle was observed. Emitting its name here would make
 *    the call a `SKILL_CALL`, which resolves against skill and command inventory only — so a
 *    dispatch sharing a name with an installed skill would position THAT skill at a sequence it
 *    never ran.
 *  - a read of a hook/rule/CLAUDE.md file. Reading the file is not running the hook; a hook
 *    runs when the harness fires it on an event, which is a separate signal on a separate
 *    path. `HOOK_CALL` from a file read would claim a run nothing performed.
 *  - an auto-attached `context.cursorRules[]` entry. It carries no tool call to sit at, and
 *    it persists across every bubble of the conversation, so no bubble is the invoking one —
 *    positioning it anywhere asserts a place the data does not record. It stays a
 *    conversation-grained usage signal and reaches a consumer as an UNPOSITIONED
 *    declaration, which is the honest shape for context the harness injected on its own.
 *
 * Engine-agnostic on purpose: it takes a tool name and a plain args object, so any harness
 * whose transcript names its tool calls can route through it rather than growing its own copy —
 * adding that harness's reader to the allowlist above is the whole integration.
 */
export function declaredArtifactOf(
  toolName: string | undefined,
  args: Record<string, unknown>,
): DeclaredArtifact | null {
  if (!toolName || !INSTRUCTION_LOADING_TOOLS.has(toolName)) return null;
  const hit = classifyPath(pathArg(args));
  return hit && hit.assetType === "skill" ? { assetType: "skill", assetName: hit.assetName } : null;
}

/** A JSON-string-or-object value as a plain object, or null (arrays/primitives → null). */
export function asObject(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v !== "string") return null;
  try {
    const p = JSON.parse(v) as unknown;
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}


function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : path;
}

function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}
