// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExtractionScheduler, POLL_INTERVAL_MS, failureMessage, harnessScanFinished, statsBeforeScheduler, type CountSource } from "../extractionScheduler";
import type { WorkerHost, RunResult } from "../workerHost";
import type { RunConfig } from "../worker/protocol";

const EMPTY_COUNTS = { claudeCode: 0, cursor: 0, copilot: 0, antigravity: 0, codex: 0, kiro: 0 };
const db: CountSource = {
  countByIde: () => ({ ...EMPTY_COUNTS, total: 0 }),
  countByIdeAndProject: () => [],
};
const RESULT: RunResult = { counts: { ...EMPTY_COUNTS }, moduleCounts: {}, problems: [], durationMs: 1 };

describe("ExtractionScheduler and the worker", () => {
  it("a worker that cannot start shows its own error as the status's lastError", async () => {
    let runs = 0;
    const worker = {
      isDead: () => false,
      isReady: () => false,
      deadMessage: () => null,
      spawn: async () => {
        throw new Error("sessions.db is not a local-session-extractor store");
      },
      run: async () => {
        runs++;
        return RESULT;
      },
    } as unknown as WorkerHost;
    const scheduler = new ExtractionScheduler(db, worker);
    await scheduler.triggerNow();
    const stats = scheduler.getStats();
    assert.equal(stats.status, "error");
    assert.equal(stats.lastError, "sessions.db is not a local-session-extractor store");
    assert.equal(runs, 0, "no cycle is sent to a worker that is not running");
  });

  it("a worker that is not running yet is started before the cycle", async () => {
    let ready = false;
    const seen: RunConfig[] = [];
    const worker = {
      isDead: () => false,
      isReady: () => ready,
      deadMessage: () => null,
      spawn: async () => {
        ready = true;
      },
      run: async (config: RunConfig) => {
        seen.push(config);
        return RESULT;
      },
    } as unknown as WorkerHost;
    const scheduler = new ExtractionScheduler(db, worker);
    await scheduler.triggerNow();
    assert.equal(seen.length, 1);
    assert.equal(scheduler.getStats().lastError, null);
  });

  it("hands the worker the protected folders it must not read this cycle", async () => {
    const seen: RunConfig[] = [];
    const worker = {
      isDead: () => false,
      isReady: () => true,
      deadMessage: () => null,
      run: async (config: RunConfig) => {
        seen.push(config);
        return RESULT;
      },
    } as unknown as WorkerHost;
    const scheduler = new ExtractionScheduler(db, worker, undefined, undefined, async () => ["/Users/jane/Documents"]);
    await scheduler.triggerNow();
    assert.deepEqual(seen[0]?.skipRoots, ["/Users/jane/Documents"]);
  });

  it("reads again five minutes after a cycle ends", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let runs = 0;
    const worker = {
      isDead: () => false,
      isReady: () => true,
      deadMessage: () => null,
      run: async () => {
        runs++;
        return RESULT;
      },
    } as unknown as WorkerHost;
    const scheduler = new ExtractionScheduler(db, worker);
    const settle = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    scheduler.start();
    await settle();
    assert.equal(runs, 1, "start reads at once");
    t.mock.timers.tick(POLL_INTERVAL_MS - 1);
    await settle();
    assert.equal(runs, 1);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(runs, 2);
    assert.equal(POLL_INTERVAL_MS, 5 * 60_000);
    scheduler.stop();
  });

  it("stopAndWait lets a read in progress finish before the store is closed", async () => {
    let closed = false;
    const store: CountSource = {
      countByIde: () => {
        if (closed) throw new Error("database is not open");
        return { ...EMPTY_COUNTS, total: 0 };
      },
      countByIdeAndProject: () => [],
    };
    let finishRead!: () => void;
    const worker = {
      isDead: () => false,
      isReady: () => true,
      deadMessage: () => null,
      run: () => new Promise<RunResult>((resolve) => (finishRead = () => resolve(RESULT))),
    } as unknown as WorkerHost;
    const scheduler = new ExtractionScheduler(store, worker, () => {});
    scheduler.start();
    await new Promise((r) => setImmediate(r)); // the read is now in the worker
    let waited = false;
    const quitting = scheduler.stopAndWait(5000).then(() => (waited = true));
    await new Promise((r) => setImmediate(r));
    assert.equal(waited, false, "quitting waits while the read runs");
    finishRead();
    await quitting;
    closed = true; // the store closes only now, after the read and its status push
    assert.equal(waited, true);
  });

  it("stopAndWait gives up after its bound and the late read then pushes nothing", async () => {
    let pushes = 0;
    let finishRead!: () => void;
    const worker = {
      isDead: () => false,
      isReady: () => true,
      deadMessage: () => null,
      run: () => new Promise<RunResult>((resolve) => (finishRead = () => resolve(RESULT))),
    } as unknown as WorkerHost;
    const scheduler = new ExtractionScheduler(db, worker, () => pushes++);
    scheduler.start();
    await new Promise((r) => setImmediate(r));
    const before = pushes;
    await scheduler.stopAndWait(10);
    finishRead();
    await new Promise((r) => setImmediate(r));
    assert.equal(pushes, before, "no status push after the store may have closed");
  });

  it("triggerNow during a read waits for it and reads again", async () => {
    let runs = 0;
    const finishers: (() => void)[] = [];
    const worker = {
      isDead: () => false,
      isReady: () => true,
      deadMessage: () => null,
      run: () => {
        runs++;
        return new Promise<RunResult>((resolve) => finishers.push(() => resolve(RESULT)));
      },
    } as unknown as WorkerHost;
    const scheduler = new ExtractionScheduler(db, worker);
    scheduler.start();
    await new Promise((r) => setImmediate(r));
    const refresh = scheduler.triggerNow();
    finishers[0]!();
    await new Promise((r) => setImmediate(r));
    assert.equal(runs, 2, "a second read starts after the first");
    finishers[1]!();
    await refresh;
    scheduler.stop();
  });

  it("a store that cannot be counted shows as the status's error and does not stop later reads", async () => {
    let fail = true;
    const store: CountSource = {
      countByIde: () => {
        if (fail) {
          fail = false;
          throw new Error("database disk image is malformed");
        }
        return { ...EMPTY_COUNTS, total: 0 };
      },
      countByIdeAndProject: () => [],
    };
    let runs = 0;
    const worker = {
      isDead: () => false,
      isReady: () => true,
      deadMessage: () => null,
      run: async () => {
        runs++;
        return RESULT;
      },
    } as unknown as WorkerHost;
    const pushed: (string | null)[] = [];
    const scheduler = new ExtractionScheduler(store, worker, (stats) => pushed.push(stats.lastError));
    await scheduler.triggerNow();
    assert.ok(pushed.some((e) => e?.includes("database disk image is malformed")), JSON.stringify(pushed));
    await scheduler.triggerNow();
    assert.equal(runs, 2, "the scheduler is not stuck after the failed count");
    assert.equal(scheduler.getStats().status, "idle");
  });

  it("a read asked for while quitting does not start", async () => {
    let runs = 0;
    const worker = {
      isDead: () => false,
      isReady: () => true,
      deadMessage: () => null,
      run: async () => {
        runs++;
        return RESULT;
      },
    } as unknown as WorkerHost;
    const scheduler = new ExtractionScheduler(db, worker);
    await scheduler.stopAndWait(10);
    await scheduler.triggerNow();
    assert.equal(runs, 0);
  });

  it("the worker's problems reach the status", async () => {
    const worker = {
      isDead: () => false,
      isReady: () => true,
      deadMessage: () => null,
      run: async () => ({ ...RESULT, problems: ["codex: 2 sessions could not be read"] }),
    } as unknown as WorkerHost;
    const scheduler = new ExtractionScheduler(db, worker);
    await scheduler.triggerNow();
    assert.deepEqual(scheduler.getStats().problems, ["codex: 2 sessions could not be read"]);
  });

  it("before the scheduler exists the stats say nothing has been read", () => {
    const stats = statsBeforeScheduler();
    assert.equal(stats.status, "idle");
    assert.equal(stats.lastRunAt, null);
    assert.equal(stats.counts.total, 0);
    assert.deepEqual(stats.folders.claudeCode, []);
  });

  it("when the app could not start reading, the stats carry that error", () => {
    const stats = statsBeforeScheduler("sessions.db could not be opened");
    assert.equal(stats.status, "error");
    assert.equal(stats.lastError, "sessions.db could not be opened");
  });

  it("a read that fails does not keep showing the previous read's problems", async () => {
    let fail = false;
    const worker = {
      isDead: () => false,
      isReady: () => true,
      deadMessage: () => null,
      run: async () => {
        if (fail) throw new Error("worker exited mid-cycle (code=9)");
        return { ...RESULT, problems: ["codex: 2 sessions could not be read"] };
      },
    } as unknown as WorkerHost;
    const scheduler = new ExtractionScheduler(db, worker);
    await scheduler.triggerNow();
    assert.equal(scheduler.getStats().problems.length, 1);
    fail = true;
    await scheduler.triggerNow();
    assert.deepEqual(scheduler.getStats().problems, []);
    assert.match(scheduler.getStats().lastError ?? "", /mid-cycle/);
  });

  it("the status pushed at the end of a read carries the counts that read wrote", async () => {
    let total = 0;
    const store: CountSource = {
      countByIde: () => ({ ...EMPTY_COUNTS, claudeCode: total, total }),
      countByIdeAndProject: () => [],
    };
    const worker = {
      isDead: () => false,
      isReady: () => true,
      deadMessage: () => null,
      run: async () => {
        total = 3; // the read stored three sessions
        return RESULT;
      },
    } as unknown as WorkerHost;
    const pushes: number[] = [];
    const scheduler = new ExtractionScheduler(store, worker, (stats) => pushes.push(stats.counts.total));
    await scheduler.triggerNow();
    assert.equal(pushes.at(-1), 3);
  });

  it("a dead worker's own message wins over the last read's error", async () => {
    let dead = false;
    const worker = {
      isDead: () => dead,
      isReady: () => true,
      deadMessage: () => "worker crashed 3 times in 60s; not respawning",
      revive: async () => {
        throw new Error("revive failed");
      },
      run: async () => {
        throw new Error("worker exited mid-cycle (code=9)");
      },
    } as unknown as WorkerHost;
    const scheduler = new ExtractionScheduler(db, worker);
    await scheduler.triggerNow();
    dead = true;
    assert.match(scheduler.getStats().lastError ?? "", /crashed 3 times/);
  });

  it("every finished harness scan makes the Harness page refetch, an empty one too", () => {
    assert.equal(harnessScanFinished({ stage: "module", id: "harness-assets", state: "done", count: 2 } as never), true);
    assert.equal(harnessScanFinished({ stage: "module", id: "harness-assets", state: "done", count: 0 } as never), true);
    assert.equal(harnessScanFinished({ stage: "module", id: "harness-assets", state: "start" } as never), false);
    assert.equal(harnessScanFinished({ stage: "source", id: "codex", state: "done", count: 2 } as never), false);
  });

  it("start after a quit has begun starts no read", async () => {
    let runs = 0;
    const worker = {
      isDead: () => false,
      isReady: () => true,
      deadMessage: () => null,
      run: async () => {
        runs++;
        return RESULT;
      },
    } as unknown as WorkerHost;
    let pushes = 0;
    const scheduler = new ExtractionScheduler(db, worker, () => pushes++);
    await scheduler.stopAndWait(10);
    scheduler.start(); // the deferred first start, firing during the quit wait
    await new Promise((r) => setImmediate(r));
    assert.equal(runs, 0);
    assert.equal(pushes, 0, "not even a Reading… status");
  });

  it("a read that follows a failed one shows no error while it runs", async () => {
    let fail = true;
    let finish!: () => void;
    const worker = {
      isDead: () => false,
      isReady: () => true,
      deadMessage: () => null,
      run: () => {
        if (fail) return Promise.reject(new Error("worker exited mid-cycle (code=9)"));
        return new Promise<RunResult>((resolve) => (finish = () => resolve(RESULT)));
      },
    } as unknown as WorkerHost;
    const scheduler = new ExtractionScheduler(db, worker);
    await scheduler.triggerNow();
    assert.ok(scheduler.getStats().lastError);
    fail = false;
    const second = scheduler.triggerNow();
    await new Promise((r) => setImmediate(r));
    assert.equal(scheduler.getStats().status, "running");
    assert.equal(scheduler.getStats().lastError, null, "the old failure is not shown during the new read");
    finish();
    await second;
  });

  // A read waiting at each of its awaits when a quit begins runs nothing after it.
  for (const waitsOn of ["the worker starting", "the worker reviving", "the folders not granted"] as const) {
    it(`a read waiting on ${waitsOn} runs nothing once a quit has begun`, async () => {
      let release!: () => void;
      const pending = <T,>(value: T) => new Promise<T>((resolve) => (release = () => resolve(value)));
      let runs = 0;
      const worker = {
        isDead: () => waitsOn === "the worker reviving",
        isReady: () => waitsOn === "the folders not granted",
        deadMessage: () => null,
        spawn: () => pending(undefined),
        revive: () => pending(undefined),
        run: async () => {
          runs++;
          return RESULT;
        },
      } as unknown as WorkerHost;
      const skipRoots = waitsOn === "the folders not granted" ? () => pending<string[]>([]) : undefined;
      const scheduler = new ExtractionScheduler(db, worker, undefined, undefined, skipRoots);
      const reading = scheduler.triggerNow();
      await new Promise((r) => setImmediate(r));
      const quitting = scheduler.stopAndWait(5000);
      release();
      await Promise.all([reading, quitting]);
      assert.equal(runs, 0);
    });
  }

  it("a failure with no message still shows as an error", async () => {
    const worker = {
      isDead: () => false,
      isReady: () => true,
      deadMessage: () => null,
      run: () => Promise.reject(new Error("")),
    } as unknown as WorkerHost;
    const scheduler = new ExtractionScheduler(db, worker);
    await scheduler.triggerNow();
    assert.equal(scheduler.getStats().status, "error");
    assert.equal(scheduler.getStats().lastError, "The read failed (no message)");
    assert.equal(failureMessage(new Error("worker exited mid-cycle (code=9)")), "worker exited mid-cycle (code=9)", "a message is kept as it is");
  });
});
