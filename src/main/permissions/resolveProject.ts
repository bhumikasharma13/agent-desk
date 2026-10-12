// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { lstat, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { isPathWithinBase } from "./pathWithin";

// A symlink chain longer than this is treated as a loop.
const MAX_LINK_HOPS = 40;

const withinAny = (p: string, roots: readonly string[]): boolean => roots.some((root) => isPathWithinBase(p, root));

/**
 * Where a project folder really is, found without reading inside a folder the
 * user has not allowed: the spelled path is walked one component at a time,
 * following each symlink (and each "..") from where it really points, and every
 * resolved prefix is checked against `skipRoots` before anything inside it is
 * looked at. Null when the project resolves into a skipped folder, onto the home
 * folder or a folder that holds it, or when a part of the path does not exist:
 * what follows a missing part cannot be resolved, so it is not read.
 *
 * Not `realpath`: that would stat every component on the way, inside a skipped
 * folder too, before the check could stop it.
 */
export async function resolveProject(spelled: string, skipRoots: readonly string[]): Promise<string | null> {
  const current = await resolveLinks(spelled, await withResolvedSkipRoots(skipRoots));
  if (current === null || isPathWithinBase(homedir(), current)) return null;
  return current;
}

/**
 * The skipped folders as spelled and where they really are, for resolveLinks. A skipped
 * folder is matched where it really is too, so a symlinked folder above it
 * (/Users/x -> /Volumes/Data/Users/x) cannot lead around it. Only the folders above a
 * skipped folder are resolved, so one that is itself a symlink is matched as spelled.
 */
export async function withResolvedSkipRoots(skipRoots: readonly string[]): Promise<string[]> {
  const resolvedRoots = await Promise.all(
    skipRoots.map(async (root) => {
      const parent = await resolveLinks(path.dirname(root), []);
      return parent === null ? null : path.join(parent, path.basename(root));
    }),
  );
  return [...skipRoots, ...resolvedRoots.filter((root): root is string => root !== null)];
}

/** The spelled path resolved one component at a time; null when it reaches a skipped folder or a missing part. */
export async function resolveLinks(spelled: string, skipRoots: readonly string[]): Promise<string | null> {
  // Split as spelled, without normalizing: "link/.." must step back from where the link
  // points. Project paths are absolute; a relative one is read from the root.
  const queue = spelled.split(path.sep);
  let current: string = path.sep;
  let hops = 0;
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (name === "" || name === ".") continue;
    if (name === "..") {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, name);
    if (withinAny(next, skipRoots)) return null;
    let info;
    try {
      info = await lstat(next);
    } catch {
      // Missing or unreadable: a ".." or a link after it could lead anywhere.
      return null;
    }
    if (!info.isSymbolicLink()) {
      current = next;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) return null;
    const target = await readlink(next).catch(() => null);
    if (target === null) return null;
    if (path.isAbsolute(target)) current = path.sep;
    queue.unshift(...target.split(path.sep));
  }
  return withinAny(current, skipRoots) ? null : current;
}
