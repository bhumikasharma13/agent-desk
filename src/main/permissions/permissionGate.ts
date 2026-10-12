// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * The folder-permission primer's logic. `computeNeeded` decides, with no
 * filesystem access or OS prompt, which registry folders still need the primer.
 * `askFolders` asks for them after Continue and re-probes until each has a
 * decision, with the probe and the clock injected. The IPC lives in `ipc.ts`.
 */

import type { NeededFolder, ProtectedFolderKey } from "../../shared/permissionTypes";
import { PROTECTED_FOLDERS, PROTECTED_FOLDER_KEYS } from "./protectedFolders";
import type { ProbeResult } from "./folderAccess";
import { logger } from "../logging/logger";

/**
 * Returns the registry folders not yet asked, as primer rows. Empty when the
 * platform is unsupported (non-macOS) or every folder has already been asked
 * ("remember the choice" — we never re-ask).
 *
 * @param isAsked  Whether the native prompt has already been shown for a folder.
 */
export function computeNeeded(
  isAsked: (key: ProtectedFolderKey) => boolean,
  supported: boolean,
): NeededFolder[] {
  if (!supported) return [];
  return PROTECTED_FOLDER_KEYS.filter((key) => !isAsked(key)).map((key) => {
    const def = PROTECTED_FOLDERS[key];
    return { key: def.key, label: def.label };
  });
}

/** Time for the re-probing, injected so tests need no real waits. */
export interface AskClock {
  now(): number;
  /** Waits `ms`, or less if `signal` aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface AskOptions {
  /** How often a folder still blocked is probed again. */
  intervalMs?: number;
  /** How long a blocked folder is re-probed before it counts as declined. */
  boundMs?: number;
  clock?: AskClock;
  /** Aborted at quit: the re-probing stops at once, logs nothing more and calls nothing. */
  signal?: AbortSignal;
  /** Called once every folder has been asked (the first pass), and again for each folder as it turns granted. */
  onChange?: (change: { key?: ProtectedFolderKey; state: "asked" | "granted" }) => void;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export type AskOutcome = "granted" | "declined" | "indeterminate";

export const ASK_INTERVAL_MS = 500;
export const ASK_BOUND_MS = 60_000;

export const realClock: AskClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    }),
};

/**
 * Asks macOS for each folder after one Continue. A probe does not wait for the
 * native prompt: the first read of an un-decided folder fails with EPERM at once
 * while macOS shows its prompt, and the user's answer applies to later reads. So
 * one that reads as blocked is probed again every `intervalMs` until it reads as
 * granted or `boundMs` passes. A folder is remembered as asked only on a decision:
 * when it reads as granted, or as declined at the bound; never when a quit cuts
 * the wait short, since macOS may have recorded nothing yet. `onChange` runs after the first pass and for each folder
 * the moment it turns granted, so the app follows each answer as it comes. At
 * the bound a folder still blocked is logged declined (which includes a prompt
 * left unanswered). An aborted `signal` (quit) ends it at once with nothing more
 * logged or called. A non-decision (a missing folder, a transient error, a probe
 * that throws) stays un-asked, so the primer asks again next time: remembering it
 * would skip the primer and let a later read prompt unexplained.
 */
export async function askFolders(
  keys: readonly ProtectedFolderKey[],
  probe: (key: ProtectedFolderKey) => Promise<ProbeResult>,
  markAsked: (key: ProtectedFolderKey) => void,
  opts: AskOptions = {},
): Promise<Partial<Record<ProtectedFolderKey, AskOutcome>>> {
  const { intervalMs = ASK_INTERVAL_MS, boundMs = ASK_BOUND_MS, clock = realClock, signal } = opts;
  const log = opts.log ?? ((event, data) => logger.info("permissions", event, data));
  const stopped = (): boolean => signal?.aborted === true;
  const safeProbe = async (key: ProtectedFolderKey): Promise<ProbeResult> => {
    try {
      return await probe(key);
    } catch (err: unknown) {
      logger.warn("permissions", "probe_failed", { folder: key, error: err instanceof Error ? err.message : String(err) });
      return "indeterminate";
    }
  };
  const outcomes: Partial<Record<ProtectedFolderKey, AskOutcome>> = {};
  const pending = new Set<ProtectedFolderKey>();
  const started = clock.now();
  for (const key of keys) {
    const result = await safeProbe(key);
    if (stopped()) return outcomes;
    if (result === "indeterminate") {
      outcomes[key] = "indeterminate";
      log("folder_access_indeterminate", { folder: key });
      continue;
    }
    if (result === "granted") {
      markAsked(key);
      outcomes[key] = "granted";
      log("folder_access_granted", { folder: key, waitedMs: 0 });
    } else {
      pending.add(key);
    }
  }
  opts.onChange?.({ state: "asked" });
  while (pending.size > 0 && clock.now() - started < boundMs) {
    await clock.sleep(intervalMs, signal);
    if (stopped()) return outcomes;
    for (const key of [...pending]) {
      const result = await safeProbe(key);
      if (stopped()) return outcomes;
      if (result !== "granted") continue;
      pending.delete(key);
      markAsked(key);
      outcomes[key] = "granted";
      log("folder_access_granted", { folder: key, waitedMs: clock.now() - started });
      opts.onChange?.({ key, state: "granted" });
    }
  }
  for (const key of pending) {
    markAsked(key);
    outcomes[key] = "declined";
    log("folder_access_declined", { folder: key, waitedMs: clock.now() - started });
  }
  return outcomes;
}
