# Provenance — turn-telemetry fixture corpus

This corpus (34 files: 33 captured inputs and 1 case README) pins the on-disk shapes
the extractors parse. The extractor tests read it, and `scripts/golden.ts` stages it
into the golden export at `fixtures/golden.jsonl`. `README.md` describes the corpus's
contract; this file records where each member came from and what a human read found.

## What the corpus is

Every captured input is a **real, redacted provider transcript** from a developer's
machine, never a hand-built file (README, "Editing fixtures").

| Case | Inputs | Origin |
|---|---|---|
| `claude-code/api-retry` | `session-min.jsonl` | Real `system/api_error` records, induced by pointing a headless `claude` run at a local HTTP 529 endpoint; `cwd`/`sessionId`/timestamps replaced by `████████`. |
| `claude-code/compaction`, `injected-user`, `interrupted-zero-token`, `subagent-nesting` | 4 sessions (+1 subagent transcript, +1 meta) | Real Claude Code project transcripts. Prose replaced by `PLACEHOLDER TEXT (scrubbed)`, paths by `/Users/example-user/src/example-repo/…`, branch by `feature/example-branch`, thinking signatures by `SCRUBBED_SIGNATURE`. Message, request, tool-use and session ids rotated. |
| `claude-code/cowork` | `audit.jsonl` | Real Cowork audit log. Prose scrubbed; MCP servers, skills, agents, plugins, slash commands renamed `example-*`; `tools[]` names renamed `mcp__example-server-N__tool-N`. |
| `claude-code/session-rename-bridge` | 1 file | Real `custom-title` + `system/bridge_status` records; bridge token replaced. |
| `codex/boot-zero-token`, `compaction`, `retries`, `turn-brackets` | 4 rollouts | Real Codex Desktop rollouts. Prompt, agent and tool text replaced by `[SCRUBBED …]` markers; org renamed `example-org`, repo `example-repo`; username `redacted`. Response, call and thread ids rotated; plan tier replaced; rate-limit numbers kept. `compaction` is `boot-zero-token` with a real `context_compacted` record spliced in. |
| `codex/end-record-kinds` | 1 file | A hand-assembled slice of real Codex records of several kinds from different sessions (ids zeroed). |
| `cursor/model-recovery`, `requestid-merge`, `subagent-dirs` | stop-hook ledgers + agent transcripts | Real Cursor Agent transcripts and `token-events-raw` ledgers. Prompt and assistant text replaced by `[scrubbed …]`, paths by `/Users/user/src/example-repo/path/scrubbed-N`, email by `user@example.com`. Generation, conversation and subagent ids rotated; the user-query timestamp wrapper rewritten to UTC. |
| `kiro/inline-subagents`, `per-turn-credits`, `turn-brackets` | 3 `sess_*` dirs | Real Kiro IDE sessions. Prose replaced by `SCRUBBED …`, workspace by `/Users/scrubbed-user/workspace`, skills by `scrubbed-skill`. Trace ids, request ids and message ids rotated. |

## How it was captured

Some members were scrubbed by hand; later ones went through
`fixtures/extraction/capture-fixture-scrub.mts`, which runs the package's redaction
module over the raw file and then requires the hand review the README describes. The
scrub catches secret shapes and the home path, not prose or ids.

## Kiro created timestamps

`kiroIdeExtractor.ts` falls back to the session directory's birth time when
`session.json` has no `createdAt`, which would make a Kiro row differ per checkout.
All three `session.json` files carry an explicit `createdAt`
(`2026-08-07T09:49:32.478Z`, `2026-08-12T02:30:30.461Z`, `2026-08-26T05:41:20.734Z`),
and `scripts/golden.ts` asserts that every Kiro row's
`conversation_source_created_at_ms` equals one of these values. A new Kiro case must
keep the field.

## Determinism for the golden

`scripts/golden.ts` (run by `pnpm capture-golden` and the parity test) pins every
staged file's mtime and atime to `2026-01-01T00:00:00Z` before scanning.

## Scrub decisions

Candidates came from one full read of every data file (every string value). Every
candidate but T12 was replaced in place. Identifiers were rotated, not blanked: the
same original maps to the same synthetic value in every file, directory name and
test. Each value keeps its shape (prefix, length, character class), and a UUID keeps
its version and variant digits, plus the timestamp prefix for version 7.

| # | File(s) | Field | Decision | Replacement |
|---|---|---|---|---|
| T1 | `codex/*` rollouts, `codex/end-record-kinds`, `claude-code/session-rename-bridge` | `cwd`, sandbox paths, `stdout`, `changes` keys, `repository_url` | replaced | `/Users/example-user/src/example-repo`, `https://github.com/example-org/example-repo` |
| T2 | `codex/{boot-zero-token,compaction,retries}` | `state.environments.timezone` | replaced | `Etc/UTC` |
| T3 | `cursor/{subagent-dirs,model-recovery,requestid-merge}` | `<timestamp>` wrapper in user queries | rewritten | the same instant in UTC, labelled `(UTC)` |
| T4 | `cursor/requestid-merge` | `subagent_type` | replaced | `example-agent`, `example-agent-2` |
| T5 | `cursor/subagent-dirs` | MCP `input.server` alias | replaced | `example-mcp` |
| T6 | `claude-code/cowork/audit.jsonl` | `tools[]` MCP tool names | replaced | `mcp__example-server-N__tool-N`, numbered per server |
| T7 | `claude-code/**`, `cowork/audit.jsonl` | Anthropic message, request and tool-use ids; session UUIDs and subagent `agentId`s (and the transcript file names that carry them) | rotated | shape-preserving synthetic ids |
| T8 | `codex/{retries,turn-brackets,compaction}` | OpenAI response and call ids; `plan_type` | rotated; replaced | `plan_type: example`; rate-limit numbers kept |
| T9 | `cursor/*/stop.jsonl`, `subagentStop.jsonl` | generation, conversation and subagent ids | rotated | `cursor_version` kept |
| T10 | `kiro/**` | `traceparent`, `requestIds[]`, `userMessageTag`, every `*tooluse_` tool-call id | rotated | shape-preserving synthetic ids |
| T11 | `claude-code/api-retry/session-min.jsonl` | user prompt | scrubbed | `[scrubbed user prompt]` |
| T12 | every captured input | `timestamp` / `_audit_timestamp` | kept | timestamps stay byte-faithful (README, "Scrub conventions") |
| T13 | `claude-code/injected-user/66aaaa85-….jsonl` | an `AskUserQuestion` answer key (the question text) | replaced | `PLACEHOLDER QUESTION (scrubbed)` |

Not candidates, recorded so a scanner hit is not misread: `bugbot` (Cursor's own
built-in agent name), `sdk-cli` / `sdk` (Claude Code entrypoint enum), the
`session_ExampleBridgeSessionToken` bridge URL, `user@example.com`, and every
`[SCRUBBED …]` / `PLACEHOLDER TEXT (scrubbed)` / `████████` marker.
