// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCliSessionEvents, cliToolOrdinal, cliResultOutcome } from "../../internal";

// Every shape below is taken from a real captured `/loop` session under ~/.cursor/chats:
// the id format, the tool names (Read/Shell/Write/Glob) and the result prefixes are what that
// session actually contained. The ordinals in it ran 0..8 contiguously, which is the fact this
// adapter depends on — the module header calls the blobs unordered, and that is true of the
// table but not of the ids.
describe("cli tool ordinals recover the order the table does not carry", () => {
  it("reads the ordinal off the first line of a real tool id", () => {
    const id = "call-fc9e64c5-e04c-4797-aafb-24d75f6ae32d-5\nfc_owHqMB5-6SkKZu-a2b7e2ba3fa48bcf_3";
    assert.equal(cliToolOrdinal(id), 5);
  });

  it("takes the CALL ordinal, not the within-message index", () => {
    // The second segment ends in _3; the answer must be 5, from the first line.
    const id = "call-abc-12\nfc_msg_3";
    assert.equal(cliToolOrdinal(id), 12);
  });

  it("returns null for an id that is not a tool call", () => {
    assert.equal(cliToolOrdinal("msg_owHqHMk-6SkKZu-a2b7e269ffe08bcf_0"), null);
    assert.equal(cliToolOrdinal(undefined), null);
    // A bare assistant id carries no `-N` suffix, so it yields no ordinal — which is what
    // sends such a result to the end of the timeline rather than to position 1.
    assert.equal(cliToolOrdinal("1"), null);
  });
});

describe("cli outcomes are read only from what a tool states", () => {
  it("maps a shell exit code", () => {
    assert.equal(cliResultOutcome("Exit code: 0\n\nCommand output:\n\n```\nHello\n```"),
      "SESSION_EVENT_OUTCOME_SUCCEEDED");
    assert.equal(cliResultOutcome("Exit code: 1\n\nCommand output:"),
      "SESSION_EVENT_OUTCOME_FAILED");
  });

  it("takes Write's explicit success statement", () => {
    assert.equal(cliResultOutcome("Wrote contents to /tmp/hello_world.py"),
      "SESSION_EVENT_OUTCOME_SUCCEEDED");
  });

  it("refuses to infer success from a Read's contents", () => {
    // A Read returns the file and says nothing about whether reading worked. Treating the
    // absence of an error as a pass would manufacture a verdict the tool never gave — and the
    // consumer reads this as a check's result.
    assert.equal(cliResultOutcome("---\n# No `paths:` scope on purpose."),
      "SESSION_EVENT_OUTCOME_UNKNOWN");
    assert.equal(cliResultOutcome("Result of search in '/Users/x'"),
      "SESSION_EVENT_OUTCOME_UNKNOWN");
  });
});

describe("a cli session becomes an ordered, paired timeline", () => {
  const messages = [
    {
      role: "assistant",
      id: "msg_a_0",
      content: [
        { type: "tool-call", toolCallId: "c-b", toolName: "Shell", args: { command: "pnpm test" } },
        { type: "tool-call", toolCallId: "c-a", toolName: "Read", args: { file_path: "a.ts" } },
      ],
    },
    // Results arrive as their own blobs, and their ids — not their position — give the order.
    { role: "tool", id: "call-x-1\nfc_a_1", content: [{ type: "tool-result", toolCallId: "c-b", toolName: "Shell", result: "Exit code: 1\n" }] },
    { role: "tool", id: "call-x-0\nfc_a_0", content: [{ type: "tool-result", toolCallId: "c-a", toolName: "Read", result: "file body" }] },
  ];

  it("orders by the id ordinal, not by blob order", () => {
    const { events } = buildCliSessionEvents(messages);
    const calls = events.filter((e) => e.kind === "SESSION_EVENT_KIND_TOOL_CALL");
    // ordinal 0 is the Read, ordinal 1 the Shell — the reverse of how the blobs were listed.
    assert.deepEqual(calls.map((c) => c.operation_name), ["Read", "Shell"]);
  });

  it("pairs each result to the call that produced it", () => {
    const { events } = buildCliSessionEvents(messages);
    const results = events.filter((e) => e.kind === "SESSION_EVENT_KIND_TOOL_RESULT");
    assert.deepEqual(results.map((r) => r.parent_call_id), ["c-a", "c-b"]);
    assert.equal(results[1]?.outcome, "SESSION_EVENT_OUTCOME_FAILED", "the shell exit code survives");
  });

  it("keeps a call whose result never arrived", () => {
    // A truncated session must not read as a complete one.
    const { events } = buildCliSessionEvents([
      { role: "assistant", id: "m", content: [{ type: "tool-call", toolCallId: "orphan", toolName: "Shell", args: {} }] },
    ]);
    assert.equal(events.filter((e) => e.kind === "SESSION_EVENT_KIND_TOOL_CALL").length, 1);
    assert.equal(events.filter((e) => e.kind === "SESSION_EVENT_KIND_TOOL_RESULT").length, 0);
  });

  it("summarises a call by its path or command, never its body", () => {
    const { events } = buildCliSessionEvents(messages);
    const [first] = events.filter((e) => e.kind === "SESSION_EVENT_KIND_TOOL_CALL");
    assert.equal(first?.redacted_summary, "a.ts");
  });
});
