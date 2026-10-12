// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A Codex record kind the extractor handles is a recognized kind, so it never
 * counts as vendor drift in `ScanResult.unknownRecordKinds`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { noteUnknownRecordKind } from "../../internal";
import { runInScanScope, type ScanScope } from "../../seams/scanScope";

function unknownKindsAfter(kind: string): Record<string, number> {
  const scope: ScanScope = {
    source: "codex",
    logger: undefined,
    metrics: undefined,
    home: undefined,
    paths: new Map(),
    errors: [],
    unknownRecordKinds: new Map(),
    sourceFailed: false,
    loggedOnce: new Set(),
  };
  runInScanScope(scope, () => noteUnknownRecordKind("codex", kind));
  return Object.fromEntries(scope.unknownRecordKinds);
}

describe("Codex record kinds the extractor handles are recognized", () => {
  for (const kind of [
    "event_msg/mcp_tool_call_end",
    "event_msg/thread_goal_updated",
    "event_msg/item_completed/UserMessage",
    "event_msg/item_completed/AgentMessage",
    "event_msg/item_completed/CommandExecution",
    "event_msg/item_completed/Reasoning",
  ]) {
    it(`${kind} is not counted as unknown`, () => {
      assert.deepEqual(unknownKindsAfter(kind), {});
    });
  }

  it("a genuinely unknown kind is still counted", () => {
    assert.deepEqual(unknownKindsAfter("event_msg/some_future_kind"), { "codex:event_msg/some_future_kind": 1 });
  });
});
