// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { redactText } from "../../internal";
import { SessionEventBuilder, promptReferenceAuthor, promptAuthorship, type TimelineLine } from "../../internal";
import { invokedCommandArgs, invokedCommandName, isInjectedUserMarkup } from "../../internal";
import { userInfo } from "node:os";

const AT = "2026-05-10T12:00:00.000Z";

/**
 * Command turns, copied verbatim out of transcripts under ~/.claude/projects.
 *
 * Two orderings occur and both are real: a built-in leads with `<command-name>` and
 * indents the following tags; a project command leads with `<command-message>`. Across
 * 1328 transcripts every one of the 68 command turns carried this markup and NONE was a
 * bare `/name`, so a fixture that starts with a literal slash tests a shape Claude Code
 * does not write.
 */
const REAL = {
  loop: "<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>Keep going until the feature is built and tested.</command-args>",
  goal: "<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>Keep reviewing the design until every open question is answered.</command-args>",
  // A scheduled `/loop`, in the same markup. The argument form is rule 1 of Claude Code's own
  // `/loop` definition (`5m /babysit-prs` -> interval `5m`).
  scheduledLoop:
    "<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>5m /babysit-prs</command-args>",
  namedCommand: "<command-message>deploy-app</command-message>\n<command-name>/deploy-app</command-name>",
  model: "<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args></command-args>",
  // The one bare-slash shape real transcripts do contain: a command relayed as plain text.
  bareCommand: "/run-checks",
  // A stderr paste that opens with an absolute path — the bare-slash form's false friend.
  pastedPath:
    "/Users/redacted/src/example-repo/scripts/eval.py:36: FutureWarning:",
  // A local-command-stdout turn: Claude Code injects a local command's output as a user turn.
  // The marker shape Claude Code writes. These carry no isMeta, so authorship must recognise them
  // from the content.
  localStdout: "<local-command-stdout>Set model to Opus 5 (1M context) and saved as your default.</local-command-stdout>",
  // A task-notification envelope: the harness injects a background task's completion (here wrapping
  // a sub-agent result) as a user turn. Main-session and no isMeta, so authorship must recognise it
  // from the content.
  taskNotification:
    "<task-notification>\n<task-id>a1b2c3</task-id>\n<result>the sub-agent found 3 issues</result>\n</task-notification>",
} as const;

/** A command turn: real transcripts store `message.content` as a plain string, not blocks. */
function commandTurn(text: string): TimelineLine {
  return { type: "user", message: { content: text } };
}

function userLine(text: string): TimelineLine {
  return { type: "user", message: { content: [{ type: "text", text }] } };
}

function toolUseLine(name: string, id: string, input?: Record<string, unknown>): TimelineLine {
  return { type: "assistant", message: { content: [{ type: "tool_use", name, id, input }] } };
}

function toolResultLine(toolUseId: string, isError: boolean, text: string): TimelineLine {
  return {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: isError, content: text }] },
  };
}

describe("invokedCommandName", () => {
  it("reads the markup Claude Code actually stores, in either tag order", () => {
    assert.equal(invokedCommandName(REAL.loop), "loop");
    assert.equal(invokedCommandName(REAL.goal), "goal");
    assert.equal(invokedCommandName(REAL.namedCommand), "deploy-app");
    assert.equal(invokedCommandName(REAL.model), "model");
  });

  it("reads the bare-slash form, normalized", () => {
    assert.equal(invokedCommandName(REAL.bareCommand), "run-checks");
    assert.equal(invokedCommandName("  /deploy-app"), "deploy-app");
    assert.equal(invokedCommandName("/Loop"), "loop");
  });

  it("ignores a mention, in either form", () => {
    // A command referred to is not a command invoked; conflating the two would inflate
    // declared adoption. The markup half is not hypothetical — the tag appears far more
    // often quoted inside user turns than opening one.
    assert.equal(invokedCommandName("you should try /loop here"), undefined);
    assert.equal(
      invokedCommandName("`sessionEvents.ts` never sees <command-name>/loop</command-name> today."),
      undefined,
    );
  });

  it("ignores slashes that are not commands", () => {
    assert.equal(invokedCommandName("/ leading space"), undefined);
    assert.equal(invokedCommandName(REAL.pastedPath), undefined);
    assert.equal(invokedCommandName("no slash at all"), undefined);
  });
});

// The arguments decide what KIND of loop a `/loop` is — `5m …` arms a fixed schedule, prose
// self-paces — and the command name cannot tell the two apart. So the arguments have to survive
// onto the wire, and reading them out of both stored shapes is what makes that possible.
describe("invokedCommandArgs", () => {
  it("reads the arguments out of the markup Claude Code stores", () => {
    assert.equal(
      invokedCommandArgs(REAL.loop),
      "Keep going until the feature is built and tested.",
    );
    assert.equal(invokedCommandArgs(REAL.scheduledLoop), "5m /babysit-prs");
  });

  it("reports no arguments for a command that took none", () => {
    // An empty tag and an absent tag are the same fact and must not differ.
    assert.equal(invokedCommandArgs(REAL.model), "");
    assert.equal(invokedCommandArgs(REAL.namedCommand), "");
    assert.equal(invokedCommandArgs(REAL.bareCommand), "");
  });

  it("reads the arguments of a bare-slash invocation", () => {
    // Cursor stores the text typed, so this is the shape its `/loop` arrives in.
    assert.equal(invokedCommandArgs("/loop 5m check the deploy"), "5m check the deploy");
  });

  it("reports nothing for a turn that only MENTIONS a command", () => {
    // Gated on the same anchor as the name: reading arguments off a mention would attribute a
    // quoted example's text to an invocation nobody made.
    assert.equal(invokedCommandArgs("you should try /loop 5m here"), "");
    assert.equal(invokedCommandArgs(REAL.pastedPath), "");
    assert.equal(invokedCommandArgs("no slash at all"), "");
  });

  it("keeps a trailing schedule clause that a head-only cut would drop", () => {
    // A consumer reads this field as the invocation, and a trailing `every <N><unit>` is what
    // makes a loop time-based rather than self-paced. A head-only bound loses it silently — real
    // invocations do run past the cap, so this is reachable rather than theoretical.
    const long = "refactor the extraction layer ".repeat(20).trim();
    const b = new SessionEventBuilder();
    b.addMessageEvents(commandTurn(`/loop ${long} every 30m`), AT);

    const [ev] = b.build().filter((e) => e.kind === "SESSION_EVENT_KIND_COMMAND");
    const summary = ev?.redacted_summary ?? "";
    assert.ok(summary.length > 0, "the invocation must carry a summary");
    assert.ok(
      /every 30m$/.test(summary),
      `the schedule clause must survive the bound, got: ${JSON.stringify(summary)}`,
    );
    // Still bounded — the head-and-tail split spends the same budget, it does not raise it.
    assert.ok(
      Array.from(summary).length <= 200,
      `summary must stay within the cap, got ${Array.from(summary).length}`,
    );
    assert.ok(summary.startsWith("refactor the extraction layer"), "the objective still leads");
  });

  it("leaves a short invocation untouched by the head-and-tail split", () => {
    const b = new SessionEventBuilder();
    b.addMessageEvents(commandTurn("/loop 5m /babysit-prs"), AT);
    const [ev] = b.build().filter((e) => e.kind === "SESSION_EVENT_KIND_COMMAND");
    assert.equal(ev?.redacted_summary, "5m /babysit-prs");
  });
});

describe("SessionEventBuilder", () => {
  it("references prompts by ordinal without copying their text", () => {
    const b = new SessionEventBuilder();
    b.addPromptReference(1, AT, "SESSION_EVENT_AUTHOR_HUMAN");
    b.addPromptReference(2, AT, "SESSION_EVENT_AUTHOR_HUMAN");

    const events = b.build();
    assert.equal(events.length, 2);
    assert.equal(events[0]!.kind, "SESSION_EVENT_KIND_PROMPT_REFERENCE");
    assert.equal(events[0]!.prompt_ordinal, 1);
    assert.equal(events[1]!.prompt_ordinal, 2);
    // The privacy boundary: a prompt reference must never carry message text.
    for (const ev of events) {
      assert.equal(ev.redacted_summary, undefined);
    }
  });

  it("addApiRetry emits an API_RETRY carrying the source and attempt, never the raw error", () => {
    // Claude Code's `system/api_error` retry record; the emitter keeps source +
    // attempt (structured) and must never surface the free-text `error` field.
    const b = new SessionEventBuilder();
    b.addApiRetry({ source: "request_retry", retryAttempt: 1, maxRetries: 10, at: AT });

    const [ev] = b.build().filter((e) => e.kind === "SESSION_EVENT_KIND_API_RETRY");
    assert.ok(ev, "expected an API_RETRY event");
    assert.equal(ev.operation_name, "request_retry");
    // SUCCEEDED, never FAILED — a positional marker must not feed a consumer's
    // outcome-generic discard ledger (which reads FAILED as abandoned work).
    assert.equal(ev.outcome, "SESSION_EVENT_OUTCOME_SUCCEEDED");
    assert.equal(ev.redacted_summary, "attempt 1 of 10");
  });

  it("addApiRetry omits the attempt summary when the record lacks the counts", () => {
    const b = new SessionEventBuilder();
    b.addApiRetry({ source: "connection_retry", retryAttempt: undefined, maxRetries: undefined, at: AT });

    const [ev] = b.build().filter((e) => e.kind === "SESSION_EVENT_KIND_API_RETRY");
    assert.ok(ev, "expected an API_RETRY event");
    assert.equal(ev.operation_name, "connection_retry");
    assert.equal(ev.redacted_summary, undefined);
  });

  it("stamps who authored each prompt reference", () => {
    // The autonomy bar reads this field and nothing else, so a reference must say whose turn
    // it was. An adapter that emitted only the kind left every turn looking like a person's.
    const b = new SessionEventBuilder();
    b.addPromptReference(1, AT, promptReferenceAuthor({ role: "user" }));
    b.addPromptReference(2, AT, promptReferenceAuthor({ role: "assistant" }));
    b.addPromptReference(
      3,
      AT,
      promptReferenceAuthor({ role: "user", metadata: { isSubAgent: true } })
    );

    assert.deepEqual(
      b.build().map((e) => e.author),
      [
        "SESSION_EVENT_AUTHOR_HUMAN",
        "SESSION_EVENT_AUTHOR_AGENT",
        // A folded sub-agent turn wears the user role but is the machine — reading it as a
        // person would delete every autonomous run on such a surface.
        "SESSION_EVENT_AUTHOR_DELEGATED_AGENT",
      ]
    );
  });

  it("does not stamp a harness-injected turn as a person", () => {
    // Claude injects local-command caveats, resume reminders and command output as `user` turns.
    // They carry text, so they reach the prompt list and get a reference — and the caveat's own
    // text says "DO NOT respond to these messages". Reading one as human lets a line the person
    // never typed disqualify a run's autonomy, and a consumer trusts this stamp over the prompt
    // list, so there is no later correction for it.
    const b = new SessionEventBuilder();
    b.addPromptReference(1, AT, promptReferenceAuthor({ role: "user" }, { injected: true }));
    // The same turn NOT injected is a real person — without this the case above would pass
    // against a derivation that never returned HUMAN at all.
    b.addPromptReference(2, AT, promptReferenceAuthor({ role: "user" }, { injected: false }));
    // `injected` beats the role, because the role is what makes an injected turn look human.
    b.addPromptReference(3, AT, promptReferenceAuthor({ role: "assistant" }, { injected: true }));

    assert.deepEqual(
      b.build().map((e) => e.author),
      [
        "SESSION_EVENT_AUTHOR_AGENT",
        "SESSION_EVENT_AUTHOR_HUMAN",
        "SESSION_EVENT_AUTHOR_AGENT",
      ]
    );
  });

  it("leaves the author off events that are not turns", () => {
    // The field answers "who spoke", and a tool call is not a turn — its actor is already
    // implied by the kind. Stamping one would make a COMMAND event indistinguishable from a
    // human's message to a reader that only checks the author.
    const b = new SessionEventBuilder();
    b.addMessageEvents(toolUseLine("Bash", "call-1", { command: "go test ./..." }), AT);
    b.addMessageEvents(toolResultLine("call-1", false, "ok"), AT);

    for (const ev of b.build()) {
      assert.equal(ev.author, undefined, `${ev.kind} must carry no author`);
    }
  });

  it("assigns a contiguous one-based sequence in source order", () => {
    const b = new SessionEventBuilder();
    b.addPromptReference(1, AT, "SESSION_EVENT_AUTHOR_HUMAN");
    b.addMessageEvents(toolUseLine("Bash", "call-1", { command: "go test ./..." }), AT);
    b.addMessageEvents(toolResultLine("call-1", false, "ok"), AT);

    assert.deepEqual(b.build().map((e) => e.sequence), [1, 2, 3]);
  });

  it("marks a failing tool result FAILED and links it to its call", () => {
    const b = new SessionEventBuilder();
    b.addMessageEvents(toolUseLine("Bash", "call-1", { command: "go test ./..." }), AT);
    b.addMessageEvents(toolResultLine("call-1", true, "FAIL TestRetry"), AT);

    const [call, result] = b.build();
    assert.equal(call!.kind, "SESSION_EVENT_KIND_TOOL_CALL");
    assert.equal(call!.call_id, "call-1");
    // A call's outcome is not knowable at call time; the paired result carries it.
    assert.equal(call!.outcome, "SESSION_EVENT_OUTCOME_UNKNOWN");
    assert.equal(result!.outcome, "SESSION_EVENT_OUTCOME_FAILED");
    assert.equal(result!.parent_call_id, "call-1");
  });

  it("treats delegation as a skill call named for the agent", () => {
    const b = new SessionEventBuilder();
    b.addMessageEvents(toolUseLine("Task", "call-1", { subagent_type: "code-reviewer" }), AT);

    const [ev] = b.build();
    assert.equal(ev!.kind, "SESSION_EVENT_KIND_SKILL_CALL");
    assert.equal(ev!.operation_name, "code-reviewer");
  });

  it("emits a typed COMMAND for /loop and a SKILL_CALL for other commands", () => {
    const b = new SessionEventBuilder();
    b.addMessageEvents(commandTurn(REAL.loop), AT);
    b.addMessageEvents(commandTurn(REAL.namedCommand), AT);

    const [loopEv, skillEv] = b.build();
    assert.equal(loopEv!.kind, "SESSION_EVENT_KIND_COMMAND");
    assert.equal(loopEv!.operation_name, "loop");
    assert.equal(skillEv!.kind, "SESSION_EVENT_KIND_SKILL_CALL");
    assert.equal(skillEv!.operation_name, "deploy-app");
  });

  // The two canonical loop commands are the whole point of the COMMAND event, and both
  // arrive as markup. A detector that only reads a literal leading `/` sees a turn
  // starting with `<`, emits nothing, and the feature observes zero declared loops while
  // every unit test passes.
  it("emits COMMAND for both canonical loop commands as transcripts store them", () => {
    const b = new SessionEventBuilder();
    b.addMessageEvents(commandTurn(REAL.loop), AT);
    b.addMessageEvents(commandTurn(REAL.goal), AT);

    const events = b.build();
    assert.deepEqual(
      events.map((e) => [e.kind, e.operation_name]),
      [
        ["SESSION_EVENT_KIND_COMMAND", "loop"],
        ["SESSION_EVENT_KIND_COMMAND", "goal"],
      ],
    );
  });

  it("declares nothing for a turn that merely quotes the markup", () => {
    const b = new SessionEventBuilder();
    b.addMessageEvents(
      userLine("The extractor already matches <command-name>/loop</command-name> for its label."),
      AT,
    );
    assert.deepEqual(b.build(), []);
  });

  it("summarizes only checker-tool results", () => {
    const b = new SessionEventBuilder();
    b.addMessageEvents(toolUseLine("Bash", "bash-1", { command: "go test" }), AT);
    b.addMessageEvents(toolResultLine("bash-1", false, "PASS\nlots of detail"), AT);
    b.addMessageEvents(toolUseLine("Read", "read-1", {}), AT);
    b.addMessageEvents(toolResultLine("read-1", false, "secret file contents"), AT);

    const events = b.build();
    // Only the first line, so a log dump never rides along.
    assert.equal(events[1]!.redacted_summary, "PASS");
    // A Read result would be file content for no detection benefit.
    assert.equal(events[3]!.redacted_summary, undefined);
  });

  it("redacts secrets out of a summary before it can leave the machine", () => {
    // These summaries are built from raw tool input and output, so redaction here is
    // the last line before the value hits local storage and the store — a consumer
    // re-redacting the stored excerpt is too late.
    const b = new SessionEventBuilder();
    b.addMessageEvents(
      toolUseLine("Bash", "call-1", { command: 'curl -H "Authorization: Bearer ghp_ABCDEFGHIJKLMNOP1234" https://api.example.com' }), // fake credential, test fixture. gitleaks:allow
      AT,
    );
    const summary = b.build()[0]!.redacted_summary ?? "";
    assert.ok(!summary.includes("ghp_ABCDEFGHIJKLMNOP1234"), `token survived redaction: ${summary}`);
  });

  it("keeps the newline that separates statements, and collapses everything else", () => {
    // A consumer splits a Bash summary into the statements a shell would run, and the
    // newline is one of its separators. Collapsing it into a space merges every line into
    // one statement judged by its first word — a `go test` on line two then reads as
    // carrying no verdict, and a `grep` on line one as carrying an independent pass.
    const b = new SessionEventBuilder();
    b.addMessageEvents(
      toolUseLine("Bash", "call-1", { command: 'echo   "running"  \n\n   go test ./...  ' }),
      AT,
    );
    // Expected goes through redactText too. The summary is redacted before it is
    // collapsed, and redactText anonymises the running user's name wherever it
    // appears — so a developer whose $USER happens to be a word in this fixture
    // (`test`) would otherwise see a false failure here. Comparing post-redaction
    // keeps the assertion about collapsing, which is what this test is for.
    assert.equal(
      b.build()[0]!.redacted_summary,
      redactText('echo "running"\ngo test ./...'),
    );
  });

  it("bounds a summary to the shared excerpt limit", () => {
    const b = new SessionEventBuilder();
    b.addMessageEvents(toolUseLine("Bash", "call-1", { command: "x".repeat(500) }), AT);
    assert.equal(b.build()[0]!.redacted_summary!.length, 200);
  });

  it("rates coverage from what it could actually observe", () => {
    // NONE: nothing observed at all.
    assert.equal(new SessionEventBuilder().coverage(), "EVENT_COVERAGE_NONE");

    // PARTIAL: prompts only — no actions, no checks.
    const promptsOnly = new SessionEventBuilder();
    promptsOnly.addPromptReference(1, AT, "SESSION_EVENT_AUTHOR_HUMAN");
    assert.equal(promptsOnly.coverage(), "EVENT_COVERAGE_PARTIAL");

    // PARTIAL: actions visible but no observable outcome, so no check can be proven
    // to have passed or failed — the session must stay out of observed rates.
    const noOutcome = new SessionEventBuilder();
    noOutcome.addPromptReference(1, AT, "SESSION_EVENT_AUTHOR_HUMAN");
    noOutcome.addMessageEvents(toolUseLine("Bash", "call-1", { command: "go test" }), AT);
    assert.equal(noOutcome.coverage(), "EVENT_COVERAGE_PARTIAL");

    // COMPLETE: both halves of a verify-correct cycle are observable.
    const complete = new SessionEventBuilder();
    complete.addPromptReference(1, AT, "SESSION_EVENT_AUTHOR_HUMAN");
    complete.addMessageEvents(toolUseLine("Bash", "call-1", { command: "go test" }), AT);
    complete.addMessageEvents(toolResultLine("call-1", false, "PASS"), AT);
    assert.equal(complete.coverage(), "EVENT_COVERAGE_COMPLETE");
  });

  it("reconstructs a full correction cycle in order", () => {
    // The shape free-form detection needs: action → failing check → correction →
    // passing re-check.
    const b = new SessionEventBuilder();
    b.addPromptReference(1, AT, "SESSION_EVENT_AUTHOR_HUMAN");
    b.addMessageEvents(toolUseLine("Edit", "edit-1", { description: "first attempt" }), AT);
    b.addMessageEvents(toolUseLine("Bash", "test-1", { command: "go test ./..." }), AT);
    b.addMessageEvents(toolResultLine("test-1", true, "FAIL TestRetry"), AT);
    b.addMessageEvents(toolUseLine("Edit", "edit-2", { description: "fix" }), AT);
    b.addMessageEvents(toolUseLine("Bash", "test-2", { command: "go test ./..." }), AT);
    b.addMessageEvents(toolResultLine("test-2", false, "ok"), AT);

    const events = b.build();
    assert.deepEqual(events.map((e) => e.kind), [
      "SESSION_EVENT_KIND_PROMPT_REFERENCE",
      "SESSION_EVENT_KIND_TOOL_CALL",
      "SESSION_EVENT_KIND_TOOL_CALL",
      "SESSION_EVENT_KIND_TOOL_RESULT",
      "SESSION_EVENT_KIND_TOOL_CALL",
      "SESSION_EVENT_KIND_TOOL_CALL",
      "SESSION_EVENT_KIND_TOOL_RESULT",
    ]);
    assert.equal(events[3]!.outcome, "SESSION_EVENT_OUTCOME_FAILED");
    assert.equal(events[6]!.outcome, "SESSION_EVENT_OUTCOME_SUCCEEDED");
    assert.equal(b.coverage(), "EVENT_COVERAGE_COMPLETE");
  });
});

describe("SessionEventBuilder — declaration boundaries", () => {
  // The `Skill` tool is how a skill is actually invoked. Emitted as a plain TOOL_CALL named
  // "Skill" the skill's identity is lost entirely, so a loop-capable skill was only ever
  // detected when a human happened to type `/name` as a slash command instead.
  it("surfaces a Skill tool call under the skill it invoked", () => {
    const b = new SessionEventBuilder();
    b.addMessageEvents(toolUseLine("Skill", "t1", { skill: "code-review" }), AT);

    const [ev] = b.build();
    assert.equal(ev!.kind, "SESSION_EVENT_KIND_SKILL_CALL");
    assert.equal(ev!.operation_name, "code-review");
  });

  it("falls back to the tool name when a Skill call names no skill", () => {
    const b = new SessionEventBuilder();
    b.addMessageEvents(toolUseLine("Skill", "t1", {}), AT);

    const [ev] = b.build();
    assert.equal(ev!.kind, "SESSION_EVENT_KIND_TOOL_CALL", "no skill named means no declaration");
    assert.equal(ev!.operation_name, "Skill");
  });

  it("still surfaces a Task delegation under its subagent type", () => {
    const b = new SessionEventBuilder();
    b.addMessageEvents(toolUseLine("Task", "t1", { subagent_type: "code-reviewer" }), AT);

    const [ev] = b.build();
    assert.equal(ev!.kind, "SESSION_EVENT_KIND_SKILL_CALL");
    assert.equal(ev!.operation_name, "code-reviewer");
  });
});

describe("SessionEventBuilder — summary keys name the work", () => {
  // A call whose input matches no summary key ships no summary, and a consumer then has
  // only the tool's NAME to describe it — so Edit/Read/Write all collapse to their own name
  // and the digest of that name groups unrelated runs into one fabricated "loop".
  it("summarizes a file-scoped tool from its path", () => {
    const b = new SessionEventBuilder();
    b.addMessageEvents(toolUseLine("Edit", "t1", { file_path: "consumer/loop.go", old_string: "a", new_string: "b" }), AT);

    const [ev] = b.build();
    assert.ok(ev!.redacted_summary, "an Edit must not ship summary-less");
    assert.match(ev!.redacted_summary!, /loop\.go/);
  });

  it("never ships file bodies or diffs", () => {
    const b = new SessionEventBuilder();
    b.addMessageEvents(
      toolUseLine("Write", "t1", { file_path: "secrets.md", content: "SUPER_SECRET_BODY_TEXT" }),
      AT,
    );

    const [ev] = b.build();
    assert.doesNotMatch(ev!.redacted_summary ?? "", /SUPER_SECRET_BODY_TEXT/);
  });

  it("prefers the skill name over a path on the same input", () => {
    const b = new SessionEventBuilder();
    b.addMessageEvents(toolUseLine("Skill", "t1", { skill: "deploy-app", file_path: "/tmp/x" }), AT);

    const [ev] = b.build();
    assert.equal(ev!.redacted_summary, "deploy-app");
  });
});

describe("SessionEventBuilder — coverage needs a legible majority", () => {
  // Read/Edit/Grep results carry no `is_error`; ~47% of results across real sessions have no
  // outcome at all. "At least one observable result" therefore admitted sessions that were
  // mostly dark into the denominator of the headline observed rate, as if fully read.
  it("rates a mostly-unobservable session PARTIAL even though one result reported", () => {
    const b = new SessionEventBuilder();
    b.addMessageEvents(toolUseLine("Bash", "t1", { command: "go test ./..." }), AT);
    b.addMessageEvents(toolResultLine("t1", false, "ok"), AT);
    // Four results with no outcome at all — the shape of a Read/Edit-heavy session.
    for (const id of ["t2", "t3", "t4", "t5"]) {
      b.addMessageEvents(toolUseLine("Read", id, { file_path: `f${id}.go` }), AT);
      b.addMessageEvents(
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "body" }] } },
        AT,
      );
    }
    assert.equal(b.coverage(), "EVENT_COVERAGE_PARTIAL");
  });

  it("rates a session COMPLETE when most results reported an outcome", () => {
    const b = new SessionEventBuilder();
    for (const id of ["t1", "t2", "t3"]) {
      b.addMessageEvents(toolUseLine("Bash", id, { command: "go build ./..." }), AT);
      b.addMessageEvents(toolResultLine(id, false, "ok"), AT);
    }
    b.addMessageEvents(toolUseLine("Read", "t4", { file_path: "f.go" }), AT);
    b.addMessageEvents(
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t4", content: "body" }] } },
      AT,
    );
    assert.equal(b.coverage(), "EVENT_COVERAGE_COMPLETE", "3 of 4 observable is a legible timeline");
  });

  it("rates exactly half observable COMPLETE — the boundary is inclusive", () => {
    const b = new SessionEventBuilder();
    b.addMessageEvents(toolUseLine("Bash", "t1", { command: "go test ./..." }), AT);
    b.addMessageEvents(toolResultLine("t1", true, "FAIL"), AT);
    b.addMessageEvents(toolUseLine("Read", "t2", { file_path: "f.go" }), AT);
    b.addMessageEvents(
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "body" }] } },
      AT,
    );
    assert.equal(b.coverage(), "EVENT_COVERAGE_COMPLETE");
  });
});

describe("SessionEventBuilder — widened summary keys stay redacted on egress", () => {
  // The summary is built from raw tool input and stored, so storing IS the raw value
  // leaving the machine — a later consumer pass cannot un-leak it. Adding path-shaped keys to
  // the summary list widens what that channel carries, so the redaction has to be pinned
  // rather than assumed. Built from the running user's real username so the assertion is
  // portable rather than hardcoded to one machine.
  it("never ships the real home segment of a file path", () => {
    const username = userInfo().username as string;
    if (username.length < 4) return; // bare-username anonymization is length-gated

    const b = new SessionEventBuilder();
    b.addMessageEvents(
      toolUseLine("Edit", "t1", { file_path: `/Users/${username}/src/secret-project/main.go` }),
      AT,
    );

    const [ev] = b.build();
    assert.ok(ev!.redacted_summary, "the path must still name the work");
    assert.doesNotMatch(ev!.redacted_summary!, new RegExp(username), "the real username must not leave the machine");
  });

  it("never ships a secret embedded in a command", () => {
    const b = new SessionEventBuilder();
    b.addMessageEvents(
      toolUseLine("Bash", "t1", { command: "curl -H 'Authorization: Bearer sk-ant-api03-AAAABBBBCCCCDDDD' https://x" }), // fake credential, test fixture. gitleaks:allow
      AT,
    );

    const [ev] = b.build();
    assert.doesNotMatch(ev!.redacted_summary ?? "", /sk-ant-api03-AAAABBBBCCCCDDDD/);
  });
});

describe("isInjectedUserMarkup", () => {
  it("flags a no-args command wrapper, stdout, and task-notification (machine content only)", () => {
    // Injected classes that carry no isMeta and no user content: a bare command wrapper with
    // empty args, local-command-stdout, and a task-notification envelope. Matched by the
    // stored-markup shape that OPENS the turn, never a mention.
    assert.equal(isInjectedUserMarkup(REAL.model), true); // <command-args></command-args>
    assert.equal(isInjectedUserMarkup(REAL.namedCommand), true); // no <command-args> tag
    assert.equal(isInjectedUserMarkup(REAL.localStdout), true);
    assert.equal(isInjectedUserMarkup(REAL.taskNotification), true);
  });

  it("does not flag a command whose <command-args> carry user-authored input", () => {
    // The person's args are their own prompt, so a command turn
    // WITH args is not wholly injected — it reads HUMAN, preserving the directive rather than
    // discarding it. Only the empty-args wrappers above are wholly machine.
    assert.equal(isInjectedUserMarkup(REAL.loop), false); // "Keep going until…"
    assert.equal(isInjectedUserMarkup(REAL.goal), false); // "Keep reviewing the design…"
    assert.equal(isInjectedUserMarkup(REAL.scheduledLoop), false); // "5m /babysit-prs"
  });

  it("does not flag human prose, a bare slash, or a merely-quoted marker", () => {
    assert.equal(isInjectedUserMarkup("lets raise a PR to master"), false);
    assert.equal(isInjectedUserMarkup("check the /model flag in the config please"), false);
    assert.equal(isInjectedUserMarkup(REAL.pastedPath), false);
    // A bare `/word` opening is human prose, not a stored command wrapper — a real command is
    // stored as <command-name> markup, so counting the bare form would erase a human turn.
    assert.equal(isInjectedUserMarkup(REAL.bareCommand), false);
    assert.equal(isInjectedUserMarkup("/cc @reviewer take a look"), false);
    // A human turn that merely QUOTES the stdout marker mid-prose is not an injected turn.
    assert.equal(
      isInjectedUserMarkup("why do I see <local-command-stdout> blocks in my transcript?"),
      false
    );
  });
});

describe("promptAuthorship", () => {
  it("reads a typed user turn as HUMAN and an injected one as INJECTED", () => {
    assert.equal(promptAuthorship({ role: "user" }), "PROMPT_AUTHORSHIP_HUMAN");
    assert.equal(
      promptAuthorship({ role: "user" }, { injected: true }),
      "PROMPT_AUTHORSHIP_INJECTED"
    );
  });

  it("reads a folded sub-agent turn as INJECTED", () => {
    assert.equal(
      promptAuthorship({ role: "user", metadata: { isSubAgent: true } }),
      "PROMPT_AUTHORSHIP_INJECTED"
    );
  });

  it("leaves an assistant turn UNSPECIFIED", () => {
    assert.equal(promptAuthorship({ role: "assistant" }), "PROMPT_AUTHORSHIP_UNSPECIFIED");
  });

  it("classifies a real no-args command turn as INJECTED via the content marker", () => {
    // A command wrapper carries no isMeta, so its injected signal is the content markup — this
    // is the Claude Code feed's contract for the wholly-machine (empty-args) command class.
    const injected = isInjectedUserMarkup(REAL.model);
    assert.equal(
      promptAuthorship({ role: "user" }, { injected }),
      "PROMPT_AUTHORSHIP_INJECTED"
    );
  });
});
