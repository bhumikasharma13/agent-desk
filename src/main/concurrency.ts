// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Maps items through an async fn with at most `limit` in flight. Results keep
 * input order. `fn` is expected to catch its own errors; a rejection
 * propagates out of the Promise.all and abandons the remaining items.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(lanes);
  return results;
}
