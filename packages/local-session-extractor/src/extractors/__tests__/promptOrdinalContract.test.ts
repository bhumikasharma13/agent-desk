// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../../store/SessionStore";
import { extractCursor } from "../../internal";
import { SessionEventBuilder } from "../../internal";
import type { SessionEvent } from "../../internal";
import { DatabaseSync } from "node:sqlite";
import { setPathOverrides } from "../pathResolver";

/**
 * `prompt_ordinal` is a ONE-BASED position into the stored prompt list. The invariant is
 * pinned here for every adapter that emits a timeline, rather than left to each adapter's own
 * convention, because the two producers disagreed silently: nothing on either side of the wire
 * fails when an ordinal is off by one — it simply resolves to a different turn's text, and the
 * consumer cannot tell that from a session where the person really did say that.
 *
 * The assertion is deliberately a round trip — dereference the emitted ordinal back into the
 * prompt list and compare CONTENT — not "some ordinal was emitted". An ordinal is only correct
 * relative to the list it indexes, so any assertion that does not follow it home passes on a
 * zero-based producer too.
 */


type StoredPrompt = { role: string; content?: string };

/** Every prompt reference in a timeline, in sequence order. */
function promptReferences(events: SessionEvent[]): SessionEvent[] {
  return events
    .filter((e) => e.kind === "SESSION_EVENT_KIND_PROMPT_REFERENCE")
    .sort((a, b) => a.sequence - b.sequence);
}

/**
 * A consumer's dereference, reproduced exactly: `prompts[ordinal-1]`, with anything outside the
 * list treated as no evidence. Mirrors `eventText` in
 * a consumer's evidence reader.
 */
function deref(prompts: StoredPrompt[], ordinal: number | undefined): StoredPrompt | undefined {
  if (ordinal === undefined || ordinal < 1 || ordinal > prompts.length) return undefined;
  return prompts[ordinal - 1];
}

describe("prompt_ordinal is one-based — Cursor", () => {

  /**
   * The bubble sequence of a REAL captured Cursor conversation, read out of
   * ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb (30 headers, 4 user
   * turns). Only the structure is reproduced — which bubbles are user vs assistant, which
   * assistant bubbles carry prose vs a tool call, and which carry no text at all — with the
   * prompt text replaced by markers so nothing real is committed. Structure is what this
   * invariant depends on, and it is exactly what a hand-invented alternating fixture gets wrong:
   *
   *  - Real Cursor emits RUNS of assistant bubbles between user turns, not strict alternation.
   *  - An empty-text assistant bubble WITH a tool call becomes a placeholder prompt (pushed).
   *  - An empty-text assistant bubble with NO tool call is skipped entirely (not pushed), so the
   *    prompt list and the header list have different lengths and a naive index drifts.
   *
   * `createdAt` is absent on every real bubble in that capture, so it is absent here too.
   */
  const REAL_SHAPE: Array<{ type: 1 | 2; text?: string; tool?: string }> = [
    { type: 1, text: "user turn 1" },
    { type: 2 }, // blank, no tool — skipped, never pushed
    { type: 2, text: "assistant prose 1" },
    { type: 2, tool: "edit_file" }, // blank + tool — pushed as a placeholder
    { type: 2, text: "assistant prose 2" },
    { type: 2, tool: "edit_file" },
    { type: 2, text: "assistant prose 3" },
    { type: 2, tool: "edit_file" },
    { type: 2, text: "assistant prose 4" },
    { type: 1, text: "user turn 2" },
    { type: 2 },
    { type: 2, text: "assistant prose 5" },
    { type: 2, tool: "edit_file" },
    { type: 2, text: "assistant prose 6" },
    { type: 1, text: "user turn 3" },
    { type: 2 },
    { type: 2, text: "assistant prose 7" },
    { type: 2, tool: "edit_file" },
    { type: 2, text: "assistant prose 8" },
  ];

  const buildDb = (path: string, composerId: string, lastUpdatedAt: number): void => {
    const raw = new DatabaseSync(path);
    raw.exec("CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);");
    const headers = REAL_SHAPE.map((_b, i) => ({ bubbleId: `b${i}`, type: REAL_SHAPE[i]!.type }));
    const composerData = {
      composerId,
      createdAt: lastUpdatedAt - 60_000,
      lastUpdatedAt,
      name: "Ordinal contract session",
      fullConversationHeadersOnly: headers,
      modelConfig: { modelName: "claude-sonnet-4-6" },
    };
    const ins = raw.prepare("INSERT OR REPLACE INTO cursorDiskKV (key, value) VALUES (?, ?)");
    ins.run(`composerData:${composerId}`, JSON.stringify(composerData));
    REAL_SHAPE.forEach((b, i) => {
      // `text` is ALWAYS present, empty string included. Measured over 4,000 real tool bubbles:
      // 4,000 carry a `text` key, all of them blank, and NONE carries `rawText`. That matters
      // rather than being pedantry — `parseBubbleData` drops a bubble whose `text` and `rawText`
      // are both non-strings, so a fixture that omits the key on a tool bubble makes the whole
      // bubble invisible to the extractor and no timeline event is ever emitted for it.
      const bubble: Record<string, unknown> = { bubbleId: `b${i}`, type: b.type, text: b.text ?? "" };
      if (b.tool) {
        // Real tool bubbles carry `params` AND `rawArgs` (both were present on every tool bubble
        // in the capture), and two different readers use them: `cursorToolSummary` reads `params`
        // for the event summary, `parseToolArgs` parses `rawArgs` for the placeholder text. A
        // fixture with only one of them leaves whichever reader wants the other silently empty.
        bubble["toolFormerData"] = {
          name: b.tool,
          status: "completed",
          toolCallId: `call-${i}`,
          params: { target_file: `f${i}.go` },
          rawArgs: JSON.stringify({ target_file: `f${i}.go` }),
        };
      }
      ins.run(`bubbleId:${composerId}:b${i}`, JSON.stringify(bubble));
    });
    raw.close();
  };

  let tmpDir: string;
  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-ordinal-"));
    // Without this a machine with real ~/.cursor history leaks extra sessions into the row set.
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: join(tmpDir, "no-cli-chats") });
  });
  after(() => {
    setPathOverrides({ CURSOR_DB_PATH: undefined });
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("dereferences every emitted ordinal back to the user turn it was emitted for", async () => {
    const composerId = "ordinal-contract";
    const cursorDbPath = join(tmpDir, "ordinal.vscdb");
    buildDb(cursorDbPath, composerId, Date.now() - 60_000);
    const db = new SessionStore(join(tmpDir, "ordinal-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });

    assert.equal(await extractCursor(db), 1, "the composer must be stored");

    const row = db
      .raw()
      .prepare(
        "SELECT conversation, session_events FROM conversations WHERE ide_type = 'cursor' AND session_id = ?"
      )
      .get(composerId) as { conversation: string; session_events: string | null };

    assert.ok(row.session_events, "a session with user turns must store a timeline");
    const prompts = JSON.parse(row.conversation) as StoredPrompt[];
    const refs = promptReferences(JSON.parse(row.session_events) as SessionEvent[]);

    // Three user turns in the captured shape, so three references — one per user bubble.
    assert.equal(refs.length, 3, "one prompt reference per user turn");

    const userPrompts = prompts.filter((p) => p.role === "user");
    assert.equal(userPrompts.length, 3, "the three user turns are all in the prompt list");

    refs.forEach((ref, i) => {
      const target = deref(prompts, ref.prompt_ordinal);
      assert.ok(
        target,
        `ordinal ${ref.prompt_ordinal} is outside the prompt list of ${prompts.length} — ` +
          "a zero-based producer puts the first reference at 0, which a consumer refuses outright"
      );
      assert.equal(
        target.role,
        "user",
        `ordinal ${ref.prompt_ordinal} resolved to a ${target.role} turn. A reference that ` +
          "lands on the assistant is how the autonomy bar stops recognising a human turn, and " +
          "how a run's objective excerpt becomes the model's own prose"
      );
      assert.equal(
        target.content,
        userPrompts[i]!.content,
        "the reference must resolve to the SAME user turn it was emitted for, in order"
      );
    });

    // The first user bubble is the sharpest case: emitted pre-push it is ordinal 0, which the
    // consumer treats as no evidence at all rather than as a wrong turn.
    assert.equal(refs[0]!.prompt_ordinal, 1, "the opening user turn is ordinal 1, never 0");
  });

  // These guarantees are checked on the walk that actually runs.
  it("pairs a call with its result and rates the session readable", async () => {
    const composerId = "timeline-shape";
    const cursorDbPath = join(tmpDir, "timeline.vscdb");
    buildDb(cursorDbPath, composerId, Date.now() - 60_000);
    const db = new SessionStore(join(tmpDir, "timeline-local.db"));
    setPathOverrides({ CURSOR_DB_PATH: cursorDbPath });

    assert.equal(await extractCursor(db), 1);

    const row = db
      .raw()
      .prepare(
        "SELECT session_events, event_coverage FROM conversations WHERE ide_type = 'cursor' AND session_id = ?"
      )
      .get(composerId) as { session_events: string | null; event_coverage: string | null };

    const events = JSON.parse(row.session_events!) as SessionEvent[];
    const calls = events.filter((e) => e.kind === "SESSION_EVENT_KIND_TOOL_CALL");
    const results = events.filter((e) => e.kind === "SESSION_EVENT_KIND_TOOL_RESULT");

    const toolBubbles = REAL_SHAPE.filter((b) => b.tool).length;
    assert.equal(calls.length, toolBubbles, "one call per tool bubble");
    assert.equal(results.length, toolBubbles, "and one result — Cursor carries both on one bubble");
    // The pairing is what attributes a check to the action it verified; without it every result
    // is parentless and no correction cycle is readable.
    assert.deepEqual(
      results.map((r) => r.parent_call_id),
      calls.map((c) => c.call_id),
      "each result names the call it answers"
    );
    // The summary is what stops every edit_file collapsing into one fabricated loop.
    assert.equal(calls[0]?.redacted_summary, "f3.go");
    assert.equal(row.event_coverage, "EVENT_COVERAGE_COMPLETE");
  });
});

/**
 * The same invariant on the Claude Code side of the wire, asserted against the builder rather
 * than a transcript: `addPromptReference` takes the ordinal from its caller, so the contract that
 * matters is that the caller passes the position the message OCCUPIES. Pinning it for both
 * adapters is the point — an invariant checked on one producer is that producer's convention.
 */
describe("prompt_ordinal is one-based — the builder contract", () => {
  it("keeps a caller that references after its push in step with the list", () => {
    const b = new SessionEventBuilder();
    const prompts: StoredPrompt[] = [];

    for (const turn of [
      { role: "user", content: "first ask" },
      { role: "assistant", content: "an answer" },
      { role: "user", content: "second ask" },
    ]) {
      prompts.push(turn);
      if (turn.role === "user") b.addPromptReference(prompts.length, undefined, "SESSION_EVENT_AUTHOR_HUMAN");
    }

    const refs = promptReferences(b.build());
    assert.equal(refs.length, 2);
    assert.equal(deref(prompts, refs[0]!.prompt_ordinal)?.content, "first ask");
    assert.equal(deref(prompts, refs[1]!.prompt_ordinal)?.content, "second ask");
  });

  it("shows what a pre-push caller emits, so the failure mode stays legible", () => {
    const b = new SessionEventBuilder();
    const prompts: StoredPrompt[] = [];

    for (const turn of [
      { role: "user", content: "first ask" },
      { role: "assistant", content: "an answer" },
      { role: "user", content: "second ask" },
    ]) {
      // The defect: the ordinal is read BEFORE the push, so it names the position the message
      // is about to take rather than the one it takes.
      if (turn.role === "user") b.addPromptReference(prompts.length, undefined, "SESSION_EVENT_AUTHOR_HUMAN");
      prompts.push(turn);
    }

    const refs = promptReferences(b.build());
    assert.equal(refs[0]!.prompt_ordinal, 0, "the opening turn becomes unresolvable");
    assert.equal(
      deref(prompts, refs[1]!.prompt_ordinal)?.role,
      "assistant",
      "and every later turn resolves to the previous one — here, the assistant's answer"
    );
  });
});
