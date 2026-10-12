// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Detail-view file read for the Harness page (harness:readAsset). Serves the raw
 * contents of ONE asset file, read-only. This is deliberately narrow: the app is
 * read-only on the user's machine, so nothing here writes, uploads, or reaches
 * the network — it is a local read, like the inventory serve.
 *
 * Security boundary: the read is allowlisted to files the stored inventory
 * surfaced (`viewableFilePaths`), so this IPC can't be turned into an
 * arbitrary file reader. The read then opens the path ONCE and works off that
 * single handle (size check + read on the same inode, no check-then-read gap),
 * and refuses binary files. A listed path is also resolved link by link
 * (resolveProject) and refused when it leads into a folder the user has not
 * granted: the home-folder scan follows links in `~/.claude` and the like into
 * protected folders, and the viewer must not open what they lead to.
 */

import { open } from "node:fs/promises";
import { constants } from "node:fs";
import type { HarnessAssetContent } from "../../shared/harnessTypes";
import { homedir } from "node:os";
import { resolveLinks, resolveProject, withResolvedSkipRoots } from "../permissions/resolveProject";
import { isPathWithinBase } from "../permissions/pathWithin";

// Cap the read so a pathological file can't be slurped whole into the renderer.
const MAX_VIEW_BYTES = 512 * 1024;

/**
 * Read one asset's file for the detail view. Only files in `allowed` (the
 * stored inventory's viewable paths) are served — that membership check is
 * the security boundary. Size-capped; binary files refused.
 */
export async function readHarnessAsset(
  allowed: readonly string[],
  filePath: string,
  skipRoots: readonly string[] = [],
  readRoots: readonly string[] = [homedir()],
): Promise<HarnessAssetContent> {
  if (typeof filePath !== "string" || filePath === "") {
    return { content: null, error: "This file is not part of the current inventory." };
  }
  if (!allowed.includes(filePath)) {
    return { content: null, error: "This file is not part of the current inventory." };
  }
  const resolved = await resolveProject(filePath, skipRoots);
  if (resolved === null) {
    return { content: null, error: "This file is missing, or is in a folder Agent Desk is not allowed to read." };
  }
  // The file may have been swapped for a link since the scan: what it leads to must
  // still be inside the home folder or a scanned repo, as at scan time. A repo in a
  // folder not granted is no root: resolving it would look inside that folder.
  const skip = await withResolvedSkipRoots(skipRoots);
  const roots = await Promise.all(readRoots.map((root) => resolveLinks(root, skip)));
  if (!roots.some((root) => root !== null && isPathWithinBase(resolved, root))) {
    return { content: null, error: "This file now leads outside your home folder and the scanned projects, so it is not opened." };
  }

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Open once, then stat and read from the SAME handle: the size gate and the
    // read see one inode, so the path can't be swapped between a separate
    // stat() and readFile() (the check-then-read gap). O_NONBLOCK so the open()
    // itself can't hang on a non-regular file — e.g. an allowlisted path
    // repointed to a FIFO with no writer would otherwise block the IPC handler
    // forever; the fstat below then rejects anything that isn't a regular file.
    // (O_NONBLOCK is inert for reading a regular file.)
    handle = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) return { content: null, error: "Not a file." };
    if (info.size > MAX_VIEW_BYTES) {
      return {
        content: null,
        error: `File is too large to preview (${Math.round(info.size / 1024)} KB).`,
      };
    }
    // Bound the read itself, not just the pre-read stat(): read at most
    // MAX_VIEW_BYTES + 1 bytes so a file that grew past the size gate between
    // stat() and here can't be slurped whole (capping memory + keeping the IPC
    // responsive). bytesRead > MAX_VIEW_BYTES means it outgrew the cap.
    const readBuf = Buffer.allocUnsafe(MAX_VIEW_BYTES + 1);
    const { bytesRead } = await handle.read(readBuf, 0, MAX_VIEW_BYTES + 1, 0);
    if (bytesRead > MAX_VIEW_BYTES) {
      return {
        content: null,
        error: `File is too large to preview (over ${Math.round(MAX_VIEW_BYTES / 1024)} KB).`,
      };
    }
    const buf = readBuf.subarray(0, bytesRead);
    // A binary file decodes to U+FFFD replacement characters as UTF-8; detect a
    // NUL byte and refuse rather than render garbage in the viewer.
    if (buf.includes(0)) {
      return { content: null, error: "This file can't be previewed (binary)." };
    }
    return { content: buf.toString("utf8"), error: null };
  } catch (err) {
    return { content: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await handle?.close();
  }
}
