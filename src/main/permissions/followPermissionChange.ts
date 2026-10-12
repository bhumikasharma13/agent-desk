// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import type { PermissionChange } from "./ipc";

export interface PermissionFollowUps {
  /** Re-runs the stack detector, so projects in a folder that just opened up get their tags. */
  rescan(): void;
  /** Re-evaluates the menu bar icon; `notify` also allows the once-per-launch notification. */
  refreshTray(opts: { notify: boolean }): void;
  /** Tells the renderer (the folder-access banner) to re-read. */
  send(channel: "permissions:changed"): void;
}

/**
 * What the app does about each folder-access change. Every change but a decline
 * can open a folder, so it rescans. Only a settled decline, or a change found on
 * focus, may notify, never "asked" or "granted", while a prompt may still be open.
 * The banner always re-reads.
 */
export function followPermissionChange(change: PermissionChange, followUps: PermissionFollowUps): void {
  if (change !== "declined") followUps.rescan();
  followUps.refreshTray({ notify: change === "declined" || change === "changed" });
  followUps.send("permissions:changed");
}
