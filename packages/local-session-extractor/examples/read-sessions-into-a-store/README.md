This is the SDK program from the top-level README. It opens the default store, scans every source, prints the result and lists the stored sessions. Given a folder, it reads that copied home instead of yours, with no git and no `ps`.

Here it reads the demo home from `scan-from-the-command-line`.

```sh
node examples/read-sessions-into-a-store/index.mts examples/scan-from-the-command-line/testdata/home
```

```text
written: {"claude-code":1,"copilot":0,"antigravity":0,"codex":1,"kiro":0,"cursor":0}
errors: 0, failed as a whole: none
codex 0d6c2f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f
claude-code -Users-you-src-shop::7d3c9a10-demo-claude
```
