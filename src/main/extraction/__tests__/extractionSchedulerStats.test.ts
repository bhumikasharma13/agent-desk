// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExtractionScheduler, type CountSource } from "../extractionScheduler";
import type { WorkerHost, RunResult } from "../workerHost";

// Guard for the getStats() count cache: the two count aggregates are
// full-table scans on the main thread, and getStats fires on every status push
// (2× per cycle) plus page mount. The cache must (a) serve repeat calls
// without re-querying, (b) recompute after every cycle, and (c) drop on
// stop().

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

function makeFakeWorker(result: RunResult): WorkerHost {
  return {
    isDead: () => false,
    isReady: () => true,
    deadMessage: () => null,
    run: async () => result,
  } as unknown as WorkerHost;
}

function runResult(counts: Partial<typeof EMPTY_COUNTS>): RunResult {
  return { counts: { ...EMPTY_COUNTS, ...counts }, moduleCounts: {}, problems: [], durationMs: 1 };
}

describe("ExtractionScheduler getStats count cache", () => {
  it("repeat getStats calls hit the cache — count queries run once", () => {
    const { db, queries } = makeFakeDb();
    const scheduler = new ExtractionScheduler(db, makeFakeWorker(runResult({})));

    scheduler.getStats();
    scheduler.getStats();
    scheduler.getStats();

    assert.equal(queries(), 1, "repeat getStats must serve the cached counts");
  });

  it("every completed cycle invalidates the cache — even a zero-count one", async () => {
    const { db, queries } = makeFakeDb();
    const wrote = new ExtractionScheduler(db, makeFakeWorker(runResult({ claudeCode: 2 })));
    wrote.getStats();
    // triggerNow without start(): stopped stays true, so scheduleNext arms no timer.
    await wrote.triggerNow();
    wrote.getStats();
    assert.equal(queries(), 2, "a cycle with writes must recompute counts on the next getStats");

    // A zero-count cycle can still mutate rows (a session's project path can be
    // patched without counting a write), so it must invalidate too.
    const idle = makeFakeDb();
    const zeroCount = new ExtractionScheduler(idle.db, makeFakeWorker(runResult({})));
    zeroCount.getStats();
    await zeroCount.triggerNow();
    zeroCount.getStats();
    assert.equal(idle.queries(), 2, "a zero-count cycle must recompute — counts can change without counted writes");

    // A failed run can have partially committed rows (sources run one after
    // another, no wrapping transaction), so failure invalidates too.
    const failing = makeFakeDb();
    const failedRun = new ExtractionScheduler(
      failing.db,
      { isDead: () => false, isReady: () => true, deadMessage: () => null, run: async () => { throw new Error("boom"); } } as unknown as WorkerHost,
    );
    failedRun.getStats();
    await failedRun.triggerNow();
    failedRun.getStats();
    assert.equal(failing.queries(), 2, "a failed cycle must recompute — rows may have committed before the error");
  });

  it("stop() drops the cache", () => {
    const { db, queries } = makeFakeDb();
    const scheduler = new ExtractionScheduler(db, makeFakeWorker(runResult({})));

    scheduler.getStats();
    scheduler.stop();
    scheduler.getStats();

    assert.equal(queries(), 2, "getStats after stop() must recompute, not serve stale counts");
  });
});
