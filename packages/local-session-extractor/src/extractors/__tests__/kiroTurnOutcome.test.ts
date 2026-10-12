// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A Kiro turn closes SUCCEEDED only when Kiro says the model ended its turn: a
 * cancellation is CANCELLED, an error is FAILED, and any other or missing stop
 * reason is UNKNOWN — never a synthesized pass.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseIdeMessages } from "../../internal";

function outcomeOf(stopReason: string | undefined): string | undefined {
  const payload: Record<string, unknown> = { type: "turn_end", executionId: "e1" };
  if (stopReason !== undefined) payload["stopReason"] = stopReason;
  const parsed = parseIdeMessages([
    JSON.stringify({ id: "s", timestamp: "2026-08-06T18:00:00.000Z", payload: { type: "turn_start", executionId: "e1" } }),
    JSON.stringify({ id: "t", timestamp: "2026-08-06T18:00:05.000Z", payload }),
  ]);
  return parsed.sessionEvents.find((e) => e.kind === "SESSION_EVENT_KIND_TURN_COMPLETED")?.outcome;
}

describe("kiro turn_end outcome", () => {
  const cases: Array<[string | undefined, string]> = [
    ["end_turn", "SESSION_EVENT_OUTCOME_SUCCEEDED"],
    ["cancelled", "SESSION_EVENT_OUTCOME_CANCELLED"],
    ["error", "SESSION_EVENT_OUTCOME_FAILED"],
    ["max_tokens", "SESSION_EVENT_OUTCOME_UNKNOWN"],
    ["", "SESSION_EVENT_OUTCOME_UNKNOWN"],
    [undefined, "SESSION_EVENT_OUTCOME_UNKNOWN"],
  ];
  for (const [reason, want] of cases) {
    it(`stopReason ${JSON.stringify(reason)} -> ${want}`, () => assert.equal(outcomeOf(reason), want));
  }
});
