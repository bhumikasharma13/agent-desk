#!/bin/sh
# Copyright 2026 The Agent Desk Authors
# SPDX-License-Identifier: MIT

# Sourced by every examples/<name>/run.sh. It gives the example an empty HOME, a fresh
# working directory ($HD_WORK, created by the runner or here), the CLI built from this
# checkout on PATH as `harness-discovery`, a fixed git identity, and $EXAMPLE, the
# example's own folder. Nothing the examples run leaves the machine.
set -eu
EXAMPLE=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$EXAMPLE/../.." && pwd)
if [ ! -f "$REPO_ROOT/dist/cli.mjs" ]; then
  echo "dist/cli.mjs is missing: run pnpm build first" >&2
  exit 1
fi
# A run the runner did not start makes its own work dir and removes it on exit.
if [ -z "${HD_WORK:-}" ]; then
  HD_WORK=$(mktemp -d)
  trap 'rm -rf "$HD_WORK"' EXIT
fi
export HOME="$HD_WORK/home"
# Temp dirs an example makes (the quick start's `--home "$(mktemp -d)"`) land in the work dir
# where mktemp honours TMPDIR (GNU). macOS's mktemp -d does not, so there that one empty dir
# is left behind: the quick start and scan-a-repo/run.sh must stay the same program.
export TMPDIR="$HD_WORK/tmp"
mkdir -p "$HOME" "$HD_WORK/bin" "$TMPDIR"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME="Jane Doe" GIT_AUTHOR_EMAIL="jane@example.com"
export GIT_COMMITTER_NAME="Jane Doe" GIT_COMMITTER_EMAIL="jane@example.com"
printf '#!/bin/sh\nexec node "%s/dist/cli.mjs" "$@"\n' "$REPO_ROOT" > "$HD_WORK/bin/harness-discovery"
chmod +x "$HD_WORK/bin/harness-discovery"
export PATH="$HD_WORK/bin:$PATH"
cd "$HD_WORK"
