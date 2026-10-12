// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * IPC surface for the folder-permission primer. Two handlers, split so the
 * native prompts fire only after the user's explicit Continue:
 *
 *   permissions:getNeeded — evaluate with NO OS prompt; tells the renderer which
 *                           folders the consolidated primer should list.
 *   permissions:request   — after Continue, probe every needed folder (which
 *                           shows its native prompt) and re-probe a blocked one
 *                           until the user's answer applies; each decision is
 *                           remembered so it is never asked again (askFolders).
 *
 * Neither handler takes folder keys from the renderer — the set is derived from
 * the registry — so there is no untrusted-path surface.
 *
 * `onChange` reports each change as it happens: "asked" after a request's first
 * pass, "granted" the moment a folder turns granted, "declined" when a request
 * ends with a folder still blocked at the bound, and "changed" when a focus
 * re-probe (`recheck`) finds the blocked folders differ from the last known set.
 * Nothing is reported once `stop()` has run (quit). The app decides what follows
 * each change (followPermissionChange.ts), so this module stays decoupled from it.
 */

import { ipcMain } from "electron";
import type { FolderPermissionStatus, NeededFolder } from "../../shared/permissionTypes";
import { askFolders, computeNeeded, type AskOptions } from "./permissionGate";
import { evaluateBlockedFolders } from "./permissionHealth";
import { probeFolderAccess } from "./folderAccess";
import { PermissionStore } from "./permissionStore";
import { PROTECTED_FOLDERS } from "./protectedFolders";
import { logger } from "../logging/logger";

/** What changed in folder access: the app follows each one (rescan, tray, banner). */
export type PermissionChange = "asked" | "granted" | "declined" | "changed";

export interface PermissionsIpc {
  /** Re-probes the asked folders (the window gained focus) and reports a change. */
  recheck(): Promise<void>;
  /** True while a request is asking: its own reports cover any change then. */
  asking(): boolean;
  /** At quit: ends any re-probing at once; nothing more is reported. */
  stop(): void;
}

export function registerPermissionsIpc(
  onChange?: (change: PermissionChange) => void,
  // Tests pass a fake clock; the app uses the real one.
  ask: Pick<AskOptions, "clock"> = {},
): PermissionsIpc {
  const supported = process.platform === "darwin";
  // Single-flight: ignore a second request while the prompts are mid-flight, so
  // a double Continue (or a second window) can't open overlapping native dialogs.
  let inFlight = false;
  const quit = new AbortController();
  // The blocked folders as last reported, so a focus re-probe reports only a change.
  let lastBlocked: string | null = null;
  const report = (change: PermissionChange): void => {
    if (quit.signal.aborted) return;
    try {
      onChange?.(change);
    } catch (err: unknown) {
      logger.warn("permissions", "on_change_hook_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  };

  ipcMain.handle("permissions:getNeeded", (): FolderPermissionStatus => {
    const store = PermissionStore.getInstance();
    return { supported, needed: computeNeeded((key) => store.isAsked(key), supported) };
  });

  // Blocked folders (already asked + probe returns blocked). Safe to probe:
  // an already-decided TCC folder answers without a prompt. Powers the Harness
  // PermissionBanner's denied-access path (the case getNeeded can't see).
  ipcMain.handle("permissions:getBlocked", async (): Promise<NeededFolder[]> => {
    if (!supported) return [];
    const keys = await evaluateBlockedFolders();
    return keys.map((key) => ({ key, label: PROTECTED_FOLDERS[key].label }));
  });

  ipcMain.handle("permissions:request", async (): Promise<void> => {
    if (!supported || inFlight) return;
    inFlight = true;
    try {
      const store = PermissionStore.getInstance();
      const needed = computeNeeded((key) => store.isAsked(key), supported);
      if (needed.length === 0) return;

      const outcomes = await askFolders(
        needed.map((f) => f.key),
        (key) => probeFolderAccess(PROTECTED_FOLDERS[key].getPath()),
        (key) => store.markAsked(key),
        { ...ask, signal: quit.signal, onChange: ({ state }) => report(state) },
      );
      if (quit.signal.aborted) return;
      // The request reported its own changes; a focus re-probe compares with where it left things.
      lastBlocked = (await evaluateBlockedFolders()).sort().join(",");
      if (quit.signal.aborted) return;
      if (Object.values(outcomes).includes("declined")) report("declined");
    } finally {
      inFlight = false;
    }
  });

  return {
    // The first call (at launch) only records where things stand.
    async recheck(): Promise<void> {
      if (!supported || quit.signal.aborted || inFlight) return;
      const blocked = (await evaluateBlockedFolders()).sort().join(",");
      if (quit.signal.aborted) return;
      const changed = lastBlocked !== null && blocked !== lastBlocked;
      lastBlocked = blocked;
      if (changed) report("changed");
    },
    asking(): boolean {
      return inFlight;
    },
    stop(): void {
      quit.abort();
    },
  };
}
