// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Path helpers shared between main and renderer.
 */

/** The leaf directory name of a POSIX or Windows-style path (a project's display name). */
export function extractBasename(path: string | null | undefined): string | null {
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? null;
}
