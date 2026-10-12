A home directory and a repo together, the way `harness-discovery scan` is usually run, where the home holds a Claude Code hook in `settings.json`, and the repo a committed skill and `AGENTS.md` (listed once per tool that reads it), an uncommitted Cursor rule, and a `CLAUDE.md` symlinked to a file outside both. The scan does not follow the symlink and says so on standard error, which the script folds into the output. The runner shows the temp path in that warning as `/tmp/work`, and a hand run prints the real path.

```sh
sh examples/inventory-home-and-repo/run.sh
```

```text
user	claude-code	hook	.claude/settings.json#PreToolUse:93bdb3d49d53	5421e648f67d
repo-committed	claude-code	skill	.claude/skills/review/SKILL.md	dc549a698eb6
repo-committed	claude-code	agents_md	AGENTS.md	34de1f410b30
repo-committed	codex	agents_md	AGENTS.md	34de1f410b30
repo-local	cursor	rule	.cursor/rules/style.mdc	c68249835e10
repo-committed	cursor	agents_md	AGENTS.md	34de1f410b30
6 assets
warning: /tmp/work/demo/CLAUDE.md: resolves outside HOME and the scanned repos; not read
```
