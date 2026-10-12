// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import type { CycleStage, ExtractionStats, IdeType } from "../../shared/extractionTypes";
import type { WorkerHost, RunResult } from "./workerHost";
import type { CountsAggregates, WorkerProgressEvent } from "./worker/protocol";
import { HARNESS_STAGE, PRE_MODULE_SOURCES, POST_MODULE_SOURCES } from "./worker/protocol";
import { logger } from "../logging/logger";

export type StatusCallback = (stats: ExtractionStats) => void;
export type CycleCompleteCallback = (result: RunResult) => void;

/** The count queries the scheduler reads for the renderer (the session store implements both). */
export interface CountSource {
  countByIde(): CountsAggregates["counts"];
  countByIdeAndProject(): CountsAggregates["folderRows"];
}

const NO_COUNTS: CountsAggregates["counts"] = { claudeCode: 0, cursor: 0, copilot: 0, antigravity: 0, codex: 0, kiro: 0, total: 0 };

/**
 * What the stats IPC serves while there is no scheduler: nothing read yet, or,
 * when the app could not start reading at all, that error.
 */
/** A failure's text for lastError. Never empty: the status is read from it, and an empty one reads as success. */
export function failureMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)) || "The read failed (no message)";
}

export function statsBeforeScheduler(initError: string | null = null): ExtractionStats {
  return {
    status: initError ? "error" : "idle",
    lastRunAt: null,
    lastError: initError,
    problems: [],
    progress: null,
    counts: { ...NO_COUNTS },
    folders: { claudeCode: [], cursor: [], copilot: [], antigravity: [], codex: [], kiro: [] },
  };
}

/**
 * Whether a worker progress event should make the Harness page refetch: the
 * harness scan finished, whatever it found or failed to find. An open page then
 * shows the new scan (or its failure) while the last sources are still being read.
 */
export function harnessScanFinished(event: WorkerProgressEvent): boolean {
  return event.stage === "module" && event.state === "done";
}

/** Every source the app reads, in the worker's run order. */
export const KNOWN_IDE_SOURCES: readonly IdeType[] = [...PRE_MODULE_SOURCES, ...POST_MODULE_SOURCES];

/** How long after a cycle ends the next one starts. */
export const POLL_INTERVAL_MS = 5 * 60_000;

/**
 * The stage list for one cycle, in the worker's execution order
 * (PRE_MODULE_SOURCES → harness scan → POST_MODULE_SOURCES — the order
 * constants in worker/protocol.ts are the single source of truth).
 */
export function seedCycleStages(sources: readonly string[]): CycleStage[] {
  const stage = (id: string, kind: CycleStage["kind"]): CycleStage => ({
    id,
    kind,
    state: "pending",
    count: null,
  });
  return [
    ...PRE_MODULE_SOURCES.filter((s) => sources.includes(s)).map((s) => stage(s, "source")),
    stage(HARNESS_STAGE, "module"),
    ...POST_MODULE_SOURCES.filter((s) => sources.includes(s)).map((s) => stage(s, "source")),
  ];
}

const SUB = "extraction.scheduler";

/**
 * Polling scheduler that periodically asks the extraction utility process to
 * run a cycle. Owns the timer + cycle-status reporting; the actual file and
 * store I/O happens in the worker so the main process stays responsive.
 *
 * Counts shown to the renderer come from the session store (main-side
 * connection) after each cycle completes.
 */
export class ExtractionScheduler {
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;
  private inFlight: Promise<void> | null = null;
  private closing = false;
  private stopped = true;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  // What the last completed cycle could not read, one line each.
  private problems: string[] = [];
  // Cached count aggregates for getStats(). The two GROUP BY count queries
  // scan the whole conversations table, and getStats fires on every status
  // push — twice per cycle — plus page mount. Recompute after every cycle
  // attempt — a failed run can have partially committed rows.
  private countsDirty = true;
  private countsCache: CountsAggregates | null = null;
  private countsError: string | null = null;
  // Stage list of the in-flight cycle (null between cycles), advanced by
  // worker progress events and served to the renderer via getStats().
  private cycleStages: CycleStage[] | null = null;

  constructor(
    private readonly db: CountSource,
    private readonly worker: WorkerHost,
    private readonly onStatusChange?: StatusCallback,
    private readonly onCycleComplete?: CycleCompleteCallback,
    // The protected folders the worker must not read this cycle (see RunConfig.skipRoots).
    private readonly getSkipRoots?: () => Promise<string[]>,
  ) {}

  start(): void {
    // Quitting (stopAndWait has begun): the store is about to close, so no read starts.
    if (!this.stopped || this.closing) return;
    this.stopped = false;
    logger.info(SUB, "scheduler_started");
    void this.runOnce();
  }

  stop(): void {
    this.stopped = true;
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.countsDirty = true;
    logger.info(SUB, "scheduler_stopped");
  }

  /** Runs a read now. A read already running started before this call, so it waits for that one and reads again. */
  async triggerNow(): Promise<void> {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.inFlight) await this.inFlight;
    // Quitting: the session store is about to close, so no new read starts.
    if (this.closing) return;
    await this.runOnce();
  }

  /** Stops the schedule and waits, up to `timeoutMs`, for a read in progress to finish. */
  async stopAndWait(timeoutMs: number): Promise<void> {
    this.closing = true;
    this.stop();
    if (!this.inFlight) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.inFlight, new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
  }

  getStats(): ExtractionStats {
    if (this.countsDirty || !this.countsCache) {
      // A store that cannot be counted (closed, corrupt) shows as an error with
      // the last counts it gave, never as a throw: the status push and the IPC
      // handler both call this.
      try {
        this.countsCache = {
          counts: this.db.countByIde(),
          folderRows: this.db.countByIdeAndProject(),
        };
        this.countsDirty = false;
        this.countsError = null;
      } catch (err) {
        this.countsError = `The session store could not be read: ${err instanceof Error ? err.message : String(err)}`;
        this.countsCache ??= { counts: { ...NO_COUNTS }, folderRows: [] };
      }
    }
    const { counts, folderRows } = this.countsCache;

    const foldersFor = (ide: IdeType) =>
      folderRows.filter((r) => r.ide_type === ide).map((r) => ({ path: r.project_path, count: r.count }));

    const persistentDeadMessage = this.worker.isDead()
      ? this.worker.deadMessage()
      : null;
    const lastError = persistentDeadMessage ?? this.countsError ?? this.lastError;

    return {
      status: this.isRunning ? "running" : lastError ? "error" : "idle",
      lastRunAt: this.lastRunAt,
      lastError,
      problems: this.problems,
      progress: this.cycleStages,
      counts,
      folders: {
        claudeCode: foldersFor("claude-code"),
        cursor: foldersFor("cursor"),
        copilot: foldersFor("copilot"),
        antigravity: foldersFor("antigravity"),
        codex: foldersFor("codex"),
        kiro: foldersFor("kiro"),
      },
    };
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    if (this.timeoutId !== null) clearTimeout(this.timeoutId);
    this.timeoutId = setTimeout(() => {
      void this.runOnce();
    }, delayMs);
  }

  private runOnce(): Promise<void> {
    if (this.inFlight) {
      logger.debug(SUB, "extraction_skipped_already_running");
      return this.inFlight;
    }
    this.inFlight = this.runCycle().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runCycle(): Promise<void> {
    if (this.isRunning) {
      logger.debug(SUB, "extraction_skipped_already_running");
      return;
    }
    // Set this synchronously before any await, otherwise a timer firing
    // mid-await would race past the guard above and start a parallel cycle.
    this.isRunning = true;
    // Clear any stale error before flipping to running — the renderer
    // shouldn't show "Reading…" alongside an old error.
    this.lastError = null;
    // A read's problems belong to that read: one that fails must not keep showing the last one's.
    this.problems = [];
    // One sources list for both the seeded stage list and the worker's run
    // config — seeding from anything else would leave never-run stages stuck
    // "pending" and misnumber the renderer's "step N of M".
    const sources = [...KNOWN_IDE_SOURCES];
    // Seed the stage list up front so the very first "running" push already
    // carries every pending stage; worker progress events advance it.
    this.cycleStages = seedCycleStages(sources);

    try {
      this.emitStatus();
      // Auto-revive a dead worker on every cycle. The "3 crashes in 60s" cap
      // marks the host dead to stop tight respawn loops on a deterministic
      // crash, but at the polling cadence attempts to revive are sparse enough
      // to be safe.
      if (this.worker.isDead()) {
        logger.info(SUB, "auto_reviving_dead_worker");
        try {
          await this.worker.revive();
        } catch (err) {
          this.lastError = failureMessage(err);
          logger.error(SUB, "auto_revive_failed", { error: this.lastError });
          return;
        }
      } else if (!this.worker.isReady()) {
        // Start the worker (the first cycle, or after a spawn that failed). A
        // failure shows as this cycle's error, with the worker's own reason.
        try {
          await this.worker.spawn();
        } catch (err) {
          this.lastError = failureMessage(err);
          logger.error(SUB, "worker_start_failed", { error: this.lastError });
          return;
        }
      }

      // A quit that began while the worker was starting: the store is about to close.
      if (this.closing) return;
      const startTime = Date.now();
      logger.info(SUB, "extraction_cycle_start");

      try {
        const skipRoots = (await this.getSkipRoots?.()) ?? [];
        if (this.closing) return;
        const result = await this.worker.run({ sources, skipRoots });

        this.lastRunAt = new Date().toISOString();
        this.lastError = null;
        this.problems = result.problems;

        const c = result.counts;
        logger.info(SUB, "extraction_cycle_complete", {
          durationMs: Date.now() - startTime,
          ...c,
          totalCount: c.claudeCode + c.cursor + c.copilot + c.antigravity + c.codex + c.kiro,
          moduleCounts: result.moduleCounts,
          problems: result.problems.length,
        });

        try {
          this.onCycleComplete?.(result);
        } catch (cbErr) {
          logger.warn(SUB, "cycle_complete_callback_failed", {
            error: cbErr instanceof Error ? cbErr.message : String(cbErr),
          });
        }
      } catch (err) {
        this.lastError = failureMessage(err);
        logger.error(SUB, "extraction_cycle_error", { durationMs: Date.now() - startTime, error: this.lastError });
      }
    } finally {
      // Every attempt invalidates, success or failure: sources run one after
      // another without a wrapping transaction, so a cycle that errors partway
      // can still have committed rows. Set before emitStatus so the
      // end-of-cycle emit already serves fresh counts.
      this.countsDirty = true;
      this.isRunning = false;
      this.cycleStages = null;
      // After stopAndWait no status is pushed: at quit the session store may
      // already be closed once its bound has passed.
      if (!this.closing) this.emitStatus();
      this.scheduleNext(POLL_INTERVAL_MS);
    }
  }

  /**
   * Advance the in-flight cycle's stage list from a worker progress event and
   * push the update to the renderer. Mid-cycle count refreshes come as
   * worker-computed aggregate snapshots on the event — adopted into the cache
   * as-is, never recomputed here: the two aggregate queries are full-table
   * scans that would block the Electron main (UI) thread on a grown store.
   */
  noteWorkerProgress(event: WorkerProgressEvent): void {
    const stage = this.cycleStages?.find((s) => s.kind === event.stage && s.id === event.id);
    if (!stage) return;
    if (event.state === "start") {
      stage.state = "running";
    } else {
      stage.state = "done";
      stage.count = event.count;
      if (event.stage === "source" && event.aggregates) {
        this.countsCache = event.aggregates;
        this.countsDirty = false;
      }
    }
    this.emitStatus();
  }

  private emitStatus(): void {
    if (this.onStatusChange) {
      this.onStatusChange(this.getStats());
    }
  }
}
