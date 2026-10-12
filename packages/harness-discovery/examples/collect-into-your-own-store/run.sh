#!/bin/sh
. "$(dirname "$0")/../../scripts/example-setup.sh"
git init -q -b main shop && cd shop
git remote add origin https://example.com/team/shop.git
mkdir -p .cursor/rules .cursor/commands
printf 'Prefer small functions.\n' > .cursor/rules/style.mdc
printf '# Ship it\n\nRun the release checklist.\n' > .cursor/commands/ship.md
node "$EXAMPLE/mirror.mjs" .
