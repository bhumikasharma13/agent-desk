#!/bin/sh
. "$(dirname "$0")/../../scripts/example-setup.sh"
git init -q -b main shop && cd shop
mkdir -p .claude/skills/deploy
printf -- '---\nname: deploy\ndescription: Deploys the service to staging.\n---\n' > .claude/skills/deploy/SKILL.md
printf 'Use the staging cluster.\n' > CLAUDE.md
git add . && git commit -q -m "Add agent config"
printf 'Use the production cluster.\n' > CLAUDE.md
node "$EXAMPLE/drift.mjs" .
