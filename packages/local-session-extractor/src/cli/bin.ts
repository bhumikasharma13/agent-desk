#!/usr/bin/env node
// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/** The `local-session-extractor` binary. */

// Node flags node:sqlite experimental when it loads; to a CLI user that notice is
// noise on every run. Only that one warning is dropped, and only by the binary,
// so it is filtered before `./main` (which loads node:sqlite) is imported.
const emitWarning = process.emitWarning.bind(process) as (...args: unknown[]) => void;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (/SQLite is an experimental feature/.test(text)) return;
  emitWarning(warning, ...rest);
}) as typeof process.emitWarning;

// A reader that closes the pipe early (`| head`) has everything it asked for:
// EPIPE on either stream exits 0. Any other stream error exits 1 with its
// message, and neither prints a stack trace.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    try {
      process.stderr.write(`local-session-extractor: ${err.message}\n`);
    } finally {
      process.exit(1);
    }
  });
}

const { main } = await import("./main");
process.exitCode = await main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin });

export {};
