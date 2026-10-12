// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Deliberate folder-access probe.
 *
 * On macOS, the FIRST read of a TCC-protected folder (Desktop/Documents/
 * Downloads) shows the native permission prompt and fails with EPERM at once,
 * without waiting for the answer; the answer applies to later reads, which
 * reflect the stored TCC decision with no further prompt. So a "blocked" result
 * right after a first ask means "not granted yet" (askFolders re-probes).
 *
 * The gate calls this ONLY after the user clicks Continue in our primer, so the
 * native prompt never appears before we have explained why.
 */

import { readdir } from "node:fs/promises";

export type ProbeResult = "granted" | "blocked" | "indeterminate";

/**
 * Maps an fs error code to a probe result. A true permission error (EPERM/
 * EACCES) is "blocked" — the user denied access, a real TCC decision. Anything
 * else (missing folder, transient I/O) is "indeterminate": no TCC decision
 * happened, so the caller must NOT persist it as asked — otherwise the primer
 * is skipped forever and a later real read surfaces the native prompt with no
 * explanation.
 *
 * Pure + exported for unit testing without touching the filesystem.
 */
export function classifyProbeError(code: string | undefined): ProbeResult {
  return code === "EPERM" || code === "EACCES" ? "blocked" : "indeterminate";
}

/**
 * Attempts to read `dir`. Returns "granted" on success, "blocked" on a
 * permission error (EPERM/EACCES), "indeterminate" on any other error (missing
 * folder / transient I/O). See module doc for the macOS prompt semantics.
 */
export async function probeFolderAccess(dir: string): Promise<ProbeResult> {
  try {
    await readdir(dir);
    return "granted";
  } catch (err) {
    return classifyProbeError((err as NodeJS.ErrnoException)?.code);
  }
}
