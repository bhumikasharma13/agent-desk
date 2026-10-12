// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { currentContext, type ReportedProblem } from "./context";

/** Where the package's diagnostics go. `meta.component` names the emitting area. */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const noop = (): void => {};
const silent: Logger = { debug: noop, info: noop, warn: noop, error: noop };

let current: Logger = silent;

/** Route diagnostics to `logger` (process-wide); null selects the silent default. */
export function setLogger(logger: Logger | null): void {
  current = logger ?? silent;
}

/** The logger of the scan in progress (its `ScanOptions.logger`), else the process-wide one. */
export function log(): Logger {
  return currentContext()?.logger ?? current;
}

/**
 * Record a problem: into the running scan's `warnings` or `errors` when there is one, and
 * always to the logger.
 */
export function reportProblem(problem: ReportedProblem): void {
  const ctx = currentContext();
  ctx?.report?.({ ...problem, ...(ctx.ide !== undefined ? { ide: ctx.ide } : {}) });
  log().warn("scan_problem", { component: "scan", ...problem });
}
