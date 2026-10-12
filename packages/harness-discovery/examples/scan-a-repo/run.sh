#!/bin/sh
. "$(dirname "$0")/../../scripts/example-setup.sh"
mkdir demo && cd demo && git init -q
mkdir -p .claude/skills/review .cursor/rules
printf -- '---\nname: review\ndescription: Reviews a change before it merges.\n---\nRead the diff.\n' > .claude/skills/review/SKILL.md
printf 'Prefer small functions.\n' > .cursor/rules/style.mdc
harness-discovery scan --home "$(mktemp -d)" --repo .
