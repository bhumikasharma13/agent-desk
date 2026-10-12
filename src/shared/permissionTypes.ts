// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Shared types for the folder-permission primer.
 *
 * One consolidated popup lists every macOS-protected folder the app needs and is
 * shown BEFORE any native prompt. Adding a folder is data-driven — declare it in
 * the main-process registry (`permissions/protectedFolders.ts`); no UI changes.
 *
 * These shapes cross the IPC boundary, so they live in `shared/` and are
 * imported by main, preload, and renderer (like harnessTypes).
 */

/**
 * The macOS TCC-protected folders the primer covers. Each maps to an Electron
 * `app.getPath()` name in the registry.
 */
export type ProtectedFolderKey = "desktop" | "documents" | "downloads";

/** One folder row shown in the consolidated primer. */
export interface NeededFolder {
  key: ProtectedFolderKey;
  /** Display label (e.g. "Desktop"). */
  label: string;
}

/**
 * What the renderer needs to decide whether to show the primer — computed in the
 * main process WITHOUT triggering any OS prompt.
 */
export interface FolderPermissionStatus {
  /** false on Windows/Linux — the primer is a no-op there. */
  supported: boolean;
  /** Folders not yet asked. Empty → already handled, show nothing. */
  needed: NeededFolder[];
}
