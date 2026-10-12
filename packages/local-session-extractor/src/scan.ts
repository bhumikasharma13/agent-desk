// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * `readAll` and `readSource`: one scan over the requested sources into a store.
 * Each source runs inside its own scan scope (`seams/scanScope.ts`), so the
 * scan's logger, metrics sink and path overrides reach every extractor read
 * without touching the process-wide defaults, and a source that throws is
 * recorded and the next source still runs.
 */
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extractAntigravity } from "./extractors/antigravityExtractor";
import { extractClaudeCode } from "./extractors/claudeCodeExtractor";
import { extractCodex } from "./extractors/codexExtractor";
import { extractCopilot } from "./extractors/copilotExtractor";
import { scanCursor } from "./extractors/cursorExtractor";
import { extractKiro } from "./extractors/kiroExtractor";
import { assertPathKey, type PathKey } from "./extractors/pathResolver";
import { redactErrorMessage, redactPath } from "./redaction";
import { logger as defaultLogger, type Logger } from "./seams/logger";
import type { MetricsSink } from "./seams/metrics";
import { redactedRecordError, runInScanScope, type RecordError, type ScanScope } from "./seams/scanScope";
import type { SeatTierLookup } from "./seams/seatTier";
import type { SessionStore } from "./store/SessionStore";
import type { SeatTierRunReport } from "./types/seatTier";
import { IDE_TYPES, type IdeType } from "./types/session";
import { recordHomeOwner } from "./store/homeOwners";
import type { SessionSink } from "./types/store";

export type { RecordError } from "./seams/scanScope";

/** The order a scan with no `sources` runs; `capabilities().sources` reports it. */
export const DEFAULT_SOURCES: readonly IdeType[] = ["claude-code", "copilot", "antigravity", "codex", "kiro", "cursor"];

/** Thrown before any extractor runs when `sources` names a source this build lacks. */
export class UnsupportedSourceError extends Error {
  readonly source: string;
  constructor(source: string) {
    super(`unsupported source: ${source}; this build reads ${IDE_TYPES.join(", ")}`);
    this.source = source;
    this.name = "UnsupportedSourceError";
  }
}

/** Thrown before any extractor runs when `sources` names one source twice. */
export class DuplicateSourceError extends Error {
  readonly source: IdeType;
  constructor(source: IdeType) {
    super(`duplicate source: ${source}; list each source once`);
    this.source = source;
    this.name = "DuplicateSourceError";
  }
}

/** One source starting, or finishing with the sessions it wrote (0 when it failed). */
export type ScanProgressEvent =
  | { source: IdeType; state: "start" }
  | { source: IdeType; state: "done"; count: number };

export interface ScanOptions {
  /** The sources to run, in this order, each at most once. Defaults to `capabilities().sources`. */
  sources?: readonly IdeType[];
  /**
   * The home root every default vendor location resolves under, for this scan.
   * It shadows the process-wide path overrides; this scan's own `paths` still
   * win over it. Must be non-empty.
   */
  home?: string;
  /**
   * Per-location overrides for this scan; they win over the home root, the
   * process-wide overrides and the environment. An unknown key or an empty
   * value throws before any extractor runs.
   */
  paths?: Partial<Record<PathKey, string>>;
  /** Captures sub-agent transcripts as lineage-tagged sessions. */
  captureLineage?: boolean;
  /** The version stamped on every row a source writes; a source absent here stamps null. */
  extractorVersions?: Partial<Record<IdeType, number>>;
  /** Defaults to the process-wide logger, which is silent unless a host installed one. */
  logger?: Logger;
  /** Defaults to the process-wide sink, which discards unless a host installed one. */
  metrics?: MetricsSink;
  /** A callback that throws is logged and the scan continues. */
  onProgress?: (event: ScanProgressEvent) => void;
  cursor?: {
    /**
     * The network call for the Cursor seat tier. Absent, the package never
     * contacts Cursor and no row carries a vendor-derived tier.
     */
    lookup?: SeatTierLookup;
  };
}

export interface ScanResult {
  /** Sessions written per source that ran. */
  counts: Partial<Record<IdeType, number>>;
  durationMs: number;
  /**
   * Session-scoped errors, one per unreadable session or file, and
   * source-scoped errors, one per whole-source failure. Paths and messages are
   * redacted.
   */
  errors: RecordError[];
  /** Unrecognized record kinds seen, keyed `<provider>:<kind>`. */
  unknownRecordKinds: Record<string, number>;
  /**
   * Per source that ran: true exactly when the source as a whole failed, which
   * is the only whole-source failure signal; each such failure also has a
   * source-scoped entry in `errors`.
   */
  partial: Partial<Record<IdeType, boolean>>;
  /** Present exactly when the Cursor source reached the seat-tier gate. */
  seatTier?: SeatTierRunReport;
}

interface RunContext {
  captureLineage: boolean;
  lookup: SeatTierLookup | undefined;
}

type SourceRun = { count: number; seatTier?: SeatTierRunReport };

/** The extractor call behind each source; `runScan` takes the table so a test can substitute one. */
export type SourceRunners = Record<IdeType, (sink: SessionSink, ctx: RunContext) => Promise<SourceRun>>;

const count = async (n: number | Promise<number>): Promise<SourceRun> => ({ count: await n });

export const DEFAULT_RUNNERS: SourceRunners = {
  "claude-code": (sink, ctx) => count(extractClaudeCode(sink, ctx.captureLineage)),
  copilot: (sink) => count(extractCopilot(sink)),
  antigravity: (sink) => count(extractAntigravity(sink)),
  codex: (sink, ctx) => count(extractCodex(sink, ctx.captureLineage)),
  kiro: (sink) => count(extractKiro(sink)),
  cursor: (sink, ctx) => scanCursor(sink, { captureLineage: ctx.captureLineage, seatTierLookup: ctx.lookup }),
};

/**
 * Runs the requested sources into `store`, in the order given. Never throws for
 * one bad session or one failed source; throws {@link UnsupportedSourceError}
 * before running anything when `sources` names an unknown source.
 */
export function readAll(store: SessionStore, opts: ScanOptions = {}): Promise<ScanResult> {
  return runScan(store, opts, DEFAULT_RUNNERS);
}

/** `readAll` over one source. */
export function readSource(
  source: IdeType,
  store: SessionStore,
  opts: Omit<ScanOptions, "sources"> = {},
): Promise<ScanResult> {
  return readAll(store, { ...opts, sources: [source] });
}

/** `readAll` with its extractor table supplied; the table is a test seam. */
export async function runScan(store: SessionSink, opts: ScanOptions, runners: SourceRunners): Promise<ScanResult> {
  const sources = validateSources(opts.sources ?? DEFAULT_SOURCES);
  const paths = validatePaths(opts.paths);
  if (opts.home !== undefined && (typeof opts.home !== "string" || opts.home.length === 0)) {
    throw new TypeError("home must be a non-empty path");
  }
  // A symlinked home is followed, so the owner recorded and hashed is the real folder's.
  const home = opts.home === undefined ? undefined : realDirectory(opts.home);
  if (opts.home !== undefined && home === undefined) {
    throw new TypeError(`home is not a directory: ${redactPath(opts.home)}`);
  }

  // Recorded before any row, the default home included, so an export run by
  // another account still hashes this owner's name in session ids.
  recordHomeOwner(store, home ?? homedir());

  const started = Date.now();
  const errors: RecordError[] = [];
  const unknownRecordKinds = new Map<string, number>();
  const result: ScanResult = { counts: {}, durationMs: 0, errors, unknownRecordKinds: {}, partial: {} };
  const ctx: RunContext = { captureLineage: opts.captureLineage === true, lookup: opts.cursor?.lookup };
  const loggedOnce = new Set<string>();

  for (const source of sources) {
    notifyProgress(opts, { source, state: "start" });
    const version = opts.extractorVersions?.[source];
    const sink = version === undefined ? store : stampingSink(store, version);
    const scope: ScanScope = {
      source,
      logger: opts.logger,
      metrics: opts.metrics,
      home,
      paths,
      errors,
      unknownRecordKinds,
      sourceFailed: false,
      loggedOnce,
    };
    let written = 0;
    try {
      const run = await runInScanScope(scope, () => runners[source](sink, ctx));
      written = run.count;
      if (run.seatTier !== undefined) result.seatTier = run.seatTier;
    } catch (err) {
      // Redacted inside the scope, so the scan's home root is among the names hashed.
      errors.push(runInScanScope(scope, () => redactedRecordError(source, "source", null, null, err)));
      scope.sourceFailed = true;
    }
    result.partial[source] = scope.sourceFailed;
    result.counts[source] = written;
    notifyProgress(opts, { source, state: "done", count: written });
  }

  result.unknownRecordKinds = Object.fromEntries(unknownRecordKinds);
  result.durationMs = Date.now() - started;
  return result;
}

/** The real path of a directory, symlinks followed, or undefined when it is not one. */
function realDirectory(path: string): string | undefined {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

function validateSources(sources: readonly IdeType[]): readonly IdeType[] {
  const seen = new Set<IdeType>();
  for (const source of sources) {
    if (!(IDE_TYPES as readonly string[]).includes(source)) throw new UnsupportedSourceError(source);
    if (seen.has(source)) throw new DuplicateSourceError(source);
    seen.add(source);
  }
  return sources;
}

function validatePaths(given: ScanOptions["paths"]): Map<PathKey, string> {
  const paths = new Map<PathKey, string>();
  for (const [key, value] of Object.entries(given ?? {})) {
    assertPathKey(key);
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length === 0) throw new TypeError(`paths.${key} must be a non-empty path`);
    paths.set(key, value);
  }
  return paths;
}

/** Calls the host's progress callback; a throw is logged, never propagated into the scan. */
function notifyProgress(opts: ScanOptions, event: ScanProgressEvent): void {
  if (!opts.onProgress) return;
  try {
    opts.onProgress(event);
  } catch (err) {
    (opts.logger ?? defaultLogger).warn("local_session_extractor.scan", "progress_callback_failed", {
      source: event.source,
      state: event.state,
      error: redactErrorMessage(err),
    });
  }
}

/** A sink that stamps `version` on every row it writes and delegates the rest. */
function stampingSink(store: SessionSink, version: number): SessionSink {
  return {
    upsert: (params) => store.upsert({ ...params, extractorVersion: version }),
    getTracking: (ideType, sessionId) => store.getTracking(ideType, sessionId),
    hasBeenIngested: (ideType, sessionId) => store.hasBeenIngested(ideType, sessionId),
    stampPendingSubagentLineage: (ideType, sessionId, parentRecordKey, extras) =>
      store.stampPendingSubagentLineage(ideType, sessionId, parentRecordKey, extras),
    updateProjectPath: (ideType, sessionId, projectPath) => store.updateProjectPath(ideType, sessionId, projectPath),
    updateRepoName: (ideType, sessionId, repoName) => store.updateRepoName(ideType, sessionId, repoName),
    getMeta: (key) => store.getMeta(key),
    setMeta: (key, value) => store.setMeta(key, value),
  };
}
