// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log";

const COMPONENT = "git";

/**
 * The nearest ancestor of startPath containing a `.git` entry, resolved through
 * symlinks — a filesystem stand-in for `git rev-parse --show-toplevel` when the
 * git binary is unavailable. It does NOT resolve a worktree to its parent
 * checkout: a worktree's own root is returned (its `.git` is a file), so
 * callers that special-case worktrees behave identically with or without git.
 * Returns undefined when no `.git` is found. A path in the home folder looks no
 * higher than home itself, so the walk reads nothing outside HOME and the repos
 * (home itself is still looked at: a dotfiles repo there is reported, not used).
 */
export function findGitToplevel(startPath: string): string | undefined {
  const segments = startPath.split("/").filter(Boolean);
  const home = homedir().replace(/\/+$/, "");
  const trimmed = startPath.replace(/\/+$/, "");
  const inHome = trimmed === home || trimmed.startsWith(home + "/");
  const floor = inHome ? home.split("/").filter(Boolean).length : 1;
  for (let depth = segments.length; depth >= floor && depth > 0; depth--) {
    const candidate = "/" + segments.slice(0, depth).join("/");
    try {
      if (!existsSync(join(candidate, ".git"))) continue;
      try {
        return realpathSync(candidate);
      } catch (err) {
        // realpath can fail on a broken symlink — fall back to the lexical path
        log().warn("toplevel_realpath_failed", {
          component: COMPONENT,
          candidate,
          error: err instanceof Error ? err.message : String(err),
        });
        return candidate;
      }
    } catch (err) {
      // existsSync can throw on permission errors — log and keep walking up
      log().warn("toplevel_walk_error", {
        component: COMPONENT,
        candidate,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return undefined;
}
