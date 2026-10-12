# agent-desk

## What this is

A macOS Electron menu bar app: AI coding sessions per tool and project, read by
local-session-extractor, and the agent files coding agents load, scanned by harness-discovery.
It has no account or server, and never changes, runs or deletes a file it finds.

## Layout

- `src/main/` is the main process: `index.ts` wires it, `extraction/` reads in a utility process,
  `harness/` serves the Harness page, `permissions/` is folder access, `stack/` tags stacks.
- `src/preload/` is the IPC bridge, `src/renderer/` the React pages, `src/shared/` the types.
  Unit tests sit in `__tests__/` beside the code. `test/acceptance/` launches the built app.
- `packages/local-session-extractor/` and `packages/harness-discovery/` are the two libraries,
  each with its own `CLAUDE.md`. The app imports them by name through `exports`, never by `src/`.
- `examples/` holds the runnable examples, indexed by `examples/README.md`.

## Commands

Node 24 is the floor. CI builds and packages on 24, tests on 24 and 26, and lints on 26.
`pnpm build` and `pnpm make` also pass on 26.7.0. `corepack enable` gets the pinned pnpm.

```sh
pnpm install --frozen-lockfile
pnpm type-check
pnpm lint
pnpm test
pnpm audit --prod
pnpm audit --audit-level=high
pnpm build
pnpm test:acceptance
shellcheck scripts/*.sh examples/*/run.sh .github/assets/screenshots.sh
scripts/run-examples.sh
pnpm make
```

`pnpm lint` runs ESLint 10.11.0 with typescript-eslint 8.71.0, pinned in the lockfile. CI
installs shellcheck 0.11.0. Run `pnpm build` before the acceptance test and the examples, and
`pnpm --filter <name> build` after editing a package's `src`. Package checks run in its folder.
A new dependency that ships in the app needs `node scripts/third-party-licenses.mjs write`.

## Contract to keep

- The app's Node code reads only HOME, the repos, the app and its profile, writes only its
  profile, connects nowhere and runs only `git` and `ps` (`acceptance.test.mjs`, "offline").
- Nothing in a protected folder not granted is read but the session library's `.git` lookup
  ("containment", `stackDetectorProtected.test.ts`, `extractionWorker.test.ts`). Paths go through
  `resolveProject.ts`, which follows symlinks by hand, never `realpath`. Stack probes follow none.
- The pages match the libraries' own CLIs for the same HOME ("first launch", "repeatable").
- Failures are never silent. A failure shows as a problem or `lastError`, and a failed scan keeps
  the last one (`extractionWorker`, `extractionSchedulerWorker` and `storedScan` tests).
- The viewer serves only stored-scan files outside folders not granted, as text, up to 512 KB
  (`assetContent.test.ts`). The log masks tokens, emails and HOME (`sanitize.test.ts`).
- A launch never turns on launch at login (`launch.test.ts`). Unit tests get a temp profile
  from `src/main/electron-stub.mjs`, never a real one.

## Making a change

- A behaviour change needs a test beside the code that fails before it and passes after. A
  change to what the app shows, reads or writes gets an "Unreleased" line in `CHANGELOG.md`.
  Examples, tests and refactors get none.
- Never silence ESLint inline. Turn a rule off in `eslint.config.mjs` with the reason, and a
  shellcheck rule in `.shellcheckrc`. `pnpm test` fails until a new licence is committed.
- A page change needs new screenshots: `sh .github/assets/screenshots.sh` after `pnpm build`.
- The examples runner gives each example a temp HOME from its `testdata/home`, with `/Users/you`
  rewritten and each `src/*` a git repo, and compares stdout with its README's `text` block.
- A new example copies `examples/list-agent-files-in-a-repo/` to a `[a-z0-9-]+` folder. A repo
  is scanned once a session in `.claude/projects/-Users-you-src-<name>/` has `cwd` set to
  `/Users/you/src/<name>`. Its README is one paragraph, `run.sh` in an `sh` block and the
  runner's `+` lines in a `text` block. Link it from `examples/README.md` only (three show in
  the root README, `readme-examples.test.mjs`).

## Do not

- Try a change with `pnpm start`: it reads your real home folder. Use an example instead.
- Hand-edit `third_party/licenses/` or `resources/icon.icns`. Regenerate them with
  `node scripts/third-party-licenses.mjs write` and `resources/scripts/gen-icon.py`.
- Remove `nodeLinker: hoisted` from `pnpm-workspace.yaml`: Electron Forge needs it.
