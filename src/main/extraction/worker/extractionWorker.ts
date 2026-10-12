// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// Extraction utility-process entry. Runs a cycle off the Electron main process
// so the UI stays responsive: `local-session-extractor` reads every tool's
// sessions into the session store, then `harness-discovery` scans HOME and the
// project folders those sessions name, and the scan is stored as JSON.
//
// Communication uses Electron's process.parentPort (MessagePortMain). Messages
// are typed via ./protocol.ts. The worker owns its own store connection; the
// main process opens the same file for reads (SQLite WAL lets both proceed).

import { openStore, readAll, unredactPath, type SessionStore } from "local-session-extractor";
import { setLogger as setSessionLogger } from "local-session-extractor/host";
import { scan, setLogger as setHarnessLogger } from "harness-discovery";
import { initLogger, logger } from "../../logging/logger";
import { clearScanFailure, writeScanFailure, writeStoredScan } from "../../harness/inventory";
import { resolveProject } from "../../permissions/resolveProject";
import type {
  CountsAggregates,
  ExtractionSource,
  MainToWorkerMessage,
  WorkerToMainMessage,
  RunCounts,
  RunConfig,
  SpawnInit,
} from "./protocol";
import { HARNESS_STAGE, PRE_MODULE_SOURCES, POST_MODULE_SOURCES } from "./protocol";

interface ParentPortLike {
  on(event: "message", listener: (event: { data: MainToWorkerMessage }) => void): void;
  postMessage(message: WorkerToMainMessage): void;
}

declare const process: NodeJS.Process & { parentPort: ParentPortLike };

const SUB = "extraction.worker";

let store: SessionStore | null = null;
let init: SpawnInit | null = null;
let isRunning = false;

function send(message: WorkerToMainMessage): void {
  process.parentPort.postMessage(message);
}

function emptyCounts(): RunCounts {
  return { claudeCode: 0, cursor: 0, copilot: 0, antigravity: 0, codex: 0, kiro: 0 };
}

const COUNT_FIELD: Record<ExtractionSource, keyof RunCounts> = {
  "claude-code": "claudeCode",
  cursor: "cursor",
  copilot: "copilot",
  antigravity: "antigravity",
  codex: "codex",
  kiro: "kiro",
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reads one group of sources into the store, reporting each source's start and
 * done. A source that failed as a whole, and sessions that could not be read,
 * are added to `problems`; the rest of the group still runs.
 */
async function readGroup(
  db: SessionStore,
  group: readonly ExtractionSource[],
  config: RunConfig,
  counts: RunCounts,
  problems: string[],
): Promise<void> {
  const sources = group.filter((s) => config.sources.includes(s));
  if (sources.length === 0) return;
  const result = await readAll(db, {
    sources,
    onProgress: (event) => {
      if (event.state === "start") {
        send({ type: "progress", stage: "source", id: event.source, state: "start" });
        return;
      }
      counts[COUNT_FIELD[event.source]] = event.count;
      // A source that wrote rows changed the aggregates — recompute them HERE,
      // on the worker's connection, so the main process never runs these scans
      // on its own thread mid-cycle. Display-only: a failed count must not fail
      // the cycle; the end-of-cycle recompute in main self-heals it.
      let aggregates: CountsAggregates | undefined;
      if (event.count > 0) {
        try {
          aggregates = { counts: db.countByIde(), folderRows: db.countByIdeAndProject() };
        } catch (err) {
          logger.warn(SUB, "aggregates_failed", { source: event.source, error: errorMessage(err) });
        }
      }
      send({
        type: "progress",
        stage: "source",
        id: event.source,
        state: "done",
        count: event.count,
        ...(aggregates !== undefined ? { aggregates } : {}),
      });
    },
  });
  const skipped = new Map<string, number>();
  for (const e of result.errors) {
    if (e.scope === "source") {
      problems.push(`${e.source} could not be read: ${e.message}`);
      logger.error(SUB, "source_failed", { source: e.source, error: e.message });
    } else {
      skipped.set(e.source, (skipped.get(e.source) ?? 0) + 1);
    }
  }
  for (const [source, n] of skipped) {
    problems.push(`${source}: ${n} ${n === 1 ? "session" : "sessions"} could not be read`);
    logger.warn(SUB, "sessions_skipped", { source, count: n });
  }
}

/**
 * Scans HOME and every project folder the store knows for harness assets, and
 * stores the result. Returns the number of assets found; a failure keeps the
 * previous stored scan and is added to `problems`.
 */
async function scanHarness(
  db: SessionStore,
  inventoryPath: string,
  skipRoots: readonly string[],
  problems: string[],
): Promise<number> {
  send({ type: "progress", stage: "module", id: HARNESS_STAGE, state: "start" });
  let count = 0;
  try {
    // Project paths are stored redacted (the user name hashed); the scan needs
    // the real on-disk path. Each repo is resolved to where it really is, symlinks
    // followed one at a time, and dropped when that is inside a protected folder the
    // user has not granted (so the scan never raises a macOS prompt; RunConfig.skipRoots)
    // or is the home folder or a folder that holds it (harness-discovery itself skips
    // only a repo equal to HOME). The scan gets the resolved path.
    const spelled = db.listDetectedProjects().map((p) => unredactPath(p.project_path));
    const resolved = await Promise.all(spelled.map((repo) => resolveProject(repo, skipRoots)));
    const repos = [...new Set(resolved.filter((repo): repo is string => repo !== null))];
    const result = await scan({ repos });
    writeStoredScan(inventoryPath, { scannedAt: new Date().toISOString(), result });
    clearScanFailure(inventoryPath);
    count = result.assets.length;
    logger.info(SUB, "harness_scanned", {
      repos: repos.length,
      assets: count,
      warnings: result.warnings.length,
      errors: result.errors.length,
    });
  } catch (err) {
    problems.push(`The harness scan failed: ${errorMessage(err)}`);
    try {
      writeScanFailure(inventoryPath, { at: new Date().toISOString(), message: errorMessage(err) });
    } catch (writeErr) {
      logger.error(SUB, "harness_failure_record_failed", { error: errorMessage(writeErr) });
    }
    logger.error(SUB, "harness_scan_failed", { error: errorMessage(err) });
  }
  send({ type: "progress", stage: "module", id: HARNESS_STAGE, state: "done", count });
  return count;
}

async function runOnce(config: RunConfig): Promise<void> {
  if (!store || !init) {
    send({ type: "error", message: "worker not initialized" });
    return;
  }
  if (isRunning) {
    logger.debug(SUB, "run_skipped_already_running");
    return;
  }

  isRunning = true;
  const startTime = Date.now();
  const counts = emptyCounts();
  const problems: string[] = [];
  logger.info(SUB, "run_start", { sources: config.sources.join(",") });

  try {
    // Run order (PRE_MODULE_SOURCES → harness scan → POST_MODULE_SOURCES) puts
    // the fast sources first and Cursor last — see protocol.ts.
    await readGroup(store, PRE_MODULE_SOURCES, config, counts, problems);
    const assets = await scanHarness(store, init.inventoryPath, config.skipRoots ?? [], problems);
    await readGroup(store, POST_MODULE_SOURCES, config, counts, problems);

    const durationMs = Date.now() - startTime;
    logger.info(SUB, "run_complete", { durationMs, ...counts, assets, problems: problems.length });
    send({ type: "done", counts, moduleCounts: { [HARNESS_STAGE]: assets }, problems, durationMs });
  } catch (err) {
    const message = errorMessage(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.error(SUB, "run_failed", { error: message, stack });
    send({ type: "error", message, ...(stack !== undefined ? { stack } : {}) });
  } finally {
    isRunning = false;
  }
}

function handleInit(payload: SpawnInit): void {
  if (init) {
    logger.warn(SUB, "duplicate_init_ignored");
    return;
  }
  init = payload;

  try {
    initLogger(payload.userDataPath, "worker");
  } catch (err) {
    console.error("[worker] Logger init failed:", err);
  }
  // Both libraries are silent unless a host installs a logger; route their
  // diagnostics into this process's log file.
  setSessionLogger(logger);
  setHarnessLogger({
    debug: (msg, meta) => logger.debug("harness", msg, meta),
    info: (msg, meta) => logger.info("harness", msg, meta),
    warn: (msg, meta) => logger.warn("harness", msg, meta),
    error: (msg, meta) => logger.error("harness", msg, meta),
  });

  try {
    store = openStore(payload.storePath);
    logger.info(SUB, "worker_initialized");
    send({ type: "ready" });
  } catch (err) {
    const message = errorMessage(err);
    const stack = err instanceof Error ? err.stack : undefined;
    logger.error(SUB, "worker_init_failed", { error: message, stack });
    send({ type: "error", message, ...(stack !== undefined ? { stack } : {}) });
  }
}

function handleShutdown(): void {
  logger.info(SUB, "worker_shutdown");
  try {
    store?.close();
  } catch (err) {
    console.error("[worker] Store close failed:", err);
  }
  // Give the message loop a tick to flush before exiting.
  setImmediate(() => process.exit(0));
}

process.parentPort.on("message", (event) => {
  const message = event.data;
  switch (message.type) {
    case "init":
      handleInit(message.init);
      return;
    case "run":
      void runOnce(message.config);
      return;
    case "shutdown":
      handleShutdown();
      return;
  }
});
