// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * "Did the user deny scan access?" — the single evaluator behind the tray
 * attention state and the blocked-folder prompt.
 *
 * Only folders the store has already asked for are probed: a first read of an
 * un-decided TCC folder shows a native prompt, so probing an un-asked
 * folder here would surface an unexplained OS dialog. An already-decided folder
 * returns granted/blocked immediately with no prompt. Only a definitive
 * `blocked` escalates; `indeterminate` (missing folder / transient I/O) and a
 * throwing probe are treated as not-blocked so a transient failure never nags.
 */

import type { ProtectedFolderKey } from "../../shared/permissionTypes";
import { probeFolderAccess, type ProbeResult } from "./folderAccess";
import { PermissionStore } from "./permissionStore";
import { PROTECTED_FOLDERS, PROTECTED_FOLDER_KEYS } from "./protectedFolders";

/**
 * Pure core: probe each already-asked folder and collect the blocked ones.
 * Dependencies injected so it is unit-testable without fs/electron.
 */
export async function computeBlockedFolders(
  keys: ProtectedFolderKey[],
  isAsked: (key: ProtectedFolderKey) => boolean,
  probe: (key: ProtectedFolderKey) => Promise<ProbeResult>,
): Promise<ProtectedFolderKey[]> {
  const blocked: ProtectedFolderKey[] = [];
  for (const key of keys) {
    if (!isAsked(key)) continue;
    let result: ProbeResult = "indeterminate";
    try {
      result = await probe(key);
    } catch {
      result = "indeterminate";
    }
    if (result === "blocked") blocked.push(key);
  }
  return blocked;
}

/** Production wiring: real store + real folder probe over the registry. */
export function evaluateBlockedFolders(): Promise<ProtectedFolderKey[]> {
  const store = PermissionStore.getInstance();
  return computeBlockedFolders(
    PROTECTED_FOLDER_KEYS,
    (key) => store.isAsked(key),
    (key) => probeFolderAccess(PROTECTED_FOLDERS[key].getPath()),
  );
}
