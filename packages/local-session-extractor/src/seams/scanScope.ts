// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The per-scan layer over the process-wide seams. `readAll` runs each source
 * inside a scope carrying that scan's logger, metrics sink and path overrides,
 * and collecting its errors and unknown record kinds. An async scope rather
 * than install-and-restore, so two overlapping scans never see each other's
 * options; outside a scan the process-wide defaults apply alone.
 *
 * The module caches (`transcriptCache` and the others) are process-wide and keyed by absolute path and content.
 */
import { redactErrorMessage, redactPath } from "../redaction";
import type { IdeType } from "../types/session";
import { currentScanScope, type RecordError } from "./scanContext";

export { currentScanScope, runInScanScope, type RecordError, type ScanScope } from "./scanContext";

/** A `RecordError` with its file path and message redacted, as every recorded error is. */
export function redactedRecordError(
  source: IdeType,
  scope: RecordError["scope"],
  sessionId: string | null,
  file: string | null,
  err: unknown,
): RecordError {
  return {
    source,
    scope,
    sessionId,
    file: file === null ? null : redactPath(file),
    message: redactErrorMessage(err),
  };
}

/**
 * Records one session the current scan could not read. Outside a scan it does
 * nothing, and the extractor's own log line is the only record.
 */
export function reportRecordError(sessionId: string | null, file: string | null, err: unknown): void {
  const scope = currentScanScope();
  if (!scope) return;
  scope.errors.push(redactedRecordError(scope.source, "session", sessionId, file, err));
}

/**
 * Records that the current source could not be read as a whole, for a failure
 * the extractor catches and continues past, and marks the source partial.
 * Outside a scan it does nothing.
 */
export function reportSourceError(file: string | null, err: unknown): void {
  const scope = currentScanScope();
  if (!scope) return;
  scope.errors.push(redactedRecordError(scope.source, "source", null, file, err));
  scope.sourceFailed = true;
}

/** Counts one unrecognized record kind, keyed `<provider>:<kind>`, for the current scan. */
export function noteScanUnknownRecordKind(key: string): void {
  const scope = currentScanScope();
  if (!scope) return;
  scope.unknownRecordKinds.set(key, (scope.unknownRecordKinds.get(key) ?? 0) + 1);
}

/**
 * Whether `key` is new, recording it: inside a scan, new to that scan, so every
 * scan's own logger sees each drift once; outside a scan, new to `outside`, the
 * caller's process-wide once-set.
 */
export function firstInScan(key: string, outside: Set<string>): boolean {
  const seen = currentScanScope()?.loggedOnce ?? outside;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}
