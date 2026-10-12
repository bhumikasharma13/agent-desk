// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Shapes that cross the IPC boundary, imported by main, preload and renderer
 * from this one place.
 */

export type { ExtractionStats } from "./extractionTypes";

export type {
  HarnessInventory,
  HarnessAsset,
  HarnessAssetContent,
  HarnessPlugin,
  HarnessSummary,
  HarnessAssetType,
  HarnessAssetScope,
  HarnessOperationalState,
} from "./harnessTypes";

export type {
  ProtectedFolderKey,
  NeededFolder,
  FolderPermissionStatus,
} from "./permissionTypes";

/** One project folder with the stack tags detected in it (Projects page chips). */
export interface StackProject {
  /** Redacted the same way the session store redacts project paths, so it joins onto a Projects row. */
  path: string;
  displayName: string;
  stackTags: string[];
}
