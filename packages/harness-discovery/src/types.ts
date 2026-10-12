// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * The discovered-asset contract. An asset's identity is {@link harnessAssetId}
 * over (ide, scope, repo anchor, source path, type, name); its body is
 * `contentHash`. Import-free, so a consumer can import the types alone.
 */

/** What kind of harness asset a file (or a hook entry) is. */
export type HarnessAssetType =
  | "skill"
  | "plugin"
  | "command"
  | "rule"
  | "hook"
  | "agent"
  | "claude_md"
  | "agents_md"
  | "prompt_template";

/**
 * Three-way scope: user (under HOME), repo-committed (tracked and on the default branch),
 * repo-local (in a repo, or a scanned directory, but not on its default branch).
 */
export type HarnessAssetScope = "user" | "repo-local" | "repo-committed";

export type HarnessOperationalState = "enabled" | "disabled";

/** One file of a multi-file asset's file list, as the scan observed it. */
export interface HarnessAssetFile {
  /** Path relative to the asset's grouping DIRECTORY (the one holding the
   *  primary), so a skill's primary is "SKILL.md" and a helper is
   *  "scripts/deploy.sh". */
  relativePath: string;
  /** sha256 of the body. */
  contentHash: string;
  /** Absolute on-disk path, so the body can be re-read. */
  absPath: string;
  /** The anchor — a skill's SKILL.md. Exactly one per manifest. */
  isPrimary: boolean;
}

/** Per-kind counts of what one plugin contributes. */
export interface PluginAssetCounts {
  skills: number;
  commands: number;
  rules: number;
  hooks: number;
  agents: number;
}

/**
 * Reader-supplied fields for one asset. `baseline_content_hash` is set exactly
 * when the scope is `repo-committed`: the SHA-256 of the file's body on the
 * repo's default branch.
 */
export interface HarnessAssetPayload {
  source: string;
  operational_state: HarnessOperationalState;
  repo_remote_url?: string;
  baseline_content_hash?: string;
  description?: string;
  version?: string;
  plugin_name?: string;
  marketplace?: string;
  invocation?: string;
  source_url?: string;
  /** Directory assets only: the observed file list (primary + helpers). */
  files?: HarnessAssetFile[];
  /** Kiro steering rules only: how the doc enters context — "always" (Kiro's
   *  default, and what an absent frontmatter key means), "fileMatch", or
   *  "manual". */
  inclusion_mode?: string;
  /** Kiro steering rules with inclusion_mode "fileMatch": the glob that pulls
   *  the doc into context. */
  inclusion_file_match?: string;
  /** Hooks only: the raw settings.json / hooks.json `command` string this hook runs. */
  hook_command?: string;
  /** Hooks only: the structured activation (event, matcher, timeout in seconds;
   *  0 means unset). Absent for non-hook assets and Kiro hook files. */
  hook_config?: { event: string; matcher: string; timeoutSeconds: number };
  /** Inline hooks only: the command string that IS the body (no disk file to
   *  read); `contentHash` hashes it. Verbatim, not redacted — the command
   *  already lives in the config file's body. */
  inline_body?: string;
  active_in_agents: string[];
  /** Plugin assets only: install path + per-kind asset counts. */
  plugin_install_path?: string;
  plugin_asset_counts?: PluginAssetCounts;
}

/** One discovered asset, as produced by a per-agent reader. */
export interface CollectedAsset {
  ideType: string;
  type: HarnessAssetType;
  name: string;
  scope: HarnessAssetScope;
  /** Repo root for repo scopes, '' for user scope (never null). */
  projectPath: string;
  /** Absolute on-disk path of the asset's defining file (for opening it). The
   *  stable identity uses the relative source path, derived from this via
   *  {@link deriveSourcePath}. */
  filePath: string;
  /** SHA256 of the asset body. */
  contentHash: string;
  /** Overrides the source path derived from filePath — used by inline hooks to
   *  sub-key several artifacts that share one settings.json (`settings.json#…`). */
  sourcePathOverride?: string;
  /** For a USER-scope asset whose install root is NOT the home dir, the root its
   *  source path anchors on. Absent → home dir. Only consulted at user scope;
   *  repo scopes anchor on projectPath regardless. */
  userScopeRoot?: string;
  payload: HarnessAssetPayload;
}

/** A directory a collector scans for repo-scope assets. */
export interface ProjectRoot {
  path: string;
  /** A linked git worktree: skipped, since it mirrors the main checkout's config. */
  isWorktree: boolean;
}
