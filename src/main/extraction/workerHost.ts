// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { utilityProcess, type UtilityProcess } from "electron";
import path from "node:path";
import { logger } from "../logging/logger";
import type {
  MainToWorkerMessage,
  RunConfig,
  RunCounts,
  WorkerProgressEvent,
  SpawnInit,
  WorkerToMainMessage,
} from "./worker/protocol";

export interface RunResult {
  counts: RunCounts;
  // Per-stage counts beyond the sessions (the harness scan's asset count).
  moduleCounts: Record<string, number>;
  // What could not be read this cycle, one line each (see protocol.ts).
  problems: string[];
  durationMs: number;
}

export type ProgressHandler = (event: WorkerProgressEvent) => void;

const SHUTDOWN_GRACE_MS = 3000;
const RESTART_BACKOFF_MS = 5000;
const MAX_CRASHES_PER_WINDOW = 3;
const CRASH_WINDOW_MS = 60_000;

/**
 * Host wrapper for the extraction utility process.
 *
 * Owns one long-lived child process spawned via `utilityProcess.fork`. The
 * scheduler calls `run()` to request a cycle and awaits the resolved result.
 * Crashes are auto-restarted with backoff; the third crash inside 60s marks
 * the host as dead so the UI can surface the persistent failure.
 */
export class WorkerHost {
  private child: UtilityProcess | null = null;
  private ready = false;
  private pending: { resolve: (r: RunResult) => void; reject: (e: Error) => void; startedAt: number } | null = null;
  private shuttingDown = false;
  private crashTimestamps: number[] = [];
  private dead = false;
  private deadReason: string | null = null;
  // The in-flight spawn, shared by concurrent callers.
  private spawning: Promise<void> | null = null;
  // Settles the in-flight spawn: the worker's `ready` ack resolves it, its init `error` rejects it.
  private spawnWait: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(
    private readonly init: SpawnInit,
    private readonly onProgress?: ProgressHandler,
  ) {}

  /** Whether a worker is running and has acked `ready`, so `run()` can be called. */
  isReady(): boolean {
    return this.child !== null && this.ready;
  }

  /**
   * Spawns the utility process and waits for the worker's `ready` ack.
   * Resolves once the worker has opened its store and is ready to accept `run`;
   * resolves at once when it already is. Rejects with the worker's own message
   * when it reports an init error, or after 10 s without an ack; either way the
   * worker is stopped, so the next call starts a fresh one.
   */
  spawn(): Promise<void> {
    if (this.dead) {
      return Promise.reject(new Error(`worker host marked dead: ${this.deadReason ?? "unknown"}`));
    }
    if (this.isReady()) return Promise.resolve();
    this.spawning ??= this.startWorker().finally(() => {
      this.spawning = null;
    });
    return this.spawning;
  }

  private async startWorker(): Promise<void> {
    const scriptPath = path.join(__dirname, "extractionWorker.js");
    logger.info("extraction.workerHost", "spawn_start", { scriptPath });

    const child = utilityProcess.fork(scriptPath, [], {
      serviceName: "agent-desk-extraction-worker",
      stdio: "inherit",
    });
    this.child = child;
    this.ready = false;

    // Events from a worker this host has since dropped are ignored.
    child.on("message", (data: WorkerToMainMessage) => {
      if (this.child === child) this.handleMessage(data);
    });
    child.on("exit", (code) => {
      if (this.child === child) this.handleExit(code);
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        this.spawnWait = { resolve, reject };
        timer = setTimeout(() => reject(new Error("worker spawn timeout (no ready ack within 10s)")), 10_000);
        child.once("spawn", () => {
          child.postMessage({ type: "init", init: this.init } satisfies MainToWorkerMessage);
        });
      });
    } catch (err) {
      logger.error("extraction.workerHost", "spawn_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.child = null;
      this.ready = false;
      try {
        child.kill();
      } catch {
        // already gone
      }
      throw err;
    } finally {
      clearTimeout(timer);
      this.spawnWait = null;
    }

    logger.info("extraction.workerHost", "spawn_ready");
  }

  /**
   * Sends a `run` message to the worker and resolves with counts when the
   * cycle reports `done`. Rejects on `error` or on worker crash mid-cycle.
   * Caller must serialize calls — concurrent `run()` is rejected.
   *
   * `config` carries the per-cycle source allowlist.
   */
  run(config: RunConfig): Promise<RunResult> {
    if (this.dead) {
      return Promise.reject(new Error(`worker host dead: ${this.deadReason ?? "unknown"}`));
    }
    if (!this.child || !this.ready) {
      return Promise.reject(new Error("worker not ready"));
    }
    if (this.pending) {
      return Promise.reject(new Error("extraction already in progress"));
    }

    return new Promise<RunResult>((resolve, reject) => {
      this.pending = {
        resolve,
        reject,
        startedAt: Date.now(),
      };
      this.child!.postMessage({ type: "run", config } satisfies MainToWorkerMessage);
    });
  }

  /**
   * Whether the host has stopped trying to keep the worker alive.
   * Surfaced to the renderer via the scheduler's `lastError` field.
   */
  isDead(): boolean {
    return this.dead;
  }

  deadMessage(): string | null {
    return this.deadReason;
  }

  /**
   * Clears the marked-dead state and attempts a fresh spawn. The scheduler
   * calls it at the start of every cycle, so hitting the 3-crashes-in-60s cap
   * recovers on the next cycle instead of needing an app restart.
   *
   * Throws on spawn failure; the caller surfaces it via lastError.
   */
  async revive(): Promise<void> {
    if (!this.dead) return;
    logger.info("extraction.workerHost", "revive_requested", {
      previousReason: this.deadReason,
    });
    this.dead = false;
    this.deadReason = null;
    this.crashTimestamps = [];
    await this.spawn();
  }

  /**
   * Sends `shutdown` and waits up to SHUTDOWN_GRACE_MS for graceful exit.
   * Force-kills the child after the grace period. Idempotent.
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const child = this.child;
    if (!child) return;

    logger.info("extraction.workerHost", "shutdown_request");

    if (this.pending) {
      this.pending.reject(new Error("worker shutting down"));
      this.pending = null;
    }

    try {
      child.postMessage({ type: "shutdown" } satisfies MainToWorkerMessage);
    } catch (err) {
      // Already gone — fall through to kill.
      logger.warn("extraction.workerHost", "shutdown_postMessage_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.child === child) {
          logger.warn("extraction.workerHost", "shutdown_force_kill");
          try {
            child.kill();
          } catch {
            // ignore
          }
        }
        resolve();
      }, SHUTDOWN_GRACE_MS);

      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.child = null;
    this.ready = false;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private handleMessage(data: WorkerToMainMessage): void {
    switch (data.type) {
      case "ready":
        this.ready = true;
        this.spawnWait?.resolve();
        return;
      case "progress":
        // Display-only: the authoritative per-source counts arrive on `done`.
        this.onProgress?.(data);
        return;
      case "done": {
        const pending = this.pending;
        this.pending = null;
        pending?.resolve({
          counts: data.counts,
          moduleCounts: data.moduleCounts,
          problems: data.problems,
          durationMs: data.durationMs,
        });
        return;
      }
      case "error": {
        const pending = this.pending;
        this.pending = null;
        const err = new Error(data.message);
        if (data.stack) err.stack = data.stack;
        if (pending) {
          pending.reject(err);
        } else if (this.spawnWait) {
          // The worker could not initialise (its store would not open): fail the spawn with its reason.
          this.spawnWait.reject(err);
        } else {
          logger.error("extraction.workerHost", "worker_error_no_pending", {
            message: data.message,
          });
        }
        return;
      }
    }
  }

  private handleExit(code: number | undefined): void {
    logger.info("extraction.workerHost", "worker_exited", { code });
    this.child = null;
    this.ready = false;

    if (this.pending) {
      this.pending.reject(new Error(`worker exited mid-cycle (code=${code ?? "null"})`));
      this.pending = null;
    }
    this.spawnWait?.reject(new Error(`worker exited before it was ready (code=${code ?? "null"})`));

    if (this.shuttingDown || code === 0) {
      // Expected exit — do not respawn.
      return;
    }

    // Unexpected crash — record and decide whether to respawn.
    const now = Date.now();
    this.crashTimestamps = this.crashTimestamps.filter((t) => now - t < CRASH_WINDOW_MS);
    this.crashTimestamps.push(now);

    if (this.crashTimestamps.length >= MAX_CRASHES_PER_WINDOW) {
      this.dead = true;
      this.deadReason = `worker crashed ${this.crashTimestamps.length} times in ${CRASH_WINDOW_MS / 1000}s; not respawning`;
      logger.error("extraction.workerHost", "worker_dead", {
        reason: this.deadReason,
      });
      return;
    }

    logger.warn("extraction.workerHost", "worker_respawn_scheduled", {
      backoffMs: RESTART_BACKOFF_MS,
      crashCount: this.crashTimestamps.length,
    });
    setTimeout(() => {
      void this.respawn();
    }, RESTART_BACKOFF_MS);
  }

  private async respawn(): Promise<void> {
    if (this.dead || this.shuttingDown) return;
    try {
      await this.spawn();
    } catch (err) {
      logger.error("extraction.workerHost", "respawn_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
