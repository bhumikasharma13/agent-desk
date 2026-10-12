#!/bin/sh
# Copyright 2026 The Agent Desk Authors
# SPDX-License-Identifier: MIT

# Runs every example the way its README says and compares its standard output with the
# README's last ```text block. Each run gets its own temp directory ($HD_WORK); that path is
# rewritten to /tmp/work in the output before the comparison. Fails when an example exits
# non-zero, when its output differs, or when examples/README.md and the example folders
# disagree. Needs a build first (pnpm build) and git 2.28 or later.
set -eu
cd "$(dirname "$0")/.."

block() { # block <lang> <file> <first|last>: the fenced block of that language
  awk -v lang="$1" -v which="$3" '
    $0 == "```" lang { inb = 1; buf = ""; next }
    inb && $0 == "```" { inb = 0; n++; if (which == "first" && n == 1) { printf "%s", buf; exit } last = buf; next }
    inb { buf = buf $0 "\n" }
    END { if (which == "last") printf "%s", last }
  ' "$2"
}

fail=0
listed=$(grep -oE '\]\([a-z0-9-]+/\)' examples/README.md | sed 's/^](//; s/\/)$//' | sort | tr '\n' ' ')
present=$(find examples -mindepth 1 -maxdepth 1 -type d | sed 's|^examples/||' | sort | tr '\n' ' ')
if [ "$listed" != "$present" ]; then
  echo "FAIL examples/README.md lists: $listed"
  echo "     folders present:          $present"
  fail=1
fi

for dir in $present; do
  readme="examples/$dir/README.md"
  cmd=$(block sh "$readme" first)
  want=$(block text "$readme" last)
  HD_WORK=$(mktemp -d)
  export HD_WORK
  real=$(cd "$HD_WORK" && pwd -P)
  status=0
  sh -c "$cmd" > "$HD_WORK/.stdout" || status=$?
  got=$(sed "s|$real|/tmp/work|g; s|$HD_WORK|/tmp/work|g" "$HD_WORK/.stdout")
  if [ "$status" -ne 0 ]; then
    echo "FAIL $dir (exit $status)"
    fail=1
  elif [ "$got" = "$want" ]; then
    echo "ok   $dir"
  else
    echo "FAIL $dir"
    printf '%s\n' "$got" > "$HD_WORK/.got"
    printf '%s\n' "$want" | diff -u - "$HD_WORK/.got" || true
    fail=1
  fi
  rm -rf "$HD_WORK"
done
exit "$fail"
