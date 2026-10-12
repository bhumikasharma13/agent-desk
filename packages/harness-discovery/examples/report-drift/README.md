Lists committed agent config that someone has edited locally. The scanner takes no plugins, so this rule runs over its result and compares each `repo-committed` asset's hash with `payload.baseline_content_hash`, the hash of its body on the default branch. The script commits a skill and a `CLAUDE.md`, then edits `CLAUDE.md`.

```sh
sh examples/report-drift/run.sh
```

```text
edited since the default branch: CLAUDE.md
1 drifted
```
