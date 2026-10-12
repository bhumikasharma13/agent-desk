// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A Claude Code session's thinking blocks and tool results are not stored: the conversation keeps
 * the text and a `[Tool: <name>]` marker for each call, nothing else.
 */
import { after, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../store/SessionStore";
import { extractClaudeCode } from "../../internal";
import { setPathOverrides } from "../pathResolver";

const dir = mkdtempSync(join(tmpdir(), "lse-cc-hidden-"));
after(() => {
  setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: undefined });
  rmSync(dir, { recursive: true, force: true });
});

it("stores no thinking and no tool result text", () => {
  const projects = join(dir, "projects");
  mkdirSync(join(projects, "project_hidden"), { recursive: true });
  const at = (s: number) => `2026-04-01T10:00:${String(s).padStart(2, "0")}.000Z`;
  const lines = [
    { type: "user", uuid: "u1", timestamp: at(0), sessionId: "hidden1", message: { role: "user", content: "Why is the total off?" } },
    {
      type: "assistant", uuid: "a1", timestamp: at(5), sessionId: "hidden1",
      message: {
        id: "m1", role: "assistant", model: "claude-sonnet-4-6",
        content: [
          { type: "thinking", thinking: "PRIVATE-THINKING-TEXT", signature: "sig" },
          { type: "text", text: "Reading the cart." },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/w/cart.ts" } },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
    {
      type: "user", uuid: "u2", timestamp: at(6), sessionId: "hidden1",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "TOOL-RESULT-TEXT from cart.ts" }] },
    },
    { type: "assistant", uuid: "a2", timestamp: at(9), sessionId: "hidden1", message: { id: "m2", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "Floats." }], usage: { input_tokens: 10, output_tokens: 5 } } },
  ];
  writeFileSync(join(projects, "project_hidden", "hidden1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: projects });
  const db = new SessionStore(join(dir, "s.db"));
  try {
    extractClaudeCode(db);
    const rows = db.listConversations({ ideType: "claude-code" });
    assert.equal(rows.length, 1);
    const stored = rows[0]!.conversation;
    assert.ok(stored.includes("Reading the cart.") && stored.includes("[Tool: Read]") && stored.includes("Floats."), stored);
    assert.ok(!stored.includes("PRIVATE-THINKING-TEXT"), "thinking is not stored");
    assert.ok(!stored.includes("TOOL-RESULT-TEXT"), "a tool result is not stored");
  } finally {
    db.close();
  }
});
