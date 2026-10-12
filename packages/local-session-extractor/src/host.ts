// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The host wiring: the logger and metrics seams and the vendor-path overrides,
 * as process-wide defaults a scan's own options take precedence over. Importing
 * it loads no extractor.
 */
export { setLogger, type Logger } from "./seams/logger";
export { setMetricsSink, type CounterTags, type MetricsSink } from "./seams/metrics";
export {
  getPathOverride,
  hasPathOverride,
  resetPathOverrides,
  setPathOverrides,
  type PathKey,
} from "./extractors/pathResolver";
