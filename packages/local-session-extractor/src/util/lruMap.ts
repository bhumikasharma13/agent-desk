// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
// Shared, frozen, empty — the no-eviction return value for every lruSet call
// (the overwhelming majority: a per-file hot-path call against a cache well
// under its cap). One sentinel instead of a fresh `[]` per call keeps that
// path allocation-free; frozen so a caller can never mutate the shared
// instance out from under the next caller.
const NO_EVICTIONS: readonly unknown[] = Object.freeze([]);

/**
 * Insert into a Map used as a bounded LRU cache, evicting the oldest entries
 * once it exceeds `maxEntries`. Relies on Map preserving insertion order:
 * deleting the key first (also on a hit) moves it to the newest position, so
 * the entry evicted on overflow is always the least-recently set.
 *
 * Returns the evicted values (empty when nothing was evicted) so a caller
 * that keeps its own running total over the map's contents — e.g. a byte
 * count — can subtract them; most existing call sites ignore the return.
 * The common case (map still under `maxEntries` after the insert) returns the
 * shared empty sentinel without allocating — this runs on a per-file hot path
 * whose steady state never evicts, so an unconditional `[]` per call would be
 * self-inflicted allocation on the instrument's own hot path.
 *
 * `readonly`, not `V[]`: the no-eviction path returns the frozen shared
 * sentinel, and a mutable signature would let a caller `.push()` onto it and
 * get a runtime TypeError shared across every no-eviction caller, where the
 * type system can instead reject the mutation at compile time.
 */
export function lruSet<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): readonly V[] {
  map.delete(key);
  map.set(key, value);
  if (map.size <= maxEntries) return NO_EVICTIONS as readonly V[];
  const evicted: V[] = [];
  while (map.size > maxEntries) {
    const oldest = map.keys().next();
    if (oldest.done) break; // defensive: maxEntries < 1 with an emptied map
    const oldestValue = map.get(oldest.value);
    if (oldestValue !== undefined) evicted.push(oldestValue);
    map.delete(oldest.value);
  }
  return evicted;
}
