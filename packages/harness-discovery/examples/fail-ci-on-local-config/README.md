A CI step that fails when a repo holds agent config that is not on its default branch yet, where `check.mjs` calls `scan()`, lists each `repo-local` file once even when several tools report it, and exits 1 when there is one or when a root could not be scanned. The script commits `AGENTS.md`, then adds a Cursor rule without committing it. In CI, check out with `fetch-depth: 0` or an `origin/HEAD`: with no default branch every file reads as repo-local, with a warning.

```sh
sh examples/fail-ci-on-local-config/run.sh
```

```text
not on the default branch: .cursor/rules/style.mdc
1 file(s) to commit
exit status 1
```
