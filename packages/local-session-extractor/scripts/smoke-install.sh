#!/usr/bin/env bash
# Copyright 2026 The Agent Desk Authors
# SPDX-License-Identifier: MIT
# Adds the packed package to an empty project with pnpm, as the README adds it from its GitHub
# Release URL, imports it by name, and runs the installed binary: capabilities, then a staged scan,
# its rows export compared with fixtures/golden.jsonl outside the four bookkeeping columns, and its
# default export with fixtures/golden-conversation.jsonl. It also runs the .tgz with npx, the
# README's way to run the command, and the added copy by name with `pnpm exec`.
# The package has no runtime dependencies, so the install runs offline.
# Usage: scripts/smoke-install.sh [<path to a .tgz>]. With no path it packs one; the release
# workflow passes the .tgz it attaches, so the file checked is the file released.
set -euo pipefail

pkg="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/local-session-extractor-smoke-XXXXXX")"
trap 'rm -rf "$work"' EXIT

cd "$pkg"
pnpm -s build >/dev/null
if [ $# -gt 0 ]; then
  tarball="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
else
  # prepack builds first and prints to stdout; pnpm pack prints the tarball's path last.
  tarball="$(pnpm pack --pack-destination "$work" | tail -n 1)"
fi
echo "packed: $(basename "$tarball")"

mkdir "$work/app"
cd "$work/app"
pnpm add --offline --store-dir "$work/store" "$tarball" >/dev/null
installed="node_modules/local-session-extractor"
for f in dist/cli.js LICENSE NOTICE third_party/dataclaw/LICENSE CHANGELOG.md; do
  [ -f "$installed/$f" ] || { echo "the tarball has no $f"; exit 1; }
done
for f in src fixtures contract examples scripts test-setup.mjs; do
  [ ! -e "$installed/$f" ] || { echo "the tarball carries $f"; exit 1; }
done
# An install from the .tgz must run nothing: those scripts would need the repository's files.
node -e 'const s = require(process.argv[1]).scripts ?? {};
const run = ["preinstall", "install", "postinstall", "prepare"].filter((k) => k in s);
if (run.length) { console.error("the installed package.json declares " + run.join(", ")); process.exit(1); }' "$PWD/$installed/package.json"
bin="$work/app/node_modules/.bin/local-session-extractor"
echo "installed: $("$bin" --version)"
# The README's SDK program imports the package by name from the project it was added to.
node --no-warnings=ExperimentalWarning --input-type=module -e 'import { openStore, readAll } from "local-session-extractor";
if (typeof openStore !== "function" || typeof readAll !== "function") process.exit(1);' || { echo "the installed package does not export openStore and readAll"; exit 1; }
echo "import: ok"

# The installed binary runs with an empty HOME; every read is under a staged home.
mkdir "$work/empty-home"
run() { HOME="$work/empty-home" "$bin" "$@"; }

run capabilities --json

# The README's `npx "$LSE" capabilities`, from the .tgz, with npx's cache in the work dir.
# A bare absolute path would run as a command, so the spec is `file:<path>`.
(cd "$work/empty-home" && HOME="$work/empty-home" npm_config_cache="$work/npm-cache" npm_config_update_notifier=false npx --yes --offline "file:$tarball" capabilities) >"$work/npx.txt"
run capabilities | cmp -s - "$work/npx.txt" || { echo "npx capabilities differs from the installed binary's"; exit 1; }
echo "npx: ok"
# The copy added to the project runs by name there, as the SDK's project would run it.
(cd "$work/app" && HOME="$work/empty-home" pnpm exec local-session-extractor capabilities) | cmp -s - "$work/npx.txt" || { echo "the project's local-session-extractor capabilities differs from the installed binary's"; exit 1; }
echo "by name: ok"

(cd "$pkg" && pnpm -s stage "$work/staged" >/dev/null)
db="$work/sessions.db"
run scan --home "$work/staged/home" --db "$db"
run scan --home "$work/staged/codex-sqlite-home" --sources codex --db "$db"
run export --raw --format jsonl --include-sync-state --db "$db" >"$work/export.jsonl"
run export --db "$db" >"$work/conversations.jsonl"

node - "$work/export.jsonl" "$pkg/fixtures/golden.jsonl" <<'EOF'
const { readFileSync } = require("node:fs");
const [exportPath, goldenPath] = process.argv.slice(2);
const bookkeeping = ["created_at", "updated_at", "synced_at", "last_reextract_at"];
const lines = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean);
const key = (r) => `${r.ide_type}\u0000${r.session_id}`;
const rows = lines(exportPath).map((l) => JSON.parse(l)).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
for (const r of rows) for (const c of bookkeeping) delete r[c];
const got = rows.map((r) => JSON.stringify(r));
const want = lines(goldenPath);
const diffs = want.filter((w, i) => w !== got[i]).length + Math.max(0, got.length - want.length);
console.log(`export: ${got.length} rows, golden: ${want.length} rows, differing: ${diffs}`);
process.exit(diffs === 0 && got.length === want.length ? 0 : 1);
EOF
# A session with no prompt or source time starts at the store's wall-clock created_at,
# which the golden, built from rows without it, leaves out.
node - "$work/conversations.jsonl" "$pkg/fixtures/golden-conversation.jsonl" <<'EOF'
const { readFileSync } = require("node:fs");
const [exportPath, goldenPath] = process.argv.slice(2);
const lines = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const key = (c) => `${c.ideType}\u0000${c.sessionId}`;
const sorted = (cs) => cs.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
const want = sorted(lines(goldenPath));
const got = sorted(lines(exportPath));
got.forEach((c, i) => {
  if (want[i] && !("conversationStartedAt" in want[i])) delete c.conversationStartedAt;
});
const diffs = want.filter((w, i) => JSON.stringify(w) !== JSON.stringify(got[i])).length + Math.max(0, got.length - want.length);
console.log(`conversations: ${got.length}, golden: ${want.length}, differing: ${diffs}`);
process.exit(diffs === 0 && got.length === want.length ? 0 : 1);
EOF
echo "smoke install: ok"
