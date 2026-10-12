This is the quick start from the package README, run as a script. It creates a small repo with a Claude Code skill and a Cursor rule, then scans it with an empty home directory, so the output shows only the repo. Neither file is committed, so both are `repo-local`.

```sh
sh examples/scan-a-repo/run.sh
```

```text
repo-local	claude-code	skill	.claude/skills/review/SKILL.md	bbf2eccdf2e2
repo-local	cursor	rule	.cursor/rules/style.mdc	c68249835e10
2 assets
```
