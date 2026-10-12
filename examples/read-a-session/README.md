This example opens Agent Desk on a sample home folder with one Claude Code session in a repo, `src/shop`. In it the agent reads and edits a file, and one prompt holds an email address. It prints what the Projects page shows for that project: its session list, then the session's conversation, with each tool call as a `[Tool: <name>]` line and the email address masked.

```sh
examples/read-a-session/run.sh
```

```text
1 session:
  TOOL         MESSAGES  PROJECT  TITLE
  claude-code  5         shop     The cart total is off by one cent. Find out why.
Conversation: The cart total is off by one cent. Find out why.
  user       The cart total is off by one cent. Find out why.
  assistant  Reading the cart code first.
             [Tool: Read]
  assistant  Prices are summed as floats. I will switch to integer cents.
             [Tool: Edit]
  user       Good. Send the summary to ████████.
  assistant  Done. Totals are now exact.
```
