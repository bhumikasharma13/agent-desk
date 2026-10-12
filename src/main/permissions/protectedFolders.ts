// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * The single, consolidated declaration of every macOS-protected folder the app
 * needs access to. The primer lists all of these in one popup, and the gate
 * iterates this map to drive the native prompts.
 *
 * To cover a new folder: add a `ProtectedFolderKey` in shared/permissionTypes.ts
 * and one entry here. Nothing else (UI, IPC, store) changes.
 */

import { app } from "electron";
import type { ProtectedFolderKey } from "../../shared/permissionTypes";

export interface ProtectedFolderDef {
  key: ProtectedFolderKey;
  /** Display label used in the primer (e.g. "Desktop"). */
  label: string;
  /**
   * Resolves the absolute folder path at call time. A function (not a constant)
   * because `app.getPath` must run after the app is ready and can throw if the
   * location is unavailable.
   */
  getPath: () => string;
}

export const PROTECTED_FOLDERS: Record<ProtectedFolderKey, ProtectedFolderDef> = {
  desktop: { key: "desktop", label: "Desktop", getPath: () => app.getPath("desktop") },
  documents: { key: "documents", label: "Documents", getPath: () => app.getPath("documents") },
  downloads: { key: "downloads", label: "Downloads", getPath: () => app.getPath("downloads") },
};

export const PROTECTED_FOLDER_KEYS = Object.keys(PROTECTED_FOLDERS) as ProtectedFolderKey[];

/** Type guard for untrusted values (e.g. keys read back from the on-disk store). */
export function isProtectedFolderKey(value: unknown): value is ProtectedFolderKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROTECTED_FOLDERS, value);
}

export { isPathWithinBase } from "./pathWithin";
