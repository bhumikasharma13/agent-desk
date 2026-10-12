// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The per-scan context itself: the async scope `readAll` runs each source in,
 * and nothing else, so every module that reads the scope (the path resolver,
 * the logger and metrics seams, redaction) can import it without importing the
 * reporting helpers in `scanScope.ts`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { PathKey } from "../extractors/pathResolver";
import type { IdeType } from "../types/session";
import type { Logger } from "./logger";
import type { MetricsSink } from "./metrics";

/**
 * One failure a scan recorded. `scope: "source"` means the source as a whole
 * could not be read, and `ScanResult.partial[source]` is then true; a
 * session-scoped error may carry a null `sessionId` when the unreadable file
 * never yielded one.
 */
export interface RecordError {
  source: IdeType;
  scope: "session" | "source";
  sessionId: string | null;
  file: string | null;
  message: string;
}

export interface ScanScope {
  source: IdeType;
  logger: Logger | undefined;
  metrics: MetricsSink | undefined;
  /** The scan's home root; when set, it shadows every process-wide path override. */
  home: string | undefined;
  /** The scan's own path overrides, which win over its home root. */
  paths: ReadonlyMap<PathKey, string>;
  errors: RecordError[];
  unknownRecordKinds: Map<string, number>;
  /** Set when an extractor reports a whole-source failure it swallowed. */
  sourceFailed: boolean;
  /** Log-once keys for this scan, so each scan's logger sees each drift once. */
  loggedOnce: Set<string>;
}

const storage = new AsyncLocalStorage<ScanScope>();

export function runInScanScope<T>(scope: ScanScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentScanScope(): ScanScope | undefined {
  return storage.getStore();
}
