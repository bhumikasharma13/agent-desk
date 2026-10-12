// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * `pnpm stage <dir>`: writes `<dir>/home` and `<dir>/codex-sqlite-home`, the two
 * HOME-shaped fixture trees whose scans reproduce the goldens:
 *
 *   local-session-extractor scan --home <dir>/home --db <db>
 *   local-session-extractor scan --home <dir>/codex-sqlite-home --sources codex --db <db>
 *   local-session-extractor export --raw --format jsonl --include-sync-state --db <db>
 *
 * The rows export equals the golden apart from its bookkeeping columns, and a plain
 * `export` equals `fixtures/golden-conversation.jsonl`.
 */
import { resolve } from "node:path";
import { stageHomes } from "./golden";

const target = process.argv[2];
if (target === undefined || target.length === 0) {
  console.error("usage: pnpm stage <dir>   (the directory must be missing or empty)");
  process.exit(1);
}
// pnpm runs a script from the package directory; a relative path means the caller's directory.
const out = resolve(process.env["INIT_CWD"] ?? process.cwd(), target);
try {
  const { home, codexSqliteHome } = stageHomes(out);
  console.log(`staged ${home}`);
  console.log(`staged ${codexSqliteHome}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
