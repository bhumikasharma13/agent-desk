// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * First-pass scrub of one captured session file for a fixture corpus. From the
 * package root:
 *   node --import ./test-register.mjs \
 *     fixtures/extraction/capture-fixture-scrub.mts <src> <out>
 *
 * IT IS A FIRST PASS, NOT COMPLETE REDACTION. It runs the package's
 * own redactText (anonymizeText + redactSecrets) over the RAW file text, so it
 * catches what that module catches — the running user's home path/username and
 * known secret SHAPES (JWTs, cloud keys, PEM blocks, emails, high-entropy quoted
 * strings) — ANYWHERE in the file, keys included, with number formatting and
 * structure byte-preserved (no JSON round-trip). What it CANNOT catch, and what
 * the human scrub-review must remove, is free prose the module has no pattern
 * for: colleague/customer/org names, phone numbers, IP addresses, and repo/dir
 * names embedded in paths; and it does not rotate ids. The capture tool exists
 * to make that review the only manual step, not to replace it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { redactText } from "../../src/redaction/index";

const srcPath = process.argv[2];
const outPath = process.argv[3];
if (!srcPath || !outPath) {
  console.error("usage: capture-fixture-scrub.mts <src> <out>");
  process.exit(2);
}

// Redact the raw text, not a parsed-and-restringified tree: a JSON KEY that is
// an absolute path (edit/diff/tool-result maps keyed by /Users/<user>/…) is
// scrubbed exactly like a value, and numbers keep their on-disk formatting
// (big-int timestamps and snowflakes never re-serialize to a different number).
const scrubbed = redactText(readFileSync(srcPath, "utf8"));

// Scrubbing raw text can corrupt JSON structure: a secret pattern whose value
// class runs to a delimiter (e.g. a URL query token `?token=…`, matched up to
// `&`/whitespace) swallows the closing quote and everything after it, leaving an
// unparseable line. The whole point of this corpus is faithful fixtures, so
// refuse to emit a member that no longer parses rather than lock in silent
// garbage — fail-closed, like the binary/compressed refusals upstream. Only JSON
// inputs are validated; the corpus also holds non-JSON text the extractors read.
if (srcPath.endsWith(".jsonl")) {
  scrubbed.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      JSON.parse(line);
    } catch {
      console.error(`scrub corrupted JSONL line ${i + 1} of ${srcPath} — not emitting (a secret pattern likely consumed a structural delimiter)`);
      process.exit(1);
    }
  });
} else if (srcPath.endsWith(".json")) {
  try {
    JSON.parse(scrubbed);
  } catch {
    console.error(`scrub corrupted the JSON of ${srcPath} — not emitting (a secret pattern likely consumed a structural delimiter)`);
    process.exit(1);
  }
}

writeFileSync(outPath, scrubbed);
