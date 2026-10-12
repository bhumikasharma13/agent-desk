This example uses `local-session-extractor/host` to install a logger and a metrics sink, and the scan's `paths` option to point the Claude Code reader at a folder outside `~/.claude/projects`. Its `home` keeps every other location inside the temp folder, so it reads nothing of yours. The transcript holds a record kind this version does not know, and the scan counts it in `unknownRecordKinds` and in a counter instead of guessing what it means.

Nothing can be registered as a new source. The logger, the metrics sink and the path settings are how a host plugs in.

```sh
node examples/wire-a-logger-and-metrics/index.mts
```

```text
log info extraction.claude_code extraction_start
metric unknown_record_kinds {"component":"extraction.claude_code","errorKind":"parse","status":"skipped"} +1
log warn extraction.claude_code unknown_record_kind
log info extraction.claude_code cowork_extraction_complete
log info extraction.claude_code extraction_complete
sessions: {"claude-code":1}, unknown record kinds: {"claude-code:hologram":1}
```
