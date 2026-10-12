// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The logger the extractors write through. Silent until a host installs one
 * with `setLogger`, so the package logs nowhere on its own; a scan's own
 * `logger` option takes precedence for that scan.
 */
import { currentScanScope } from "./scanContext";

export interface Logger {
  info(component: string, event: string, data?: Record<string, unknown>): void;
  warn(component: string, event: string, data?: Record<string, unknown>): void;
  error(component: string, event: string, data?: Record<string, unknown>): void;
  debug(component: string, event: string, data?: Record<string, unknown>): void;
}

const silent: Logger = { info() {}, warn() {}, error() {}, debug() {} };

let current: Logger = silent;

/** Installs the host's logger; `null` restores the silent default. */
export function setLogger(next: Logger | null): void {
  current = next ?? silent;
}

function active(): Logger {
  return currentScanScope()?.logger ?? current;
}

export const logger: Logger = {
  info: (component, event, data) => active().info(component, event, data),
  warn: (component, event, data) => active().warn(component, event, data),
  error: (component, event, data) => active().error(component, event, data),
  debug: (component, event, data) => active().debug(component, event, data),
};
