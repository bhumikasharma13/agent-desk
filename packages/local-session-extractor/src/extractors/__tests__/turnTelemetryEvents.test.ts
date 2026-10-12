// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { parseRolloutContent } from "../codexExtractor";
import { extractClaudeCode } from "../claudeCodeExtractor";
import { parseIdeMessages, extractKiroIde } from "../kiroIdeExtractor";
import { setPathOverrides } from "../pathResolver";
import { setMetricsSink, type CounterTags } from "../../seams/metrics";
import { SessionStore } from "../../store/SessionStore";
import type { ConversationPrompt } from "../../types/session";

/**
 * Layer-1 golden tests for the new turn-shape session events, over the committed
 * fixture corpus. They assert the events land at the right timeline positions and
 * that an unrecognized record trips the drift counter.
 *
 * `boot-zero-token`, `turn-brackets`, and `retries` are all well-formed rollouts
 * (session_meta on line 0). `turn-brackets` exercises one clean bracket; `retries`
 * exercises the cancelled bracket — a second turn that opens but never reaches
 * task_complete, so its TURN_STARTED has no closing TURN_COMPLETED and the grouper
 * ends it at the timeline's end.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXROOT = join(HERE, "../../../fixtures/turn-telemetry");

/** Every counter increment since the last reset, captured through the metrics seam. */
const counted: { name: string; tags: CounterTags; delta: number }[] = [];
setMetricsSink({ inc: (name, tags = {}, by = 1) => counted.push({ name, tags, delta: by }), observe: () => {} });
const _resetForTests = (): void => {
  counted.length = 0;
};
const snapshotAndReset = (): { counters: { name: string; tags: CounterTags; delta: number }[] } => {
  const counters = [...counted];
  _resetForTests();
  return { counters };
};

/** The one .jsonl directly under a case dir. */
function caseFile(provider: string, caseName: string): string {
  const dir = join(FIXROOT, provider, caseName);
  const jsonl = readdirSync(dir).find((n) => n.endsWith(".jsonl"));
  assert.ok(jsonl, `no .jsonl in ${dir}`);
  return join(dir, jsonl);
}

function kindsOf(events: { kind: string }[]): string[] {
  return events.map((e) => e.kind.replace("SESSION_EVENT_KIND_", ""));
}

/** The messages.jsonl lines for a Kiro fixture case. */
function kiroMessageLines(caseName: string): string[] {
  const caseDir = join(FIXROOT, "kiro", caseName);
  const sessDir = readdirSync(caseDir).find((n) => n.startsWith("sess_"));
  assert.ok(sessDir, `no session dir in ${caseDir}`);
  return readFileSync(join(caseDir, sessDir, "messages.jsonl"), "utf8").split("\n").filter((l) => l.trim());
}

describe("Codex turn brackets", () => {
  it("boot-zero-token: a task opens TURN_STARTED and closes TURN_COMPLETED around its content", () => {
    const result = parseRolloutContent(readFileSync(caseFile("codex", "boot-zero-token"), "utf8"), "t");
    assert.ok(result, "boot-zero-token must parse");
    const kinds = kindsOf(result.sessionEvents);
    const started = kinds.indexOf("TURN_STARTED");
    const completed = kinds.lastIndexOf("TURN_COMPLETED");
    assert.ok(started >= 0, `expected a TURN_STARTED, got ${kinds.join(",")}`);
    assert.ok(completed >= 0, `expected a TURN_COMPLETED, got ${kinds.join(",")}`);
    assert.ok(started < completed, `the bracket must open before it closes: ${kinds.join(",")}`);
  });
});

describe("Codex clean vs cancelled turn brackets", () => {
  it("turn-brackets: one turn opens TURN_STARTED and closes TURN_COMPLETED", () => {
    const result = parseRolloutContent(readFileSync(caseFile("codex", "turn-brackets"), "utf8"), "t");
    assert.ok(result, "turn-brackets must parse (session_meta on line 0)");
    const kinds = kindsOf(result.sessionEvents);
    const starts = kinds.filter((k) => k === "TURN_STARTED").length;
    const completes = kinds.filter((k) => k === "TURN_COMPLETED").length;
    assert.equal(starts, 1, `one bracket opens: ${kinds.join(",")}`);
    assert.equal(completes, 1, `one bracket closes: ${kinds.join(",")}`);
    assert.ok(
      kinds.indexOf("TURN_STARTED") < kinds.lastIndexOf("TURN_COMPLETED"),
      `the bracket must open before it closes: ${kinds.join(",")}`,
    );
  });

  it("retries: an abandoned second turn opens a TURN_STARTED that never closes", () => {
    const result = parseRolloutContent(readFileSync(caseFile("codex", "retries"), "utf8"), "t");
    assert.ok(result, "retries must parse (session_meta on line 0)");
    const kinds = kindsOf(result.sessionEvents);
    const starts = kinds.filter((k) => k === "TURN_STARTED").length;
    const completes = kinds.filter((k) => k === "TURN_COMPLETED").length;
    assert.equal(starts, 2, `two turns open (one retried): ${kinds.join(",")}`);
    assert.equal(completes, 1, `only the first turn closes: ${kinds.join(",")}`);
    // The cancelled bracket: the last TURN_STARTED has no TURN_COMPLETED after it.
    assert.ok(
      kinds.lastIndexOf("TURN_STARTED") > kinds.lastIndexOf("TURN_COMPLETED"),
      `the final turn must be left open (no closing TURN_COMPLETED): ${kinds.join(",")}`,
    );
  });
});

describe("Codex unknown-record-kind drift counter", () => {
  it("an unrecognized event_msg increments UNKNOWN_RECORD_KINDS for the provider", () => {
    _resetForTests();
    // A real rollout (valid session_meta) plus one record whose kind is not in the
    // registry — the drift path, exercised end-to-end through the real extractor.
    const valid = readFileSync(caseFile("codex", "boot-zero-token"), "utf8").trimEnd();
    const drifted = `${valid}\n${JSON.stringify({ type: "event_msg", payload: { type: "__novel_drift_kind__" } })}`;
    parseRolloutContent(drifted, "t");

    const snap = snapshotAndReset();
    const hit = snap.counters.find(
      (c) => c.name === "unknown_record_kinds" && c.tags.component === "extraction.codex"
    );
    assert.ok(hit, `expected the drift counter for extraction.codex, got ${JSON.stringify(snap.counters)}`);
    assert.ok(hit.delta >= 1, "the counter must have incremented");
  });
});

describe("Codex context_compacted is a recognized record kind", () => {
  it("a real compaction rollout parses and fires NO drift counter", () => {
    _resetForTests();
    // The inverse of the drift test: `context_compacted` is a real Codex kind (the
    // extractor treats it as a turn boundary), so a rollout carrying it must parse
    // and trip NOTHING — the whole point of registering it is that a real compaction
    // no longer looks like vendor drift.
    const result = parseRolloutContent(readFileSync(caseFile("codex", "compaction"), "utf8"), "t");
    assert.ok(result, "the compaction fixture must parse (session_meta on line 0)");

    const snap = snapshotAndReset();
    const drift = snap.counters.find(
      (c) => c.name === "unknown_record_kinds" && c.tags.component === "extraction.codex"
    );
    assert.ok(
      !drift || drift.delta === 0,
      `context_compacted must be recognized — no codex drift expected, got ${JSON.stringify(drift)}`
    );
  });
});

describe("Claude Code compaction event", () => {
  let tmpDir: string;
  let db: SessionStore;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-t5-cc-"));
    // The extractor treats each subdir of the projects path as a project; drop the
    // compaction fixture in one, unchanged.
    const projects = join(tmpDir, "projects");
    const proj = join(projects, "project_compaction");
    mkdirSync(proj, { recursive: true });
    const src = caseFile("claude-code", "compaction");
    writeFileSync(join(proj, "session.jsonl"), readFileSync(src, "utf8"));
    setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: projects });
    db = new SessionStore(join(tmpDir, "test.db"));
  });

  after(() => {
    setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("emits a COMPACTION timeline event at the compact_boundary", () => {
    extractClaudeCode(db);
    const rows = db.getPendingConversations(1000);
    const withEvents = rows.filter((r) => r.session_events);
    const hasCompaction = withEvents.some((r) => {
      const events = JSON.parse(r.session_events ?? "[]") as { kind: string }[];
      return events.some((e) => e.kind === "SESSION_EVENT_KIND_COMPACTION");
    });
    assert.ok(hasCompaction, "the compaction fixture must yield a COMPACTION event");
  });
});

describe("Kiro greenfield timeline", () => {
  it("turn-brackets: emits native TURN_STARTED/TURN_COMPLETED (Kiro emitted no events before)", () => {
    const parsed = parseIdeMessages(kiroMessageLines("turn-brackets"));
    const kinds = kindsOf(parsed.sessionEvents);
    assert.ok(kinds.includes("TURN_STARTED"), `expected TURN_STARTED: ${kinds.join(",")}`);
    assert.ok(kinds.includes("TURN_COMPLETED"), `expected TURN_COMPLETED: ${kinds.join(",")}`);
  });

  it("turn-brackets: the human prompt reference lands INSIDE its turn bracket, after TURN_STARTED", () => {
    // Kiro writes the `user` record just before `turn_start`. The grouper opens
    // the turn at TURN_STARTED, so the human PROMPT_REFERENCE must be emitted
    // after it — otherwise the prompt strands in the prior turn and this turn is
    // authorless. Assert the first human reference follows the first TURN_STARTED,
    // and no human reference precedes it.
    const parsed = parseIdeMessages(kiroMessageLines("turn-brackets"));
    const seqOf = (pred: (e: (typeof parsed.sessionEvents)[number]) => boolean) =>
      parsed.sessionEvents.find(pred)?.sequence;
    const firstTurnStarted = seqOf((e) => e.kind === "SESSION_EVENT_KIND_TURN_STARTED");
    const firstHumanRef = seqOf(
      (e) => e.kind === "SESSION_EVENT_KIND_PROMPT_REFERENCE" && e.author === "SESSION_EVENT_AUTHOR_HUMAN"
    );
    assert.ok(firstTurnStarted !== undefined, "expected a TURN_STARTED");
    assert.ok(firstHumanRef !== undefined, "expected a human PROMPT_REFERENCE");
    assert.ok(
      firstHumanRef > firstTurnStarted,
      `human prompt (seq ${firstHumanRef}) must sit inside the bracket opened at seq ${firstTurnStarted}`
    );
    const humanBeforeAnyBracket = parsed.sessionEvents.some(
      (e) =>
        e.kind === "SESSION_EVENT_KIND_PROMPT_REFERENCE" &&
        e.author === "SESSION_EVENT_AUTHOR_HUMAN" &&
        e.sequence < firstTurnStarted
    );
    assert.ok(!humanBeforeAnyBracket, "no human prompt reference may precede the first TURN_STARTED");
  });

  it("turn-brackets: a shell TOOL_CALL carries the command as its redacted grounding summary", () => {
    // A consumer's checker-command grounding needs BOTH a recognized tool name
    // and a nonempty summary — an execute_bash result whose TOOL_CALL carried no
    // summary is rejected as evidence even though its exit status is stored. The
    // command must reach the event (bounded + redacted by addExternalToolCall).
    const parsed = parseIdeMessages(kiroMessageLines("turn-brackets"));
    const shellCall = parsed.sessionEvents.find(
      (e) => e.kind === "SESSION_EVENT_KIND_TOOL_CALL" && e.operation_name === "execute_bash"
    );
    assert.ok(shellCall, "expected an execute_bash TOOL_CALL event in the turn-brackets fixture");
    assert.ok(
      typeof shellCall.redacted_summary === "string" && shellCall.redacted_summary.length > 0,
      "the shell TOOL_CALL must carry a nonempty redacted_summary (the command)"
    );
  });

  it("inline-subagents: SUBAGENT edges pair on the child's call_id", () => {
    const parsed = parseIdeMessages(kiroMessageLines("inline-subagents"));
    const starts = parsed.sessionEvents.filter((e) => e.kind === "SESSION_EVENT_KIND_SUBAGENT_STARTED");
    const completes = parsed.sessionEvents.filter((e) => e.kind === "SESSION_EVENT_KIND_SUBAGENT_COMPLETED");
    assert.ok(starts.length > 0, "expected SUBAGENT_STARTED events");
    // Every completed span shares a call_id with an opened one — the pairing the
    // grouper segments on.
    const openIds = new Set(starts.map((e) => e.call_id));
    for (const c of completes) {
      assert.ok(c.call_id && openIds.has(c.call_id), `unpaired SUBAGENT_COMPLETED call_id=${c.call_id}`);
    }
  });

  it("inline-subagents: a user-cancelled turn_end closes CANCELLED, not a fabricated pass", () => {
    // This fixture carries a `stopReason: "cancelled"` turn_end (grep-confirmed).
    const parsed = parseIdeMessages(kiroMessageLines("inline-subagents"));
    const completes = parsed.sessionEvents.filter((e) => e.kind === "SESSION_EVENT_KIND_TURN_COMPLETED");
    assert.ok(
      completes.some((e) => e.outcome === "SESSION_EVENT_OUTCOME_CANCELLED"),
      `expected a CANCELLED TURN_COMPLETED, got ${completes.map((e) => e.outcome).join(",")}`
    );
  });
});

describe("Kiro PROMPT_REFERENCE ordinals survive the sub-execution merge", () => {
  let tmpDir: string;
  let db: SessionStore;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-t5-kiro-"));
    // The extractor walks sessionsRoot/<workspaceHash>/sess_.../, so the session
    // sits under a workspace dir, not the root directly.
    const workspace = join(tmpDir, "ide-sessions", "workspace-hash");
    mkdirSync(workspace, { recursive: true });
    // Copy the whole inline-subagents session (session.json + messages.jsonl +
    // sub-executions/) — it has 6 parent prompts and 43 sub-execution prompts that
    // interleave, so a parse-order ordinal would point at a delegated-agent prompt.
    const caseDir = join(FIXROOT, "kiro", "inline-subagents");
    const sessName = readdirSync(caseDir).find((n) => n.startsWith("sess_"))!;
    cpSync(join(caseDir, sessName), join(workspace, sessName), { recursive: true });
    setPathOverrides({ KIRO_IDE_SESSIONS_PATH: join(tmpDir, "ide-sessions") });
    db = new SessionStore(join(tmpDir, "test.db"));
  });

  after(() => {
    setPathOverrides({ KIRO_IDE_SESSIONS_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  type EventRow = {
    kind: string;
    prompt_ordinal?: number;
    sequence?: number;
    call_id?: string;
  };

  /** Extract once and return the stored conversation + parsed session events. */
  function stored(): { conversation: ConversationPrompt[]; events: EventRow[] } {
    extractKiroIde(db, {});
    const row = db.getPendingConversations(1000).find((r) => r.ide_type === "kiro" && r.session_events);
    assert.ok(row, "a kiro row with events must exist");
    const conversation = (
      typeof row.conversation === "string" ? JSON.parse(row.conversation) : row.conversation
    ) as ConversationPrompt[];
    const events = JSON.parse(row.session_events ?? "[]") as EventRow[];
    return { conversation, events };
  }

  const refsOf = (events: EventRow[]) =>
    events.filter((e) => e.kind === "SESSION_EVENT_KIND_PROMPT_REFERENCE");
  /** 1-based positions of the (non-)sub-agent prompts in the merged conversation. */
  const positionsWhere = (conversation: ConversationPrompt[], sub: boolean) =>
    conversation
      .map((p, i) => ((p.metadata?.isSubAgent === true) === sub ? i + 1 : -1))
      .filter((n) => n > 0);
  const sorted = (ns: number[]) => [...ns].sort((a, b) => a - b);

  it("the stored timeline now carries the children's PROMPT_REFERENCEs and the SUBAGENT span edges", () => {
    const { conversation, events } = stored();
    const refs = refsOf(events);
    assert.ok(refs.length > 0, "expected PROMPT_REFERENCE events");
    // The fix: a delegated child's references now reach the store. Before it, every
    // ref pointed at a parent prompt and this count was zero — the SUBAGENT span was
    // eventless and a consumer could not segment the delegated turns.
    const childRefs = refs.filter((r) => conversation[(r.prompt_ordinal ?? 0) - 1]?.metadata?.isSubAgent === true);
    assert.ok(childRefs.length > 0, "expected at least one child PROMPT_REFERENCE in the stored events");
    // The span edges a consumer segments delegated turns on must survive the merge.
    assert.ok(
      events.some((e) => e.kind === "SESSION_EVENT_KIND_SUBAGENT_STARTED"),
      "expected SUBAGENT_STARTED span edges in the stored events"
    );
    assert.ok(
      events.some((e) => e.kind === "SESSION_EVENT_KIND_SUBAGENT_COMPLETED"),
      "expected SUBAGENT_COMPLETED span edges in the stored events"
    );
  });

  it("child PROMPT_REFERENCE ordinals point at the child prompts, parent ordinals at the parent prompts", () => {
    const { conversation, events } = stored();
    const refs = refsOf(events);
    for (const ref of refs) {
      assert.ok(ref.prompt_ordinal && ref.prompt_ordinal >= 1, "a ref must carry a 1-based ordinal");
      assert.ok(
        conversation[ref.prompt_ordinal - 1],
        `ordinal ${ref.prompt_ordinal} out of range (len ${conversation.length})`
      );
    }
    // Every prompt (parent + child) emits exactly one reference, so the ordinals are
    // a bijection onto 1..N: the parent references land on exactly the parent
    // positions, the child references on exactly the delegated positions. A wrong
    // remap — the bug this guards — would duplicate, drop, or cross those sets.
    const ordinals = sorted(refs.map((r) => r.prompt_ordinal ?? 0));
    assert.deepEqual(
      ordinals,
      sorted(conversation.map((_, i) => i + 1)),
      "PROMPT_REFERENCE ordinals must be a permutation of every conversation position"
    );
    const parentRefOrdinals = sorted(
      refs
        .map((r) => r.prompt_ordinal ?? 0)
        .filter((o) => conversation[o - 1]?.metadata?.isSubAgent !== true)
    );
    const childRefOrdinals = sorted(
      refs
        .map((r) => r.prompt_ordinal ?? 0)
        .filter((o) => conversation[o - 1]?.metadata?.isSubAgent === true)
    );
    // No regression: parent references cover exactly the parent positions.
    assert.deepEqual(parentRefOrdinals, positionsWhere(conversation, false), "parent ordinals drifted");
    // The fix: child references cover exactly the delegated positions.
    assert.deepEqual(childRefOrdinals, positionsWhere(conversation, true), "child ordinals mis-placed");
  });

  it("merged event sequences stay unique and monotonic — children rebased past the parent", () => {
    const { events } = stored();
    const seqs = events.map((e) => e.sequence ?? -1);
    assert.ok(seqs.every((s) => s >= 1), "every event carries a sequence");
    assert.equal(new Set(seqs).size, seqs.length, "sequences must be unique after the merge (children rebased)");
    seqs.reduce((prev, s, i) => {
      if (i > 0) assert.ok(s > prev, `sequence must increase in array order at index ${i}`);
      return s;
    }, 0);
  });
});

describe("drift counter wiring is live for every provider", () => {
  // Codex is covered above; these cover the identical wiring in the Claude Code
  // and Kiro extractors, where a wrong component/derivation/placement would go
  // uncaught — exactly the drift this feature exists to detect.

  it("Kiro: an unrecognized payload.type increments UNKNOWN_RECORD_KINDS for extraction.kiro", () => {
    _resetForTests();
    const lines = [
      JSON.stringify({ id: "1", timestamp: "2026-01-01T00:00:00.000Z", payload: { type: "user", content: "hi" } }),
      JSON.stringify({ id: "2", timestamp: "2026-01-01T00:00:01.000Z", payload: { type: "__novel_kiro_kind__" } }),
    ];
    parseIdeMessages(lines);
    const hit = snapshotAndReset().counters.find(
      (c) => c.name === "unknown_record_kinds" && c.tags.component === "extraction.kiro"
    );
    assert.ok(hit && hit.delta >= 1, "the Kiro drift counter must increment");
  });

  it("Kiro: a record that LOST its payload.type still increments the drift counter", () => {
    // A vendor drop/rename of payload.type is exactly the schema drift the counter
    // exists to catch. The missing-type early-return must not skip the record
    // before it is counted (kiroRecordKind maps the absence to "<none>").
    _resetForTests();
    const lines = [
      JSON.stringify({ id: "1", timestamp: "2026-01-01T00:00:00.000Z", payload: { type: "user", content: "hi" } }),
      JSON.stringify({ id: "2", timestamp: "2026-01-01T00:00:01.000Z", payload: { note: "type field dropped" } }),
    ];
    parseIdeMessages(lines);
    const hit = snapshotAndReset().counters.find(
      (c) => c.name === "unknown_record_kinds" && c.tags.component === "extraction.kiro"
    );
    assert.ok(hit && hit.delta >= 1, "a record with no payload.type must still increment the drift counter");
  });

  describe("Claude Code", () => {
    let tmpDir: string;
    let db: SessionStore;

    before(() => {
      _resetForTests();
      tmpDir = mkdtempSync(join(tmpdir(), "lse-t5-ccdrift-"));
      const projects = join(tmpDir, "projects");
      mkdirSync(join(projects, "project_drift"), { recursive: true });
      const lines = [
        JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, timestamp: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "ok" }, timestamp: "2026-01-01T00:00:01.000Z" }),
        JSON.stringify({ type: "__novel_cc_kind__", timestamp: "2026-01-01T00:00:02.000Z" }),
      ].join("\n");
      writeFileSync(join(projects, "project_drift", "session.jsonl"), lines);
      setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: projects });
      db = new SessionStore(join(tmpDir, "test.db"));
    });

    after(() => {
      setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: undefined });
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    });

    it("an unrecognized line type increments UNKNOWN_RECORD_KINDS for extraction.claude_code", () => {
      extractClaudeCode(db);
      const hit = snapshotAndReset().counters.find(
        (c) => c.name === "unknown_record_kinds" && c.tags.component === "extraction.claude_code"
      );
      assert.ok(hit && hit.delta >= 1, "the Claude Code drift counter must increment");
    });
  });
});
