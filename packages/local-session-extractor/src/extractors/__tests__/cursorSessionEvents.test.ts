// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cursorOutcomeOf, cursorToolSummary } from "../../internal";

// The status vocabulary below is the one measured across 3,000 real Cursor bubbles:
// completed / error / cancelled. An earlier comment in the extractor claimed "errored", which
// no real row uses — the mapping is what types a check's verdict, so the spelling is
// load-bearing rather than descriptive.
//
// This is the LIFECYCLE mapping alone: `completed` says the tool ran, which for a terminal tool
// is not the same as the command having succeeded. What a tool call's outcome actually resolves
// to is `cursorToolOutcome` — exit code first — asserted in cursorToolPayload.test.ts.
describe("cursor status maps to the shared outcome", () => {
  it("maps the vocabulary real sessions actually use", () => {
    assert.equal(cursorOutcomeOf("completed"), "SESSION_EVENT_OUTCOME_SUCCEEDED");
    assert.equal(cursorOutcomeOf("error"), "SESSION_EVENT_OUTCOME_FAILED");
    assert.equal(cursorOutcomeOf("cancelled"), "SESSION_EVENT_OUTCOME_CANCELLED");
  });

  it("refuses to invent a pass out of silence", () => {
    // A consumer reads a result's outcome as a check's verdict, so an unrecognised or absent
    // status must not satisfy a correction bar nothing verified.
    assert.equal(cursorOutcomeOf(undefined), "SESSION_EVENT_OUTCOME_UNKNOWN");
    assert.equal(cursorOutcomeOf("errored"), "SESSION_EVENT_OUTCOME_UNKNOWN");
    assert.equal(cursorOutcomeOf(""), "SESSION_EVENT_OUTCOME_UNKNOWN");
  });
});

describe("a tool call is summarised by what it acted on", () => {
  it("prefers the argument that names the work", () => {
    // Without a summary a consumer has only the tool NAME, so every read_file collapses
    // to one identity and unrelated work groups into a fabricated loop.
    assert.equal(cursorToolSummary({ name: "read_file", params: { path: "a.ts" } }), "a.ts");
    assert.equal(
      cursorToolSummary({ name: "edit_file", params: { target_file: "auth/session.go" } }),
      "auth/session.go"
    );
    assert.equal(
      cursorToolSummary({ name: "run_terminal_cmd", params: { command: "pnpm test" } }),
      "pnpm test"
    );
  });

  it("follows the key preference order rather than whatever key comes first", () => {
    // target_file outranks command, so a tool carrying both names the file it edited.
    assert.equal(
      cursorToolSummary({ name: "edit_file", params: { command: "x", target_file: "b.ts" } }),
      "b.ts"
    );
  });

  it("names nothing when no argument names the work", () => {
    assert.equal(cursorToolSummary({ name: "read_file", params: {} }), undefined);
    assert.equal(cursorToolSummary({ name: "read_file" }), undefined);
    assert.equal(cursorToolSummary(undefined), undefined);
    // A body is not a name. Cursor puts file contents on other keys and none of them are read.
    assert.equal(
      cursorToolSummary({ name: "edit_file", params: { code_edit: "package main" } }),
      undefined
    );
  });
});
