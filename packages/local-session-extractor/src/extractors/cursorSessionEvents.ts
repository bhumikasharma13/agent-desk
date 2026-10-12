// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Cursor bubble → session-event VOCABULARY: the status and argument mappings, and nothing else.
 *
 * The timeline itself is built inline in `cursorExtractor.loadBubbles`, which is the only Cursor
 * mapper. It has to be built there: the prompt ordinal is the position a prompt takes in the list
 * that same loop appends to, so a separate mapper would need the ordinal handed to it and could
 * only ever be a second implementation of the walk it already does.
 *
 * What lives here is the part that is a fact about CURSOR rather than about the walk — how Cursor
 * spells a terminal status, where it keeps a command's exit code, and which of a tool call's
 * arguments names the work. Keeping those out of the extractor is what lets them be tested
 * directly, which is what every bug in this file has needed: each was a field name or a status
 * spelling assumed rather than measured, agreed with by a fixture written from the same guess.
 */

import { outcomeForExitCode, type SessionEventOutcome } from "./sessionEvents";
import { toolArgs } from "./cursorUsageShared";

/** A Cursor bubble, as far as this module cares. The extractor owns the full shape. */
export interface CursorBubble {
  toolFormerData?: {
    name?: string;
    toolCallId?: string;
    /**
     * Cursor's terminal-status vocabulary. Measured on a real 29,839-tool-bubble store:
     * `completed` | `error` | `cancelled` | `loading`, plus absent. NOT `errored` — the
     * spelling is load-bearing, since this is what the outcome mapping switches on.
     */
    status?: string;
    /** JSON-encoded on real data, and camelCase inside. Read via `toolArgs`, never directly. */
    params?: unknown;
    /** JSON-encoded on real data, and snake_case inside. Preferred by `toolArgs`. */
    rawArgs?: unknown;
    /**
     * JSON-encoded tool result. A terminal tool's carries the command's exit code beside its
     * output: `{"output":"…stdout…","exitCode":1,"exitCodeV2":1,…}`. Read via
     * {@link cursorExitCode}.
     */
    result?: unknown;
  };
}

/**
 * Cursor's IDE terminal tools — the tools whose outcome is a command's exit status rather than
 * the tool's own lifecycle.
 *
 * Both names are measured on real stores, and both are live: one machine's history holds
 * thousands of the unversioned form and hundreds of the versioned one, interleaved. The set is
 * kept explicit rather than pattern-matched because a guessed spelling is what these mappings
 * keep getting wrong; a future `_v3` still has its exit code read (that path is name-agnostic),
 * and only loses the guard below — which fails toward UNKNOWN, never toward a synthesized pass.
 *
 * A consumer that grounds a check on these names must use the same list: a name the adapter
 * treats as a terminal tool but the consumer does not is an outcome nothing reads, and the
 * reverse grounds a verdict on an outcome that was never exit-code-derived.
 */
const CURSOR_TERMINAL_TOOLS = new Set(["run_terminal_cmd", "run_terminal_command_v2"]);

/**
 * A top-level `exitCodeV2` / `exitCode` in a tool result, in that order of preference, or null.
 *
 * `exitCodeV2` is the field current Cursor writes and the older `exitCode` sits beside it on a
 * small tail of historical rows (3,178 vs 71 on one real store), so both are read and the
 * current one wins.
 *
 * Scanned rather than JSON-parsed, for the same reason the CLI adapter scans its result text: a
 * terminal result holds the command's whole stdout, which is megabytes for a build log — and a
 * failing build is exactly the case whose exit code must not be lost to a size cap. The key must
 * be preceded by `{` or `,`, which is what separates a real top-level key from the same text
 * occurring inside the captured output: a quote inside a JSON string value is backslash-escaped,
 * so an `\"exitCode\"` printed by the command itself can never match.
 */
const EXIT_CODE_PATTERNS = [
  /[{,]\s*"exitCodeV2"\s*:\s*"?(-?\d+)/,
  /[{,]\s*"exitCode"\s*:\s*"?(-?\d+)/,
];

export function cursorExitCode(result: unknown): number | null {
  if (typeof result !== "string" || result.length === 0) return null;
  for (const pattern of EXIT_CODE_PATTERNS) {
    const m = pattern.exec(result);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Cursor's terminal status vocabulary, mapped to the shared outcome.
 *
 * An unrecognised or absent status resolves to UNKNOWN rather than to success. A consumer
 * reads a result's outcome as a check's verdict, so treating "Cursor told us nothing" as a
 * pass would satisfy a correction bar nothing verified — the same trap the Claude adapter
 * documents for a result with no error flag.
 */
export function cursorOutcomeOf(status: string | undefined): SessionEventOutcome {
  switch (status) {
    case "completed":
      return "SESSION_EVENT_OUTCOME_SUCCEEDED";
    case "error":
      return "SESSION_EVENT_OUTCOME_FAILED";
    case "cancelled":
      return "SESSION_EVENT_OUTCOME_CANCELLED";
    default:
      return "SESSION_EVENT_OUTCOME_UNKNOWN";
  }
}

/**
 * One tool call's outcome: the command's exit code where there is one, the lifecycle status
 * otherwise.
 *
 * The two answer different questions, and only the first one is a verdict. Cursor's `completed`
 * says the tool RAN to completion — a failing test run is a completed terminal invocation — so a
 * mapping that reads it as success reports a failed check as a passing one. Measured on one real
 * store, 1,281 of 3,591 completed terminal bubbles had exited nonzero, all of them stamped
 * SUCCEEDED; the exit code sat unread in the same payload. A consumer overrides the model's own
 * claim with this outcome, so the cost is not lost information — a failed verification is
 * laundered into positive evidence, and grounded pass counts only ever move up.
 *
 * Where they disagree, the exit code wins, whatever the lifecycle says. And a terminal tool
 * cannot claim success without one: an exit code we could not observe leaves the command's result
 * unobserved, so `completed` alone resolves to UNKNOWN rather than to a pass — the same refusal
 * to read silence as success the status mapping already makes. `error` and `cancelled` still
 * stand on their own, since neither manufactures a pass.
 */
export function cursorToolOutcome(data: CursorBubble["toolFormerData"]): SessionEventOutcome {
  const code = cursorExitCode(data?.result);
  if (code !== null) return outcomeForExitCode(code);
  const outcome = cursorOutcomeOf(data?.status);
  if (outcome === "SESSION_EVENT_OUTCOME_SUCCEEDED" && data?.name && CURSOR_TERMINAL_TOOLS.has(data.name)) {
    return "SESSION_EVENT_OUTCOME_UNKNOWN";
  }
  return outcome;
}

/**
 * What one tool status contributes to the session-meta rollup (`tool_errors`,
 * `user_interruptions`) — an explicit mapping over the vocabulary Cursor actually writes.
 *
 * Counted over a real 29,839-tool-bubble store: `completed` 21,757, ABSENT 7,291, `error` 720,
 * `cancelled` 62, `loading` 9. `errored` occurs zero times, so a test on it would leave
 * `tool_errors` always 0 and every one of those 720 real errors uncounted.
 *
 * The two states that are not obviously either thing are decided here rather than left to a
 * truthiness test, because getting them wrong replaces an always-zero with an always-inflated:
 *
 *  - ABSENT is the second most common state, and it is not an error. Cursor simply recorded no
 *    status for the call; counting 7,291 of those as failures would swamp the real 720.
 *  - `cancelled` is the user stopping a tool mid-flight, so it counts as an interruption and not
 *    as a tool error — matching Claude Code's session-meta semantics.
 *  - `loading` is a call still in flight when the store was read. Neither.
 *
 * An unrecognised status contributes nothing, which undercounts a spelling Cursor adds later
 * rather than inflating on one. That is the safer direction but it is still a blind spot: the
 * vocabulary in {@link CursorBubble} is where a newly observed value gets recorded, and this
 * mapping is what has to change with it.
 */
export type CursorStatusEffect = "tool_error" | "user_interruption" | "none";

export function cursorStatusEffect(status: string | undefined): CursorStatusEffect {
  switch (status) {
    case "error":
      return "tool_error";
    case "cancelled":
      return "user_interruption";
    default:
      return "none";
  }
}

/**
 * The argument worth naming for a tool call, in preference order.
 *
 * Same reasoning as the Claude adapter's key list: a call whose summary is empty leaves the
 * consumer only the tool's NAME to describe it, so every `read_file` in an organisation
 * collapses to one identity and unrelated work groups into a fabricated loop. A path or a
 * query is what stops that. Deliberately excluded: file bodies, diffs, and terminal output —
 * a path names the work; its contents are not needed to name it.
 *
 * BOTH spellings are listed because the two fields Cursor carries args in disagree, measured
 * across a real 22,548-tool-bubble store: `rawArgs` is snake_case (`target_file`, `file_path`)
 * and `params` is camelCase (`relativeWorkspacePath`, `targetFile`). Keys that differ only by
 * case are one entry — `path`, `command`, `query` and `pattern` are spelled the same in both.
 */
const SUMMARY_KEYS = [
  "target_file",
  "targetFile",
  "path",
  "file_path",
  "query",
  "command",
  "pattern",
  "relative_workspace_path",
  "relativeWorkspacePath",
];

/**
 * Names the work a Cursor tool call did, for the timeline's `redacted_summary`.
 *
 * Reads args through `toolArgs`, the same resolver the usage parser uses, for two reasons the
 * data forces. Cursor stores both arg fields as a JSON-encoded STRING, not an object — 22,438
 * of 22,548 tool bubbles — so a `typeof params === "object"` test rejects almost every call
 * before looking at a single key. And `rawArgs` is the field that actually carries the naming
 * keys, so it is preferred and `params` is the fallback. Reading `params` as a raw object for
 * snake_case keys agreed with neither half: it summarized 4 of 22,548 calls, leaving the
 * consumer a bare tool name for the rest.
 */
export function cursorToolSummary(data: CursorBubble["toolFormerData"]): string | undefined {
  const args = toolArgs(data);
  for (const key of SUMMARY_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
