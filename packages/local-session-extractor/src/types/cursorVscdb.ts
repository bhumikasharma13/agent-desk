// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Pure parsers for Cursor's `state.vscdb` project layout. No fs and no SQLite,
 * so any caller can use them.
 *
 * Both `messageRequestContext:*` and `bubbleId:*` values carry the same
 * `{ projectLayouts: [{ rootPath }] }` shape, so one pair of helpers covers the
 * modern path and the older-Cursor fallback identically.
 */

/**
 * Extract `rootPath` from a `projectLayouts` element — either an object
 * (`{ rootPath }`) or a stringified-JSON form (older Cursor).
 */
export function parseRootPathFromLayout(layout: unknown): string | undefined {
  if (typeof layout === "string") {
    try {
      const parsed: unknown = JSON.parse(layout);
      if (typeof parsed === "object" && parsed !== null) {
        const rp = (parsed as Record<string, unknown>)["rootPath"];
        if (typeof rp === "string" && rp.length > 0) return rp;
      }
    } catch {
      // Not JSON — no rootPath recoverable.
    }
    return undefined;
  }
  if (typeof layout === "object" && layout !== null) {
    const rp = (layout as Record<string, unknown>)["rootPath"];
    if (typeof rp === "string" && rp.length > 0) return rp;
  }
  return undefined;
}

/** Parse `rootPath` from a Cursor `state.vscdb` value (JSON string). */
export function parseRootPathFromCursorValue(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const layouts = (parsed as Record<string, unknown>)["projectLayouts"];
    if (!Array.isArray(layouts) || layouts.length === 0) return undefined;
    return parseRootPathFromLayout(layouts[0]);
  } catch {
    return undefined;
  }
}
