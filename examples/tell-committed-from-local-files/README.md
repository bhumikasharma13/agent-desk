This example shows how the Harness page tells three kinds of agent file apart. The repo's `AGENTS.md` is committed, and the `draft` skill is written after the last commit, so it is not on the default branch and reads as local. The `standup` skill sits in the home folder's `.claude/skills`, so every repo gets it. Use it to check what a teammate gets from a clone and what only you have.

```sh
examples/tell-committed-from-local-files/run.sh
```

```text
3 entries:
  TYPE       NAME       SOURCE            AGENTS
  agents_md  AGENTS.md  shop · committed  Claude Code, Codex, Cursor
  skill      draft      shop · local      Claude Code
  skill      standup    User              Claude Code
```
