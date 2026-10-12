This example runs the `local-session-extractor` command over `testdata/home`, a home folder with one Claude Code session and one Codex session. It scans into a new store, lists the sessions and prints the store's status. With `--home`, the scan stays inside that folder, runs no git and makes no network call.

The script sources `scripts/example-setup.sh`, which builds the command, puts it first on `PATH` and gives it an empty home folder.

```sh
examples/scan-from-the-command-line/run.sh
```

```text
Scanned into /tmp/example/sessions.db in 0.0s
  claude-code  1
  copilot      0
  antigravity  0
  codex        1
  kiro         0
  cursor       0
  UPDATED              SOURCE       SESSION                                    PROMPTS  PROJECT
  2026-01-01 00:00:00  codex        0d6c2f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f       1        /Users/you/src/shop
  2026-01-01 00:00:00  claude-code  -Users-you-src-shop::7d3c9a10-demo-claude  4        /Users/you/src/shop
Store: /tmp/example/sessions.db (schema 21)
Sessions (sub-agent, plugin and hook runs not counted):
  claude-code  1
  copilot      0
  antigravity  0
  codex        1
  kiro         0
  cursor       0
  total        2
Sync state of every row: pending 2
```
