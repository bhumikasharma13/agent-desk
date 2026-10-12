This example shows how a scan behaves when something is wrong. It asks `capabilities()` which sources this build reads, and a request for a source it lacks throws `UnsupportedSourceError` before anything runs.

It then scans a home folder holding one readable Claude Code session and a Codex database that is not SQLite, with an `onProgress` callback. The Codex source fails as a whole and is marked in `partial` with a redacted error, and the Claude Code session is still stored.

Use this shape when a host reports scan progress, or must tell "no sessions" apart from "this source could not be read".

```sh
node examples/keep-scanning-past-a-broken-source/index.mts
```

```text
this build reads: claude-code, copilot, antigravity, codex, kiro, cursor
refused before scanning: windsurf, stored rows: 0
start claude-code
done  claude-code: 1 session(s)
start codex
done  codex: 0 session(s)
claude-code: 1 written, complete
codex: 0 written, failed as a whole
error codex (source): file is not a database
stored rows: 1
```
