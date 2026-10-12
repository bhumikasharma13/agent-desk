// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRolloutContent } from "../../internal";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Captured from a real `/goal` rollout on a real machine, filtered to the records under test and
// with the home path scrubbed. The field names below (`goal.objective`, `tokensUsed`,
// `timeUsedSeconds`) therefore come from Codex's own output rather than from what this code hopes
// to find — a fixture written to agree with the parser would pass while both disagreed with Codex.
const goalRollout = readFileSync(join(__dirname, "../../../fixtures/extraction", "codex", "goal-rollout.jsonl"), "utf-8");
// Same capture with the counters string-replaced to non-zero, so asserting on them
// discriminates a real vendor read from the parser's own zero default.
const goalRolloutCounters = readFileSync(
  join(__dirname, "../../../fixtures/extraction", "codex", "goal-rollout-counters.jsonl"), "utf-8");
// Same capture plus a SECOND invocation — fresh createdAt, new objective.
const goalRolloutTwo = readFileSync(
  join(__dirname, "../../../fixtures/extraction", "codex", "goal-rollout-two-invocations.jsonl"), "utf-8");
// A DIFFERENT real capture: a thread the person re-goaled with the SAME objective, so only the
// `createdAt` separates the two invocations. Two turns, no assistant message — the run was cut
// off before it produced one. Filtered to the records under test, home path scrubbed.
const goalRolloutReinvoked = readFileSync(
  join(__dirname, "../../../fixtures/extraction", "codex", "goal-rollout-reinvoked.jsonl"), "utf-8");

/** The fixture with its goal report removed — a rollout carrying genuinely no human turn. */
function withoutGoalReport(jsonl: string): string {
  return jsonl
    .split("\n")
    .filter((l) => l.length > 0 && !l.includes('"thread_goal_updated"'))
    .join("\n");
}

describe("codexExtractor — a /goal thread reaches the stored prompts", () => {
  it("counts the objective as the opening turn, so the caller does not discard the session", () => {
    // The gate this protects is `userTurns === 0` in processThread: a goal thread emits no
    // `user_message` event, so before the objective counted, every Codex loop was dropped whole
    // on the client and never reached analysis at all.
    assert.equal(goalRollout.includes('"user_message"'), false, "fixture must carry no user_message");

    const result = parseRolloutContent(goalRollout, "01a01992-bfce-75ef-91e8-3dee719d7284");
    if (!result) assert.fail("parseRolloutContent returned null");

    assert.ok(result.userTurns >= 1, `expected at least one user turn, got ${result.userTurns}`);
    assert.equal(result.prompts[0]?.role, "user");
    // Prefixed with the canonical command: a consumer's marker scan matches a slash command at
    // a prompt's opening, and Codex never writes the invocation as text. Without the prefix the
    // session is stored and still declares nothing.
    assert.equal(
      result.prompts[0]?.content,
      "/goal [scrubbed goal objective 1]",
    );
  });

  it("reports the goal it pursued", () => {
    const result = parseRolloutContent(goalRollout, "t-goal");
    if (!result) assert.fail("parseRolloutContent returned null");

    assert.ok(result.goal, "expected a goal");
    assert.equal(result.goal.status, "active");
    assert.equal(result.goal.updates, 1);
  });

  it("reads the counters from the vendor rather than defaulting them", () => {
    // Both real captures happen to carry 0, so a zero assertion would pass even if the field
    // names were wrong — a vendor rename would ship silently. This fixture carries non-zero
    // values, so the assertion fails if the read breaks.
    const result = parseRolloutContent(goalRolloutCounters, "t-goal");
    if (!result) assert.fail("parseRolloutContent returned null");
    assert.equal(result.goal?.tokensUsed, 25412);
    assert.equal(result.goal?.timeUsedSeconds, 64);
  });

  it("counts a re-goal in the same thread as a second invocation", () => {
    // A real captured thread carries two invocations, each with its own createdAt and its own
    // task_started/task_complete. Keying "new goal" on absence alone counted them as one and
    // lost an attempt — and dropped the second objective entirely.
    const result = parseRolloutContent(goalRolloutTwo, "t-two");
    if (!result) assert.fail("parseRolloutContent returned null");
    assert.equal(result.goalInvocations, 2, "two invocations, not one goal refreshed");
    assert.equal(result.goal?.objective, "[scrubbed goal objective 4]",
      "the running goal is the LATEST invocation");
    const goalTurns = result.prompts.filter((pr) => pr.role === "user" && pr.content.startsWith("/goal "));
    assert.equal(goalTurns.length, 2, "each invocation is its own turn");
  });

  it("counts one goal however many times the thread reports it", () => {
    // Codex re-reports the same goal on every state change. Each report must refresh the
    // counters, never push the objective again — re-pushing would invent turns nobody took.
    const twice = goalRollout
      .split("\n")
      .filter((l) => l.length > 0)
      .flatMap((l) => (l.includes('"thread_goal_updated"') ? [l, l] : [l]))
      .join("\n");

    const result = parseRolloutContent(twice, "t-goal");
    if (!result) assert.fail("parseRolloutContent returned null");

    assert.equal(result.goal?.updates, 2, "both reports counted");
    const objectiveTurns = result.prompts.filter(
      (p) => p.role === "user" && p.content === "/goal [scrubbed goal objective 1]",
    );
    assert.equal(objectiveTurns.length, 1, "the objective is one turn, not one per report");
  });

  it("counts a re-goal on the same objective as a second invocation", () => {
    // Real captured behaviour the synthesized two-invocation fixture cannot show: the person
    // re-goaled with the IDENTICAL objective, so `createdAt` is the only thing separating the
    // two. Comparing objectives alone would read this as one goal refreshed and lose an attempt.
    const result = parseRolloutContent(goalRolloutReinvoked, "01a00531-6010-78ed-a49d-c2aeb0e81965");
    if (!result) assert.fail("parseRolloutContent returned null");

    assert.equal(result.goalInvocations, 2);
    assert.equal(result.userTurns, 2);
    assert.equal(result.goal?.updates, 1, "each invocation starts its own update count");
  });
});

describe("codexExtractor — a /goal declaration is typed and positioned", () => {
  it("emits a GOAL event per invocation, each on its own turn", () => {
    // A `/goal` relayed as prompt text is recoverable only by a consumer's marker fallback,
    // which reads the text and cannot say where in the session it landed — so a re-goal is
    // indistinguishable from a re-report of the first. The typed event carries the position:
    // a consumer attributes a declaration to the first prompt reference at or after its own
    // sequence, so each GOAL must precede exactly the turn that declared it.
    const result = parseRolloutContent(goalRolloutReinvoked, "t-reinvoked");
    if (!result) assert.fail("parseRolloutContent returned null");

    const goals = result.sessionEvents.filter((e) => e.kind === "SESSION_EVENT_KIND_GOAL");
    assert.equal(goals.length, 2, "one typed declaration per invocation");

    const refs = result.sessionEvents.filter((e) => e.kind === "SESSION_EVENT_KIND_PROMPT_REFERENCE");
    assert.deepEqual(refs.map((e) => e.prompt_ordinal), [1, 2]);
    // The ordinal is the one-based position in the stored prompt list, which a consumer
    // dereferences — a drifted ordinal points the analysis at the wrong message.
    assert.equal(result.prompts.length, 2);

    for (const [i, decl] of goals.entries()) {
      const nextRef = refs.find((r) => r.sequence > decl.sequence);
      assert.ok(nextRef, `declaration ${i} has no following prompt reference`);
      assert.equal(nextRef.prompt_ordinal, i + 1, `declaration ${i} landed on the wrong turn`);
    }
  });

  it("carries the objective in operation_name and leaves the summary unset", () => {
    const result = parseRolloutContent(goalRollout, "t-goal");
    if (!result) assert.fail("parseRolloutContent returned null");

    const decl = result.sessionEvents.find((e) => e.kind === "SESSION_EVENT_KIND_GOAL");
    assert.ok(decl, "expected a GOAL event");
    assert.equal(
      decl.operation_name,
      "[scrubbed goal objective 1]",
    );
    // A consumer prefers a declaration's summary over its operation_name when reading the run's
    // objective, so anything here would REPLACE the objective in the run's digest.
    assert.equal(decl.redacted_summary, undefined);
    // The transcript only ever reports `active`; the terminal status lives in the CLI's own goal
    // store. UNKNOWN is the honest value — SUCCEEDED would be a verdict made out of an absence.
    assert.equal(decl.outcome, "SESSION_EVENT_OUTCOME_UNKNOWN");
  });

  it("stamps the goal turn HUMAN, because a person set the objective", () => {
    // A consumer accepts an objective only from a human turn, and reads this field and nothing
    // else. Stamped AGENT, a goal-driven run would establish no objective at all.
    const result = parseRolloutContent(goalRollout, "t-goal");
    if (!result) assert.fail("parseRolloutContent returned null");

    const ref = result.sessionEvents.find(
      (e) => e.kind === "SESSION_EVENT_KIND_PROMPT_REFERENCE" && e.prompt_ordinal === 1,
    );
    assert.equal(ref?.author, "SESSION_EVENT_AUTHOR_HUMAN");
  });

  it("reports PARTIAL coverage for a goal thread that observed no tool call", () => {
    // PARTIAL is the honest rating: this fixture carries the declaration and the turns but no tool
    // call, so the walk cannot claim the session was legible enough to prove a check ran.
    const withGoal = parseRolloutContent(goalRollout, "t-goal");
    if (!withGoal) assert.fail("parseRolloutContent returned null");
    assert.equal(withGoal.eventCoverage, "EVENT_COVERAGE_PARTIAL");
  });
});

describe("codexExtractor — a /goal thread reaches the stored prompts (gate)", () => {
  it("still drops a rollout that carries no turn at all", () => {
    // The gate is loosened, not removed: a session with neither a user message nor a goal has
    // nothing to analyse, and admitting it would spend an inference to conclude exactly that.
    const result = parseRolloutContent(withoutGoalReport(goalRollout), "t-empty");
    if (!result) assert.fail("parseRolloutContent returned null");

    assert.equal(result.userTurns, 0);
    assert.equal(result.goal, undefined);
  });
});

describe("codexExtractor — response_item tool calls become TOOL_CALL/TOOL_RESULT events", () => {
  // The `response_item` records below are the shapes Codex writes, captured verbatim from real
  // rollouts on a developer machine (home path scrubbed): a `function_call` exec_command whose
  // `function_call_output` states "Process exited with code 0"; a `custom_tool_call` apply_patch
  // whose `custom_tool_call_output` carries `metadata.exit_code`; and a `custom_tool_call` exec
  // (the script tool) whose output carries NO exit status. Codex records each tool call in this
  // form (the superset), so splicing these into the real goal rollout proves the extractor emits
  // the action->check pair a loop analysis needs for a session that ran its tools only in the
  // response_item form.

  // Real captured records (see extraction/__tests__ fixtures; home path scrubbed).
  const fnExecCall =
    '{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"pwd\\",\\"workdir\\":\\"/home/user/project\\",\\"max_output_tokens\\":200}","call_id":"call_exec1"}';
  const fnExecOut =
    '{"type":"function_call_output","call_id":"call_exec1","output":"Chunk ID: 8a6a2c\\nWall time: 0.0000 seconds\\nProcess exited with code 0\\nOriginal token count: 14\\nOutput:\\n/home/user/project\\n"}';
  const patchCall =
    '{"type":"custom_tool_call","status":"completed","call_id":"call_patch1","name":"apply_patch","input":"*** Begin Patch\\n*** Delete File: plan.md\\n*** End Patch\\n"}';
  const patchOut =
    '{"type":"custom_tool_call_output","call_id":"call_patch1","output":"{\\"output\\":\\"Success. Updated the following files:\\\\nD plan.md\\\\n\\",\\"metadata\\":{\\"exit_code\\":0,\\"duration_seconds\\":0.0}}"}';
  const execCall =
    '{"type":"custom_tool_call","status":"completed","call_id":"call_exec2","name":"exec","input":"const r = await tools.write_stdin({session_id:82802}); text(JSON.stringify(r))\\n"}';
  const execOut =
    '{"type":"custom_tool_call_output","call_id":"call_exec2","output":"Script running with cell ID 43\\nWall time 10.0 seconds\\nOutput:\\n"}';

  // Wrap a response_item payload as the top-level `{type:"response_item",payload}` record the
  // rollout stores.
  function ri(payloadJson: string): string {
    return JSON.stringify({ type: "response_item", payload: JSON.parse(payloadJson) });
  }

  // Real `event_msg` `*_end` record shapes (from the grounded rollout-fixture.jsonl capture, home
  // path scrubbed). An `exec_command_end` WITHOUT a call_id is the older END-ONLY format — no
  // response_item twin — and must still produce a timeline entry.
  const execEndNoTwin =
    '{"type":"event_msg","payload":{"type":"exec_command_end","command":["/bin/zsh","-lc","go test ./..."],"exit_code":0,"aggregated_output":"ok"}}';
  // A twinned exec: an exec_command_end sharing call_id with the function_call above. Its timeline
  // must come from response_item ONLY — this record is deduped out.
  const execEndTwin =
    '{"type":"event_msg","payload":{"type":"exec_command_end","call_id":"call_exec1","command":["/bin/zsh","-lc","pwd"],"exit_code":0,"aggregated_output":"ok"}}';
  // A twinned MCP call: function_call + output + an mcp_tool_call_end carrying the Err variant, all
  // sharing call_id. The response_item output states no verdict; the end twin's Err must survive.
  const mcpCall =
    '{"type":"function_call","name":"_get_pr_info","arguments":"{\\"number\\":42}","call_id":"call_mcp1"}';
  const mcpOut =
    '{"type":"function_call_output","call_id":"call_mcp1","output":"{}"}';
  const mcpEndErr =
    '{"type":"event_msg","payload":{"type":"mcp_tool_call_end","call_id":"call_mcp1","invocation":{"server":"github","tool":"_get_pr_info"},"result":{"Err":"boom"}}}';
  // exec_command whose runner header says the process is STILL RUNNING, while its stdout literally
  // contains "Process exited with code 0". The verdict must be UNKNOWN — the stdout is not the
  // runner's own status line .
  const execRunningCall =
    '{"type":"function_call","name":"exec_command","arguments":"{\\"cmd\\":\\"tail -f log\\"}","call_id":"call_run1"}';
  const execRunningOut =
    '{"type":"function_call_output","call_id":"call_run1","output":"Chunk ID: z\\nWall time: 1.0 seconds\\nProcess running with session ID 5\\nOriginal token count: 0\\nOutput:\\nlog line: Process exited with code 0\\n"}';

  // Splice raw JSONL lines into the real goal rollout, after the goal report (a GOAL thread).
  function goalRolloutWith(...lines: string[]): string {
    const base = goalRollout.split("\n").filter((l) => l.length > 0);
    const goalIdx = base.findIndex((l) => l.includes('"thread_goal_updated"'));
    base.splice(goalIdx + 1, 0, ...lines);
    return base.join("\n");
  }

  // Build a NON-goal thread: the real goal rollout with its goal report removed and a real-shaped
  // user_message added, then the given lines spliced in. goal is undefined, so coverage is NOT
  // held at PARTIAL by the goal-continuation cap — an honest COMPLETE is reachable here.
  function nonGoalRolloutWith(...lines: string[]): string {
    const userMsg = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-19T10:00:00.000Z",
      payload: { type: "user_message", message: "do the thing" },
    });
    const base = goalRollout
      .split("\n")
      .filter((l) => l.length > 0 && !l.includes('"thread_goal_updated"'));
    base.splice(1, 0, userMsg, ...lines);
    return base.join("\n");
  }

  it("emits linked call+result events for each response_item tool, reaching COMPLETE on a non-goal thread", () => {
    const result = parseRolloutContent(
      nonGoalRolloutWith(ri(fnExecCall), ri(fnExecOut), ri(patchCall), ri(patchOut), ri(execCall), ri(execOut)),
      "t-tools",
    );
    if (!result) assert.fail("parseRolloutContent returned null");

    const calls = result.sessionEvents.filter((e) => e.kind === "SESSION_EVENT_KIND_TOOL_CALL");
    const exec = calls.find((e) => e.operation_name === "exec_command");
    assert.ok(exec, "expected an exec_command TOOL_CALL");
    // The call summary names the work from the arguments — the command, never a file body.
    assert.equal(exec!.redacted_summary, "pwd");
    assert.ok(calls.some((e) => e.operation_name === "apply_patch"), "expected an apply_patch TOOL_CALL");
    assert.ok(calls.some((e) => e.operation_name === "exec"), "expected an exec TOOL_CALL");

    // "Process exited with code 0" in the runner HEADER → a SUCCEEDED result linked by call_id.
    const execResult = result.sessionEvents.find(
      (e) => e.kind === "SESSION_EVENT_KIND_TOOL_RESULT" && e.parent_call_id === exec!.call_id,
    );
    assert.ok(execResult, "exec_command result must link to its call by id");
    assert.equal(execResult!.outcome, "SESSION_EVENT_OUTCOME_SUCCEEDED");

    // apply_patch's outcome comes from its output's metadata.exit_code.
    const patch = calls.find((e) => e.operation_name === "apply_patch");
    const patchResult = result.sessionEvents.find(
      (e) => e.kind === "SESSION_EVENT_KIND_TOOL_RESULT" && e.parent_call_id === patch!.call_id,
    );
    assert.equal(patchResult!.outcome, "SESSION_EVENT_OUTCOME_SUCCEEDED");

    // The `exec` script tool carries no exit status → UNKNOWN, never a synthesized pass.
    const execTool = calls.find((e) => e.operation_name === "exec");
    const execToolResult = result.sessionEvents.find(
      (e) => e.kind === "SESSION_EVENT_KIND_TOOL_RESULT" && e.parent_call_id === execTool!.call_id,
    );
    assert.equal(execToolResult!.outcome, "SESSION_EVENT_OUTCOME_UNKNOWN");

    // Two of three results carry an explicit outcome (a majority) and this is not a goal thread, so
    // coverage is honestly COMPLETE — the flat cap is gone.
    assert.equal(result.eventCoverage, "EVENT_COVERAGE_COMPLETE");
  });

  it("holds a /goal thread at PARTIAL even with fully-observed tools (skipped human continuations)", () => {
    // A goal thread's human continuations arrive as response_item messages the parser does not read
    // as turns, so the timeline cannot see a mid-cycle human turn — coverage must not claim full
    // legibility, even when every tool result was observed. Same tools as the COMPLETE case above.
    const result = parseRolloutContent(
      goalRolloutWith(ri(fnExecCall), ri(fnExecOut), ri(patchCall), ri(patchOut)),
      "t-goal-tools",
    );
    if (!result) assert.fail("parseRolloutContent returned null");
    assert.ok(result.goal, "fixture must be a goal thread");
    assert.equal(result.eventCoverage, "EVENT_COVERAGE_PARTIAL");
  });

  it("holds an exec-only session at PARTIAL, because exec results carry no verdict", () => {
    // The common modern Codex session runs everything through the `exec` script tool, whose output
    // has no exit status. With no observable outcome on any result, coverage is honestly PARTIAL.
    const result = parseRolloutContent(nonGoalRolloutWith(ri(execCall), ri(execOut)), "t-exec-only");
    if (!result) assert.fail("parseRolloutContent returned null");

    assert.ok(
      result.sessionEvents.some(
        (e) => e.kind === "SESSION_EVENT_KIND_TOOL_CALL" && e.operation_name === "exec",
      ),
      "expected the exec TOOL_CALL in the timeline",
    );
    assert.equal(result.eventCoverage, "EVENT_COVERAGE_PARTIAL");
  });

  it("keeps the timeline for an END-ONLY exec_command_end that has no response_item twin", () => {
    // An older rollout records the tool only as an `event_msg` `*_end` (no response_item). Dropping
    // its timeline would blank those sessions — so an end-only record still emits its call+result.
    const result = parseRolloutContent(nonGoalRolloutWith(execEndNoTwin), "t-end-only");
    if (!result) assert.fail("parseRolloutContent returned null");

    const exec = result.sessionEvents.find(
      (e) => e.kind === "SESSION_EVENT_KIND_TOOL_CALL" && e.operation_name === "exec_command",
    );
    assert.ok(exec, "an end-only exec_command_end must still emit a TOOL_CALL");
    const execResult = result.sessionEvents.find(
      (e) => e.kind === "SESSION_EVENT_KIND_TOOL_RESULT" && e.parent_call_id === exec!.call_id,
    );
    assert.equal(execResult!.outcome, "SESSION_EVENT_OUTCOME_SUCCEEDED", "exit 0 → SUCCEEDED");
  });

  it("emits a twinned tool exactly once — the *_end record is deduped against its response_item", () => {
    // Both forms of the SAME exec (function_call + its exec_command_end, one call_id) must yield one
    // exec_command TOOL_CALL, not two.
    const result = parseRolloutContent(
      nonGoalRolloutWith(ri(fnExecCall), ri(fnExecOut), execEndTwin),
      "t-dedup",
    );
    if (!result) assert.fail("parseRolloutContent returned null");
    const execCalls = result.sessionEvents.filter(
      (e) => e.kind === "SESSION_EVENT_KIND_TOOL_CALL" && e.operation_name === "exec_command",
    );
    assert.equal(execCalls.length, 1, "a twinned tool is emitted once, from response_item");
  });

  it("preserves an MCP failure the response_item output omits, from the *_end Err twin", () => {
    // The response_item output states no verdict; the mcp_tool_call_end twin carries Err. The
    // result must be FAILED, and the call emitted once (the end twin is deduped).
    const result = parseRolloutContent(
      nonGoalRolloutWith(ri(mcpCall), ri(mcpOut), mcpEndErr),
      "t-mcp-err",
    );
    if (!result) assert.fail("parseRolloutContent returned null");

    const mcpCalls = result.sessionEvents.filter(
      (e) => e.kind === "SESSION_EVENT_KIND_TOOL_CALL" && e.operation_name === "_get_pr_info",
    );
    assert.equal(mcpCalls.length, 1, "the MCP call is emitted once");
    const mcpResult = result.sessionEvents.find(
      (e) => e.kind === "SESSION_EVENT_KIND_TOOL_RESULT" && e.parent_call_id === mcpCalls[0]!.call_id,
    );
    assert.equal(mcpResult!.outcome, "SESSION_EVENT_OUTCOME_FAILED", "the end twin's Err is preserved");
  });

  it("does not read an exit code from stdout — a still-running exec_command is UNKNOWN", () => {
    // The runner header says the process is still running; its stdout merely contains the phrase
    // "Process exited with code 0". Reading that as the verdict would invert the result.
    const result = parseRolloutContent(
      nonGoalRolloutWith(ri(execRunningCall), ri(execRunningOut)),
      "t-running",
    );
    if (!result) assert.fail("parseRolloutContent returned null");
    const exec = result.sessionEvents.find(
      (e) => e.kind === "SESSION_EVENT_KIND_TOOL_CALL" && e.operation_name === "exec_command",
    );
    const execResult = result.sessionEvents.find(
      (e) => e.kind === "SESSION_EVENT_KIND_TOOL_RESULT" && e.parent_call_id === exec!.call_id,
    );
    assert.equal(execResult!.outcome, "SESSION_EVENT_OUTCOME_UNKNOWN");
  });

  it("does not carry the exec script body or the exec output into a result summary", () => {
    // `exec` is not a checker tool, so its result contributes its outcome alone — never its output
    // text. And a planted secret in an exec input never survives into the stored timeline:
    // summaries are redacted at the builder's bounded-summary choke point.
    const secret = "sk-ant-planted-SECRET-0123456789";
    // Inject the secret without adding quotes, so the surrounding record stays valid JSON.
    const taintedCall = execCall.replace("JSON.stringify(r)", secret);
    const result = parseRolloutContent(nonGoalRolloutWith(ri(taintedCall), ri(execOut)), "t-secret");
    if (!result) assert.fail("parseRolloutContent returned null");

    const serialized = JSON.stringify(result.sessionEvents);
    assert.equal(serialized.includes(secret), false, "a planted secret must not reach the timeline");
    const execResult = result.sessionEvents.find(
      (e) => e.kind === "SESSION_EVENT_KIND_TOOL_RESULT" && e.parent_call_id !== undefined,
    );
    assert.equal(execResult?.redacted_summary, undefined, "a non-checker result carries no summary");
  });
});
