// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * A vendor time field as epoch milliseconds. An absent field yields `fallbackMs`
 * (a file time, say); a field that is present but not a date yields undefined —
 * an unknown time, never the 1970 epoch or NaN.
 */
export function dateMs(value: string | number | null | undefined, fallbackMs?: number): number | undefined {
  if (value === undefined || value === null || value === "") return fallbackMs;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** Seconds from `startMs` to `endMs`, or undefined when either is unknown. */
export function spanSeconds(startMs: number | undefined, endMs: number | undefined): number | undefined {
  if (startMs === undefined || endMs === undefined) return undefined;
  return Math.max(0, (endMs - startMs) / 1000);
}
