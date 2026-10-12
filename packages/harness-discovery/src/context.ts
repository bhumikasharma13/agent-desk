// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "./log";

/** Something a scan could not read or chose not to read, surfaced instead of dropped. */
export interface ReportedProblem {
  severity: "warning" | "error";
  message: string;
  /** A scanned root the problem is about (an unreadable repo). */
  root?: string;
  /** A file or directory the problem is about. */
  path?: string;
}

/**
 * State of the scan in progress, carried by AsyncLocalStorage so concurrent scans never
 * share it: each scan's logger, problem sink, the tool being collected, and the canonical
 * directories reads are confined to.
 */
export interface ScanContext {
  logger?: Logger;
  ide?: string;
  /** Realpaths a read must stay inside. Empty: reads are not confined. */
  readRoots: readonly string[];
  report?: (problem: ReportedProblem & { ide?: string }) => void;
}

const storage = new AsyncLocalStorage<ScanContext>();

export function currentContext(): ScanContext | undefined {
  return storage.getStore();
}

/** Run `fn` with the current context extended by the defined fields of `patch`. */
export function runInContext<T>(patch: Partial<ScanContext>, fn: () => Promise<T>): Promise<T> {
  const next: ScanContext = { readRoots: [], ...storage.getStore() };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
  }
  return storage.run(next, fn);
}
