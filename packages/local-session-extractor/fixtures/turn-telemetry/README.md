# Turn-telemetry fixture corpus

Real, redacted provider transcripts that pin the on-disk shapes the extractors
parse: turn boundaries, per-message token counts, sub-agent nesting, retries and
compaction. The extractor tests read this corpus, and `scripts/golden.ts` stages it
into the golden export (`fixtures/golden.jsonl`). Old-shape fixtures never retire:
old files stay on disk for a long time, so they are backward-compatibility coverage.

## Layout

```
fixtures/turn-telemetry/<provider>/<case>/   captured inputs (add, don't edit)
```

Coverage by provider: Claude Code (`api-retry`, `compaction`, `cowork`,
`injected-user`, `interrupted-zero-token`, `session-rename-bridge`,
`subagent-nesting`), Codex (`boot-zero-token`, `compaction`, `end-record-kinds`,
`retries`, `turn-brackets`), Cursor (`model-recovery`, `requestid-merge`,
`subagent-dirs`) and Kiro (`inline-subagents`, `per-turn-credits`, `turn-brackets`).

- **Cursor.** A Cursor row is built only from the binary IDE store, which this
  corpus deliberately excludes (see Scrub conventions), so the Cursor cases feed the
  stop-hook ledger and transcript tests, not the golden rows.
- **`claude-code/session-rename-bridge`, `claude-code/api-retry`,
  `codex/end-record-kinds`, `codex/compaction`.** Record-kind fixtures for the
  `knownRecordKinds` registry: each carries a record kind the sentinel test requires a
  fixture for. `api-retry` is an induced `system/api_error` retry storm (a headless
  request against a local `529` endpoint), so it has no assistant response.

## Editing fixtures

Fixture inputs are captured real transcripts, so treat them as evidence: **add a
new case rather than editing an existing one.** A fixture change shows up as a diff
in review, and review is what keeps the corpus faithful to real vendor shapes. To
supersede a fixture, add a new case and delete the old file in the same change.

## Scrub conventions

Content is replaced, structure is preserved. Human prompt and response text, paths
outside generic shapes, emails, org-identifying strings, and anything secret-shaped
are replaced with neutral placeholders; record kinds, usage objects, ids (rotated,
with equality relationships preserved), timestamps, and provider markers stay
byte-faithful in shape. Cursor binary store blobs (`state.vscdb`, field-5 snapshots)
enter the corpus only as extracted numeric records, never as raw blobs: their scrub
is a supervised manual step.

## Capturing a drifted session

`fixtures/extraction/capture-fixture-scrub.mts` runs the package's own redaction
(`redactText`) over one raw session file:

```sh
node --import ./test-register.mjs \
  fixtures/extraction/capture-fixture-scrub.mts <src> <out>
```

**The scrub is a first pass, not complete redaction — review its output by hand.**
It catches what `redactText` catches: the running user's home path and username and
known secret shapes (JWTs, cloud keys, PEM, emails, high-entropy quoted strings),
anywhere in the file including JSON keys. It does NOT catch free prose — a
colleague, customer or org name, a phone number, an IP, a repo or directory name in a
path — and it does not rotate ids. Remove those by hand and rotate ids preserving
equality before committing the fixture. That review is the safety gate.

Two input classes must not be scrubbed as text: a binary store (`state.vscdb`) and a
compressed rollout (Codex `*.jsonl.zst` — decompress it first). Either would
otherwise produce a corrupt member that looks valid.

## Known gaps

Cases no captured store could produce are listed here rather than faked:

- `codex/double-compaction` — two `context_compacted` records inside one turn.
- A Kiro zero-credit turn — a `usage_summary` with `usage: 0`. The extractor's
  zero-emission path is covered by its own tests.

Codex `event_msg/mcp_tool_call_end` and `event_msg/thread_goal_updated` have no case
here; the sentinel finds them in `fixtures/extraction/codex/` (the `/goal` rollouts and
`rollout-fixture.jsonl`), which it reads alongside this corpus.
