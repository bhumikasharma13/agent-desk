#!/bin/sh
# Copyright 2026 The Agent Desk Authors
# SPDX-License-Identifier: MIT

# Sourced by every examples/<name>/run.sh, and by .github/assets/screenshots.sh with EXAMPLE
# set to its own folder. It makes a throwaway HOME in a fresh working
# directory ($AD_WORK, created by the runner or here) from the example's testdata/home, with
# /Users/you in the session files rewritten to that HOME, and turns every folder under
# $HOME/src into a git repo with one commit on main. The app reads that HOME only, with its
# own throwaway profile, and nothing leaves the machine.
set -eu
EXAMPLE=${EXAMPLE:-$(cd "$(dirname "$0")" && pwd)}
REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
if [ ! -f "$REPO_ROOT/.vite/build/index.js" ]; then
  echo "the app is not built: run pnpm build first" >&2
  exit 1
fi
# A run the runner did not start makes its own work dir and removes it on exit.
if [ -z "${AD_WORK:-}" ]; then
  AD_WORK=$(mktemp -d)
  trap 'rm -rf "$AD_WORK"' EXIT
fi
AD_WORK=$(cd "$AD_WORK" && pwd -P)
export HOME="$AD_WORK/home"
mkdir -p "$HOME"
cp -R "$EXAMPLE/testdata/home/." "$HOME/"
find "$HOME" -name '*.jsonl' -exec sed -i.bak "s|/Users/you|$HOME|g" {} +
find "$HOME" -name '*.jsonl.bak' -delete
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
# example-show.mjs imports a .ts helper of the Harness page; Node prints a note that it
# guessed the module type. Keep the examples' output to what they print.
export NODE_NO_WARNINGS=1
export GIT_AUTHOR_NAME="Jane Doe" GIT_AUTHOR_EMAIL="jane@example.com"
export GIT_COMMITTER_NAME="Jane Doe" GIT_COMMITTER_EMAIL="jane@example.com"
for repo in "$HOME"/src/*/; do
  git -C "$repo" init -q -b main
  git -C "$repo" add -A
  git -C "$repo" commit -q -m "First commit"
done
cd "$REPO_ROOT"
