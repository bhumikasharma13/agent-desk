#!/usr/bin/env node
// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { escapeControls } from "./sanitize";
import { IDES, scan } from "./scan";

const USAGE = `Usage: harness-discovery scan [--home <dir>] [--repo <dir>]... [--ide <ide>]... [--json]

Lists the skills, rules, agents, hooks, commands, plugins and instruction files that
Claude Code, Codex, Cursor and Kiro load. It reads files and never writes.

  --home <dir>   Home directory to read user-scope config from (default: $HOME)
  --repo <dir>   Repository to scan for repo-scope config (repeatable)
  --ide <ide>    Limit to claude-code, codex, cursor or kiro (repeatable)
  --json         Print the full result as JSON

Exit status: 0 on success, 1 when a repo or tool could not be scanned, 2 on bad usage.
`;

interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const stdio: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

/**
 * One text-mode field, safe for a terminal and for the tab-separated format: file names come
 * from scanned repos, so control characters (escape sequences, tab, newline) are shown as
 * `\xNN`, and bidirectional controls as `\uNNNN`, rather than written raw.
 */
const field = (s: string): string => escapeControls(s);

/** JSON.stringify escapes only C0; C1 and bidi controls become `\uXXXX` too (still valid JSON). */
const safeJson = (value: unknown): string =>
  JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

export async function main(argv: string[], io: Io = stdio): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        home: { type: "string" },
        repo: { type: "string", multiple: true },
        ide: { type: "string", multiple: true },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    const unknown = err instanceof Error ? err.message.match(/^Unknown option '(.*?)'(?:\. |$)/s) : null;
    const message = unknown ? `unknown option: ${field(unknown[1]!)}` : err instanceof Error ? err.message : String(err);
    io.err(`${message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  if (positionals.length !== 1 || positionals[0] !== "scan") {
    io.err(USAGE);
    return 2;
  }

  const previousHome = process.env.HOME;
  try {
    if ((values.repo ?? []).includes("")) {
      io.err("--repo: empty path\n");
      return 2;
    }
    // Canonical, so it compares equal to git's physical paths.
    if (values.home !== undefined) {
      if (values.home === "") {
        io.err("--home: empty path\n");
        return 2;
      }
      let home: string | undefined;
      try {
        home = realpathSync(resolve(values.home));
      } catch {
        home = undefined;
      }
      if (home === undefined || !statSync(home).isDirectory()) {
        io.err(`--home ${field(values.home)}: not a directory\n`);
        return 2;
      }
      process.env.HOME = home;
    }
    const ides = [...new Set(values.ide ?? IDES)];
    const unknown = ides.filter((i) => !(IDES as readonly string[]).includes(i));
    if (unknown.length > 0) {
      io.err(`unknown --ide: ${unknown.map(field).join(", ")} (expected one of ${IDES.join(", ")})\n`);
      return 2;
    }

    const result = await scan({ repos: values.repo ?? [], ides: ides as (typeof IDES)[number][] });

    if (values.json) {
      io.out(`${safeJson(result)}\n`);
    } else {
      for (const a of result.assets) {
        io.out(`${[a.scope, a.ideType, a.type, a.sourcePath, a.contentHash.slice(0, 12)].map(field).join("\t")}\n`);
      }
      io.out(`${result.assets.length} asset${result.assets.length === 1 ? "" : "s"}\n`);
    }
    for (const w of result.warnings) io.err(`warning: ${field(w.path ?? w.root ?? w.ide ?? "")}: ${field(w.message)}\n`);
    for (const e of result.errors) io.err(`error: ${field(e.path ?? e.root ?? e.ide ?? "")}: ${field(e.message)}\n`);
    return result.errors.length > 0 ? 1 : 0;
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
