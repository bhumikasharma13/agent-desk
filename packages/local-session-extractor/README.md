<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tetriz-ai/agent-desk/main/packages/local-session-extractor/assets/banner-dark.svg">
  <img alt="local-session-extractor: read Claude Code, Copilot, Codex, Cursor, Kiro and Antigravity sessions on macOS into one redacted SQLite store" src="https://raw.githubusercontent.com/tetriz-ai/agent-desk/main/packages/local-session-extractor/assets/banner-light.svg" width="880">
</picture>

<img alt="Demo: set the release URL, list the sources the package reads, then scan a demo home folder and list the sessions it stored" src="https://raw.githubusercontent.com/tetriz-ai/agent-desk/main/packages/local-session-extractor/assets/demo.gif" width="1000">

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/tetriz-ai/agent-desk/blob/main/LICENSE)
![Node](https://img.shields.io/badge/node-24%2B-339933.svg)
![macOS](https://img.shields.io/badge/platform-macOS-lightgrey.svg)

## What it does

Every AI coding tool on a Mac saves its sessions in its own folder and format. local-session-extractor reads the sessions of Claude Code, Copilot, Codex, Cursor, Kiro and Antigravity into one SQLite file on your machine. Before it saves a session, it masks secrets, email addresses and your user name. Nothing is uploaded. It can export the sessions in [Session Intelligence](https://github.com/tetriz-ai/session-intelligence)'s format, ready for analysis.

### What it does not do

- It does not upload or send your sessions anywhere.
- It does not score, summarize or judge a session. It saves what the files say.
- It does not watch for new sessions. Run a scan again, and files that have not changed are skipped.
- It does not run on Linux or Windows.

## Requirements

- macOS.
- Node 24 or later. npx comes with Node.

There is nothing else to install, and no account is needed.

## Quick start

Each release is a single `.tgz` file on GitHub. Set its URL once in your shell, and npx runs it from there. This prints the tools it can read:

```sh
LSE=https://github.com/tetriz-ai/agent-desk/releases/download/local-session-extractor-v0.1.0/local-session-extractor-0.1.0.tgz
npx "$LSE" capabilities
```

```text
Package version: 0.1.0
Store schema version: 21
Platforms: darwin
Export formats: jsonl, json
Sources, in scan order, with extractor code versions:
  claude-code  1
  copilot      1
  antigravity  1
  codex        1
  kiro         1
  cursor       1
```

Scan your sessions. It prints where it saved them, and how many came from each tool:

```sh
npx "$LSE" scan
```

```text
Scanned into /Users/you/.local-session-extractor/sessions.db in 0.0s
  claude-code  1
  copilot      0
  antigravity  0
  codex        1
  kiro         0
  cursor       0
```

List the saved sessions, newest first:

```sh
npx "$LSE" list
```

```text
  UPDATED              SOURCE       SESSION                                    PROMPTS  PROJECT
  2026-01-01 00:00:00  codex        0d6c2f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f       1        /Users/you/src/shop
  2026-01-01 00:00:00  claude-code  -Users-you-src-shop::7d3c9a10-demo-claude  4        /Users/you/src/shop
```

Save one session as JSON, by its tool and id. A Claude Code id starts with `-`, so it goes after `--`, as in `npx "$LSE" show claude-code -- <id>`.

```sh
npx "$LSE" show codex 0d6c2f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f > session.json
```

Export every session to one file, one session per line:

```sh
npx "$LSE" export --out sessions.jsonl
```

The sessions are saved in `~/.local-session-extractor/sessions.db`, or in the file you pass with `--db <path>`. `npx "$LSE" reset --yes` deletes them. `npx "$LSE" --help` lists every command and flag. Newer versions are on the [Releases page](https://github.com/tetriz-ai/agent-desk/releases?q=local-session-extractor-v&expanded=true).

## Use it as a library

Add the package to your project from the same URL:

```sh
mkdir lse-try && cd lse-try
pnpm add "$LSE"
```

This program scans your sessions into the same file the command uses, then prints what it saved. Save it as `scan.mts`:

```ts
import { openStore, readAll } from "local-session-extractor";

// Opens ~/.local-session-extractor/sessions.db, creating it on first use.
const store = openStore();
// Reads every tool's sessions under your home, or under a copied home folder you pass.
const home = process.argv[2];
const result = await readAll(store, home === undefined ? {} : { home });
console.log(`written: ${JSON.stringify(result.counts)}`);
const failed = Object.entries(result.partial).filter(([, partial]) => partial).map(([source]) => source);
console.log(`errors: ${result.errors.length}, failed as a whole: ${failed.join(", ") || "none"}`);
for (const row of store.listConversations({ limit: 5 })) console.log(`${row.ide_type} ${row.session_id}`);
store.close();
```

```sh
node --no-warnings=ExperimentalWarning scan.mts
```

```text
written: {"claude-code":1,"copilot":0,"antigravity":0,"codex":1,"kiro":0,"cursor":0}
errors: 0, failed as a whole: none
codex 0d6c2f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f
claude-code -Users-you-src-shop::7d3c9a10-demo-claude
```

The `--no-warnings` flag hides Node's notice that its SQLite module is experimental. More programs, such as syncing sessions to your own server, are in the [examples](https://github.com/tetriz-ai/agent-desk/blob/main/packages/local-session-extractor/examples/README.md).

## Analyse sessions with Session Intelligence

The `session.json` that `show` writes is already in [Session Intelligence](https://github.com/tetriz-ai/session-intelligence)'s format. To hand it every session at once, `npx "$LSE" export --split <folder>` writes each session as its own file. The [Session Intelligence README](https://github.com/tetriz-ai/session-intelligence#readme) explains how to analyse them.

## Privacy and limits

- **Masked:** secrets in known shapes, email addresses in session text, and your user name.
- **Not masked:** each tool's login email, account ids and device ids. An export carries them, so treat it as personal data before you share it.
- **Missed:** a secret in a shape no pattern knows can stay in the text.
- **Local only:** it reads files on your Mac and uploads nothing. Its only network call goes to a local Antigravity server on 127.0.0.1.
- **Your projects:** a scan of your own home runs `ps`, and runs git in each project folder your sessions name. Pass `--home <dir>` to read a copied home folder instead, with no git and no `ps`.
- **macOS only.**

[Before you rely on it](https://github.com/tetriz-ai/agent-desk/blob/main/packages/local-session-extractor/docs/limits.md) lists every limit and the test that pins it.

## More detail

- [Reference](https://github.com/tetriz-ai/agent-desk/blob/main/packages/local-session-extractor/docs/reference.md): every scan option, command-line flag, export field and redaction pattern, plus versioning, checking a release and the tests. Its [store section](https://github.com/tetriz-ai/agent-desk/blob/main/packages/local-session-extractor/docs/reference.md#the-store-openstore-and-sessionstore) covers reading sessions page by page.
- [Before you rely on it](https://github.com/tetriz-ai/agent-desk/blob/main/packages/local-session-extractor/docs/limits.md): what is masked, what a scan starts and reads, and what it misses.
- [How a scan runs](https://github.com/tetriz-ai/agent-desk/blob/main/packages/local-session-extractor/docs/how-a-scan-runs.md): how the parts fit together, and one scan step by step.
- [CONTRIBUTING.md](https://github.com/tetriz-ai/agent-desk/blob/main/CONTRIBUTING.md): building from source, running the tests and making a release.
- [Agent Desk](https://github.com/tetriz-ai/agent-desk/blob/main/README.md): the menu bar app in this repository, which reads its sessions through this package.

## License

MIT, in [LICENSE](https://github.com/tetriz-ai/agent-desk/blob/main/LICENSE). Parts of the redaction code are adapted from Dataclaw, and [NOTICE](https://github.com/tetriz-ai/agent-desk/blob/main/NOTICE) records its license. Report a vulnerability through GitHub's [private vulnerability reporting](https://github.com/tetriz-ai/agent-desk/security/advisories/new), never in a public issue. [SECURITY.md](https://github.com/tetriz-ai/agent-desk/blob/main/SECURITY.md) has the policy.

Copyright 2026 Workloom Solutions Private Limited.

Contributors are listed in [CONTRIBUTORS.md](https://github.com/tetriz-ai/agent-desk/blob/main/CONTRIBUTORS.md).
