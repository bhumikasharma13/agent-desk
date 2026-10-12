// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mapWithConcurrency } from "../concurrency";

describe("mapWithConcurrency", () => {
  it("preserves input order in results", async () => {
    // Reverse delays: later items finish first; results must still align by index.
    const items = [30, 20, 10, 0];
    const results = await mapWithConcurrency(items, 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return `done-${ms}`;
    });
    assert.deepEqual(results, ["done-30", "done-20", "done-10", "done-0"]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    assert.ok(peak <= 3, `peak in-flight ${peak} exceeded limit 3`);
    assert.ok(peak > 1, "expected some parallelism");
  });

  it("handles empty input and limit larger than items", async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, async (x) => x), []);
    assert.deepEqual(await mapWithConcurrency([1, 2], 10, async (x) => x * 2), [2, 4]);
  });
});
