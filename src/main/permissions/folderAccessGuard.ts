// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Folder-access guard: the one door every folder scan goes through.
 *
 * macOS fires a native prompt the first time anything reads a protected folder
 * (Desktop, Documents, Downloads). The primer must be the only thing that
 * triggers those prompts, and only after the user clicks Continue; a folder the
 * user denied cannot be read at all.
 *
 * So every scan of user folders (the extraction worker's harness scan, the
 * stack detector) asks `ungrantedProtectedRoots()` before it starts and skips
 * every path inside one of those folders. The rule lives here, once.
 */

import { probeFolderAccess, type ProbeResult } from "./folderAccess";
import { PROTECTED_FOLDERS, PROTECTED_FOLDER_KEYS } from "./protectedFolders";
import { PermissionStore } from "./permissionStore";
import type { ProtectedFolderKey } from "../../shared/permissionTypes";

/**
 * The protected folders a scan must not read yet: those the primer has not
 * asked about (a read would prompt), and those whose stored answer is a denial
 * (a read fails). Only asked folders are probed, since an asked folder answers
 * without a prompt. A probe that throws or cannot decide counts as readable.
 * Pure; dependencies injected so it is unit-testable.
 */
export async function computeUngrantedRoots(
  keys: readonly ProtectedFolderKey[],
  isAsked: (key: ProtectedFolderKey) => boolean,
  probe: (key: ProtectedFolderKey) => Promise<ProbeResult>,
  getPath: (key: ProtectedFolderKey) => string,
): Promise<string[]> {
  const roots: string[] = [];
  for (const key of keys) {
    let root: string;
    try {
      root = getPath(key);
    } catch {
      continue; // an unavailable location cannot contain anything
    }
    if (!isAsked(key)) {
      roots.push(root);
      continue;
    }
    let result: ProbeResult = "indeterminate";
    try {
      result = await probe(key);
    } catch {
      result = "indeterminate";
    }
    if (result === "blocked") roots.push(root);
  }
  return roots;
}

/** Production wiring of computeUngrantedRoots: the real store and probe. Empty off macOS. */
export function ungrantedProtectedRoots(): Promise<string[]> {
  if (process.platform !== "darwin") return Promise.resolve([]);
  const store = PermissionStore.getInstance();
  return computeUngrantedRoots(
    PROTECTED_FOLDER_KEYS,
    (key) => store.isAsked(key),
    (key) => probeFolderAccess(PROTECTED_FOLDERS[key].getPath()),
    (key) => PROTECTED_FOLDERS[key].getPath(),
  );
}
