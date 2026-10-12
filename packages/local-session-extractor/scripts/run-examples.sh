#!/usr/bin/env bash
# Copyright 2026 The Agent Desk Authors
# SPDX-License-Identifier: MIT
# Runs every example the way its README says and compares the output.
#
# For each examples/<name>/README.md it runs the first ```sh block from the repo root,
# with HOME pointed at an empty directory, and compares standard output with the
# README's last ```text block. Before the comparison it rewrites each temp directory
# `mktemp -d` made to /tmp/example, a scan's duration to 0.0s, and store write times
# (YYYY-MM-DD HH:MM:SS) to 2026-01-01 00:00:00. It also fails when examples/README.md
# lists a folder that does not exist or misses one that does.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"
pnpm -s build >/dev/null

block() { # block <file> <lang> first|last
  awk -v lang="$2" -v which="$3" '
    $0 == "```" lang { inside = 1; buf = ""; next }
    inside && $0 == "```" { inside = 0; n++; if (which == "first" && n == 1) { printf "%s", buf; done = 1; exit } last = buf; next }
    inside { buf = buf $0 "\n" }
    END { if (which == "last" && !done) printf "%s", last }
  ' "$1"
}

status=0
listed="$(grep -oE '\]\([a-z0-9-]+/\)' examples/README.md | sed -E 's/^\]\(//; s/\/\)$//' | sort)"
present="$(find examples -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort)"
if [ "$listed" != "$present" ]; then
  echo "FAIL  examples/README.md lists: $(echo "$listed" | tr '\n' ' ')"
  echo "      the folder holds:        $(echo "$present" | tr '\n' ' ')"
  status=1
fi

for dir in examples/*/; do
  name="$(basename "$dir")"
  readme="${dir}README.md"
  if [ ! -f "$readme" ]; then
    echo "FAIL  $name: no README.md"
    status=1
    continue
  fi
  cmd="$(block "$readme" sh first)"
  want="$(block "$readme" text last)"
  if [ -z "$cmd" ] || [ -z "$want" ]; then
    echo "FAIL  $name: README.md needs a \`\`\`sh block and a \`\`\`text block"
    status=1
    continue
  fi
  tmp="$(mktemp -d)"
  mkdir "$tmp/home"
  got="$(HOME="$tmp/home" bash -c "$cmd" 2>"$tmp/stderr" |
    sed -E -e 's#[^ ]*/tmp\.[A-Za-z0-9]{10}#/tmp/example#g' \
      -e 's/ in [0-9]+\.[0-9]s$/ in 0.0s/' \
      -e 's/[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}/2026-01-01 00:00:00/g')" || {
    echo "FAIL  $name: the command exited non-zero"
    sed 's/^/      /' "$tmp/stderr"
    status=1
    rm -rf "$tmp"
    continue
  }
  if [ "$got" == "${want%$'\n'}" ]; then
    echo "ok    $name"
  else
    echo "FAIL  $name: output differs from README.md"
    diff <(printf '%s\n' "${want%$'\n'}") <(printf '%s\n' "$got") | sed 's/^/      /' || true
    status=1
  fi
  rm -rf "$tmp"
done
exit "$status"
