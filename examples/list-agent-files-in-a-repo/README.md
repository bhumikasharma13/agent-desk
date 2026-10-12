This example opens Agent Desk on a sample home folder with one Claude Code session in a repo, `src/shop`. The repo holds a Claude skill, an `AGENTS.md`, a Cursor rule and a Claude settings hook, all committed. It prints what the Harness page lists: each agent file, where it lives and which coding agents load it.

```sh
examples/list-agent-files-in-a-repo/run.sh
```

```text
4 entries:
  TYPE       NAME                      SOURCE            AGENTS
  agents_md  AGENTS.md                 shop · committed  Claude Code, Codex, Cursor
  hook       PreToolUse: echo checked  shop · committed  Claude Code
  rule       Style                     shop · committed  Cursor
  skill      review                    shop · committed  Claude Code
```
