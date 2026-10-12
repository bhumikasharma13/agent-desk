// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import type { ProjectRoot } from "./types";

/** Inputs to one IDE's full collection pass (user scope plus every root). */
export interface CollectOptions {
  /** Directories to scan for repo-scope assets. */
  roots: readonly ProjectRoot[];
  /**
   * Which project keys to prefer when two checkouts of one remote hold the same
   * file (see resolveRepoWinners). Default: every project is in scope.
   */
  inScope?: (projectKey: string) => boolean;
}

export const allInScope = (): boolean => true;
