// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../../store/SessionStore";
import { extractCursor } from "../../internal";
import { cursorExitCode, cursorStatusEffect, cursorToolOutcome } from "../../internal";
import type { SessionEvent } from "../../internal";
import { DatabaseSync } from "node:sqlite";
import { setPathOverrides } from "../pathResolver";

/**
 * Two readings of Cursor's tool payload that the data does not support, covered together because
 * they are the same mistake: a field assumed rather than measured, with a fixture written from the
 * same assumption so the suite agreed with the code while both disagreed with Cursor.
 *
 * The shapes below are the ones a real store carries. Sources, since the field names are the whole
 * point:
 *
 *   · `toolFormerData.result` is a JSON-encoded STRING whose terminal-tool form is
 *     `{"output":"…stdout…","exitCode":N,"exitCodeV2":N}` — recorded verbatim off
 *     `bubbleId:…:800340e0` (probe of
 *     19,975 bubbles; `result` present on 8,523, 2,017 of them terminal). That bubble is also the
 *     bug: `status: "completed"` beside `exitCode: 1`.
 *   · `exitCodeV2` is the field current Cursor writes (3,178 bubbles) and `exitCode` the older one
 *     on a tail (71).
 *   · the status vocabulary is `completed` 21,757 / absent 7,291 / `error` 720 / `cancelled` 62 /
 *     `loading` 9 over 29,839 tool bubbles, and `errored` — the value the replaced branch tested —
 *     never occurs.
 *
 * Values are synthesised; only the key names, nesting and encoding come from the capture. The one
 * shape that could not be re-measured is noted here: the IDE store had been removed
 * from the authoring machine, so the counts above are the recorded probe rather than a fresh run.
 */

/** A terminal result exactly as Cursor encodes one: a JSON string, output beside the code. */
const terminalResult = (output: string, exitCodeV2: number): string =>
  JSON.stringify({ output, exitCodeV2 });

describe("a terminal tool's outcome is its exit code, not its lifecycle status", () => {
  it("reads a nonzero exit as FAILED even though Cursor says completed", () => {
    // Cursor marks a terminal bubble "completed" even when its command exited nonzero. A consumer
    // reads this outcome over the model's own claim, so a failed run must not read as a success.
    assert.equal(
      cursorToolOutcome({
        name: "run_terminal_cmd",
        status: "completed",
        result: terminalResult("FAIL src/session.test.ts\n", 1),
      }),
      "SESSION_EVENT_OUTCOME_FAILED"
    );
    assert.equal(
      cursorToolOutcome({
        name: "run_terminal_command_v2",
        status: "completed",
        result: terminalResult("command not found\n", 127),
      }),
      "SESSION_EVENT_OUTCOME_FAILED"
    );
  });

  it("reads exit 0 as SUCCEEDED", () => {
    assert.equal(
      cursorToolOutcome({
        name: "run_terminal_cmd",
        status: "completed",
        result: terminalResult("ok\n", 0),
      }),
      "SESSION_EVENT_OUTCOME_SUCCEEDED"
    );
  });

  it("refuses to pass a terminal command whose exit code it could not observe", () => {
    // 342 completed terminal bubbles carry no exit code at all. Defaulting those to success is
    // the same bug in a new costume — an unobserved command is UNKNOWN.
    assert.equal(
      cursorToolOutcome({ name: "run_terminal_cmd", status: "completed" }),
      "SESSION_EVENT_OUTCOME_UNKNOWN"
    );
    assert.equal(
      cursorToolOutcome({ name: "run_terminal_cmd", status: "completed", result: "{}" }),
      "SESSION_EVENT_OUTCOME_UNKNOWN"
    );
  });

  it("still lets a non-terminal tool's status stand", () => {
    // A regression guard rather than a fix: an edit or a read has no exit code and never had one,
    // so withholding success from every tool in Cursor would have destroyed the signal this
    // change exists to make trustworthy.
    assert.equal(
      cursorToolOutcome({ name: "edit_file", status: "completed" }),
      "SESSION_EVENT_OUTCOME_SUCCEEDED"
    );
  });

  it("keeps the statuses that do not manufacture a pass", () => {
    // error and cancelled are already honest about the tool, and a terminal tool the user stopped
    // is more precisely CANCELLED than UNKNOWN — the exit-code guard only withholds SUCCESS.
    assert.equal(
      cursorToolOutcome({ name: "run_terminal_cmd", status: "error" }),
      "SESSION_EVENT_OUTCOME_FAILED"
    );
    assert.equal(
      cursorToolOutcome({ name: "run_terminal_cmd", status: "cancelled" }),
      "SESSION_EVENT_OUTCOME_CANCELLED"
    );
    assert.equal(
      cursorToolOutcome({ name: "run_terminal_cmd", status: "loading" }),
      "SESSION_EVENT_OUTCOME_UNKNOWN"
    );
    assert.equal(cursorToolOutcome(undefined), "SESSION_EVENT_OUTCOME_UNKNOWN");
  });

  it("prefers exitCodeV2 and falls back to the older exitCode", () => {
    assert.equal(cursorExitCode(JSON.stringify({ output: "x", exitCode: 3 })), 3);
    assert.equal(
      cursorExitCode(JSON.stringify({ output: "x", exitCode: 0, exitCodeV2: 2 })),
      2,
      "the field current Cursor writes wins over the historical one"
    );
    assert.equal(cursorExitCode(JSON.stringify({ output: "x" })), null);
    assert.equal(cursorExitCode(undefined), null);
    assert.equal(cursorExitCode(""), null);
    assert.equal(cursorExitCode("{not json"), null, "a malformed result must not throw");
  });

  it("does not mistake an exit code printed by the command for the command's own", () => {
    // stdout is JSON-escaped inside the result, so a top-level key is the only unescaped one.
    // Without that distinction a build log that prints this shape decides its own verdict.
    const result = JSON.stringify({ output: 'child reported {"exitCodeV2": 1}\n', exitCodeV2: 0 });
    assert.equal(cursorExitCode(result), 0);
  });

  it("finds the exit code however large the captured output is", () => {
    // Terminal output runs to megabytes for a build log, and a failing build is exactly the case
    // whose exit code must survive. This is why the code is scanned for rather than JSON-parsed
    // behind the size cap the neighbouring output reader needs.
    const huge = terminalResult("x".repeat(1_000_000), 2);
    assert.ok(huge.length > 512_000, "the fixture has to exceed the parse cap to prove anything");
    assert.equal(cursorExitCode(huge), 2);
  });
});

describe("a tool status counts toward the rollup Cursor's own vocabulary supports", () => {
  it("counts the error spelling Cursor writes", () => {
    // The replaced branch tested "errored", which occurs zero times in 29,839 tool bubbles, so
    // tool_errors was always 0 and 720 real errors per store went uncounted.
    assert.equal(cursorStatusEffect("error"), "tool_error");
    assert.equal(cursorStatusEffect("errored"), "none");
  });

  it("treats a stopped tool as an interruption rather than an error", () => {
    assert.equal(cursorStatusEffect("cancelled"), "user_interruption");
  });

  it("counts neither for the states that are not failures", () => {
    // Absent is the second most common state at 7,291. Counting it would replace an always-zero
    // with an always-inflated, which is the worse of the two errors.
    assert.equal(cursorStatusEffect(undefined), "none");
    assert.equal(cursorStatusEffect(""), "none");
    assert.equal(cursorStatusEffect("completed"), "none");
    assert.equal(cursorStatusEffect("loading"), "none");
  });
});

// The wiring, on the walk that actually runs. Both mappings live one call away from the loop that
// builds the timeline and the session-meta rollup, and a unit test of either says nothing about
// whether the loop still calls it with the whole payload.

describe("the extracted session carries the exit-code verdict", () => {

  /**
   * One session's bubbles: a user turn, then four tool calls covering the payloads that decide
   * an outcome. Structure follows the captured shape — a tool bubble's `text` key is always
   * present and always blank, and `parseBubbleData` drops a bubble that has neither `text` nor
   * `rawText`, so omitting it would make the bubble invisible and assert nothing.
   */
  const BUBBLES: Array<{
    type: 1 | 2;
    text?: string;
    tool?: { name: string; status?: string; result?: string };
  }> = [
    { type: 1, text: "user turn" },
    {
      type: 2,
      tool: {
        name: "run_terminal_cmd",
        status: "completed",
        result: terminalResult("2 tests failed\n", 1),
      },
    },
    {
      type: 2,
      tool: { name: "run_terminal_cmd", status: "completed", result: terminalResult("ok\n", 0) },
    },
    // A completed terminal call with no result at all — the 342-bubble case.
    { type: 2, tool: { name: "run_terminal_cmd", status: "completed" } },
    // The status that carries a real tool error, and the only spelling Cursor uses for one.
    { type: 2, tool: { name: "edit_file", status: "error" } },
  ];

  const buildStore = (path: string, composerId: string, lastUpdatedAt: number): void => {
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);");
    const ins = raw.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)");
    ins.run(
      `composerData:${composerId}`,
      JSON.stringify({
        composerId,
        createdAt: lastUpdatedAt - 60_000,
        lastUpdatedAt,
        name: "Exit code session",
        fullConversationHeadersOnly: BUBBLES.map((b, i) => ({ bubbleId: `b${i}`, type: b.type })),
        modelConfig: { modelName: "claude-sonnet-4-6" },
      })
    );
    BUBBLES.forEach((b, i) => {
      const bubble: Record<string, unknown> = {
        bubbleId: `b${i}`,
        type: b.type,
        text: b.text ?? "",
      };
      if (b.tool) {
        bubble["toolFormerData"] = {
          name: b.tool.name,
          toolCallId: `call-${i}`,
          ...(b.tool.status === undefined ? {} : { status: b.tool.status }),
          ...(b.tool.result === undefined ? {} : { result: b.tool.result }),
          // Both arg fields arrive JSON-ENCODED on real bubbles (22,438 of 22,548), and both are
          // populated on nearly all of them. `command` is spelled the same in each.
          params: JSON.stringify({ command: "pnpm test" }),
          rawArgs: JSON.stringify({ command: "pnpm test" }),
        };
      }
      ins.run(`bubbleId:${composerId}:b${i}`, JSON.stringify(bubble));
    });
    raw.close();
  };

  let tmpDir: string;
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-cursor-exit-"));
    // Without this the authoring machine's own ~/.cursor CLI history is extracted too and the
    // row count stops being about this fixture.
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: join(tmpDir, "no-cli-chats") });
  });
  after(() => {
    setPathOverrides({ CURSOR_DB_PATH: undefined });
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("stamps FAILED on the nonzero exit and UNKNOWN on the unobserved one", async () => {
    const composerId = "exit-code-outcome";
    const cursorDbPath = join(tmpDir, "exit.vscdb");
    buildStore(cursorDbPath, composerId, Date.now() - 60_000);
    const db = new SessionStore(join(tmpDir, "exit-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });

    assert.equal(await extractCursor(db), 1, "the composer must be stored");

    const row = db
      .raw()
      .prepare(
        "SELECT session_events, session_meta FROM conversations WHERE ide_type = 'cursor' AND session_id = ?"
      )
      .get(composerId) as { session_events: string | null; session_meta: string | null };

    assert.ok(row.session_events, "a session with a user turn must store a timeline");
    const results = (JSON.parse(row.session_events) as SessionEvent[])
      .filter((e) => e.kind === "SESSION_EVENT_KIND_TOOL_RESULT")
      .sort((a, b) => a.sequence - b.sequence);

    assert.deepEqual(
      results.map((r) => r.outcome),
      [
        "SESSION_EVENT_OUTCOME_FAILED",
        "SESSION_EVENT_OUTCOME_SUCCEEDED",
        "SESSION_EVENT_OUTCOME_UNKNOWN",
        "SESSION_EVENT_OUTCOME_FAILED",
      ],
      "in bubble order: exit 1, exit 0, no exit code, status error"
    );
  });

  it("counts the error status into the session-meta rollup", async () => {
    const composerId = "tool-error-rollup";
    const cursorDbPath = join(tmpDir, "rollup.vscdb");
    buildStore(cursorDbPath, composerId, Date.now() - 60_000);
    const db = new SessionStore(join(tmpDir, "rollup-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });

    assert.equal(await extractCursor(db), 1);

    const row = db
      .raw()
      .prepare("SELECT session_meta FROM conversations WHERE ide_type = 'cursor' AND session_id = ?")
      .get(composerId) as { session_meta: string | null };

    assert.ok(row.session_meta, "the rollup travels in session_meta");
    const meta = JSON.parse(row.session_meta) as {
      tool_errors?: number;
      tool_error_categories?: Record<string, number>;
      user_interruptions?: number;
    };

    // Omitted entirely while the branch tested a value Cursor never writes: `tool_errors` is only
    // set when it is above zero, so the assertion is on the field existing at all.
    assert.equal(meta.tool_errors, 1, "the one error-status bubble is counted");
    assert.deepEqual(meta.tool_error_categories, { error: 1 }, "keyed by Cursor's own spelling");
    assert.equal(meta.user_interruptions, undefined, "nothing here was cancelled");
  });
});
