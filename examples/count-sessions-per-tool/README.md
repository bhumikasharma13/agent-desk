This example opens Agent Desk on a sample home folder with two Claude Code sessions and one Codex session, in two projects. It prints the counts and folders the Projects page reads: the sessions per tool, then each project with its session count and stack tags. The page itself leaves out a tool with no sessions. It is the quick way to see the app work before you point it at your own sessions.

```sh
examples/count-sessions-per-tool/run.sh
```

A direct run prints the real temp folder, under `/private/var/folders`, where this shows `/tmp/work`.

```text
Sessions per tool:
  Claude Code     2
  Cursor          0
  GitHub Copilot  0
  Antigravity     0
  Codex           1
  Kiro            0
Projects:
  TOOL         SESSIONS  STACK       PROJECT
  Claude Code  1         python      /tmp/work/home/src/api
  Claude Code  1         typescript  /tmp/work/home/src/shop
  Codex        1         typescript  /tmp/work/home/src/shop
```
