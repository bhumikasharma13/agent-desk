<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/tetriz-ai/agent-desk/main/packages/harness-discovery/assets/banner-dark.svg">
  <img alt="harness-discovery: lists the skills, rules, agents, hooks and instruction files that Claude Code, Codex, Cursor and Kiro load, with scope and hash" src="https://raw.githubusercontent.com/tetriz-ai/agent-desk/main/packages/harness-discovery/assets/banner-light.svg" width="880">
</picture>

<img alt="A terminal running the quick start: harness-discovery scan lists a repo's Claude Code skill and Cursor rule with their scope and hash" src="https://raw.githubusercontent.com/tetriz-ai/agent-desk/main/packages/harness-discovery/assets/demo.gif" width="1000">

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/tetriz-ai/agent-desk/blob/main/LICENSE)
[![Node >= 24](https://img.shields.io/badge/node-%3E%3D24-green)](https://github.com/tetriz-ai/agent-desk/blob/main/packages/harness-discovery/package.json)

Claude Code, Codex, Cursor and Kiro load agent files from your home directory as well as the repo, and the ones not committed to the repo differ from machine to machine, so two people can run the same agent on the same repo with different instructions and not know it. harness-discovery lists the skills, rules, hooks and other agent files each tool will load, with their scope and a content hash, so you can compare machines, see what a repo commits, and fail CI on config that is not committed.

## Contents

- [What it does](#what-it-does) says what the tool reads and what it leaves out.
- [Quick start](#quick-start) runs the CLI from its GitHub Release and scans a small repo.
- [Choosing an entry point](#choosing-an-entry-point) shows which call fits a terminal check, a CI gate, a rule of your own or an app's own inventory.
- [Usage](#usage) shows each entry point with a complete example.
- [Reference](#reference) gives the exact rules for each tool's files, types and names, scope and identity, collectors, exports and output.
- [Before you rely on it](#before-you-rely-on-it) lists the limits that matter on real machines.
- [Project](#project) covers versioning, tests, contributing and the license.

## What it does

Besides the files the banner names, it reports commands and plugins, and hashes each file's body with SHA-256. Use it to see what a tool will load on a machine or in a repo, to fail CI on tool config that is not committed, or to keep your own inventory.

It comes as a command-line tool, `harness-discovery scan`, and as a library. [Choosing an entry point](#choosing-an-entry-point) says which to use.

### What it does not do

- It does not read permission settings or MCP config, and it skips some other files the tools load, which [What it misses](#what-it-misses) lists.
- It does not find repos on its own. Pass each one with `--repo` or `repos`.
- It does not report the agents built into each tool, only files on disk.
- It never runs a hook or a command it finds, never writes a file, and makes no network calls.
- It reads only inside your home directory and the repos you name. The only commands it runs are read-only `git` ones, which read git's own config files as any git command does. They ignore your `GIT_*` variables, such as the `GIT_DIR` a git hook sets, except `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and `GIT_CONFIG_NOSYSTEM`, which choose those files.

## Quick start

It runs on macOS or Linux with Node 24 or later and git. npx comes with Node. The package has no dependencies.

Each release attaches the package to its GitHub Release as a `.tgz` file, and npx runs it from that file's URL. Set the URL once in your shell, then run the command as `npx "$HD" <command>`. npx fetches the file, asks once before it runs it, and keeps it in its cache. Make a small repo and scan it with an empty home directory so the output shows only the repo:

```sh
HD=https://github.com/tetriz-ai/agent-desk/releases/download/harness-discovery-v0.1.0/harness-discovery-0.1.0.tgz
mkdir demo && cd demo && git init -q
mkdir -p .claude/skills/review .cursor/rules
printf -- '---\nname: review\ndescription: Reviews a change before it merges.\n---\nRead the diff.\n' > .claude/skills/review/SKILL.md
printf 'Prefer small functions.\n' > .cursor/rules/style.mdc
npx "$HD" scan --home "$(mktemp -d)" --repo .
```

```text
repo-local	claude-code	skill	.claude/skills/review/SKILL.md	bbf2eccdf2e2
repo-local	cursor	rule	.cursor/rules/style.mdc	c68249835e10
2 assets
```

Leave out `--home` to include your own user-level config from your home directory. The same steps run as [scan-a-repo](https://github.com/tetriz-ai/agent-desk/tree/main/packages/harness-discovery/examples/scan-a-repo/).

Each version has its own URL, with the version in both the tag and the file name. Newer versions are on the [Releases page](https://github.com/tetriz-ai/agent-desk/releases?q=harness-discovery-v&expanded=true), under tags that start with `harness-discovery-v`. To check a downloaded `.tgz`, run `shasum -a 256 -c <file>.tgz.sha256` beside the `.sha256` the release attaches. These manually built releases include checksums but no hosted build provenance attestation. [CONTRIBUTING.md](https://github.com/tetriz-ai/agent-desk/blob/main/CONTRIBUTING.md) covers building it from source.

## Choosing an entry point

| You have | Use | Example |
|---|---|---|
| A terminal, and want to see what a tool loads | [The CLI](#the-cli) | [inventory-home-and-repo](https://github.com/tetriz-ai/agent-desk/tree/main/packages/harness-discovery/examples/inventory-home-and-repo/) |
| A script or CI job that needs the result | [`scan()`](#scan) | [fail-ci-on-local-config](https://github.com/tetriz-ai/agent-desk/tree/main/packages/harness-discovery/examples/fail-ci-on-local-config/) |
| A rule of your own, such as committed config edited locally | [`scan()`](#scan) | [report-drift](https://github.com/tetriz-ai/agent-desk/tree/main/packages/harness-discovery/examples/report-drift/) |
| An app that keeps its own inventory | [Collectors and sessions](#collectors-and-sessions) | [collect-into-your-own-store](https://github.com/tetriz-ai/agent-desk/tree/main/packages/harness-discovery/examples/collect-into-your-own-store/) |

Every entry point reads the same files with the same rules, and gives each asset the same id.

## Usage

### The CLI

**When:** a shell or a terminal session needs the list.

Run it in the `demo` repo from the quick start. `--ide` limits the scan to one tool, `claude-code`, `codex`, `cursor` or `kiro`, and can be repeated. The same value is each asset's `ideType` field:

```sh
npx "$HD" scan --home "$(mktemp -d)" --repo . --ide cursor
```

```text
repo-local	cursor	rule	.cursor/rules/style.mdc	c68249835e10
1 asset
```

**Remember:**

- Warnings and errors go to standard error. Only errors change the exit status, so a CI gate that checks the exit status alone still passes when a file was skipped with a warning. [Output and failures](#output-and-failures) lists the exit statuses.
- The text output escapes control characters in file names as `\xNN` and bidirectional controls as `\uNNNN`, so a hostile file name cannot write to your terminal or reorder a line.

### scan()

**When:** code needs the result as data.

Save this as `list.mjs` in the `demo` repo:

```js
import { scan } from "harness-discovery";

const result = await scan({ repos: ["."] });
for (const a of result.assets) console.log(a.scope, a.ideType, a.type, a.sourcePath);
for (const w of result.warnings) console.log("warning:", w.path ?? w.root, w.message);
```

Add the package where the script can import it, from the same URL with pnpm, and run it with an empty home directory:

```sh
pnpm add "$HD"
HOME="$(mktemp -d)" node list.mjs
```

```text
repo-local claude-code skill .claude/skills/review/SKILL.md
repo-local cursor rule .cursor/rules/style.mdc
```

**Remember:**

- Check `result.errors` before you act on a missing asset. A tool listed there may have stopped partway.
- In CI, check out with `fetch-depth: 0` or set `origin/HEAD`. Without a default branch, every repo file reads as `repo-local`.

### Collectors and sessions

**When:** your app keeps its own copy and reads one tool, or one repo, at a time.

`createCollectSession` hands each asset to your function once. Save this as `collect.mjs`:

```js
import { assetSourcePath, collectCursorRepoAssets, createCollectSession, harnessAssetId, setLogger } from "harness-discovery";

setLogger({ debug() {}, info() {}, warn: (msg, meta) => console.error(msg, meta), error() {} });

const store = new Map();
const session = createCollectSession((asset) => store.set(harnessAssetId(asset), asset));
await collectCursorRepoAssets(session, process.argv[2] ?? ".");

for (const [id, asset] of store) console.log(id.slice(0, 12), asset.scope, asset.type, assetSourcePath(asset));
```

Run it in the `demo` repo:

```sh
node collect.mjs .
```

It prints one line per Cursor asset. The `demo` repo has no `origin` remote, so the id depends on where the repo sits on disk:

```text
<12-character id> repo-local rule .cursor/rules/style.mdc
```

With a remote, each id is the same on every machine, as [collect-into-your-own-store](https://github.com/tetriz-ai/agent-desk/tree/main/packages/harness-discovery/examples/collect-into-your-own-store/) shows.

**Remember:**

- To keep your own store in step, use one session per tool and pass the same repos every run. After the run, `session.scannedKeys` lists each root the session settled, and for each one you replace that tool's stored assets with the run's result. Keep the stored assets of any root not in `scannedKeys`, because it was not read.
- A collector called directly reports problems to the logger only. `scan()` also puts them in its result.

The types, with a comment on each field, are in [`src/types.ts`](https://github.com/tetriz-ai/agent-desk/blob/main/packages/harness-discovery/src/types.ts) and [`src/scan.ts`](https://github.com/tetriz-ai/agent-desk/blob/main/packages/harness-discovery/src/scan.ts). More programs are in [examples/](https://github.com/tetriz-ai/agent-desk/blob/main/packages/harness-discovery/examples/README.md).

## Reference

### Exports

- **`harness-discovery scan`** prints one tab-separated line per asset with its scope, tool, type, path and the first 12 characters of its content hash, or the full result with `--json`.
- **`scan(options)`** returns the same result to your code: the assets, plus warnings and errors for anything it could not read.
- **`collectClaudeCodeAssets`, `collectCodexAssets`, `collectCursorAssets`, `collectKiroAssets`** and their `…RepoAssets` forms run one tool's reader into a session you create with `createCollectSession`.
- **`harnessAssetId(asset)`** gives the stable id of an asset, and **`assetSourcePath(asset)`** its relative path.
- **`setLogger(logger)`** routes diagnostics. By default the package is silent.
- **`IDES`**, **`CLAUDE_CODE_IDE`**, **`CODEX_IDE`**, **`CURSOR_IDE`**, **`KIRO_IDE`** and **`deriveSourcePath`** are exported too, and **`harness-discovery/types`** holds the types alone.

### What each tool reports

`<repo>` is each repo you name. Repo files are `repo-committed` or `repo-local` (see [Scope and identity](#scope-and-identity)).

**Claude Code**

| Path | Scope |
|---|---|
| `~/.claude/skills/` | user |
| `~/.claude/rules/*.md`, `~/.claude/agents/*.md` | user |
| `~/.claude/CLAUDE.md` | user |
| hooks in `~/.claude/settings.json` | user |
| every plugin in `~/.claude/plugins/installed_plugins.json`, with its skills, commands, rules, agents and hooks | user |
| `<repo>/.claude/skills/` | repo |
| `<repo>/.claude/rules/*.md`, `<repo>/.claude/commands/*.md`, `<repo>/.claude/agents/*.md` | repo |
| `<repo>/.claude/templates/*.md` | repo |
| hooks in `<repo>/.claude/settings.json` and `<repo>/.claude/settings.local.json` | repo |
| `<repo>/CLAUDE.md`, `<repo>/AGENTS.md` | repo |
| `CLAUDE.md` in any folder of `<repo>`, at any depth | repo |

**Codex**

| Path | Scope |
|---|---|
| `~/.agents/skills/` | user |
| `<repo>/.codex/agents/*.md` and `*.toml` | repo |
| `<repo>/.codex/rules/*.md`, `*.mdc` and `*.rules` | repo |
| hooks in `<repo>/.codex/hooks.json` | repo |
| `<repo>/.agents/skills/`, `<repo>/AGENTS.md` | repo |

**Cursor**

| Path | Scope |
|---|---|
| `~/.cursor/skills-cursor/`, `~/.cursor/skills/` | user |
| `~/.cursor/commands/*.md`, `~/.cursor/agents/*.md`, `~/.cursor/rules/*.md` and `*.mdc` | user |
| hooks in `~/.cursor/hooks.json` | user |
| `<repo>/.cursor/rules/*.md` and `*.mdc`, `<repo>/.cursorrules` | repo |
| `<repo>/.cursor/commands/*.md`, `<repo>/.cursor/agents/*.md`, `<repo>/.cursor/skills/` | repo |
| hooks in `<repo>/.cursor/hooks.json` | repo |
| `<repo>/AGENTS.md`, `<repo>/CLAUDE.md` | repo |

**Kiro**

| Path | Scope |
|---|---|
| `~/.kiro/steering/*.md`, `~/.kiro/skills/`, `~/.kiro/agents/*.md` and `*.json` | user |
| `<repo>/.kiro/steering/*.md`, `<repo>/.kiro/skills/` | repo |
| `<repo>/.kiro/agents/*.md` and `*.json` | repo |
| `<repo>/.kiro/hooks/*.kiro.hook` and `*.json` | repo |

**Folders read in a repo**

| Tool | Folders |
|---|---|
| Claude Code | the top level, the folder you passed, and each folder directly inside it that has `.claude/`, `CLAUDE.md` or `AGENTS.md`, except `node_modules` and dot folders |
| Codex, Kiro | the top level, plus the folder you passed when it is below the top level and has its own Codex or Kiro config |
| Cursor | the top level only |

Claude Code also reports `CLAUDE.md` at any depth, up to 1000 per repo, with a warning past that. In a git repo the files come from git's own file list, so gitignored ones are left out, except in the folders the table above names, whose `CLAUDE.md` is read whatever git ignores. A folder outside git, or a repo git cannot list, is searched 8 levels deep, with a warning past that.

Files under `node_modules` or a dot folder are never reported. A nested repo's files are left out of the outer repo, but an immediate subfolder that is its own repo and has `.claude/`, `CLAUDE.md` or `AGENTS.md` reports its deeper `CLAUDE.md` under its own path. On a case-insensitive disk a `claude.md` counts too, since opening `CLAUDE.md` reaches it.

### How assets are typed and named

- **Types** are `skill`, `plugin`, `command`, `rule`, `hook`, `agent`, `claude_md`, `agents_md` and `prompt_template`. Files in `.claude/templates/` are reported as `prompt_template`.
- **Skills** are `SKILL.md` in a folder, a flat `<name>.md`, or a folder of skill folders. Every other file in a skill folder is listed in `payload.files`, up to 50 files including `SKILL.md`, three folder levels and 256 KiB each. Dot files, dot folders and `node_modules` are left out.
- **Linked folders in a skill** are listed once, at their shallowest depth, and a link to the skill folder or above it is not followed. A hard link, or a second link to one file, is listed as a file of its own.
- **Hooks** are one asset per wired command. A command whose script sits inside the repo, `~/.claude`, `~/.cursor` or the plugin's folder is reported as that script. Any other command is its own body, in `payload.inline_body`, and its `sourcePath` is the settings file plus `#<event>:<first 12 characters of a hash of its matcher and command>`.
- **`payload.active_in_agents`** names the other tools whose user-level skills folder holds a skill of the same name, each tool once and by its name. `~/.agents/skills/` counts for Codex, which reads it.
- **Kiro JSON files** count only when they look like the real thing. An agent file needs a `name`, and a hook file needs a `trigger`.
- **Names** come from the frontmatter `name`, else the file name in title case, and every name is cut at 256 characters with a hash at the end. A frontmatter name or description loses its control and bidirectional characters. Other names, hook names among them, show them as `\xNN` and `\uNNNN`.
- **Hook names** are `PreToolUse[Bash]: guard.sh` when the wiring has a matcher and `PreToolUse: guard.sh` when it has none, with the matcher cut at 80 characters. A script run with arguments ends in the first 6 hex characters of the SHA-256 of the text after the script, as written: `guard.sh --strict` is named `PreToolUse[Bash]: guard.sh #5e3f4b`.
- **Hook arguments** are in the name only as that hash. An env prefix such as `FOO=1` and the interpreter are not part of the name. The `id` includes the name, so a changed matcher or argument makes a new asset.
- **Inline hook names** are the command, as in `Stop: echo done`.

### Scope and identity

| Scope | Means |
|---|---|
| `user` | Under your home directory |
| `repo-committed` | In a repo, tracked, and present on the default branch. `payload.baseline_content_hash` holds that branch's hash of it. |
| `repo-local` | In a repo but not on the default branch: untracked, or committed only on another branch |

- **Default branch** is the first that exists of `origin/HEAD`, `origin/main`, `origin/master`, `main` and `master`.
- **Gitignored files** in the folders the tables under [What each tool reports](#what-each-tool-reports) name, such as `.claude/rules/x.md`, are still listed, as `repo-local`. Only the search for `CLAUDE.md` at any depth leaves gitignored files out.
- **Hook entries** count as committed when the same event, matcher and command are in the committed file. A hook that runs a script also needs that script on the default branch.
- **`id`** is the SHA-256 of `ideType:scope:anchor:sourcePath:type:name`. The anchor is the `origin` URL with any credentials removed, else the repo's path. Two copies of a repo with the same remote give one asset.
- **Credentials** are removed from the remote, with one gap: an scp-style remote whose password holds a `/` (`user:pa/ss@host:path`) keeps it. git reads such a remote as a host named `user`, so it is not a working credential.
- **`sourcePath`** is relative to the repo, or to your home directory for `user` scope.
- **Directory links** committed in a repo, such as `.agents/skills -> ../.claude/skills`, give each file under them the scope and baseline of the file at the target, while `sourcePath` keeps the path through the link. This holds when the link is on the default branch with the same target and points inside the repo, else the file is `repo-local`.

### Collectors

- **`collect…Assets(session, { roots, inScope })`** reads the tool's user scope under `HOME`, then each root in `roots`, given as `{ path, isWorktree }`. A root with `isWorktree: true`, or one that is your home directory however it is spelled, is not read but is still added to `session.scannedKeys`.
- **`collect…RepoAssets(session, dir)`** reads one repo and no user scope, and adds that repo to `session.scannedKeys`.
- **`session.scannedKeys`** holds every root a collect call settled, as the `projectPath` its assets carry. That is each root it read (for Codex and Kiro, also a package folder read on its own), plus each worktree or home-directory root it skipped on purpose, which owns no assets. A root that could not be read is left out.
- **One script wired from several settings files of the same scope** with the same event, matcher and arguments, such as the top level's and a package's `settings.json`, is one asset. Across scopes it is one asset per scope, as [What it reports more than once](#what-it-reports-more-than-once) says.
- **`inScope`** decides which copy of a repo owns a file that two copies with the same remote both hold. Among the copies it accepts, the one whose git index changed last wins, and a tie goes to the first path in sort order.
- **`createCollectSession(sink)`** passes each asset to `sink` once per `id`. The first asset with an id wins.
- **Roots** are read as the disk spells them, so a root typed in another case or Unicode form still matches.

### Output and failures

- **`ScanResult`** is `{ schemaVersion: 1, assets, warnings, errors }`. The CLI's `--json` prints it whole, with control and bidirectional characters as `\uXXXX`.
- **`warnings`** lists what was read but not collected, each with a `path` or `root` and a `message`. The scan goes on.
- **`errors`** lists a repo that is not a directory, cannot be read or is an empty path, and a tool whose reader failed. The rest of the scan still runs.
- **Exit status** of the CLI is 0 on success, 1 when `errors` is not empty, and 2 on bad usage, including an empty `--home` or `--repo`.

| Warning | When |
|---|---|
| not valid JSON | a file it tried to read could not be parsed |
| larger than 1048576 bytes; not read | a file it tried to read was over the size cap |
| unreadable | a file it tried to read could not be opened |
| is the home directory | a repo you name is your home directory |
| inside a git repo whose top level is the home directory | a repo you name sits in a dotfiles repo at HOME. It is scanned as a plain folder |
| git could not read this repository | git is missing, refuses the repo or fails on it |
| no default branch | a repo has commits but none of the default-branch refs |
| differs from the copy reported | another copy of the repo holds a different version of a shared file |
| wired again with a different command or config | one hook asset is wired twice with different settings, such as a timeout |
| helper files listed only up to … / not listed | a skill folder past the `payload.files` caps, or a `SKILL.md` over 256 KiB with helper files beside it |
| not a JSON object, has an entry that is not an object | a config file or plugin record of the wrong shape |
| not followed, skipped | the links, worktrees and submodules that [What it misses](#what-it-misses) lists |

## Before you rely on it

### What it misses

Each gap below is config a tool can load that the scan does not report, so a clean scan does not prove clean config. Declined means the maintainers chose not to support it. An item without that label is a current limit of this package.

- **Other files the tools load** are not scanned: `~/.claude/commands/`, `~/.codex/AGENTS.md`, `~/.codex/prompts/`, a repo's `.claude/CLAUDE.md` and `CLAUDE.local.md`, and `CLAUDE.md` in folders above the repo. Declined: new scope.
- **Grouped folders** such as `.claude/commands/<group>/` and `.cursor/rules/<group>/` are not scanned. Declined: new scope.
- **Folders deeper than those in the folders table under [What each tool reports](#what-each-tool-reports)** are not scanned for `.claude/`, `.codex/`, `.cursor/` or `.kiro/` config, or for `AGENTS.md`.
- **Frontmatter** is read by a small reader, not a full YAML parser. It reads top-level plain and quoted values and `|` or `>` blocks, but not nested maps, lists, flow collections, anchors or plain values that span lines. Declined: a YAML dependency, to keep the package free of runtime dependencies.
- **Linked worktrees and submodules** passed as repos are skipped with a warning. A worktree mirrors its main repo, so scan that instead. A submodule's own config is not reported.
- **A repo with no default branch** reads every file as `repo-local`, with a warning. [scan()](#scan) says how to check out in CI.
- **Symlinks out of your home directory and the repos** are not followed. Each one is reported in `warnings`, so the gap is visible.

### What it reports more than once

- **One file read by several tools** appears once per tool. `AGENTS.md` is listed once for each tool whose reader reports it, including Claude Code. Deduplicate by `sourcePath` when you count files.
- **One hook wired in both `settings.json` and `settings.local.json`** is two assets, one for each file's scope.
- **A repo root inside a tool's user folder**, such as `~/.claude` in a dotfiles repo at HOME, reports its files twice, as `user` and as `repo-local`.

### Where it runs

- **HOME** is read from `process.env.HOME`, so every scan in one process reads the same home directory, and the CLI's `--home` sets it for its own process only. Scans that run at once in one process can each pass their own `ScanOptions.logger`. Declined for v0.1: a `home` option on `scan()`.
- **Windows** is not supported. Paths are handled as POSIX paths, and nothing is tested there.

## Project

### Versioning and compatibility

The package is at v0.1.0, and releases follow [Semantic Versioning](https://semver.org). Before 1.0, the API, the asset fields and the CLI's text output may change in a minor release.

From 1.0, a change to an exported function, an asset field, the JSON shape or the CLI's text output is breaking. `ScanResult.schemaVersion` changes when the JSON shape does.

The retained CI configuration targets Node 24 and 26. GitHub Actions is disabled; maintainers run checks locally.

### Tests

The suite covers every reader, scope and identity rule, the CLI, and each warning and error. One acceptance test scans a home directory and a repo with bait files outside both, and records every file the scanner opens to prove its own reads stay inside them. Every test runs against a temporary home directory and temporary repos.

Run the suite with `pnpm test`, and the examples with `scripts/run-examples.sh` after `pnpm build`, from this folder in a clone of [agent-desk](https://github.com/tetriz-ai/agent-desk/blob/main/README.md), after `pnpm install --frozen-lockfile` at the repository root. Running the tests and examples needs git 2.28 or later.

### Contributing, security and license

- Contributions are welcome. [CONTRIBUTING.md](https://github.com/tetriz-ai/agent-desk/blob/main/CONTRIBUTING.md) says how to build, test and lint.
- Report a vulnerability privately through GitHub's [private vulnerability reporting](https://github.com/tetriz-ai/agent-desk/security/advisories/new), never in a public issue. [SECURITY.md](https://github.com/tetriz-ai/agent-desk/blob/main/SECURITY.md) has the policy.
- The code is under the MIT License, in [LICENSE](https://github.com/tetriz-ai/agent-desk/blob/main/LICENSE). The package's notice is in [NOTICE](https://github.com/tetriz-ai/agent-desk/blob/main/packages/harness-discovery/NOTICE).

Copyright 2026 Workloom Solutions Private Limited. The people who built it are listed in [CONTRIBUTORS.md](https://github.com/tetriz-ai/agent-desk/blob/main/CONTRIBUTORS.md).
