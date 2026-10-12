// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A Cursor tool call's argument preview, IDE and CLI, is redacted before it is cut
 * to 160 characters: a token straddling the cut is masked whole, never kept as a
 * fragment too short for its pattern to recognise once the content is redacted.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPrompts, formatToolCall, parseCliBlobs } from "../../internal";
import { redactText } from "../../redaction";

const M = "████████";
const TOKEN = "ghp_0123456789abcdefghij0123456789abcdef"; // fake credential, test fixture. gitleaks:allow
/** The token starts at character 151, so a raw cut at 160 keeps `ghp_01234`. */
const COMMAND = `${"x".repeat(150)} ${TOKEN} && echo done ${"y".repeat(40)}`;
const PREVIEW = `${"x".repeat(150)} ${M} && echo done ${"y".repeat(40)}`.slice(0, 160) + "…";

describe("Cursor tool-call previews — redacted, then cut", () => {
  it("masks a token straddling the cut in an IDE tool call", () => {
    const { content } = formatToolCall({ name: "run_terminal_cmd", status: "completed", rawArgs: JSON.stringify({ command: COMMAND }) });
    assert.equal(content, `[Tool: run_terminal_cmd command=${PREVIEW}]`);
    assert.ok(!redactText(content).includes("ghp_"), redactText(content));
  });

  it("masks a token straddling the cut in a CLI tool call", () => {
    const blob = Buffer.from(
      JSON.stringify({ role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "Shell", args: { command: COMMAND } }] }),
      "utf8",
    );
    const contents = buildPrompts(parseCliBlobs([{ data: blob }]), undefined).map((p) => p.content);
    assert.deepEqual(contents, [`[Tool: Shell command=${PREVIEW}]`]);
  });

  it("keeps a value under the cut as it was, for the content's own redaction", () => {
    const { content } = formatToolCall({ name: "run_terminal_cmd", status: "completed", rawArgs: JSON.stringify({ command: `echo ${TOKEN}` }) });
    assert.equal(content, `[Tool: run_terminal_cmd command=echo ${TOKEN}]`);
  });
});
