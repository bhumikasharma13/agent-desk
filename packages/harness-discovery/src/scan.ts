// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { collectClaudeCodeAssets } from "./claudeCode";
import { collectCodexAssets } from "./codex";
import { collectCursorAssets } from "./cursor";
import { collectKiroAssets } from "./kiro";
import { assetSourcePath, harnessAssetId } from "./identity";
import { runInContext, type ReportedProblem } from "./context";
import type { Logger } from "./log";
import { isDirectory, isGitWorktree, readGitContext, resetGitBaselineCaches } from "./scanShared";
import { createCollectSession, type CollectSession } from "./session";
import type { CollectOptions } from "./collectOptions";
import type { CollectedAsset, ProjectRoot } from "./types";

export type Ide = "claude-code" | "codex" | "cursor" | "kiro";

export const IDES: readonly Ide[] = ["claude-code", "codex", "cursor", "kiro"];

const COLLECTORS: Record<Ide, (session: CollectSession, opts: CollectOptions) => Promise<void>> = {
  "claude-code": collectClaudeCodeAssets,
  codex: collectCodexAssets,
  cursor: collectCursorAssets,
  kiro: collectKiroAssets,
};

export interface ScanOptions {
  /** Repository directories to scan for repo-scope assets. User scope is always scanned. */
  repos?: readonly string[];
  /** Which tools to scan. Default: all four. */
  ides?: readonly Ide[];
  /** Diagnostics sink for this scan. Default: whatever setLogger installed (silent unless set). */
  logger?: Logger;
}

/** One discovered asset with its derived identity. */
export interface ScannedAsset extends CollectedAsset {
  /** {@link harnessAssetId}: stable across scans while ide, scope, repo, path, type and name hold. */
  id: string;
  /** Repo-relative for repo scopes; home-relative for user scope. */
  sourcePath: string;
}

export interface ScanProblem {
  ide?: Ide;
  /** The scanned root the problem is about. */
  root?: string;
  /** The file or directory the problem is about. */
  path?: string;
  message: string;
}

export interface ScanResult {
  schemaVersion: 1;
  assets: ScannedAsset[];
  /**
   * What was read but not collected: roots deliberately skipped, and files skipped because
   * they are not valid JSON, are over the size cap, are unreadable, or resolve (through a
   * symlink) outside HOME and the given repos. The rest of the scan is complete.
   */
  warnings: ScanProblem[];
  /**
   * Roots or tools that could not be scanned; the rest of the scan still ran. A tool listed here
   * may have contributed some assets before it failed, so its inventory is partial — do not treat
   * its absent assets as deleted.
   */
  errors: ScanProblem[];
}

/**
 * Inventory the harness assets under the user's home directory and the given
 * repos. Reads files and runs read-only git commands; writes nothing. Reads stay
 * inside HOME and the given repos (with their git top levels): a symlink that leaves
 * them is reported in `warnings` and not followed.
 */
export async function scan(opts: ScanOptions = {}): Promise<ScanResult> {
  resetGitBaselineCaches();
  const warnings: ScanProblem[] = [];
  const errors: ScanProblem[] = [];
  const seen = new Set<string>();
  const report = (p: ReportedProblem & { ide?: string }): void => {
    const key = `${p.severity}\0${p.root ?? ""}\0${p.path ?? ""}\0${p.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    const problem: ScanProblem = {
      // A root-level problem is the same for every tool, so it names none.
      ...(p.ide !== undefined && p.root === undefined ? { ide: p.ide as Ide } : {}),
      ...(p.root !== undefined ? { root: p.root } : {}),
      ...(p.path !== undefined ? { path: p.path } : {}),
      message: p.message,
    };
    (p.severity === "error" ? errors : warnings).push(problem);
  };

  const home = await realpath(homedir()).catch(() => homedir());
  const readRoots = new Set<string>([home]);
  const roots: ProjectRoot[] = [];
  for (const repo of opts.repos ?? []) {
    // resolve("") is the working directory, which nobody meant to scan.
    if (repo === "") {
      report({ severity: "error", root: "", message: "empty path" });
      continue;
    }
    const given = resolve(repo);
    if (!(await isDirectory(given))) {
      report({ severity: "error", root: given, message: "not a directory" });
      continue;
    }
    // git reports the physical top level, so a root reached through a symlink must be
    // canonicalized too — else its files fall outside the tracked set and its source paths
    // come out as ../ paths.
    const path = await realpath(given);
    if (path === home) {
      // Kept from the collectors, whose own home skip compares against the unresolved
      // homedir() and so misses a canonicalized root when HOME is a symlinked path.
      report({ severity: "warning", root: path, message: "is the home directory: its config is scanned as user scope, not as a repo" });
      continue;
    }
    const git = await readGitContext(path);
    if (git.isRepo && (await isGitWorktree(git.topLevel))) {
      report({
        severity: "warning",
        root: path,
        message: "skipped: its git top level has a .git file (a linked worktree or a submodule), which is not scanned",
      });
    }
    readRoots.add(path);
    if (git.isRepo) readRoots.add(await realpath(git.topLevel).catch(() => git.topLevel));
    roots.push({ path, isWorktree: await isGitWorktree(path) });
  }

  const assets: ScannedAsset[] = [];
  await runInContext({ logger: opts.logger, readRoots: [...readRoots], report }, async () => {
    for (const ide of new Set(opts.ides ?? IDES)) {
      const session = createCollectSession((a) =>
        assets.push({ id: harnessAssetId(a), sourcePath: assetSourcePath(a), ...a }),
      );
      try {
        await runInContext({ ide }, () => COLLECTORS[ide](session, { roots }));
      } catch (err) {
        errors.push({ ide, message: err instanceof Error ? err.message : String(err) });
      }
    }
  });
  return { schemaVersion: 1, assets, warnings, errors };
}