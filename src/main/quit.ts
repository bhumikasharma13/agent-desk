// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { logger } from "./logging/logger";

/** The parts of the app that reading uses, as the quit sequence needs them. */
export interface QuitParts {
  scheduler: { stopAndWait(timeoutMs: number): Promise<void> } | null;
  workerHost: { shutdown(): Promise<void> } | null;
  store: { close(): void } | null;
}

/**
 * Closes reading down for a quit, in this order: no new read, and the read in
 * progress gets up to `readWaitMs` to finish; then the worker exits (its own
 * 3 s bound before it is killed); then the session store closes. The store is
 * never closed under a running read.
 */
export async function closeForQuit(parts: QuitParts, readWaitMs: number): Promise<void> {
  await parts.scheduler?.stopAndWait(readWaitMs);
  await parts.workerHost?.shutdown();
  parts.store?.close();
}

/**
 * A quit function that closes reading down once: a second quit while the first
 * still waits (another Cmd+Q) gets the same promise, so the store is closed once,
 * after the worker has exited.
 */
export function makeQuitter(parts: () => QuitParts, readWaitMs: number): () => Promise<void> {
  let quitting: Promise<void> | null = null;
  return () => (quitting ??= closeForQuit(parts(), readWaitMs));
}

/**
 * Runs the quit sequence, then `done` (let the app quit) whether it worked or not:
 * a failure is logged and never keeps the app from quitting.
 */
export function quitThen(quit: () => Promise<void>, done: () => void): Promise<void> {
  return Promise.resolve()
    .then(quit)
    .catch((err: unknown) => {
      logger.error("app", "quit_close_failed", { error: err instanceof Error ? err.message : String(err) });
    })
    .finally(done);
}
