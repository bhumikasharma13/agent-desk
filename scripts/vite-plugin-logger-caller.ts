// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// Vite plugin that injects a source-location string as the 4th positional
// argument to every `logger.info|warn|error|debug(...)` call. A call with fewer
// than three arguments is padded with `undefined` first, so the string always
// lands in the 4th slot and never in `data`.
//
// Why: production builds bundle every .ts file into one .js, so the logger's
// runtime captureCallerSite() would name the bundle, not the source file.
// Injecting the call site as a string literal at build time survives bundling
// because it's just data, not stack metadata.
//
// The logger reads the 4th argument as __callerOverride and skips the V8
// stack parse when it's present. See src/main/logging/logger.ts.

import MagicString from "magic-string";
import { relative, sep } from "node:path";
import type { Plugin } from "vite";

const LEVELS = new Set(["info", "warn", "error", "debug"]);
const LOGGER_DEF_SUFFIX = `${sep}src${sep}main${sep}logging${sep}logger.ts`;

function isInjectable(id: string): boolean {
  if (!id.endsWith(".ts")) return false;
  if (id.includes(`${sep}node_modules${sep}`)) return false;
  if (id.endsWith(LOGGER_DEF_SUFFIX)) return false;
  return id.includes(`${sep}src${sep}main${sep}`);
}

function isWord(c: string | undefined): boolean {
  if (!c) return false;
  return /[A-Za-z0-9_$]/.test(c);
}

interface Match {
  /** Index of the opening `(` of the call. */
  open: number;
  /** Index of the matching closing `)`. */
  close: number;
  /** 1-based source line of the `logger.` prefix. */
  line: number;
}

// Single forward pass that tracks string/comment state and emits a Match for
// every top-level `logger.info|warn|error|debug(` whose argument list is
// balanced. Anything inside strings, template literals, or comments is ignored.
function scan(src: string): Match[] {
  const matches: Match[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    // Line comment
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i + 2);
      if (nl === -1) return matches;
      i = nl;
      continue;
    }
    // Block comment
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return matches;
      // Advance line counter through the comment body
      for (let j = i; j < end; j++) if (src.charCodeAt(j) === 10) line++;
      i = end + 2;
      continue;
    }
    // Strings / template literals
    if (c === '"' || c === "'" || c === "`") {
      const next = skipString(src, i, c, line);
      line = next.line;
      i = next.idx;
      continue;
    }
    // Candidate match: `logger.` at a word boundary
    if (c === "l" && src.startsWith("logger.", i) && !isWord(src[i - 1])) {
      const levelStart = i + 7;
      // Read the identifier after `logger.`
      let j = levelStart;
      while (j < n && isWord(src[j])) j++;
      const level = src.slice(levelStart, j);
      if (LEVELS.has(level)) {
        // Allow whitespace between identifier and `(`
        let k = j;
        while (k < n && (src[k] === " " || src[k] === "\t")) k++;
        if (src[k] === "(") {
          const matchLine = line;
          const close = walkToClose(src, k + 1);
          if (close.idx !== -1) {
            matches.push({ open: k, close: close.idx, line: matchLine });
            line += close.line;
            i = close.idx + 1;
            continue;
          }
        }
      }
    }
    i++;
  }
  return matches;
}

// Walks from `start` (just past the opening `(` of a call) through balanced
// brackets and strings until the matching `)`. Returns the close index and the
// running line number, or { idx: -1 } when the source is unbalanced.
function walkToClose(
  src: string,
  start: number,
): { idx: number; line: number } {
  let depth = 1;
  let i = start;
  let line = 0; // delta, caller maintains absolute line
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i + 2);
      if (nl === -1) return { idx: -1, line };
      i = nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return { idx: -1, line };
      for (let j = i; j < end; j++) if (src.charCodeAt(j) === 10) line++;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const nx = skipString(src, i, c, 0);
      line += nx.line;
      i = nx.idx;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0 && c === ")") return { idx: i, line };
    }
    i++;
  }
  return { idx: -1, line };
}

// Skips over a string or template literal starting at `start` (the opening
// quote). Returns the index after the closing quote and the line delta.
// Template-literal interpolations call skipInterpolation, which balances `{}`
// (NOT `()` — walkToClose was the wrong tool for this and consumed the rest
// of the file once it failed to find a `)`).
function skipString(
  src: string,
  start: number,
  quote: string,
  baseLine: number,
): { idx: number; line: number } {
  let i = start + 1;
  let line = baseLine;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === "\\") {
      if (src[i + 1] === "\n") line++;
      i += 2;
      continue;
    }
    if (c === quote) return { idx: i + 1, line };
    if (quote === "`" && c === "$" && src[i + 1] === "{") {
      const nx = skipInterpolation(src, i + 2);
      line += nx.line;
      i = nx.idx;
      continue;
    }
    i++;
  }
  return { idx: n, line };
}

// Walks the body of a template-literal `${...}` starting just after the `${`.
// Returns the index after the matching `}` plus the line delta. Recurses into
// nested strings/template-literals and skips comments. Treats `{}` as the
// balanced delimiter (not `()` like walkToClose).
function skipInterpolation(src: string, start: number): { idx: number; line: number } {
  let depth = 1;
  let i = start;
  let line = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i + 2);
      if (nl === -1) return { idx: n, line };
      i = nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return { idx: n, line };
      for (let j = i; j < end; j++) if (src.charCodeAt(j) === 10) line++;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const nx = skipString(src, i, c, 0);
      line += nx.line;
      i = nx.idx;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { idx: i + 1, line };
    }
    i++;
  }
  return { idx: n, line };
}

// Number of top-level arguments between a call's parentheses (`open` and
// `close` are the indexes of `(` and `)`). Strings, template literals and
// comments are skipped; a trailing comma adds no argument.
function topLevelArgCount(src: string, open: number, close: number): number {
  let depth = 0;
  let count = 0;
  let sawToken = false;
  let i = open + 1;
  while (i < close) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i + 2);
      i = nl === -1 || nl > close ? close : nl;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? close : end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i, c, 0).idx;
      sawToken = true;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      count++;
      sawToken = false;
      i++;
      continue;
    }
    if (!/\s/.test(c)) sawToken = true;
    i++;
  }
  return count + (sawToken ? 1 : 0);
}

function shortenSourcePath(absPath: string, projectRoot: string): string {
  const rel = relative(projectRoot, absPath);
  return rel.split(sep).join("/");
}

export interface LoggerCallerOptions {
  /** Absolute path of the project root. */
  projectRoot: string;
}

export function loggerCallerPlugin(opts: LoggerCallerOptions): Plugin {
  return {
    name: "agent-desk:logger-caller",
    enforce: "pre",
    transform(code, id) {
      if (!isInjectable(id)) return null;
      if (!code.includes("logger.")) return null;

      const matches = scan(code);
      if (matches.length === 0) return null;

      const ms = new MagicString(code);
      const relPath = shortenSourcePath(id, opts.projectRoot);

      for (const m of matches) {
        const args = topLevelArgCount(code, m.open, m.close);
        if (args >= 4) continue; // already carries a caller
        const callerLiteral = JSON.stringify(`${relPath}:${m.line}`);
        const between = code.slice(m.open + 1, m.close).trim();
        const prefix = between.length === 0 || between.endsWith(",") ? "" : ", ";
        const padding = "undefined, ".repeat(Math.max(0, 3 - args));
        ms.appendLeft(m.close, `${prefix}${padding}${callerLiteral}`);
      }

      return {
        code: ms.toString(),
        map: ms.generateMap({ hires: "boundary", source: id }),
      };
    },
  };
}

export default loggerCallerPlugin;
