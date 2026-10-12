For an app that keeps its own inventory: collect one tool's assets for one repo into a map keyed by `harnessAssetId`. `createCollectSession` hands each asset to your function once, and `setLogger` routes the diagnostics. The repo has a remote, so each id (shown as its first 12 characters) is the same wherever the checkout sits on disk.

```sh
sh examples/collect-into-your-own-store/run.sh
```

```text
1be98ca85b2f repo-local rule .cursor/rules/style.mdc
e7ad47205e94 repo-local command .cursor/commands/ship.md
```
