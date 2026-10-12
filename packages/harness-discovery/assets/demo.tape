# Copyright 2026 The Agent Desk Authors
# SPDX-License-Identifier: MIT

# Renders assets/demo.gif: the README's quick start, typed verbatim. Render with
# `vhs assets/demo.tape` from the package folder. The hidden steps pack this checkout and make
# the typed `npx "$HD"` run that .tgz, offline, with npx's cache in the temp directory, since a
# demo cannot wait for a release. It runs in an empty temp directory with an empty HOME, so
# nothing on the recording machine shows.
Output assets/demo.gif
Set Width 1720
Set Height 420
Set FontSize 17
Set TypingSpeed 20ms
Env PS1 "$ "
Env GIT_CONFIG_GLOBAL "/dev/null"
Hide
Type `t="$(mktemp -d)" && pnpm pack --pack-destination "$t" >/dev/null` Enter
Type `cd "$t" && export HOME="$t" npm_config_cache="$t/npm-cache" npm_config_update_notifier=false npm_config_loglevel=error` Enter
Type `npx() { if [ "$1" = "https://github.com/tetriz-ai/agent-desk/releases/download/harness-discovery-v0.1.0/harness-discovery-0.1.0.tgz" ]; then shift; command npx --yes --offline "file:$(echo "$t"/harness-discovery-*.tgz)" "$@"; else command npx "$@"; fi; }` Enter
Type "clear" Enter
Wait+Line@60s /^\$ ?$/
Show
Type@10ms `HD=https://github.com/tetriz-ai/agent-desk/releases/download/harness-discovery-v0.1.0/harness-discovery-0.1.0.tgz` Enter
Wait+Line@60s /^\$ ?$/
Type `mkdir demo && cd demo && git init -q` Enter
Wait+Line@60s /^\$ ?$/
Type `mkdir -p .claude/skills/review .cursor/rules` Enter
Wait+Line@60s /^\$ ?$/
Type `printf -- '---\nname: review\ndescription: Reviews a change before it merges.\n---\nRead the diff.\n' > .claude/skills/review/SKILL.md` Enter
Wait+Line@60s /^\$ ?$/
Type `printf 'Prefer small functions.\n' > .cursor/rules/style.mdc` Enter
Wait+Line@60s /^\$ ?$/
Type `npx "$HD" scan --home "$(mktemp -d)" --repo .` Sleep 500ms Enter
Wait+Line@60s /^\$ ?$/
Sleep 3s
