// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Normalized session-event timeline.
 *
 * Loop detection needs to know what happened in a session and in what order —
 * which tools ran, which of them reported failure, which commands and skills were
 * invoked, and where each of those sits relative to the messages. The flattened
 * prompt text cannot express that: tool results, nesting, and hook/skill ordering
 * are all lost in it.
 *
 * This module builds an ordered timeline alongside the existing prompt list. Two
 * rules keep it honest:
 *
 *  1. It never duplicates message text. A PROMPT_REFERENCE event points at a
 *     prompt by its one-based ordinal, and the prompt list stays the single
 *     authority for content.
 *  2. It reports its own completeness. `event_coverage` states whether this
 *     adapter could observe the event classes loop detection needs, so the
 *     consumer can exclude an incompletely-observed session from comparable rates
 *     rather than reading it as a session that had no loops.
 */

import { redactText } from "../redaction";
import { invokedCommandArgs, invokedCommandName } from "./claudeCommandTurn";
import type { PromptAuthorship } from "../types/session";

/** Event kinds. */
export type SessionEventKind =
  | "SESSION_EVENT_KIND_PROMPT_REFERENCE"
  | "SESSION_EVENT_KIND_TOOL_CALL"
  | "SESSION_EVENT_KIND_TOOL_RESULT"
  | "SESSION_EVENT_KIND_SKILL_CALL"
  | "SESSION_EVENT_KIND_HOOK_CALL"
  | "SESSION_EVENT_KIND_COMMAND"
  | "SESSION_EVENT_KIND_GOAL"
  // Positional turn-shape markers a turn grouper places inside the turn each one's
  // sequence falls in: COMPACTION marks where the window was compacted; API_RETRY
  // marks where the harness retried a failed API/network call (Claude Code's
  // `system/api_error` record); the TURN_* pair is a provider-native bracket
  // (Codex/Kiro) a turn grouper honors instead of the human-prompt cut; the SUBAGENT_*
  // pair brackets an inline delegated span, its child id in `call_id` and name in
  // `operation_name` so concurrent spans stay distinguishable.
  | "SESSION_EVENT_KIND_COMPACTION"
  | "SESSION_EVENT_KIND_API_RETRY"
  | "SESSION_EVENT_KIND_TURN_STARTED"
  | "SESSION_EVENT_KIND_TURN_COMPLETED"
  | "SESSION_EVENT_KIND_SUBAGENT_STARTED"
  | "SESSION_EVENT_KIND_SUBAGENT_COMPLETED";

/**
 * Who authored one turn.
 *
 * Stamped on PROMPT_REFERENCE events only. It exists because loop detection's autonomy bar
 * turns on telling a person's turn from an agent's, and the ordinal alone cannot say — the role
 * lives on the prompt, so a reader of the timeline would have to dereference a parallel list.
 * Most prompt references in an agentic session are the agent's own, so a consumer that reads
 * `PROMPT_REFERENCE` as "a human spoke" sees a human in almost every step.
 */
export type SessionEventAuthor =
  | "SESSION_EVENT_AUTHOR_HUMAN"
  | "SESSION_EVENT_AUTHOR_AGENT"
  | "SESSION_EVENT_AUTHOR_DELEGATED_AGENT";

/** Observed completion state. */
export type SessionEventOutcome =
  | "SESSION_EVENT_OUTCOME_SUCCEEDED"
  | "SESSION_EVENT_OUTCOME_FAILED"
  | "SESSION_EVENT_OUTCOME_CANCELLED"
  | "SESSION_EVENT_OUTCOME_UNKNOWN";

/**
 * The outcome a command's own exit code states.
 *
 * Shared by every adapter that can reach one, because the mapping is a fact about processes
 * rather than about a harness: a command that exited nonzero did not succeed, whatever its
 * runner reports about having finished. Each adapter still owns how it FINDS the code — Cursor's
 * IDE reads a JSON field on the tool result, its CLI parses an `Exit code:` line — and what it
 * does when there is none, which is the part that differs between them.
 */
export function outcomeForExitCode(code: number): SessionEventOutcome {
  return code === 0 ? "SESSION_EVENT_OUTCOME_SUCCEEDED" : "SESSION_EVENT_OUTCOME_FAILED";
}

/** Coverage rating. */
export type EventCoverage =
  | "EVENT_COVERAGE_COMPLETE"
  | "EVENT_COVERAGE_PARTIAL"
  | "EVENT_COVERAGE_NONE";

/** One entry in the normalized timeline. */
export interface SessionEvent {
  sequence: number;
  occurred_at: string;
  kind: SessionEventKind;
  operation_name?: string;
  call_id?: string;
  parent_call_id?: string;
  outcome: SessionEventOutcome;
  redacted_summary?: string;
  prompt_ordinal?: number;
  author?: SessionEventAuthor;
}

/**
 * Bounds a non-message summary. Matches a consumer's excerpt limit so a summary
 * cannot change length class when a consumer re-redacts it.
 */
const SUMMARY_MAX_LEN = 200;

/**
 * Extra characters kept before redaction so a secret straddling the summary bound is
 * still matched whole. Comfortably longer than the longest pattern the redactor looks
 * for (a PEM header, a JWT).
 */
const SECRET_HEADROOM = 400;

/**
 * Tool names whose result text is checker evidence. Every tool result still becomes
 * a TOOL_RESULT event carrying its outcome; this set decides only which results are
 * worth a text summary. Restricting it matters: a Read or Edit result would put file
 * content into the record for no detection benefit, while a Bash result's first line
 * is usually the pass/fail signal itself.
 */
const CHECKER_TOOL_NAMES = new Set([
  // Claude Code
  "Bash",
  "BashOutput",
  // Cursor — the shell tool a check actually runs through. Named here rather than in the
  // Cursor adapter so one set answers "is this result checker evidence" for every harness;
  // a per-adapter set would let one harness quietly stop recognising its own checks.
  "run_terminal_cmd",
  // Codex — `exec_command` is its command runner; `shell`/`local_shell` are its vendor-named siblings.
  "exec_command",
  "shell",
  "local_shell",
  // Kiro — its shell tool. Absent here, a Kiro Bash result's pass/fail first line
  // (the checker evidence this set exists to keep) would be silently dropped.
  "execute_bash",
]);

/** Slash commands that declare a loop outright. */
const LOOP_COMMAND_NAMES = new Set(["loop", "goal"]);

/**
 * A JSONL line as far as this module cares. Deliberately structural: the
 * extractor owns the full shape, and duplicating it here would drift.
 */
export interface TimelineLine {
  type?: string;
  timestamp?: unknown;
  message?: {
    content?: unknown;
    role?: string;
  };
  toolUseResult?: unknown;
  isMeta?: boolean;
}

/** Accumulates the timeline while the extractor walks a session's lines. */
export class SessionEventBuilder {
  private events: SessionEvent[] = [];
  private sequence = 0;
  /**
   * Result-outcome observability, counted rather than flagged.
   *
   * A single boolean cannot tell "one result out of forty reported an outcome" from "all
   * forty did", and those are very different sessions to read a loop out of.
   */
  private resultsWithOutcome = 0;
  private resultsTotal = 0;
  private sawToolCall = false;
  /**
   * call_id → tool name, so a result can be attributed to the tool that produced it.
   * Results arrive in a later message than their call, so the mapping cannot be
   * derived from adjacency.
   */
  private toolNameByCallId = new Map<string, string>();

  /**
   * Records a message and returns its prompt ordinal.
   *
   * The ordinal is supplied by the caller because it must match the position in
   * the stored prompt list exactly — the extractor skips continuation
   * summaries and empty messages, so a counter maintained here would drift out
   * of step with the list a consumer dereferences into.
   *
   * `author` is required rather than optional so a new adapter cannot silently ship a
   * role-less timeline: a consumer then reads every turn as authorless, and an authorless
   * turn is never counted as human, which quietly credits autonomy the session never had.
   * Derive it with `promptReferenceAuthor` from the very prompt this ordinal points at.
   */
  addPromptReference(
    promptOrdinal: number,
    timestamp: string | undefined,
    author: SessionEventAuthor
  ): void {
    this.events.push({
      sequence: ++this.sequence,
      occurred_at: timestamp ?? new Date(0).toISOString(),
      kind: "SESSION_EVENT_KIND_PROMPT_REFERENCE",
      // Deliberately empty: content is reached through the ordinal, never copied.
      outcome: "SESSION_EVENT_OUTCOME_SUCCEEDED",
      prompt_ordinal: promptOrdinal,
      author,
    });
  }

  /**
   * Records the tool calls, skill/command invocations, and results carried by one
   * message.
   */
  addMessageEvents(line: TimelineLine, timestamp: string | undefined): void {
    const at = timestamp ?? new Date(0).toISOString();
    const content = line.message?.content;

    if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        const blockType = typeof b.type === "string" ? b.type : "";

        if (blockType === "tool_use") {
          this.addToolUse(b, at);
        } else if (blockType === "tool_result") {
          this.addToolResult(b, at);
        }
      }
    }

    // A slash command opening a user message is a declaration. It is emitted as a typed
    // COMMAND event so a consumer does not have to fall back to scanning prompt text —
    // a fallback that cannot see this at all, because the prompt text it scans is the
    // stored markup rather than the `/name` the user typed.
    if (line.type === "user") {
      const text = firstTextOf(content);
      const command = invokedCommandName(text);
      if (command) {
        this.events.push({
          sequence: ++this.sequence,
          occurred_at: at,
          kind: LOOP_COMMAND_NAMES.has(command)
            ? "SESSION_EVENT_KIND_COMMAND"
            : "SESSION_EVENT_KIND_SKILL_CALL",
          operation_name: command,
          outcome: "SESSION_EVENT_OUTCOME_SUCCEEDED",
          // The ARGUMENTS, not just the name. `/loop 5m …` and `/loop keep going until green`
          // are different KINDS of loop, and the name alone cannot tell them apart — a typed
          // event carrying only `loop` forces a consumer back onto the prompt text this event
          // exists to spare it. Bounded and redacted like every other summary, because these
          // are raw user arguments and can carry a path or a token.
          redacted_summary: boundedInvocationArgs(invokedCommandArgs(text)),
        });
      }
    }
  }

  private addToolUse(block: Record<string, unknown>, at: string): void {
    const name = typeof block.name === "string" ? block.name : "unknown";
    const callId = typeof block.id === "string" ? block.id : undefined;
    this.sawToolCall = true;

    // Two tools are really declaration boundaries rather than plain calls, and both must
    // surface under the NAME of the thing they invoked, not the name of the invoking tool:
    //
    //  * Task/Agent spawning a named agent is the delegation boundary loop detection needs.
    //  * `Skill` is how a skill is actually invoked. Emitting it as a TOOL_CALL named
    //    "Skill" loses the skill's identity entirely, so a loop-capable skill was only ever
    //    detected when a human happened to type `/name` as a slash command instead.
    const delegationTarget = name === "Task" || name === "Agent" ? delegationTargetOf(block) ?? name : undefined;
    const skillTarget = name === "Skill" ? skillTargetOf(block) : undefined;
    const declaredName = skillTarget ?? delegationTarget;
    if (callId) {
      // Keyed on the invoking tool's own name: the result-side checker lookup asks "was
      // this a Bash result", which is a question about the tool, not about what it invoked.
      this.toolNameByCallId.set(callId, name);
    }
    this.events.push({
      sequence: ++this.sequence,
      occurred_at: at,
      kind: declaredName ? "SESSION_EVENT_KIND_SKILL_CALL" : "SESSION_EVENT_KIND_TOOL_CALL",
      operation_name: declaredName ?? name,
      call_id: callId,
      // A call's own outcome is not knowable at call time — the paired result
      // carries it. UNKNOWN here is the honest value, not a placeholder.
      outcome: "SESSION_EVENT_OUTCOME_UNKNOWN",
      redacted_summary: boundedSummary(commandSummaryOf(block)),
    });
  }

  private addToolResult(block: Record<string, unknown>, at: string): void {
    const callId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    const observed = typeof block.is_error === "boolean";
    this.resultsTotal += 1;
    if (observed) {
      this.resultsWithOutcome += 1;
    }

    // Only a checker tool's result carries a text summary; every other result
    // contributes its outcome alone.
    const toolName = callId ? this.toolNameByCallId.get(callId) : undefined;
    const summary = toolName && isCheckerTool(toolName) ? boundedSummary(resultSummaryOf(block)) : undefined;

    this.events.push({
      sequence: ++this.sequence,
      occurred_at: at,
      kind: "SESSION_EVENT_KIND_TOOL_RESULT",
      // parent_call_id links the result to the call that produced it, which is how
      // a check is attributed to the action it verified.
      parent_call_id: callId,
      // UNKNOWN when the source reported no status, never SUCCEEDED. Read/Edit/Grep results
      // carry no error flag, so defaulting to SUCCEEDED synthesized a pass out of an absence
      // — and a consumer reads this field as a check's verdict, so that synthetic pass would
      // overwrite a genuinely reported failure and satisfy a correction bar nothing verified.
      // UNKNOWN is the honest value and a consumer already falls back when it sees one.
      outcome: !observed
        ? "SESSION_EVENT_OUTCOME_UNKNOWN"
        : block.is_error === true
          ? "SESSION_EVENT_OUTCOME_FAILED"
          : "SESSION_EVENT_OUTCOME_SUCCEEDED",
      redacted_summary: summary,
    });
  }

  /**
   * Records a tool call observed by a harness that does not use Claude's content-block shape.
   *
   * The Claude path parses blocks because that is the form its transcript takes; every other
   * harness already has the call decomposed (a name, an id, a status), so it needs the event
   * primitive rather than a second parser. Routing both through one builder is what keeps
   * sequence numbering, call/result pairing and the coverage rating identical across sources —
   * a per-harness timeline builder would let two sources disagree about what COMPLETE means.
   */
  addExternalToolCall(args: {
    name: string;
    at: string;
    callId?: string;
    declaredName?: string;
    summary?: string;
  }): void {
    this.sawToolCall = true;
    if (args.callId) {
      this.toolNameByCallId.set(args.callId, args.name);
    }
    this.events.push({
      sequence: ++this.sequence,
      occurred_at: args.at,
      kind: args.declaredName ? "SESSION_EVENT_KIND_SKILL_CALL" : "SESSION_EVENT_KIND_TOOL_CALL",
      operation_name: args.declaredName ?? args.name,
      call_id: args.callId,
      // As on the Claude path: a call's own outcome is not knowable at call time.
      outcome: "SESSION_EVENT_OUTCOME_UNKNOWN",
      redacted_summary: args.summary === undefined ? undefined : boundedSummary(args.summary),
    });
  }

  /**
   * Records the result of an externally-observed tool call.
   *
   * `outcome` is passed rather than derived because each harness reports status its own way,
   * and UNKNOWN must stay reachable: a consumer reads this as a check's verdict, so
   * synthesising a pass out of a harness that said nothing would satisfy a correction bar
   * nothing verified.
   */
  addExternalToolResult(args: {
    at: string;
    outcome: SessionEventOutcome;
    callId?: string;
    summary?: string;
  }): void {
    this.resultsTotal += 1;
    if (args.outcome !== "SESSION_EVENT_OUTCOME_UNKNOWN") {
      this.resultsWithOutcome += 1;
    }
    const toolName = args.callId ? this.toolNameByCallId.get(args.callId) : undefined;
    const summary =
      toolName && isCheckerTool(toolName) && args.summary !== undefined
        ? boundedSummary(args.summary)
        : undefined;
    this.events.push({
      sequence: ++this.sequence,
      occurred_at: args.at,
      kind: "SESSION_EVENT_KIND_TOOL_RESULT",
      parent_call_id: args.callId,
      outcome: args.outcome,
      redacted_summary: summary,
    });
  }

  /**
   * Records a goal declaration — an objective the run that follows is measured against.
   *
   * `operation_name` carries the OBJECTIVE TEXT, not an artifact name. That inversion is the
   * contract a consumer reads: a GOAL event is identified by its KIND, and it names the
   * artifact `goal` itself, so putting a name here instead would cost it the objective. The
   * text is bounded and redacted exactly like an invocation's arguments, because that is what
   * it is — raw text a person typed, which can carry a path or a token.
   *
   * `redacted_summary` is deliberately left unset: a consumer prefers a declaration's summary
   * over its `operation_name` when reading the run's objective, so anything put there — a
   * status, a note — would REPLACE the objective in the run's digest.
   *
   * The outcome is UNKNOWN because a transcript cannot say whether the objective was met: a
   * harness records that in its own goal store, and claiming SUCCEEDED here would manufacture
   * a verdict out of an absence.
   */
  addGoalDeclaration(args: { objective: string; at: string | undefined }): void {
    this.events.push({
      sequence: ++this.sequence,
      occurred_at: args.at ?? new Date(0).toISOString(),
      kind: "SESSION_EVENT_KIND_GOAL",
      operation_name: boundedInvocationArgs(args.objective),
      outcome: "SESSION_EVENT_OUTCOME_UNKNOWN",
    });
  }

  /** Records where the context window was compacted — a positional boundary. */
  addCompaction(at: string | undefined): void {
    this.events.push({
      sequence: ++this.sequence,
      occurred_at: at ?? new Date(0).toISOString(),
      kind: "SESSION_EVENT_KIND_COMPACTION",
      // A boundary that occurred; it carries no pass/fail verdict of its own.
      outcome: "SESSION_EVENT_OUTCOME_SUCCEEDED",
    });
  }

  /**
   * Records one API/network retry — Claude Code logs each retry as a `system/api_error`
   * record. `operation_name` carries the retry SOURCE (`request_retry`/`connection_retry`);
   * the attempt position rides `redacted_summary` as bounded structured text (never the
   * record's raw `error` string, which is free text that can carry a path or token).
   *
   * The outcome is SUCCEEDED — a positional marker that OCCURRED, carrying no pass/fail
   * verdict of its own (the same reason `addCompaction` uses SUCCEEDED). It must NOT be
   * FAILED: a consumer's outcome-generic discard ledger counts every FAILED/CANCELLED
   * event as abandoned-work evidence, and a transient network retry is not abandoned work.
   */
  addApiRetry(args: {
    // Closed vocabulary — the parse site drops any other value rather than ship it raw
    // into the stored `operation_name`.
    source: "request_retry" | "connection_retry" | undefined;
    retryAttempt: number | undefined;
    maxRetries: number | undefined;
    at: string | undefined;
  }): void {
    const attempt = typeof args.retryAttempt === "number" ? args.retryAttempt : undefined;
    const max = typeof args.maxRetries === "number" ? args.maxRetries : undefined;
    const summary =
      attempt === undefined ? undefined : max === undefined ? `attempt ${attempt}` : `attempt ${attempt} of ${max}`;
    this.events.push({
      sequence: ++this.sequence,
      occurred_at: args.at ?? new Date(0).toISOString(),
      kind: "SESSION_EVENT_KIND_API_RETRY",
      operation_name: args.source,
      outcome: "SESSION_EVENT_OUTCOME_SUCCEEDED",
      redacted_summary: summary,
    });
  }

  /** Records a provider-native turn opening edge (Codex `task_started`, Kiro `turn_start`). */
  addTurnStarted(at: string | undefined): void {
    this.events.push({
      sequence: ++this.sequence,
      occurred_at: at ?? new Date(0).toISOString(),
      kind: "SESSION_EVENT_KIND_TURN_STARTED",
      outcome: "SESSION_EVENT_OUTCOME_SUCCEEDED",
    });
  }

  /**
   * Records a provider-native turn closing edge (Codex `task_complete`, Kiro `turn_end`).
   *
   * A turn that never closes emits NO completion — the caller simply omits this
   * call, and a consumer's turn grouper closes the open bracket at the next `TURN_STARTED` or
   * the timeline end. So this is only ever a real close; `outcome`
   * carries the provider's stop signal (an aborted/interrupted turn is CANCELLED),
   * defaulting to SUCCEEDED when the provider states nothing.
   */
  addTurnCompleted(at: string | undefined, outcome: SessionEventOutcome = "SESSION_EVENT_OUTCOME_SUCCEEDED"): void {
    this.events.push({
      sequence: ++this.sequence,
      occurred_at: at ?? new Date(0).toISOString(),
      kind: "SESSION_EVENT_KIND_TURN_COMPLETED",
      outcome,
    });
  }

  /**
   * Opens an inline sub-agent span. `callId` is the child's id and `name` its
   * operation name; the matching close shares the id so concurrent spans stay
   * distinguishable. Outcome is UNKNOWN — a span's result is not
   * knowable at its opening edge, exactly as a TOOL_CALL's is not.
   */
  addSubagentStarted(args: { at: string | undefined; callId?: string; name?: string }): void {
    this.events.push({
      sequence: ++this.sequence,
      occurred_at: args.at ?? new Date(0).toISOString(),
      kind: "SESSION_EVENT_KIND_SUBAGENT_STARTED",
      operation_name: args.name,
      call_id: args.callId,
      outcome: "SESSION_EVENT_OUTCOME_UNKNOWN",
    });
  }

  /**
   * Closes an inline sub-agent span. Shares the child's id with its opening edge;
   * `outcome` carries the provider's completion status (UNKNOWN when it states none,
   * never a synthesized pass — a consumer reads this as the span's verdict).
   */
  addSubagentCompleted(args: {
    at: string | undefined;
    callId?: string;
    outcome: SessionEventOutcome;
  }): void {
    this.events.push({
      sequence: ++this.sequence,
      occurred_at: args.at ?? new Date(0).toISOString(),
      kind: "SESSION_EVENT_KIND_SUBAGENT_COMPLETED",
      call_id: args.callId,
      outcome: args.outcome,
    });
  }

  /** Returns the built timeline. */
  build(): SessionEvent[] {
    return this.events;
  }

  /**
   * Rates how completely this session was observed.
   *
   * COMPLETE requires both halves of a verify-correct cycle to be visible: tool calls (the
   * actions) AND tool results carrying an explicit outcome (the checks). A session with
   * calls but no observable outcomes can still show that work happened, but cannot prove a
   * check passed or failed — so it is PARTIAL, and a consumer keeps it out of comparable
   * observed rates instead of counting it as a session without loops.
   *
   * The bar is a MAJORITY of results, not a single one. Read/Edit/Write/Grep results carry
   * no `is_error`, and measured across real sessions ~47% of all results have no outcome at
   * all — so "at least one" admitted sessions where a handful of Bash calls were observable
   * and everything else was dark. Those then sat in the denominator of the headline observed
   * rate as if fully read. COMPLETE is the strong claim on this surface; it should mean the
   * timeline is mostly legible, and anything less is disclosed as partial rather than
   * silently averaged in.
   */
  coverage(): EventCoverage {
    if (this.events.length === 0) return "EVENT_COVERAGE_NONE";
    const majorityObservable = this.resultsWithOutcome > 0 && this.resultsWithOutcome * 2 >= this.resultsTotal;
    if (this.sawToolCall && majorityObservable) return "EVENT_COVERAGE_COMPLETE";
    return "EVENT_COVERAGE_PARTIAL";
  }
}

/**
 * The author to stamp on the PROMPT_REFERENCE for one prompt.
 *
 * The single derivation of a prompt's author. Three things wear
 * the `user` role without a person having typed them, and each must not read as human:
 *
 *  - a delegated agent's turn — whether its sub-execution is folded into the parent transcript
 *    (Kiro, Cursor) or forms its own child session linked back by lineage (Claude Code subagent
 *    transcripts) — `metadata.isSubAgent`;
 *  - a turn the harness injected: a local-command caveat, a resume reminder, command output —
 *    `opts.injected`, which the caller supplies from the source's own marker (Claude Code's
 *    `isMeta`). It is stamped AGENT, meaning machine authorship. Strictly it is the harness and
 *    not the model that produced it; no consumer separates those today, and one that needs to
 *    wants a new author value rather than a re-reading of this one;
 *  - an assistant turn, which is the common case: most references in an agentic session are the
 *    agent narrating between its own tool calls.
 *
 * Getting any of them wrong is not a cosmetic slip. A consumer reads this field and nothing
 * else, and a producer's stamp wins over the prompt list, so a turn mis-stamped HUMAN inside a
 * run's cycle disqualifies that run's autonomy with no later correction available.
 *
 * Structural on purpose, like `TimelineLine` above — the extractors own the full prompt shape,
 * and duplicating it here would drift.
 */
export function promptReferenceAuthor(
  prompt: { role: "user" | "assistant"; metadata?: { isSubAgent?: boolean } },
  opts?: { injected?: boolean }
): SessionEventAuthor {
  // An injected turn wears the user role without a person having typed it. Checked BEFORE the
  // role, because the role is exactly what makes it look human.
  if (opts?.injected === true) return "SESSION_EVENT_AUTHOR_AGENT";
  if (prompt.role !== "user") return "SESSION_EVENT_AUTHOR_AGENT";
  return prompt.metadata?.isSubAgent === true
    ? "SESSION_EVENT_AUTHOR_DELEGATED_AGENT"
    : "SESSION_EVENT_AUTHOR_HUMAN";
}

/**
 * Whose words a message's text is, for PromptMetadata.authorship — the message-level
 * companion to promptReferenceAuthor's event-level author. A prompts[]-only consumer
 * reads this off the message; it cannot reach the
 * event timeline where the author stamp lives.
 *
 * INJECTED covers machine text wearing the user role: `opts.injected` from the source's
 * own marker (Claude Code's isMeta and its command/stdout markup, Cursor's
 * simulatedMessageMetadata), and a folded sub-agent turn (isSubAgent). A non-injected
 * user turn is HUMAN. Anything not a user turn is UNSPECIFIED.
 *
 * Only call this from a surface that can actually attest a plain user turn is human;
 * a surface whose user turns carry no injected marker (Codex) must NOT call it — it
 * leaves authorship unset, which is UNSPECIFIED, read as not-human.
 */
export function promptAuthorship(
  prompt: { role: "user" | "assistant"; metadata?: { isSubAgent?: boolean } },
  opts?: { injected?: boolean }
): PromptAuthorship {
  if (prompt.role !== "user") return "PROMPT_AUTHORSHIP_UNSPECIFIED";
  if (opts?.injected === true) return "PROMPT_AUTHORSHIP_INJECTED";
  if (prompt.metadata?.isSubAgent === true) return "PROMPT_AUTHORSHIP_INJECTED";
  return "PROMPT_AUTHORSHIP_HUMAN";
}

/** Extracts the delegated agent type from a Task tool_use block. */
function delegationTargetOf(block: Record<string, unknown>): string | undefined {
  const input = block.input;
  if (typeof input !== "object" || input === null) return undefined;
  const agentType = (input as Record<string, unknown>).subagent_type;
  return typeof agentType === "string" && agentType.length > 0 ? agentType : undefined;
}

/**
 * Input keys that identify WHAT a tool call did, in preference order.
 *
 * The list is load-bearing for loop detection, not decorative. A call whose input matches
 * none of these ships no summary, and a consumer then has only the tool's NAME to describe
 * it — so `Edit`, `Read`, and `Write` all collapse to their own name, the digest of that
 * name is stable, and unrelated runs across different people group into one fabricated
 * "loop". `file_path` and `skill` are what stop that at source.
 *
 * Deliberately excluded: `old_string`, `new_string`, `content`, and anything else carrying
 * file bodies or diffs. Those stay in the transcript; a path names the work, its contents
 * are not needed to name it.
 */
const SUMMARY_INPUT_KEYS = [
  "command",
  "description",
  "skill",
  "pattern",
  "query",
  "prompt",
  "subagent_type",
  "file_path",
  "notebook_path",
] as const;

/**
 * Summarizes a tool call from the input keys that name the work — never file contents or
 * diffs, which stay in the transcript.
 */
function commandSummaryOf(block: Record<string, unknown>): string {
  const input = block.input;
  if (typeof input !== "object" || input === null) return "";
  const i = input as Record<string, unknown>;
  for (const key of SUMMARY_INPUT_KEYS) {
    const value = i[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return "";
}

/** Extracts the skill name a `Skill` tool call invoked. */
function skillTargetOf(block: Record<string, unknown>): string | undefined {
  const input = block.input;
  if (typeof input !== "object" || input === null) return undefined;
  const skill = (input as Record<string, unknown>).skill;
  return typeof skill === "string" && skill.trim().length > 0 ? skill.trim() : undefined;
}

/**
 * Summarizes a tool result. Only checker-relevant tools contribute text, and only
 * their first line — enough to tell a pass from a failure without carrying log
 * output into the record.
 */
function resultSummaryOf(block: Record<string, unknown>): string {
  const content = block.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = firstTextOf(content);
  }
  if (!text) return "";
  const firstLine = text.split("\n", 1)[0] ?? "";
  return firstLine;
}

/** Returns the first text block's content from a message content array. */
function firstTextOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const block of content) {
    if (typeof block === "string") return block;
    if (typeof block === "object" && block !== null) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") return b.text;
    }
  }
  return "";
}

/**
 * Redacts and bounds a summary.
 *
 * The redaction is the point, not the bounding: these summaries are built from raw
 * tool input (a Bash command line) and raw tool output, so a bearer token, an exported
 * key, or a home-directory path would otherwise be written to the local DB and exported
 * verbatim. `redactText` is the same facade this extractor already applies to prompts
 * and paths — a consumer re-redacting the stored excerpt does not help, because by
 * then the raw value has already left the machine.
 */
function boundedSummary(text: string): string | undefined {
  // Slice first, then redact. At most SUMMARY_MAX_LEN code points survive, and the
  // generous headroom keeps any secret that straddles the bound fully inside the slice —
  // so redaction coverage of the surviving text is unchanged, while the cost stops
  // scaling with a multi-KB tool input on the extraction hot path.
  const collapsed = redactCollapse(Array.from(text).slice(0, SUMMARY_MAX_LEN + SECRET_HEADROOM).join(""));
  if (!collapsed) return undefined;
  const chars = Array.from(collapsed);
  if (chars.length <= SUMMARY_MAX_LEN) return collapsed;
  return chars.slice(0, SUMMARY_MAX_LEN).join("");
}

/**
 * The safety half of bounding: redact, then normalize whitespace. Never truncates — the caller
 * decides which end to keep, and a helper that cut here could only ever cut from the front.
 *
 * Horizontal whitespace collapses; the newline does not. In a Bash summary the newline is a
 * statement separator, and flattening it merges every line into one statement judged by its
 * first word — a consumer then reads a `go test` on line two as carrying no verdict, and a
 * `grep` on line one as carrying an independent pass. Runs of blank lines still collapse.
 */
function redactCollapse(text: string): string {
  return redactText(text)
    .replace(/[^\S\n]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Marks the cut in a head-and-tail bound. Counted against the budget so the result still fits. */
const ELLIPSIS = " … ";

/**
 * Bounds an invocation's ARGUMENTS, keeping both ends.
 *
 * `boundedSummary` keeps the head, which is right for a tool call — a path or a command leads it.
 * A command's arguments are different: the token that decides the run's TYPE can be last.
 * `/loop <a long objective> every 30m` puts the schedule at the end, and a head-only cut turns a
 * scheduled loop into a self-paced one silently, because a consumer reads this field as the
 * invocation and nothing downstream can tell a truncated argument string from a complete one.
 * Real invocations do run past the cap — a captured `/goal` on one machine exceeds it — so this is
 * a reachable case, not a theoretical one.
 *
 * Both ends are redacted independently, each with the same secret headroom `boundedSummary` uses,
 * so a secret straddling either cut is still matched whole and the cost stays bounded rather than
 * scaling with a multi-KB argument string.
 */
function boundedInvocationArgs(text: string): string | undefined {
  const chars = Array.from(text);
  if (chars.length <= SUMMARY_MAX_LEN) {
    return boundedSummary(text);
  }

  // Head-heavy split: the objective is what a reader wants, the tail is what the type resolver
  // needs, and a trailing schedule clause is short.
  const tailBudget = 40;
  const headBudget = SUMMARY_MAX_LEN - tailBudget - Array.from(ELLIPSIS).length;

  // Each end is redacted with the same headroom `boundedSummary` uses, so a secret straddling
  // either cut is still matched whole and the cost does not scale with a multi-KB argument string.
  // Truncation is applied AFTER redaction and from the correct side — running the tail through
  // `boundedSummary` would cut it from the head and drop the very clause this exists to keep.
  const head = Array.from(redactCollapse(chars.slice(0, headBudget + SECRET_HEADROOM).join("")))
    .slice(0, headBudget)
    .join("");
  const tailChars = Array.from(redactCollapse(chars.slice(-(tailBudget + SECRET_HEADROOM)).join("")));
  const tail = tailChars.slice(Math.max(0, tailChars.length - tailBudget)).join("");

  if (!head) return tail || undefined;
  if (!tail) return head;
  return head + ELLIPSIS + tail;
}

/** True when the tool's result text is worth summarizing as checker evidence. */
function isCheckerTool(name: string): boolean {
  return CHECKER_TOOL_NAMES.has(name);
}
