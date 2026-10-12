// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { declaredArtifactOf } from "../../internal";
import { cursorToolSummary } from "../../internal";
import { buildCliSessionEvents } from "../../internal";

// Every shape below is the shape a real store on disk carries, measured rather than assumed —
// which is the whole point, because the bug these tests cover was a fixture that agreed with
// the code while both disagreed with Cursor.
//
// IDE (`state.vscdb`, 22,548 tool bubbles):
//   · `toolFormerData.params`  — a JSON-encoded STRING (22,438 of them), camelCase inside
//                                (`relativeWorkspacePath` 8,605, `targetFile` 3,303)
//   · `toolFormerData.rawArgs` — a JSON-encoded STRING, snake_case inside
//                                (`target_file` 6,270, `file_path` 4,679, `command` 3,359)
// CLI (`~/.cursor/chats/*/store.db`, 55 stores):
//   · a tool blob's JSON `id` is `call-<uuid>-<N>` + "\n" + `fc_…` on all 4,254 of them
//   · `Task` args carry snake_case `subagent_type`; 177 calls read a `SKILL.md` by absolute path
//
// The values are synthesised; only the KEY NAMES, nesting and encoding are taken from the capture.

describe("a tool call's summary is read from the field that actually carries the args", () => {
  it("parses params when it arrives JSON-encoded, and reads its camelCase keys", () => {
    // Real params is a JSON string with camelCase inside, so a reader that tests
    // `typeof params === "object"` and looks for snake_case keys fails twice over and
    // summarises almost nothing — leaving a consumer a bare tool name for the rest.
    assert.equal(
      cursorToolSummary({
        name: "read_file",
        params: '{"relativeWorkspacePath":"src/session/store.ts","charsLimit":2000}',
      }),
      "src/session/store.ts"
    );
    assert.equal(
      cursorToolSummary({ name: "read_file", params: '{"targetFile":"src/app.ts"}' }),
      "src/app.ts"
    );
  });

  it("prefers rawArgs, whose snake_case keys are the ones tools populate", () => {
    assert.equal(
      cursorToolSummary({
        name: "edit_file",
        rawArgs: '{"target_file":"auth/session.go","explanation":"add a guard"}',
      }),
      "auth/session.go"
    );
    // Both present is the common case (21,927 bubbles). rawArgs wins, so no path-carrying
    // tool's summary changes meaning when params happens to name something else.
    assert.equal(
      cursorToolSummary({
        name: "edit_file",
        rawArgs: '{"target_file":"from-rawargs.go"}',
        params: '{"relativeWorkspacePath":"from-params.go"}',
      }),
      "from-rawargs.go"
    );
  });

  it("still reads a plain object, so a tool that stores args unencoded is not lost", () => {
    assert.equal(cursorToolSummary({ name: "read_file", params: { path: "a.ts" } }), "a.ts");
  });

  it("names nothing when no argument names the work", () => {
    assert.equal(cursorToolSummary({ name: "read_file", rawArgs: "{}" }), undefined);
    assert.equal(cursorToolSummary({ name: "read_file" }), undefined);
    assert.equal(cursorToolSummary(undefined), undefined);
    // Malformed JSON must not throw on the extraction hot path.
    assert.equal(cursorToolSummary({ name: "read_file", rawArgs: "{not json" }), undefined);
    // A body is not a name — file contents and diffs stay in the transcript.
    assert.equal(
      cursorToolSummary({ name: "edit_file", rawArgs: '{"code_edit":"package main"}' }),
      undefined
    );
  });
});

describe("a tool call declares an artifact only when it evidences one", () => {
  it("reads a skill from the SKILL.md the call loaded", () => {
    // On Cursor there is no `Skill` tool, so loading a skill's instructions IS its invocation.
    assert.deepEqual(
      declaredArtifactOf("read_file", { target_file: "/repo/.claude/skills/schema-check/SKILL.md" }),
      { assetType: "skill", assetName: "schema-check" }
    );
    // The CLI spells the path arg `path` and reads by absolute path.
    assert.deepEqual(
      declaredArtifactOf("Read", { path: "/repo/.claude/skills-cursor/deploy-app/SKILL.md" }),
      { assetType: "skill", assetName: "deploy-app" }
    );
  });

  it("declares nothing for a subagent dispatch, under either surface's tool name", () => {
    // An agent is not a declaring artifact: it arrives as its own delegated session and is
    // counted where its own cycle was observed. Naming it here would make the call a
    // SKILL_CALL, which resolves against skill and command entries only — so a dispatch
    // sharing a name with an installed skill would position THAT skill at a sequence it
    // never ran.
    assert.equal(declaredArtifactOf("task_v2", { subagentType: "explore" }), null);
    assert.equal(declaredArtifactOf("task_v2", { subagentType: "custom", name: "code-review" }), null);
    assert.equal(declaredArtifactOf("Task", { subagent_type: "general-purpose" }), null);
    // Including the case where the dispatch's args name a skill's file: the dispatch did not
    // load it, so it is not the invocation.
    assert.equal(
      declaredArtifactOf("Task", { path: "/repo/.claude/skills/deploy-app/SKILL.md" }),
      null
    );
  });

  it("declares nothing when the tool only searched or edited the SKILL.md", () => {
    // The path alone is not the invocation — the CALL has to be the one that loaded the
    // instructions. A searcher or a mutator admitted here asserts an invocation at a sequence
    // where the artifact was merely matched or rewritten, and grounding overrides the model,
    // so the fabrication would win.
    const skill = "/repo/.claude/skills/schema-check/SKILL.md";
    for (const tool of ["Grep", "Glob", "StrReplace", "Write", "Delete", "edit_file", "search_replace", "grep", "codebase_search", "file_search", "list_dir"]) {
      assert.equal(declaredArtifactOf(tool, { path: skill }), null, `${tool} must not declare`);
      assert.equal(declaredArtifactOf(tool, { target_file: skill }), null, `${tool} must not declare`);
    }
  });

  it("declares nothing for a file read that is not a skill", () => {
    // Reading a hook file is not running the hook — a hook runs when the harness fires it on
    // an event, which is a different signal on a different path. A HOOK_CALL synthesised from
    // a read would claim a run nothing performed.
    assert.equal(declaredArtifactOf("Read", { path: "/repo/.claude/hooks/pre-push" }), null);
    assert.equal(declaredArtifactOf("Read", { path: "/repo/.claude/rules/comments.md" }), null);
    assert.equal(declaredArtifactOf("Read", { path: "/repo/CLAUDE.md" }), null);
    assert.equal(declaredArtifactOf("read_file", { target_file: "src/app.ts" }), null);
    assert.equal(declaredArtifactOf("run_terminal_cmd", { command: "pnpm test" }), null);
    // An unnamed tool cannot be matched against the readers, so it declares nothing.
    assert.equal(declaredArtifactOf(undefined, { path: "/repo/.claude/skills/x/SKILL.md" }), null);
  });
});

describe("a cli timeline positions its declarations", () => {
  // A `/loop`-shaped session: the agent loads a skill, dispatches an agent, then runs a check.
  const messages = [
    {
      role: "assistant",
      id: "msg_a_0",
      content: [
        {
          type: "tool-call",
          toolCallId: "c-skill",
          toolName: "Read",
          args: { path: "/repo/.claude/skills/deploy-app/SKILL.md" },
        },
        {
          type: "tool-call",
          toolCallId: "c-agent",
          toolName: "Task",
          args: { subagent_type: "code-reviewer", description: "review the diff" },
        },
        { type: "tool-call", toolCallId: "c-check", toolName: "Shell", args: { command: "pnpm test" } },
      ],
    },
    {
      role: "tool",
      id: "call-x-0\nfc_a_0",
      content: [{ type: "tool-result", toolCallId: "c-skill", toolName: "Read", result: "---\nname: deploy-app" }],
    },
    {
      role: "tool",
      id: "call-x-1\nfc_a_1",
      content: [{ type: "tool-result", toolCallId: "c-agent", toolName: "Task", result: "done" }],
    },
    {
      role: "tool",
      id: "call-x-2\nfc_a_2",
      content: [{ type: "tool-result", toolCallId: "c-check", toolName: "Shell", result: "Exit code: 0\n" }],
    },
  ];

  it("emits a SKILL_CALL at the sequence the declaration happened", () => {
    // This is the whole fix. Without a declaration-typed event a consumer's `positioned` set
    // stays empty, every Cursor declaration is unpositioned, the run demotes to free-form and
    // declared-only display withholds it — so a Cursor-only user sees no declarations.
    const { events } = buildCliSessionEvents(messages);
    const declarations = events.filter((e) => e.kind === "SESSION_EVENT_KIND_SKILL_CALL");
    // Only the skill read. The `Task` dispatch in this same turn is NOT a declaration — an
    // agent runs as its own delegated session and is counted there.
    assert.deepEqual(
      declarations.map((d) => d.operation_name),
      ["deploy-app"]
    );
    // Positioned means it carries a real sequence, not merely that it exists.
    assert.ok(declarations.every((d) => typeof d.sequence === "number" && d.sequence > 0));
  });

  it("leaves a plain tool call a TOOL_CALL", () => {
    const { events } = buildCliSessionEvents(messages);
    const plain = events.filter((e) => e.kind === "SESSION_EVENT_KIND_TOOL_CALL");
    assert.deepEqual(plain.map((c) => c.operation_name), ["Task", "Shell"]);
  });

  it("keeps the result paired to the call under its own tool name", () => {
    // The result-side checker lookup asks "was this a Shell result", a question about the
    // invoking tool — so re-labelling the CALL must not re-label what produced the result.
    const { events } = buildCliSessionEvents(messages);
    const results = events.filter((e) => e.kind === "SESSION_EVENT_KIND_TOOL_RESULT");
    assert.deepEqual(results.map((r) => r.parent_call_id), ["c-skill", "c-agent", "c-check"]);
  });
});

describe("a newly-populated summary does not carry a secret or a home path off the machine", () => {
  // `session_events` is stored on its own path and is NOT covered by sanitizeSessionMeta, so
  // `boundedSummary` at the capture site is the only scrub these ever get. This summary
  // carries file paths and command lines for most calls in a store — exactly where a leak
  // would first appear, so it is asserted rather than assumed.
  const homePath = `/Users/${userInfo().username}/work/secrets.ts`;
  const key = "sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF";

  it("hashes the home segment out of a path summary", () => {
    const { events } = buildCliSessionEvents([
      {
        role: "assistant",
        id: "m",
        content: [{ type: "tool-call", toolCallId: "c", toolName: "Read", args: { path: homePath } }],
      },
    ]);
    const summary = events[0]?.redacted_summary ?? "";
    assert.ok(summary.length > 0, "the summary is populated");
    assert.ok(
      !summary.includes(userInfo().username),
      "the OS username must never reach the stored row"
    );
  });

  it("scrubs a key pasted into a command summary", () => {
    const { events } = buildCliSessionEvents([
      {
        role: "assistant",
        id: "m",
        content: [
          {
            type: "tool-call",
            toolCallId: "c",
            toolName: "Shell",
            args: { command: `curl -H "x-api-key: ${key}" https://example.test` },
          },
        ],
      },
    ]);
    const summary = events[0]?.redacted_summary ?? "";
    assert.ok(summary.length > 0, "the summary is populated");
    assert.ok(!summary.includes(key), "a known key shape must be scrubbed before store");
  });
});
