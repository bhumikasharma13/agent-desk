#!/bin/sh
# Copyright 2026 The Agent Desk Authors
# SPDX-License-Identifier: MIT

# Runs every README code block and compares its output with the text block after it, with an
# empty HOME and a fixed git identity. The release URL's release may not exist yet, so an `npx`
# stub runs the CLI built in this folder for that URL, and `pnpm add "$HD"` is skipped: the
# package is linked into the work dir's node_modules instead. scripts/smoke-install.sh adds and
# runs the packed .tgz itself. The quick start's `HD=<release URL>` line is set again before each
# later block, as the reader's shell keeps it.
# Needs a build first (pnpm build).
#   sh 1 quick start, run in a fresh dir          -> text 1
#   sh 2 CLI usage, in the demo repo              -> text 2
#   js 1 saved as demo/list.mjs, sh 3 run there   -> text 3
#   js 2 saved as demo/collect.mjs, sh 4 run there, the 12-character id masked -> text 4
# The js blocks are also linted with this package's config. src/__tests__/readme.test.ts pins the
# quick start and the collector program to the examples.
set -eu
T=$(cd "$(dirname "$0")/.." && pwd)
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
nth() { # nth <lang> <n>: the n-th fenced block of that language in the README
  awk -v lang="$1" -v want="$2" '$0 == "```" lang { inb = 1; n++; next } inb && $0 == "```" { inb = 0; next } inb && n == want { print }' "$T/README.md"
}
fail=0
check() { # check <name> <got> <want>
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '%s\n' "$3" > "$W/want"; printf '%s\n' "$2" | diff -u "$W/want" - || true; fail=1; fi
}
mkdir -p "$W/bin" "$W/node_modules" "$W/home" "$W/tmp"
export TMPDIR="$W/tmp"
v=$(node -p "require('$T/package.json').version")
url="https://github.com/tetriz-ai/agent-desk/releases/download/harness-discovery-v$v/harness-discovery-$v.tgz"
cat > "$W/bin/npx" <<EOF
#!/bin/sh
[ "\$1" = "$url" ] || { echo "npx \$1 is not stubbed" >&2; exit 1; }
shift
exec node "$T/dist/cli.mjs" "\$@"
EOF
chmod +x "$W/bin/npx"
ln -s "$T" "$W/node_modules/harness-discovery"
export HOME="$W/home" PATH="$W/bin:$PATH" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME="Jane Doe" GIT_AUTHOR_EMAIL="jane@example.com" GIT_COMMITTER_NAME="Jane Doe" GIT_COMMITTER_EMAIL="jane@example.com"

hd=$(nth sh 1 | grep '^HD=')
later() { { printf '%s\n' "$hd"; nth sh "$1" | grep -vxF "pnpm add \"\$HD\""; } | sh; }
cd "$W"
check "quick start (sh 1, npx stubbed to this build)" "$(nth sh 1 | sh)" "$(nth text 1)"
cd "$W/demo"
check "CLI usage (sh 2)" "$(later 2)" "$(nth text 2)"
nth js 1 > list.mjs
check "scan() usage (js 1 run by sh 3; skipped: pnpm add \"\$HD\")" "$(later 3)" "$(nth text 3)"
# The demo repo has no remote, so its id depends on the path: the README shows a placeholder
# there, and the rest of each line is compared.
nth js 2 > collect.mjs
check "collectors usage (js 2 run by sh 4 in the demo repo; id column masked)" "$(later 4 | sed -E 's/^[0-9a-f]{12} /<12-character id> /')" "$(nth text 4)"
cd "$T"
for i in 1 2; do
  if nth js $i | pnpm exec eslint --stdin --stdin-filename "examples/readme-block-$i.mjs"; then echo "ok   lint js $i"; else echo "FAIL lint js $i"; fail=1; fi
done
exit "$fail"
