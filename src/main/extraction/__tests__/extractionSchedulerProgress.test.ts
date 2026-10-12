// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExtractionScheduler, KNOWN_IDE_SOURCES, seedCycleStages, type CountSource } from "../extractionScheduler";
import { HARNESS_STAGE, PRE_MODULE_SOURCES, POST_MODULE_SOURCES } from "../worker/protocol";
import type { WorkerHost, RunResult } from "../workerHost";
import type { ExtractionStats, IdeType } from "../../../shared/extractionTypes";

const EMPTY_COUNTS = { claudeCode: 0, cursor: 0, copilot: 0, antigravity: 0, codex: 0, kiro: 0 };

function makeFakeDb(): { db: CountSource; queries: () => number } {
  let calls = 0;
  const db = {
    countByIde: () => {
      calls++;
      return { ...EMPTY_COUNTS, total: 0 };
    },
    countByIdeAndProject: () => [],
  };
  return { db, queries: () => calls };
}

/** A worker whose run() blocks until release() — lets tests observe mid-cycle state. */
function makeGatedWorker(result: RunResult): { worker: WorkerHost; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = {
    isDead: () => false,
    isReady: () => true,
    deadMessage: () => null,
    run: async () => {
      await gate;
      return result;
    },
  } as unknown as WorkerHost;
  return { worker, release };
}

const RUN_RESULT: RunResult = { counts: { ...EMPTY_COUNTS }, moduleCounts: {}, problems: [], durationMs: 1 };

describe("cycle stage order", () => {
  it("the run order covers every tool exactly once — adding a tool must place it in the run order", () => {
    // A Record over IdeType fails type-check when a tool is added to the type but not here.
    const everyTool: Record<IdeType, true> = { "claude-code": true, cursor: true, copilot: true, antigravity: true, codex: true, kiro: true };
    const ordered = [...PRE_MODULE_SOURCES, ...POST_MODULE_SOURCES];
    assert.deepEqual([...ordered].sort(), Object.keys(everyTool).sort());
    assert.equal(new Set(ordered).size, ordered.length, "no tool twice");
    assert.deepEqual([...KNOWN_IDE_SOURCES].sort(), Object.keys(everyTool).sort());
  });

  it("seedCycleStages: pre-module sources, then the harness scan, then post-module sources, all pending", () => {
    const stages = seedCycleStages(KNOWN_IDE_SOURCES);
    assert.deepEqual(stages.map((s) => s.id), [...PRE_MODULE_SOURCES, HARNESS_STAGE, ...POST_MODULE_SOURCES]);
    for (const s of stages) {
      assert.equal(s.state, "pending");
      assert.equal(s.count, null);
      assert.equal(s.kind, s.id === HARNESS_STAGE ? "module" : "source");
    }
  });

  it("seedCycleStages drops sources outside the cycle's allowlist", () => {
    const stages = seedCycleStages(["claude-code"]);
    assert.deepEqual(
      stages.map((s) => s.id),
      ["claude-code", HARNESS_STAGE],
    );
  });
});

describe("ExtractionScheduler stage progress", () => {
  it("progress is null when idle, seeded on cycle start, advanced by worker events, null again after the cycle", async () => {
    const { db } = makeFakeDb();
    const { worker, release } = makeGatedWorker(RUN_RESULT);
    const pushes: ExtractionStats[] = [];
    const scheduler = new ExtractionScheduler(db, worker, (stats) => pushes.push(stats));

    assert.equal(scheduler.getStats().progress, null, "no cycle → no progress");

    const cycle = scheduler.triggerNow();
    const seeded = scheduler.getStats().progress;
    assert.ok(seeded, "running cycle must expose the stage list");
    assert.equal(seeded.length, PRE_MODULE_SOURCES.length + 1 + POST_MODULE_SOURCES.length);

    scheduler.noteWorkerProgress({ stage: "source", id: "claude-code", state: "start" });
    assert.equal(stageById(scheduler, "claude-code").state, "running");

    scheduler.noteWorkerProgress({ stage: "source", id: "claude-code", state: "done", count: 7 });
    assert.equal(stageById(scheduler, "claude-code").state, "done");
    assert.equal(stageById(scheduler, "claude-code").count, 7);

    scheduler.noteWorkerProgress({ stage: "module", id: HARNESS_STAGE, state: "done", count: 3 });
    assert.equal(stageById(scheduler, HARNESS_STAGE).state, "done");

    // Every progress event pushes a status update (the renderer's live feed).
    assert.ok(pushes.length >= 3, `expected a push per progress event, got ${pushes.length}`);

    release();
    await cycle;
    assert.equal(scheduler.getStats().progress, null, "finished cycle must clear progress");
  });

  it("a stage id outside the seeded list is ignored, not crashed on", async () => {
    const { db } = makeFakeDb();
    const { worker, release } = makeGatedWorker(RUN_RESULT);
    const scheduler = new ExtractionScheduler(db, worker);

    const cycle = scheduler.triggerNow();
    scheduler.noteWorkerProgress({ stage: "module", id: "future-kind", state: "done", count: 1 });
    release();
    await cycle;
  });

  it("mid-cycle count refreshes adopt the worker's aggregates — never a main-thread recompute", async () => {
    const { db, queries } = makeFakeDb();
    const { worker, release } = makeGatedWorker(RUN_RESULT);
    const scheduler = new ExtractionScheduler(db, worker);

    const cycle = scheduler.triggerNow();
    scheduler.getStats();
    const baseline = queries();

    // Progress events must never trigger the two aggregate scans on the main
    // thread (they block the UI for hundreds of ms on a grown store) — a
    // rows-written source ships worker-computed aggregates instead.
    scheduler.noteWorkerProgress({ stage: "source", id: "codex", state: "done", count: 0 });
    scheduler.noteWorkerProgress({ stage: "module", id: HARNESS_STAGE, state: "done", count: 50 });
    scheduler.noteWorkerProgress({
      stage: "source",
      id: "claude-code",
      state: "done",
      count: 12,
      aggregates: {
        counts: { ...EMPTY_COUNTS, claudeCode: 12, total: 12 },
        folderRows: [{ ide_type: "claude-code", project_path: "/p", count: 12 }],
      },
    });
    const stats = scheduler.getStats();
    assert.equal(queries(), baseline, "no progress event may recompute counts on the main thread");
    assert.equal(stats.counts.claudeCode, 12, "worker aggregates must be served from the cache");
    assert.equal(stats.folders.claudeCode[0]?.count, 12);

    release();
    await cycle;
  });
});


function stageById(scheduler: ExtractionScheduler, id: string): { state: string; count: number | null } {
  const stage = scheduler.getStats().progress?.find((s) => s.id === id);
  assert.ok(stage, `stage ${id} must exist in the running cycle`);
  return stage;
}
