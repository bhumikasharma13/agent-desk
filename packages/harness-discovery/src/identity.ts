// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { relative, sep } from "node:path";
import type { CollectedAsset } from "./types";

/**
 * An asset's source path: the defining file made relative — repo-relative for
 * repo scopes, install-root-relative for user scope. The install root is the
 * home dir (`.claude/...`, `.cursor/...`) unless the asset names another as
 * `userScopeRoot`. 1:1 with (filePath, projectPath, userScopeRoot), so it keys
 * and dedups exactly as the absolute path would.
 */
export function deriveSourcePath(filePath: string, projectPath: string, userScopeRoot?: string): string {
  if (projectPath !== "") return relative(projectPath, filePath);
  const root = userScopeRoot ?? homedir();
  const rel = relative(root, filePath);
  if (rel !== ".." && !rel.startsWith(`..${sep}`)) return rel;
  // A file resolved through symlinks (a hook script, a plugin agent) under a HOME that is
  // itself a symlinked path: relative to the real home it is inside it.
  try {
    return relative(realpathSync(root), filePath);
  } catch {
    return rel;
  }
}

/** An asset's source_path: its override when set (inline hooks), else derived from its file. */
export function assetSourcePath(a: CollectedAsset): string {
  return a.sourcePathOverride ?? deriveSourcePath(a.filePath, a.projectPath, a.userScopeRoot);
}

/**
 * An asset's stable identity:
 * SHA256(ide_type : scope : repo_anchor : source_path : type : name).
 * Hashes the relative source_path (not the absolute file path), so the id does
 * not depend on where a checkout sits on disk when the repo has a remote.
 *
 * repo_anchor is the remote URL when the repo has one, so two checkouts of the
 * same remote collapse to a single identity (the cross-checkout dedup). With no
 * remote there is nothing tying two checkouts together, so the anchor is the
 * project path instead — two distinct local-only repos that share a relative
 * asset path (e.g. a root CLAUDE.md) stay separate identities, not one.
 */
export function harnessAssetId(a: CollectedAsset): string {
  const remote = a.payload.repo_remote_url ?? "";
  const repoAnchor = remote !== "" ? remote : a.projectPath;
  return createHash("sha256")
    .update(`${a.ideType}:${a.scope}:${repoAnchor}:${assetSourcePath(a)}:${a.type}:${a.name}`)
    .digest("hex");
}
