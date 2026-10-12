#!/bin/sh
. "$(dirname "$0")/../../scripts/example-setup.sh"
mkdir -p "$HOME/.claude"
printf '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo checked"}]}]}}\n' > "$HOME/.claude/settings.json"
git init -q -b main demo && cd demo
mkdir -p .claude/skills/review
printf -- '---\nname: review\ndescription: Reviews a change before it merges.\n---\n' > .claude/skills/review/SKILL.md
printf 'Run the tests before you commit.\n' > AGENTS.md
git add . && git commit -q -m "Add agent config"
mkdir -p .cursor/rules && printf 'Prefer small functions.\n' > .cursor/rules/style.mdc
mkdir ../elsewhere && printf 'Not part of this repo.\n' > ../elsewhere/notes.md
ln -s ../elsewhere/notes.md CLAUDE.md
harness-discovery scan --repo . 2>&1
