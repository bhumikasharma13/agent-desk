// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lruSet } from "../lruMap";

describe("lruSet", () => {
  it("evicts the least-recently-set entry once over the cap", () => {
    const m = new Map<string, number>();
    lruSet(m, "a", 1, 2);
    lruSet(m, "b", 2, 2);
    lruSet(m, "c", 3, 2); // over cap → "a" (oldest) evicted
    assert.deepEqual([...m.keys()], ["b", "c"]);
    assert.equal(m.has("a"), false);
  });

  it("re-setting a key marks it most-recently-used (spares it from eviction)", () => {
    const m = new Map<string, number>();
    lruSet(m, "a", 1, 2);
    lruSet(m, "b", 2, 2);
    lruSet(m, "a", 10, 2); // touch "a" → now "b" is oldest
    lruSet(m, "c", 3, 2); // over cap → "b" evicted, "a" survives
    assert.deepEqual([...m.keys()], ["a", "c"]);
    assert.equal(m.get("a"), 10);
  });

  it("evicts down to the cap when it is exceeded by more than one", () => {
    const m = new Map<string, number>([["x", 0], ["y", 0], ["z", 0]]);
    lruSet(m, "w", 1, 2); // 4 entries → trim to 2
    assert.equal(m.size, 2);
    assert.deepEqual([...m.keys()], ["z", "w"]);
  });

  it("returns the evicted values so a caller can subtract them from its own bookkeeping", () => {
    const m = new Map<string, number>();
    assert.deepEqual(lruSet(m, "a", 1, 2), [], "no eviction while under cap");
    assert.deepEqual(lruSet(m, "b", 2, 2), [], "no eviction while under cap");
    assert.deepEqual(lruSet(m, "c", 3, 2), [1], "over cap → oldest value returned");
  });

  it("returns every evicted value when the cap is exceeded by more than one", () => {
    const m = new Map<string, number>([["x", 10], ["y", 20], ["z", 30]]);
    assert.deepEqual(lruSet(m, "w", 40, 2), [10, 20]);
  });

  it("returns the same empty-array reference on every no-eviction call, so the hot path never allocates", () => {
    const m = new Map<string, number>();
    const first = lruSet(m, "a", 1, 2);
    const second = lruSet(m, "b", 2, 2);
    // assert.equal is reference equality here (both are arrays) — a fresh `[]`
    // per call would be deepEqual but not equal, so this pins the no-alloc path
    // specifically, not just the emptiness of the result.
    assert.equal(first, second, "no-eviction path must return the shared sentinel, not a fresh array");
    assert.deepEqual(first, []);
  });
});
