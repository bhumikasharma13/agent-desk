# Contributing

GitHub Actions is disabled at organization level. Workflow files are retained for future use, but checks and releases must be run locally. Pushing a tag does not automatically publish a release.

## Build and check

You need macOS 12 or later, the Xcode Command Line Tools (`xcode-select --install`), Node 24,
pnpm 10 (`corepack enable` picks the version in `package.json`'s `packageManager`), git and
shellcheck (`brew install shellcheck`). The retained CI configuration builds and packages on Node 24, and runs the unit
tests on Node 24 and 26; `pnpm build` and `pnpm make` also pass on Node 26.7.0. These are the
checks to run locally:

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

`pnpm lint` runs ESLint 10.11.0 with typescript-eslint 8.71.0, the versions the lockfile pins.
The retained workflows use shellcheck 0.11.0. Run both `pnpm audit` commands locally; the Vulnerability check workflow is currently disabled.
`pnpm test` runs the unit tests under Electron's own Node.

### Known advisories ignored by the audit

`pnpm audit --audit-level=high` checks every dependency, build tools included. These
advisories have no fixed release the build can use. They are ignored by id in `package.json`
(`pnpm.auditConfig.ignoreGhsas`), and each is reachable only while building, never in the app.

| Advisory | Package | Listed | Where it runs |
|---|---|---|---|
| GHSA-jmr9-qjv8-65gv, GHSA-7pqw-9j4j-h8q3 | extract-zip 2.0.1 | 2026-10-05 | Electron Forge's packager unzips the Electron release, downloaded and checked against Electron's checksums, into the build folder. |
| GHSA-vfj7-8cjw-p6xm | braces 3.0.3 | 2026-10-05 | Electron Forge globs the build folder with its own fixed pattern (`**/.bin/**/*`). |
| GHSA-w3rx-r6r6-pgpr | image-size 0.7.5 | 2026-10-05 | The fix, 2.0.3, changes the call the DMG maker (appdmg) makes, and `pnpm make` fails with it. appdmg sizes only the DMG background, a PNG that electron-installer-dmg ships, so the advisory's ICNS parser never runs. |

Remove a row, and its id, once a fixed release the build can use exists.

`@electron/node-gyp`, which Electron Forge's `@electron/rebuild` depends on, comes from a public
tarball on codeload.github.com, and the install fetches it anonymously.
It also builds the native modules of the DMG maker. Unpatched, its logger shows every level
whatever `loglevel` says, so compiling `macos-alias` would print its debug log, your environment
included. `patches/@electron__node-gyp.patch` fixes that one line (`pnpm.patchedDependencies`).
Remove the patch once Electron Forge depends on a node-gyp without the bug.

`pnpm test:acceptance` and the examples open the built app on a temporary home folder. They use
a temporary profile, never your own. `pnpm make` writes a DMG and ZIP signed ad hoc with the hardened runtime, with no Developer ID, to `out/make`, for a local check; releases ship source only.

## The session extractor package

`packages/local-session-extractor/` has its own checks, which the retained CI configuration also covers, on Node 24 and 26.
From the repository root:

```sh
pnpm install --frozen-lockfile
cd packages/local-session-extractor
pnpm type-check
pnpm lint
pnpm test
scripts/smoke-install.sh
scripts/run-examples.sh
node scripts/readme-blocks.mjs
shellcheck -x examples/*/run.sh scripts/*.sh assets/demo-setup.sh
```

The install builds the package's `dist/`, which the app imports. After editing
`packages/local-session-extractor/src`, run `pnpm --filter local-session-extractor build` before
`pnpm start`, `pnpm build` or `pnpm test:acceptance`: the app uses that built `dist/`, not the source. `scripts/run-examples.sh` runs
every example and compares its output with the example's README, and `scripts/readme-blocks.mjs`
does the same for the blocks in its README and `docs/reference.md`. The tests never read your
home folder, call `ps` or reach the network.

A change to what a scan writes changes `fixtures/golden.jsonl` and its Conversation form,
`fixtures/golden-conversation.jsonl`. Regenerate both with `pnpm capture-golden`, review the
diff, then update that source's `EXTRACTOR_CODE_VERSION` and `EXTRACTOR_GOLDEN_SHA256` in
`src/capabilities.ts`. A user-visible change to the package gets a
line in its own `CHANGELOG.md`.

The package's `assets/demo.gif` is rendered from `assets/demo.tape`, never recorded by hand.
Re-render it when a change alters what the package README's Quick start commands print. With
`vhs`, `ttyd` and `ffmpeg` installed (`brew install vhs`), run `vhs assets/demo.tape` from the
package folder and commit the GIF. Without them, run the `local-session-extractor demo GIF`
workflow and commit its `demo-gif` artifact.

## The harness discovery package

`packages/harness-discovery/` has its own checks, which the retained CI configuration also covers, on Node 24 and 26.
From the repository root:

```sh
pnpm install --frozen-lockfile
cd packages/harness-discovery
pnpm type-check
pnpm lint
pnpm test
scripts/smoke-install.sh
scripts/run-examples.sh
scripts/readme-blocks.sh
shellcheck -x scripts/*.sh examples/*/run.sh
```

The install builds the package's `dist/`, which the app and the examples import. After editing
`packages/harness-discovery/src`, run `pnpm --filter harness-discovery build` before `pnpm start`,
`pnpm build` or `pnpm test:acceptance`: the app uses that built `dist/`, not the source. The tests,
examples and README blocks need git 2.28 or later, and run against temporary home folders
and repos they create, never your own. A change to what the scan reports, or to the CLI's
output, gets a line in the package's own `CHANGELOG.md`.

The package's `assets/demo.gif` is rendered from `assets/demo.tape`, never recorded by hand.
Re-render it when a change alters what the quick start prints: run `vhs assets/demo.tape`
from the package folder, which packs this checkout and installs it for the README's release URL,
or run the `harness-discovery demo GIF` workflow and commit its `demo-gif` artifact.

## Pull requests

- Every behaviour change comes with a test that fails before it and passes after.
- A change to what the app shows, reads or writes gets a line under "Unreleased" in
  `CHANGELOG.md`. Examples, tests and refactors get none.
- Commit messages say what changed and why, in the imperative mood.
- Do not silence the linter inline. A rule that must be off is off in `eslint.config.mjs` or
  `.shellcheckrc`, with the reason.
- A new dependency that ships in the app needs its licence in `third_party/licenses/`. Run
  `node scripts/third-party-licenses.mjs write` and commit the result. `pnpm test` fails until
  you do.
- A change to a page gets new README screenshots: run `sh .github/assets/screenshots.sh` after
  `pnpm build`, look at all four images, and commit them.

## Releasing

Create a release manually from a pushed tag. The app and each package are released on their own:

| Release | Version in | Changelog | Tag | Workflow |
|---|---|---|---|---|
| The app | `package.json` | `CHANGELOG.md` | `v<version>` | `release.yml` |
| harness-discovery | `packages/harness-discovery/package.json` | its `CHANGELOG.md` | `harness-discovery-v<version>` | `release-harness-discovery.yml` |
| local-session-extractor | `packages/local-session-extractor/package.json` | its `CHANGELOG.md` | `local-session-extractor-v<version>` | `release-local-session-extractor.yml` |

1. In a pull request, set the new `version`, and turn the changelog's `[Unreleased]` lines into
   a `## [<version>] - <YYYY-MM-DD>` entry dated the day you tag, with the compare links below it.
   For a package, also change the version in its README's release URLs and in `assets/demo.tape`,
   since each URL names one version, and re-render the GIF. Its README test fails until you do.
2. Once it is merged, tag the merge commit on `main` and push the tag, for example
   `git tag v0.2.0 origin/main && git push origin v0.2.0`.

If Actions is re-enabled, each workflow stops before publishing unless the tagged commit is an ancestor of `origin/main`,
the tag is the prefix plus the `version` in that `package.json`, and the changelog has a dated,
non-empty entry for that version. Then it runs the tests. `release.yml` creates the GitHub
release with the changelog entry as its notes, using the workflow's own token; GitHub attaches the
source archives, and no app build is uploaded.

Each package workflow runs `pnpm pack` once, runs the smoke install against that `.tgz`, then
creates the GitHub release with the changelog entry as its notes and attaches the `.tgz` and its
`.sha256`, using the workflow's own token. No package registry account or token is involved. Users
run the file with `npx "<its URL>"` or add it to a project with `pnpm add <its URL>`, as each
package README shows. The workflow also attests the `.tgz`'s build provenance, and
`gh attestation verify <file>.tgz -R tetriz-ai/agent-desk` checks a downloaded file against it.

With Actions disabled, a maintainer publishes by hand from the tagged commit, with
`gh` signed in. Only the workflow can attest how the `.tgz` was built, so a release made this
way has the checksum but no build provenance attestation:

```sh
cd packages/<package>
version=$(node -p 'require("./package.json").version')
tag="<package>-v$version"
out=$(mktemp -d)
tarball="$(pnpm pack --pack-destination "$out" | tail -n 1)"
scripts/smoke-install.sh "$tarball"
awk -v v="$version" '$0 ~ "^## \\[" v "\\]" { on = 1; next } on && /^(## )?\[/ { exit } on { print }' CHANGELOG.md > "$out/notes.md"
url="https://github.com/tetriz-ai/agent-desk/releases/download/$tag/$(basename "$tarball")"
{ echo; echo "### Run"; echo; echo "    npx \"$url\" --help"; } >> "$out/notes.md"
(cd "$out" && shasum -a 256 "$(basename "$tarball")" > "$tarball.sha256")
gh release create "$tag" --verify-tag --title "$tag" --notes-file "$out/notes.md" "$tarball" "$tarball.sha256"
```

## Licensing of contributions

No sign-off line and no separately signed agreement are needed. By opening a pull request you
agree that your contribution is released under the project's [LICENSE](LICENSE).
