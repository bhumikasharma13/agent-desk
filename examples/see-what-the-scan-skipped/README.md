This example shows what the Harness page does with an agent file it cannot read. The repo `src/shop` commits an `AGENTS.md` and a `.claude/settings.json` whose hook has a trailing comma, so the settings file is not valid JSON. The page still lists `AGENTS.md`, leaves the hook out, and names the settings file under "Skipped while scanning", printed here as the line that starts with `!`. Use it to check that a typo in your config shows up instead of a hook quietly going missing.

```sh
examples/see-what-the-scan-skipped/run.sh
```

A direct run prints the real temp folder, under `/private/var/folders`, where this shows `/tmp/work`.

```text
1 entry:
  TYPE       NAME       SOURCE            AGENTS
  agents_md  AGENTS.md  shop · committed  Claude Code, Codex, Cursor
! /tmp/work/home/src/shop/.claude/settings.json: not valid JSON; skipped
```
