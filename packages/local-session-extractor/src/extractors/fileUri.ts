// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * The path of a `file://` URI as vendor stores write it, percent-decoded. Each
 * run of valid `%XX` escapes is decoded; an escape that does not decode (a stray
 * `%` in `50%.md`) is kept as written, so one malformed URI costs nothing more
 * than its own spelling. The leading `/` of `file:///…` is kept.
 */
export function fileUriPath(uri: string): string {
  const path = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
  return path.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}
