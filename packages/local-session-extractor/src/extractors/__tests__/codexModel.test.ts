// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A Codex prompt's `model` is a model id: the thread's own model, or else the
 * model the turn's `turn_context` names — never the provider (`openai`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRolloutContent } from "../../internal";

const meta = `{"type":"session_meta","payload":{"id":"t1","cwd":"/x","source":"cli","model_provider":"openai"}}`;
const turn = (model?: string) =>
  `{"type":"turn_context","payload":{"cwd":"/x","approval_policy":"on-request"${model ? `,"model":"${model}"` : ""}}}`;
const user = (t: string, text: string) => `{"type":"event_msg","timestamp":"${t}","payload":{"type":"user_message","message":"${text}"}}`;
const done = (t: string) => `{"type":"event_msg","timestamp":"${t}","payload":{"type":"task_complete","last_agent_message":"ok"}}`;

function models(jsonl: string[], override?: string): Array<string | undefined> {
  const result = parseRolloutContent(jsonl.join("\n"), "t1", override);
  if (!result) assert.fail("parseRolloutContent returned null");
  return result.prompts.map((p) => p.metadata?.model);
}

describe("parseRolloutContent — the prompt model", () => {
  it("takes the model each turn_context names", () => {
    const got = models([meta, turn("gpt-5.5"), user("2026-04-01T10:00:00Z", "a"), done("2026-04-01T10:00:05Z"), turn("gpt-5.2"), user("2026-04-01T10:01:00Z", "b"), done("2026-04-01T10:01:05Z")]);
    assert.deepEqual(got, ["gpt-5.5", "gpt-5.5", "gpt-5.2", "gpt-5.2"]);
  });

  it("never stamps the provider string when no model is named", () => {
    const got = models([meta, turn(), user("2026-04-01T10:00:00Z", "a"), done("2026-04-01T10:00:05Z")]);
    assert.ok(got.every((m) => m !== "openai"), JSON.stringify(got));
  });

  it("keeps the thread's own model as the authority", () => {
    const got = models([meta, turn("gpt-5.5"), user("2026-04-01T10:00:00Z", "a"), done("2026-04-01T10:00:05Z")], "o4-mini");
    assert.deepEqual(got, ["o4-mini", "o4-mini"]);
  });
});
