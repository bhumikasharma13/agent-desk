# claude-code / api-retry

A real Claude Code `system/api_error` retry record, captured for the record-kind
registry (the `knownRecordKinds.sentinel` drift guard).

The record only fires on a genuine API or network failure, so it was captured by
inducing one: a headless `claude` request pointed at a local endpoint returning HTTP
`529` (overloaded, retryable), which made Claude Code's own client emit real
`system/api_error` records (`source: request_retry`, `retryAttempt`, `maxRetries`) —
structurally identical to a real retry. The capture was scrubbed through the
extractor's own redaction pass (`cwd` / `sessionId` → ████) and reviewed by hand.

An api_error retry storm terminates the turn with no assistant response, so there is
no conversation body here. The `API_RETRY` event emission is covered by
`sessionEvents.test.ts`.
