#!/bin/sh
. "$(dirname "$0")/../../scripts/example-setup.sh"
# A skill written after the last commit, not committed yet.
mkdir -p "$HOME/src/shop/.claude/skills/draft"
printf -- '---\nname: draft\ndescription: Draft release notes.\n---\nList the merged changes.\n' > "$HOME/src/shop/.claude/skills/draft/SKILL.md"
node scripts/example-show.mjs agent-files
