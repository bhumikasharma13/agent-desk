// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import path from "node:path";

// macOS volumes are case-insensitive by default and accept either Unicode
// normalization of a name, so "~/documents/x" and a decomposed "é" reach the
// same folder as "~/Documents/x" and a composed "é". Both sides are compared in
// one folded form there. On a case-sensitive volume this can call two different
// folders the same; that errs towards skipping, never towards reading.
const fold =
  process.platform === "darwin" ? (p: string): string => p.normalize("NFC").toLowerCase() : (p: string): string => p;

/**
 * True when `absPath` is `baseDir` itself or a descendant of it. Pure (no fs,
 * no electron), so both the main process and the extraction worker use it. The
 * `+ path.sep` guard is load-bearing: it stops a sibling like
 * "/Users/x/Documents-old" from matching the "/Users/x/Documents" base.
 */
export function isPathWithinBase(absPath: string, baseDir: string): boolean {
  const target = fold(path.resolve(absPath));
  const base = fold(path.resolve(baseDir));
  // A base that already ends in the separator ("/") is its own prefix.
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return target === base || target.startsWith(prefix);
}
