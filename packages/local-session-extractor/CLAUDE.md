# Agent guide

## What this is

A TypeScript package and command that read Claude Code, Copilot, Antigravity, Codex, Kiro and
Cursor sessions on macOS into one redacted row each in a local SQLite store. It uploads nothing.
The app imports it by name, through `dist/`. Repo-wide rules are in `../../CLAUDE.md`.

## Layout

- `src/index.ts`, `src/host.ts` — the public entry points. `src/cli/` — the command.
- `src/scan.ts` — `readAll`/`readSource`. `src/extractors/` — one reader per source.
- `src/store/`, `src/redaction/` — the store, and the masks. `docs/reference.md` — exact rules.
- `src/export.ts`, `src/capabilities.ts` — export, and the version and golden-hash pins.
- `src/sessionIntelligence.ts` — `toConversation`, the export's Session Intelligence form, and
  its field tables. `contract/session-intelligence/` — that proto's descriptor, for the test.
- Tests sit in `__tests__/` beside the code. `fixtures/` — corpora and `golden.jsonl`.
- `examples/`, `scripts/` (example runner, smoke install), `test-setup.mjs` (the test guard).

## Commands

The floor is Node 24. CI tests on Node 24 and 26 on macOS, and runs lint and examples on 24.
`corepack enable` gets the pinned pnpm, and the root lockfile pins ESLint. Install from the repo
root, which builds `dist/`, then run the rest here. CI installs shellcheck 0.11.0. Node's
"SQLite is an experimental feature" warning on stderr is expected and harmless.

```sh
(cd ../.. && pnpm install --frozen-lockfile)
pnpm build
pnpm type-check
pnpm lint
pnpm test
scripts/smoke-install.sh
scripts/run-examples.sh
shellcheck -x examples/*/run.sh scripts/*.sh assets/demo-setup.sh
pnpm audit --prod
# one test file:
node --no-warnings=ExperimentalWarning --import ./test-register.mjs --import ./test-setup.mjs --test src/__tests__/readAll.test.ts
```

## Contract to keep

- **Redaction never gets weaker.** Pinned by `src/redaction/__tests__/` and `export.test.ts`.
- **A scan with `home` runs no `ps`, no git and no request.** Without it, only `ps` and HTTPS to
  127.0.0.1 run. Pinned by `networkDisclosure.test.ts` and `readAll.test.ts` ("spawns no git").
- **No credential token is kept.** Pinned by `credentialFiles.test.ts` and `kiroPlanTier.test.ts`.
- **A failing source never stops the scan.** Pinned by `readAll.test.ts` ("the error contract").
- **Scan output is pinned** by `fixtures/golden.jsonl`, `goldenParity.test.ts` and smoke-install.
- **The export is Session Intelligence's `Conversation`.** Pinned by
  `sessionIntelligenceContract.test.ts` and `fixtures/golden-conversation.jsonl`. A new extractor
  field does not compile until its table in `src/sessionIntelligence.ts` keeps, maps or drops it.
- **The public API is semver:** `src/index.ts`, `src/host.ts`, the outbox methods
  (`outboxContract.test.ts`), the `session_meta` field names (`fixtures/golden.jsonl`) and the
  `lineage` fields (`claudeCodeExtractor.test.ts`, `examples/fold-sub-agents-onto-their-session`).
- **The CLI exits 0 on success, 2 on a partial scan and 1 otherwise.** Pinned by `cli.test.ts`.

## Making a change

- A behaviour change needs a test beside it that fails before the change and passes after.
- Regenerate `fixtures/golden*.jsonl` with `pnpm capture-golden`, never by hand, and update that
  source's `EXTRACTOR_CODE_VERSION` and `EXTRACTOR_GOLDEN_SHA256`.
- A user-visible change gets an entry in this folder's `CHANGELOG.md`, and a refactor or test none.
- Fix a lint finding instead of silencing it. Change `eslint.config.js` only with a comment.
- `scripts/run-examples.sh` runs each example README's first ` ```sh ` block here with an empty
  `HOME`, and compares stdout with its last ` ```text ` block, after rewriting `mktemp -d` paths,
  scan durations and store write times.
- Start an example from `examples/read-one-session/`, or a CLI example as a `run.sh` sourcing
  `scripts/example-setup.sh`. Examples carry no license header and print nothing that changes
  between runs. Add a row at the end of `examples/README.md`'s table as `| ... | [name](name/) |`.
  `readmeQuickstart.test.ts` holds the README's program to `examples/read-sessions-into-a-store/`.
- A failure-case test writes a garbage `.codex/state_5.sqlite` in a temp home (`readAll.test.ts`).

## Do not

- Do not scan your real home in a test or an example. Pass `home` or a path override.
- Do not remove the `gitleaks:allow` comments. The tokens they mark are fake fixtures.
- Do not use TypeScript syntax Node cannot strip (parameter properties, enums, namespaces).
- Do not lower the Node floor below 24. `node:sqlite` and type stripping need it.
- Do not import this folder's `src/` from the app by a relative path.
