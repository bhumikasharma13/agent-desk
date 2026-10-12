// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Insert into a Map used as a bounded LRU cache, evicting the oldest entries
 * once it exceeds `maxEntries`. Relies on Map preserving insertion order:
 * deleting the key first moves it to the newest position.
 */
export function lruSet<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > maxEntries) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}
