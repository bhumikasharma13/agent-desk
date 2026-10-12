// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * `toConversation` field by field: what it maps, what it derives, and what it
 * leaves out rather than write a value the proto would reject.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toConversation } from "../sessionIntelligence";

const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "a".repeat(64),
  ide_type: "codex",
  session_id: "thread-1",
  relation_type: "PRIMARY",
  conversation: [
    { role: "user", content: "Fix the build", timestamp: "2026-03-01T12:00:05.000Z", metadata: { permission_mode: "default" } },
    { role: "assistant", content: "Done.", timestamp: "2026-03-01T12:00:01.000Z", metadata: { inputTokens: 10, tokenFidelity: "TOKEN_FIDELITY_MEASURED" } },
  ],
  project_path: "/Users/user_1a2b3c4d/src/shop/",
  repo_name: "acme/shop",
  last_mtime_ms: Date.UTC(2026, 2, 1, 13),
  last_size: 10,
  last_offset: 10,
  conversation_source_created_at_ms: null,
  session_meta: null,
  event_coverage: "EVENT_COVERAGE_PARTIAL",
  extractor_version: 3,
  created_at: "2026-03-02 08:00:00",
  updated_at: "2026-03-02 08:00:00",
  ...over,
});

describe("toConversation", () => {
  it("maps the row's identity, prompts and times to the proto's names and forms", () => {
    const c = toConversation(row());
    assert.equal(c.ideType, "IDE_TYPE_CODEX");
    assert.equal(c.sessionId, "thread-1");
    assert.equal(c.projectName, "shop");
    assert.deepEqual(
      c.prompts.map((p) => p.role),
      ["ROLE_USER", "ROLE_ASSISTANT"],
    );
    assert.deepEqual(c.prompts[0]!.metadata, { permissionMode: "default" });
    assert.deepEqual(c.prompts[1]!.metadata, { inputTokens: 10, tokenFidelity: "TOKEN_FIDELITY_MEASURED" });
    assert.equal(c.conversationStartedAt, "2026-03-01T12:00:01.000Z", "the earliest prompt time");
    assert.equal(c.lastUpdatedAt, "2026-03-01T13:00:00.000Z");
    assert.equal(c.eventCoverage, "EVENT_COVERAGE_PARTIAL");
    assert.equal(c.extractorVersion, 3);
    for (const key of ["id", "repoName", "repo_name", "relationType", "lastSize", "createdAt", "updatedAt"]) assert.equal(key in c, false, key);
  });

  it("starts the conversation at the source's own time, else at the store's UTC created_at", () => {
    const untimed = [{ role: "user", content: "hi" }];
    assert.equal(
      toConversation(row({ conversation: untimed, conversation_source_created_at_ms: Date.UTC(2026, 0, 2) })).conversationStartedAt,
      "2026-01-02T00:00:00.000Z",
    );
    assert.equal(toConversation(row({ conversation: untimed })).conversationStartedAt, "2026-03-02T08:00:00Z");
  });

  it("maps the lineage enums and leaves out the parent's store key", () => {
    const c = toConversation(
      row({ session_meta: { lineage: { relation_type: "SUBAGENT", linkage_confidence: "STRONG", parent_record_key: "b".repeat(64), spawn_depth: 0 } } }),
    );
    assert.deepEqual(c.sessionMeta?.lineage, {
      relationType: "CONVERSATION_TYPE_SUBAGENT",
      linkageConfidence: "LINKAGE_CONFIDENCE_STRONG",
      spawnDepth: 0,
    });
  });

  it("leaves out the fields the contract does not have", () => {
    const c = toConversation(
      row({ session_meta: { session_duration_seconds: 60, total_input_tokens: 5, total_output_tokens: 6, not_a_field: "x", duration_minutes: 1 } }),
    );
    assert.deepEqual(c.sessionMeta, { durationMinutes: 1 });
  });

  it("leaves out a value whose type the proto field cannot hold, keeping the rest", () => {
    const c = toConversation(
      row({
        session_meta: {
          avg_pre_compaction_tokens: 1.5,
          start_time: "2026-03-01T12:00:00",
          message_hours: [9, 10.5],
          tool_counts: { Bash: 2, Read: "3" },
          lines_added: 2 ** 31,
          user_message_count: 4,
        },
        session_events: [{ sequence: 1, occurred_at: "2026-03-01T12:00:00Z", kind: "SESSION_EVENT_KIND_NEW", outcome: "SESSION_EVENT_OUTCOME_UNKNOWN" }],
      }),
    );
    assert.deepEqual(c.sessionMeta, { toolCounts: { Bash: 2 }, userMessageCount: 4 });
    assert.deepEqual(c.sessionEvents, [{ sequence: 1, occurredAt: "2026-03-01T12:00:00Z", outcome: "SESSION_EVENT_OUTCOME_UNKNOWN" }]);
  });

  it("leaves out a timestamp protojson would refuse: out of range, or a date or time that does not exist", () => {
    const refused = [
      "0000-01-01T00:00:00Z",
      "2026-02-30T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "0001-01-01T00:30:00+01:00",
      "9999-12-31T23:30:00-01:00",
    ];
    const accepted = ["9999-12-31T23:59:59Z", "0001-01-01T00:00:00Z", "2024-02-29T23:59:59.999999999+05:30"];
    const events = [...refused, ...accepted].map((at, i) => ({ sequence: i + 1, occurred_at: at, kind: "SESSION_EVENT_KIND_TOOL_CALL" }));
    const c = toConversation(row({ session_events: events, conversation: [...refused, ...accepted].map((timestamp) => ({ role: "user", content: "x", timestamp })) }));
    assert.deepEqual(
      c.sessionEvents?.map((e) => e.occurredAt),
      [...refused.map(() => undefined), ...accepted],
    );
    assert.deepEqual(
      c.sessionEvents?.map((e) => e.sequence),
      events.map((e) => e.sequence),
      "an event whose time is left out keeps its sequence",
    );
    assert.deepEqual(
      c.prompts.map((p) => p.timestamp),
      [...refused.map(() => undefined), ...accepted],
    );
  });

  it("leaves out an epoch-milliseconds time outside 0001 to 9999", () => {
    const updated = (ms: number): string | undefined => toConversation(row({ last_mtime_ms: ms })).lastUpdatedAt;
    assert.equal(updated(253_402_300_800_000), undefined);
    assert.equal(updated(-62_135_596_800_001), undefined);
    assert.equal(updated(253_402_300_799_999), "9999-12-31T23:59:59.999Z");
    assert.equal(updated(-62_135_596_800_000), "0001-01-01T00:00:00.000Z");
  });

  it("leaves out an int64 count past 2^53, which a JSON number cannot hold exactly", () => {
    const c = toConversation(row({ conversation: [{ role: "assistant", content: "x", metadata: { inputTokens: 2 ** 53, outputTokens: 2 ** 53 - 1 } }] }));
    assert.deepEqual(c.prompts[0]!.metadata, { outputTokens: 2 ** 53 - 1 });
  });

  it("keeps a malformed message as an empty prompt, so later prompts keep their positions", () => {
    const c = toConversation(row({ conversation: [{ role: "system", content: 1 }, "x", { role: "user", content: "hi", timestamp: "yesterday" }] }));
    assert.deepEqual(c.prompts, [{}, {}, { role: "ROLE_USER", content: "hi" }]);
  });

  it("leaves out a JSON column the export could not parse, and an unknown source's ide type", () => {
    const c = toConversation(row({ ide_type: "█".repeat(8), session_meta: "{not json", session_events: "[" }));
    assert.equal("ideType" in c, false);
    assert.equal("sessionMeta" in c, false);
    assert.equal("sessionEvents" in c, false);
  });
});
