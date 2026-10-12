// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The counter sink the extractors report through. Discards until a host
 * installs one with `setMetricsSink`; a scan's own `metrics` option takes
 * precedence for that scan.
 */
import { currentScanScope } from "./scanContext";

export interface CounterTags {
  status?: string;
  errorKind?: string;
  component?: string;
}

export interface MetricsSink {
  inc(name: string, tags?: CounterTags, by?: number): void;
  observe(name: string, value: number, tags?: Pick<CounterTags, "status">): void;
}

const discard: MetricsSink = { inc() {}, observe() {} };

let current: MetricsSink = discard;

/** Installs the host's sink; `null` restores the discarding default. */
export function setMetricsSink(next: MetricsSink | null): void {
  current = next ?? discard;
}

export function inc(name: string, tags: CounterTags = {}, by = 1): void {
  (currentScanScope()?.metrics ?? current).inc(name, tags, by);
}
