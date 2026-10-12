#!/bin/sh
. "$(dirname "$0")/../../scripts/example-setup.sh"
git init -q -b main shop && cd shop
printf 'Run the tests before you commit.\n' > AGENTS.md
git add AGENTS.md && git commit -q -m "Add AGENTS.md"
mkdir -p .cursor/rules && printf 'Prefer small functions.\n' > .cursor/rules/style.mdc
node "$EXAMPLE/check.mjs" . || echo "exit status $?"
