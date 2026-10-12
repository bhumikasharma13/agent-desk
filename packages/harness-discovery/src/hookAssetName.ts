// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { escapeControls } from "./sanitize";

/**
 * Display name of an inline hook asset: `${event}: ${label}`, where `label` is the command
 * with its config-dir boilerplate stripped (see hookCommandLabel). The session bounds every
 * name at 256 characters ({@link boundAssetName}) and escapes control characters.
 *
 * The one home of the format, so anything that reconstructs a hook's name from
 * its event and command (to match a hook to the inventory, say)
 * gets the same bytes the scan reports.
 *
 * It imports only `sanitize.ts`, so such a caller can use it without the scanner's modules.
 */
export function hookInlineAssetName(eventType: string, command: string): string {
  return `${eventType}: ${hookCommandLabel(command)}`;
}

/**
 * Asset names are bounded at 256 characters, so they fit a fixed-width key or column. An
 * inline hook command can easily run longer.
 *
 * The tail is a hash of the FULL name, not an ellipsis alone, because two hooks in one file
 * routinely share a long prefix — a bare truncation would collapse them into one identity and
 * silently drop one.
 */
const MAX_ASSET_NAME = 256;
/** A hook name's matcher is bounded on its own, so the script stays. */
const MAX_NAME_PART = 80;

/** `text` cut to `max` characters with a hash of the whole of it at the end; never splits a
 *  surrogate pair or an escape (`\xNN`, `\uNNNN`) that {@link escapeControls} wrote. */
function boundText(text: string, max: number): string {
  if (text.length <= max) return text;
  // FNV-1a, inline: this module stays import-free.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const suffix = `…${h.toString(16).padStart(8, "0")}`;
  let cut = max - suffix.length;
  // Never end on the first half of a surrogate pair.
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--;
  cut -= /\\(?:x[0-9a-f]?|u[0-9a-f]{0,3})?$/.exec(text.slice(0, cut))?.[0].length ?? 0;
  return text.slice(0, cut) + suffix;
}

export function boundAssetName(name: string): string {
  return boundText(name, MAX_ASSET_NAME);
}

/**
 * Display name of a FILE-BACKED hook asset: `${event}: ${basename(scriptPath)}`, with
 * `[${matcher}]` after the event when the wiring has a matcher and ` #${argsHash}` after the
 * script when the command has arguments (`PreToolUse[Bash]: guard.sh #3f9a1c`). The script is
 * the asset's file, so the matcher and the hash are what keep two wirings of one script two
 * assets, and the arguments themselves stay out of names, ids and warnings. The matcher is
 * escaped, then bounded at 80 characters, so the script name always shows. Same single-home
 * contract as {@link hookInlineAssetName}. The basename splits on `/` only: on POSIX a
 * backslash is part of a file name.
 */
export function hookFileAssetName(eventType: string, scriptPath: string, matcher = "", argsHash = ""): string {
  const base = scriptPath.split("/").pop() ?? scriptPath;
  const m = matcher !== "" ? `[${boundText(escapeControls(matcher), MAX_NAME_PART)}]` : "";
  const a = argsHash !== "" ? ` #${argsHash}` : "";
  return `${eventType}${m}: ${base}${a}`;
}

/**
 * Strip the boilerplate a Claude Code hook command carries so the meaningful
 * script tail reads on its own: the `"$CLAUDE_PROJECT_DIR"` / `${CLAUDE_PLUGIN_ROOT}`
 * root vars Claude Code injects (quoted or bare) and a leading `.claude/` config
 * segment — so `"$CLAUDE_PROJECT_DIR"/.claude/hooks/format.sh` becomes
 * `hooks/format.sh`. An inline command with no such prefix (a bare `jq …`) is
 * returned trimmed and otherwise intact.
 */
export function hookCommandLabel(command: string): string {
  return command
    .trim()
    .replace(/["']?\$\{?CLAUDE_PROJECT_DIR\}?["']?/g, "")
    .replace(/["']?\$\{?CLAUDE_PLUGIN_ROOT\}?["']?/g, "")
    .replace(/^\/?\.claude\//, "")
    .replace(/^\/+/, "")
    .trim();
}
