# harness-discovery

## What this is

A TypeScript library and CLI that lists the skills, rules, agents, hooks, commands, plugins and
instruction files of Claude Code, Codex, Cursor and Kiro, each with its scope and SHA-256. It never
writes, runs what it finds, or reads permissions and MCP config. Repo-wide rules: `../../CLAUDE.md`.

## Layout

- `src/scan.ts` is `scan()`, `src/cli.ts` the CLI, `src/index.ts` the exports, `src/types.ts` the
  public type contract. The readers are `claudeCode.ts`, `codex.ts`, `cursor.ts` and `kiro.ts`.
- `src/scanShared.ts` holds listing, confined reads, frontmatter, git context and scope.
- `src/__tests__/` holds every test: `setup.ts` is the HOME guard, `fixtures.ts` the helpers.
- `examples/` holds runnable examples, indexed by `examples/README.md`.

## Commands

Node 24 is the floor, and the tests and examples need git 2.28 or later. CI tests on Node 24
and 26 on macOS and Linux, lints on 26 and runs the examples on 24. `corepack enable` gets the
pinned pnpm. Install from the repo root, which builds `dist/`, then run the rest here.

```sh
(cd ../.. && pnpm install --frozen-lockfile)
pnpm build
pnpm type-check
pnpm lint
pnpm test
pnpm audit --prod
shellcheck -x scripts/*.sh examples/*/run.sh
scripts/smoke-install.sh
scripts/run-examples.sh
scripts/readme-blocks.sh
```

`pnpm lint` runs ESLint 10.11.0 with typescript-eslint 8.71.0, pinned in the lockfile. CI installs
shellcheck 0.11.0. Run `pnpm build` before the examples, which import `dist/`.

## Contract to keep

- The scanner's own reads stay inside HOME and the scanned repos, and a link out is refused
  with a warning (`acceptance.test.ts`, `problems.test.ts` "symlinked entries").
- Only `repo-committed`, of the scopes `user`, `repo-committed` and `repo-local`, sets
  `baseline_content_hash` (`scan.test.ts`, `tools.test.ts` "scope"). `id` is the SHA-256 of
  `ide:scope:anchor:sourcePath:type:name` (`scan.test.ts`).
- Failures go to `warnings` or `errors`, and the CLI exits 1 on errors and 2 on bad usage
  (`problems.test.ts`, `cli.test.ts`).
- git runs with the fsmonitor off, so a scanned repo cannot make the scan run a command
  (`scan.test.ts` "never runs a command"). It drops the caller's `GIT_*` variables but the three
  that choose config files (`tools.test.ts` "git's environment").
- A crafted file is read in linear time (`frontmatter.test.ts`, `tools.test.ts` "in linear time").
- A store stays in step with one session per tool, the same roots every run, and that tool's
  assets replaced for the roots in `scannedKeys` only (`tools.test.ts` "keeps a store in step",
  `problems.test.ts` "unreadable root").
- Tests never see the real HOME or git config: `setup.ts` points HOME at an empty temp dir. The
  README's limits are pinned by `tools.test.ts` ("known limits") and `frontmatter.test.ts`.
- The public API may change in a minor release before 1.0.

## Making a change

- A behaviour change needs a test that fails before it and passes after: readers in
  `tools.test.ts` or `hooks.test.ts`, warnings and errors in `problems.test.ts`, frontmatter in
  `frontmatter.test.ts`, CLI output in `cli.test.ts`. A change to what the scan reports or the
  CLI prints gets an "Unreleased" line in `CHANGELOG.md`. Refactors, tests and examples need none.
- Never silence ESLint inline. Turn a rule off in `eslint.config.js` with the reason. Shellcheck
  exceptions go in the repo root's `.shellcheckrc`.
- `readme.test.ts` pins the quick start to `examples/scan-a-repo/run.sh` and `assets/demo.tape`,
  and the collector program to `examples/collect-into-your-own-store/`.
- A new example copies `examples/scan-a-repo/`. Its README has one paragraph, the command
  `sh examples/<name>/run.sh` and the output in a `text` block, and `examples/README.md` a row
  `[name](name/)`. The runner runs it with an empty HOME, a fixed git identity and the built CLI
  on PATH, fails on a non-zero exit, and compares stdout with the last `text` block, the temp dir
  as `/tmp/work`. Output stays stable with fixed repos, no times and sorted listings.

## Do not

- Run a scan, test or example against your real HOME or a real repo. Use a temp HOME.
- Raise the Node floor above 24 without changing `engines`, CI and the README together.
- Import this folder's `src/` from the app by a relative path.
