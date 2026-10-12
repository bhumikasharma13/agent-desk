# Provenance — extraction test fixtures

This corpus drives the extractor unit tests and, together with
`fixtures/turn-telemetry/`, the golden export at `fixtures/golden.jsonl`. Every file
is either hand-built synthetic data or a scrub whose residue has had a human read.
This file records which is which.

## What the corpus is

| Source | Files | Origin |
|---|---|---|
| `antigravity/state.vscdb`, `copilot/vscode_state.vscdb`, `cursor/state_happy.vscdb`, `codex/state_5.sqlite` | 4 | **Synthetic.** Generated once by a script; every value was typed into it (`Write a sort function`, `/home/user/project`, `https://github.com/org/repo`). The generator needed a native SQLite binding this package does not use, so it is not included; the files are committed output. |
| `claude-code/**` (12 `.jsonl` + 1 `.meta.json`) | 13 | **Synthetic.** Hand-written transcripts (`abc123def456`, `/home/user/project`, `org/repo/pull/42`). `secret777` / `secrets999` carry a deliberately key-shaped string (`sk-ant-api03-ABCDEF…`) to exercise redaction — it is not a credential. One record embeds a 5-byte `image/png` placeholder (`iVBOR`), not an image. |
| `codex/rollout-fixture.jsonl` | 1 | **Synthetic.** Hand-written rollout paired with `state_5.sqlite`. |
| `codex/goal-rollout*.jsonl` | 4 | **Real captures, scrubbed.** Codex CLI `/goal` sessions; every identifying value was replaced (see Scrub decisions below). |
| `copilot/cli-sessions/**`, `copilot/workspaceStorage/**` | 2 | **Synthetic.** |
| `cursor-cli-*.bin` (4) + `cursor-cli-root-ids.json` | 5 | **Real store fragments, id-only.** Field-1 and field-13 32-byte SHA-256 ids copied from a live `~/.cursor/chats/**/store.db`; the prompt-bearing field 5 and JSON blobs were dropped (README). |

## How it was captured

Synthetic members were written by hand or by a generator. The Codex `/goal` rollouts
were copied from `~/.codex/sessions/` and had the home path rewritten, then scrubbed
per the table below. The Cursor CLI `.bin` roots were cut from a live store by hand
with the text-bearing fields removed. `capture-fixture-scrub.mts` (below) was not run
over any member here.

## Tooling files (not data)

- `capture-fixture-scrub.mts` — a first-pass scrub of one captured session file; it
  lives here because it imports the package's redaction module
  (`fixtures/turn-telemetry/README.md`, "Capturing a drifted session").
- `README.md` — the standing judgment on the Cursor CLI binary fixtures.

## Determinism for the golden

`scripts/golden.ts` pins every staged file's mtime and atime to
`2026-01-01T00:00:00Z` before scanning, so `last_mtime_ms` is stable on a fresh
clone. No Kiro fixture lives in this corpus; the Kiro created-timestamp rule is
recorded in the turn-telemetry corpus's `PROVENANCE.md`.

## Scrub decisions

Candidates came from one full read of every data file (every string value, every
binary through `strings`). Every candidate but E9 was replaced in place. Identifiers
were rotated, not blanked: the same original maps to the same synthetic value in
every file and test. Each value keeps its shape (prefix, length, character class), and
a UUID keeps its version and variant digits, plus the timestamp prefix for version 7.

| # | File(s) | Field | Decision | Replacement |
|---|---|---|---|---|
| E1 | `codex/goal-rollout*.jsonl` (4) | `payload.cwd` | replaced | `/Users/example-user/src/example-repo` |
| E2 | same four | `payload.git.repository_url` | replaced | `git@github.com:example-org/example-repo.git` |
| E3 | same four | `payload.git.branch` | replaced | `fix/example-branch`, `fix/example-branch-2` (the two originals stay distinct) |
| E4 | same four | `payload.git.commit_hash` | replaced | forty zeros, and forty characters ending in `1` for the second SHA |
| E5 | same four | `payload.base_instructions.text` | replaced | `[SCRUBBED base instructions]` |
| E6 | same four | Codex thread, window and turn ids | rotated | rate-limit numbers are kept as shape; the plan and the limit error are E10 |
| E7 | same four | `goal.objective`, `last_agent_message` | scrubbed | `[scrubbed goal objective N]`, one N per distinct original, so `codexGoal.test.ts` still tells invocations apart |
| E8 | `claude-code/project_renamed/slashcmd999.jsonl` | `<command-args>` issue URL and the command name | replaced | `https://github.com/example-org/example-repo/issues/1`, `/deploy-app`; `claudeCodeExtractor.test.ts` asserts the new values |
| E9 | `cursor-cli-*.bin` (4), `cursor-cli-root-ids.json` | 32-byte root ids | kept | identifiers only, no text |
| E10 | `codex/goal-rollout*.jsonl` (4) | `rate_limits.plan_type`, `rate_limit_reached_type`, the usage-limit error message | replaced | `"example"`, `"example_limit_reached"`, `Example usage limit reached.` |

Not candidates, recorded so a scanner hit is not misread: the `sk-ant-api03-…` key
shape in `secret777` / `secrets999` (synthetic, exercises redaction); `org/repo`,
`/home/user/project`, `bridge.example.com` (hand-built).
