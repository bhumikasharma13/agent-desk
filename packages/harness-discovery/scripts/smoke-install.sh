#!/bin/sh
# Copyright 2026 The Agent Desk Authors
# SPDX-License-Identifier: MIT

# Adds the packed package to an empty project with pnpm, as the README adds it from its GitHub
# Release URL, then runs the installed CLI, the .tgz through npx (the README's way to run the
# command), and imports the package by name, each on a small repo with an empty HOME. The package
# has no runtime dependencies, so the install runs offline.
# Usage: scripts/smoke-install.sh [<path to a .tgz>]. With no path it packs one; the release
# workflow passes the .tgz it attaches, so the file checked is the file released.
set -eu
pkg=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/harness-discovery-smoke-XXXXXX")
trap 'rm -rf "$work"' EXIT

cd "$pkg"
if [ $# -gt 0 ]; then
  tarball="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
else
  # prepack builds dist/ and copies the root LICENSE; pnpm pack prints the tarball's path last.
  tarball="$(pnpm pack --pack-destination "$work" | tail -n 1)"
fi
echo "packed: $(basename "$tarball")"

mkdir "$work/app" "$work/home" "$work/repo"
cd "$work/app"
pnpm add --offline --store-dir "$work/store" "$tarball" >/dev/null
installed=node_modules/harness-discovery
for f in dist/cli.mjs LICENSE NOTICE CHANGELOG.md; do
  [ -f "$installed/$f" ] || { echo "the tarball has no $f"; exit 1; }
done
for f in src examples scripts assets; do
  [ ! -e "$installed/$f" ] || { echo "the tarball carries $f"; exit 1; }
done
# An install from the .tgz must run nothing: those scripts would need the repository's files.
node -e 'const s = require(process.argv[1]).scripts ?? {};
const run = ["preinstall", "install", "postinstall", "prepare"].filter((k) => k in s);
if (run.length) { console.error("the installed package.json declares " + run.join(", ")); process.exit(1); }' "$PWD/$installed/package.json"

export HOME="$work/home" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
cd "$work/repo"
git init -q
mkdir -p .cursor/rules
printf 'Prefer small functions.\n' > .cursor/rules/style.mdc

want=$(printf 'repo-local\tcursor\trule\t.cursor/rules/style.mdc\tc68249835e10\n1 asset')
got=$("$work/app/node_modules/.bin/harness-discovery" scan --repo .)
[ "$got" = "$want" ] || { printf 'CLI output differs:\n%s\n' "$got"; exit 1; }
echo "cli: ok"

# The README's `npx "$HD" scan`, from the .tgz, with npx's cache in the work dir.
# A bare absolute path would run as a command, so the spec is `file:<path>`.
got=$(npm_config_cache="$work/npm-cache" npm_config_update_notifier=false npx --yes --offline "file:$tarball" scan --repo .)
[ "$got" = "$want" ] || { printf 'npx output differs:\n%s\n' "$got"; exit 1; }
echo "npx: ok"

got=$(cd "$work/app" && node --input-type=module -e '
import { scan } from "harness-discovery";
const r = await scan({ repos: [process.argv[1]] });
for (const a of r.assets) console.log(a.scope, a.ideType, a.type, a.sourcePath);
' "$work/repo")
[ "$got" = "repo-local cursor rule .cursor/rules/style.mdc" ] || { printf 'scan() output differs:\n%s\n' "$got"; exit 1; }
echo "import: ok"
echo "smoke install: ok"
