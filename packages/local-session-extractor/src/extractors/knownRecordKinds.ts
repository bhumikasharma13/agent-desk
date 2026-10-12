// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The enumerated record kinds each extractor recognizes, and the vendor-drift
 * tripwire built on top of it.
 *
 * Every extractor walks a vendor's transcript and dispatches on a per-record
 * "kind" — Claude Code's `type` (+ `system` subtype), Codex's envelope type over
 * its payload type, Kiro's payload `type`. Handling is inline string literals in
 * each extractor; a record whose kind matches none is silently dropped. That
 * silent drop is exactly how a vendor format change goes unnoticed: the new kind
 * carries signal we now discard, and nothing counts it.
 *
 * This registry is the closed vocabulary of kinds we have SEEN — every kind that
 * occurs in the committed fixture corpus, whether the extractor acts on it or
 * deliberately ignores it. `noteUnknownRecordKind` increments a per-provider
 * counter (and logs, so the specific kind is discoverable) for any record whose
 * kind is not in this set. A sustained rise on that counter is the drift alert.
 *
 * The sentinel test (`knownRecordKinds.sentinel.test.ts`) pins this set to the
 * corpus in BOTH directions: a kind here with no fixture, or a fixture kind
 * missing here, fails the suite. So the registry cannot drift from the corpus, and
 * a kind absent from the corpus cannot be registered — recognizing a genuinely
 * new kind is structurally gated on first capturing a fixture that exercises it.
 */

import { inc } from "../seams/metrics";
import { logger } from "../seams/logger";
import { firstInScan, noteScanUnknownRecordKind } from "../seams/scanScope";

/** The providers this registry covers. Cursor's record kinds are handled by its own extractors. */
export type TurnTelemetryProvider = "claude-code" | "codex" | "kiro";

/**
 * The kind string for one Claude Code transcript line — its `type`, with the
 * `system` family split by `subtype` (`system/compact_boundary`), matching how
 * the extractor's own dispatch distinguishes them.
 */
export function claudeCodeRecordKind(line: { type?: unknown; subtype?: unknown }): string {
  const type = typeof line.type === "string" ? line.type : "<none>";
  if (type === "system" && typeof line.subtype === "string" && line.subtype.length > 0) {
    return `system/${line.subtype}`;
  }
  return type;
}

/**
 * The kind string for one Codex rollout record — the envelope `type`, refined by
 * the inner `payload.type` for the two envelopes that carry one (`response_item`,
 * `event_msg`), so `event_msg/task_started` is distinct from `event_msg/token_count`.
 * `event_msg/item_completed` is refined once more by its `item.type`
 * (`event_msg/item_completed/UserMessage`): one envelope carries every item kind, so
 * without the item type a new one would hide behind the kinds already recognized.
 */
export function codexRecordKind(line: { type?: unknown; payload?: unknown }): string {
  const type = typeof line.type === "string" ? line.type : "<none>";
  if (type === "response_item" || type === "event_msg") {
    const payload = line.payload;
    const pt =
      payload && typeof payload === "object" && typeof (payload as { type?: unknown }).type === "string"
        ? (payload as { type: string }).type
        : undefined;
    if (!pt) return type;
    if (type === "event_msg" && pt === "item_completed") {
      const item = (payload as { item?: unknown }).item;
      const it =
        item && typeof item === "object" && typeof (item as { type?: unknown }).type === "string"
          ? (item as { type: string }).type
          : undefined;
      return it ? `${type}/${pt}/${it}` : `${type}/${pt}`;
    }
    return `${type}/${pt}`;
  }
  return type;
}

/** The kind string for one Kiro message record — its payload `type`. */
export function kiroRecordKind(payload: { type?: unknown }): string {
  return typeof payload.type === "string" ? payload.type : "<none>";
}

/**
 * The recognized vocabulary per provider — every kind present in the committed
 * fixture corpus. Kept identical to the corpus by the sentinel; edit only
 * alongside a fixture that exercises the kind (that ordering is the point).
 */
export const RECOGNIZED_RECORD_KINDS: Record<TurnTelemetryProvider, ReadonlySet<string>> = {
  "claude-code": new Set<string>([
    "ai-title",
    "assistant",
    "atis-latch",
    "attachment",
    "custom-title",
    "file-history-snapshot",
    "last-prompt",
    "mode",
    "permission-mode",
    "pr-link",
    "queue-operation",
    "relocated",
    "result",
    // Each API/network retry Claude Code logs (source: request_retry/connection_retry,
    // retryAttempt, maxRetries) — the extractor emits one API_RETRY event per record.
    "system/api_error",
    "system/away_summary",
    // `/remote-control` bridge lifecycle notice (Claude Code remote-control / Cowork).
    "system/bridge_status",
    "system/compact_boundary",
    "system/init",
    "system/local_command",
    // Cowork (the Claude app's agent mode) routes its transcript through this same
    // claude-code parser, so its agent-mode-only system events are recognized here
    // too — else real Cowork usage trips the zero-tolerance unknown-kind tripwire.
    "system/permission_request",
    "system/permission_response",
    "system/status",
    "system/stop_hook_summary",
    "system/turn_duration",
    "tool_use_summary",
    "user",
    "worktree-state",
  ]),
  codex: new Set<string>([
    "event_msg/agent_message",
    "event_msg/agent_reasoning",
    // Multi-agent "collab" lifecycle events Codex emits when it delegates to sub-agent
    // threads (spawn / close / waiting-on-a-child). Recognized only — the extractor does
    // not act on them; recognizing them stops normal multi-agent usage reading as drift.
    "event_msg/collab_agent_spawn_end",
    "event_msg/collab_close_end",
    "event_msg/collab_waiting_end",
    // Codex compacts its context window in-session and emits this marker; the usage
    // extractor treats it as a turn boundary (flushes the open skill segment before
    // re-baselining, alongside task_complete/turn_aborted — see codexUsage).
    "event_msg/context_compacted",
    // Codex review-mode enter/exit (the `/review` flow). Recognized only.
    "event_msg/entered_review_mode",
    // A turn-fatal error Codex surfaces to the user (e.g. usage-limit), carrying a
    // `codex_error_info` code. Recognized so a real error doesn't read as vendor drift;
    // the extractor does not act on it (no usage/timeline effect).
    "event_msg/error",
    // Tool-lifecycle end records the extractor consumes for the timeline, file/edit
    // accounting, and interruption counting — see codexExtractor's event dispatch.
    "event_msg/exec_command_end",
    "event_msg/exited_review_mode",
    // Codex 0.118 and later write each turn's items here. A UserMessage is read as the
    // user's turn, like `user_message`. An AgentMessage is not read: the turn's final
    // one is task_complete's `last_agent_message`, which is what the extractor stores.
    // CommandExecution and Reasoning are not read either: the timeline comes from their
    // `response_item` forms, and CommandExecution's command signals (files read, git
    // commits, PR links) are not derived from it. Other item types stay unrecognized.
    "event_msg/item_completed/AgentMessage",
    "event_msg/item_completed/CommandExecution",
    "event_msg/item_completed/Reasoning",
    "event_msg/item_completed/UserMessage",
    // An MCP tool call's end record: the extractor counts it and pairs it on the timeline.
    "event_msg/mcp_tool_call_end",
    "event_msg/patch_apply_end",
    "event_msg/task_complete",
    "event_msg/task_started",
    // A `/goal` thread's objective: the extractor writes it as the goal declaration.
    "event_msg/thread_goal_updated",
    "event_msg/thread_settings_applied",
    "event_msg/token_count",
    "event_msg/turn_aborted",
    "event_msg/user_message",
    // Codex web-search tool completion. Recognized only.
    "event_msg/web_search_end",
    "response_item/custom_tool_call",
    "response_item/custom_tool_call_output",
    "response_item/function_call",
    "response_item/function_call_output",
    "response_item/message",
    "response_item/reasoning",
    // Top-level compaction envelope (distinct from `event_msg/context_compacted`) — it
    // carries the replaced history. Recognized only; the extractor does not read it.
    "compacted",
    "session_meta",
    "turn_context",
    "world_state",
  ]),
  kiro: new Set<string>([
    "assistant",
    "interaction_resolved",
    "pending_interaction",
    "session_event",
    "session_metadata",
    "session_start",
    "steering_inclusion",
    "sub_agent_complete",
    "sub_agent_start",
    "tool_call",
    "tool_result",
    "turn_end",
    "turn_start",
    "usage_summary",
    "user",
  ]),
};

/** The logging/metrics component for a provider — the `extraction.<ide>` convention. */
function componentFor(provider: TurnTelemetryProvider): string {
  return `extraction.${provider.replace(/-/g, "_")}`;
}

// One (provider, kind) is logged at most once per scan, or once per process
// outside a scan — the counter still increments on every occurrence (that is the
// rate signal), but a broadly-drifted session must not fire thousands of
// identical warn lines (each a stack capture + sanitize + a log line).
// Seeing the kind once is enough to discover it.
const loggedUnknownKinds = new Set<string>();

/**
 * Counts a record whose kind the extractor does not recognize, and logs the kind
 * (once) so the specific drift is discoverable. A no-op for a recognized kind, so
 * it is safe to call once per record at the top of an extractor's walk —
 * recognized kinds (handled or deliberately skipped) never fire it.
 *
 * The kind string itself is deliberately NOT a metric label — an unbounded vendor
 * string would explode metric cardinality — so the counter's only dimension is
 * the provider (`component`); the kind rides the log line instead.
 */
export function noteUnknownRecordKind(provider: TurnTelemetryProvider, kind: string): void {
  if (RECOGNIZED_RECORD_KINDS[provider].has(kind)) return;
  const component = componentFor(provider);
  inc("unknown_record_kinds", {
    component,
    errorKind: "parse",
    status: "skipped",
  });
  // Qualified by provider because the same kind string means different records
  // in different vendors' formats.
  noteScanUnknownRecordKind(`${provider}:${kind}`);
  if (firstInScan(`unknown_record_kind ${provider} ${kind}`, loggedUnknownKinds)) {
    logger.warn(component, "unknown_record_kind", { kind });
  }
}

// Log-once per scan (or per process outside a scan) per (provider, kind, field) —
// the same discipline `noteUnknownRecordKind` applies to whole kinds, for the same
// reason: the counter still increments on every miss (the rate signal), but a
// session whose vendor renamed a field must not fire thousands of identical warns.
// Seeing the field once names the drift.
const loggedMissingFields = new Set<string>();

/**
 * Counts a RECOGNIZED record that is missing a field the extractor consumes, and
 * logs the field path (once) so the specific drift is discoverable.
 *
 * This is the second half of the drift tripwire: `noteUnknownRecordKind` catches a
 * whole NEW/renamed kind, but a field renamed INSIDE a still-recognized kind (say
 * Claude Code's `message.usage` token object) keeps the kind recognized — the
 * parser reads the renamed field as absent and silently emits zero, and nothing
 * counts it. So this reuses the unknown-kind counter's name and labels, and a host
 * watching that counter sees this drift too. The FIELD PATH goes to the log line,
 * never a label, to keep label cardinality bounded, as for the kind string above.
 *
 * A no-op if `kind` is not recognized: an unrecognized record is already `noteUnknownRecordKind`'s
 * to count, and double-firing would inflate the same counter twice for one record.
 */
export function noteMissingConsumedField(
  provider: TurnTelemetryProvider,
  kind: string,
  fieldPath: string,
  // Bounded extra keys (e.g. expected/got shape) that ride the log line ONLY. Never
  // a metric label — the counter's cardinality is fixed by the reasons above.
  detail?: Record<string, string>,
): void {
  if (!RECOGNIZED_RECORD_KINDS[provider].has(kind)) return;
  const component = componentFor(provider);
  inc("unknown_record_kinds", {
    component,
    errorKind: "parse",
    status: "skipped",
  });
  // Dedup the log per (field, failure mode), not just per field: a field first seen
  // absent and later seen in a wrong shape is a genuinely new drift whose expected/got
  // detail still owes its one log line. `got` is the failure mode (absent vs each wrong
  // shape); the counter above already fired on every miss regardless — only the log is
  // deduped.
  if (firstInScan(`missing_consumed_field ${provider} ${kind} ${fieldPath} ${detail?.got ?? "absent"}`, loggedMissingFields)) {
    logger.warn(component, "missing_consumed_field", { kind, field: fieldPath, ...detail });
  }
}

/** The one runtime shape a choke-point field is required to have. */
export type ConsumedShape = "string" | "object" | "array";

function matchesShape(value: unknown, shape: ConsumedShape): boolean {
  switch (shape) {
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    // "object" is a plain object — an array is JS-typeof "object" but a different shape.
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

/** The observed shape, for the drift log — bounded (a JS typeof plus "array"/"null"). */
function shapeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Read a critical field off a recognized record, firing the drift tripwire when it
 * is absent. Presence is the test — `undefined`/`null` is missing; an empty string,
 * empty array, or `0` is a real value and passes (a zero-token turn is data, not
 * drift). The value is RETURNED unchanged either way, so the parser behaves exactly
 * as before — the field is simply read as absent, and now the absence is counted.
 *
 * Apply ONLY to a field that is present on every real record of `kind` (the guard
 * cannot tell a rename from a field that was always optional — an optional field
 * would cry wolf). The token-bearing and message-bearing fields whose silent loss
 * corrupts a whole session are the intended callers; see each extractor's call site
 * for why the specific path is always-present there.
 */
export function requireConsumedField<T>(
  provider: TurnTelemetryProvider,
  kind: string,
  fieldPath: string,
  value: T,
): T {
  if (value === undefined || value === null) {
    noteMissingConsumedField(provider, kind, fieldPath);
  }
  return value;
}

/**
 * The type-asserting sibling of `requireConsumedField`. Presence is not enough at a
 * choke point where the parser reads ONE shape: a vendor that emits the field in a
 * valid ALTERNATE shape — a message as a content-block array where the parser expects
 * a string, a token object arriving as a scalar — leaves the field present, so
 * `requireConsumedField` waves it through while the parser reads it as empty and
 * silently drops the turn or the session. This fires the SAME
 * drift tripwire when the field is absent OR present in the wrong `shape`, so a
 * shape-drift shows up on the existing unknown-kind alert with the expected/observed
 * shapes on the log line. The value is RETURNED unchanged — the drift is observed,
 * never corrected, exactly like the presence guard.
 *
 * Fully supersedes `requireConsumedField` for a field that is BOTH always-present and
 * single-shaped. Apply ONLY where the field genuinely has one shape on every real
 * record (verified against the fixtures): a legitimately dual-shaped field — Claude
 * Code's `message.content`, a string OR a block-array — must stay on
 * `requireConsumedField`, or the guard cries wolf on the valid alternate.
 */
export function requireConsumedShape<T>(
  provider: TurnTelemetryProvider,
  kind: string,
  fieldPath: string,
  value: T,
  shape: ConsumedShape,
): T {
  // Absence is `requireConsumedField`'s semantics — delegate so both guards share one
  // definition of "missing"; then layer the wrong-shape check on a value that is present.
  requireConsumedField(provider, kind, fieldPath, value);
  if (value !== undefined && value !== null && !matchesShape(value, shape)) {
    noteMissingConsumedField(provider, kind, fieldPath, { expected: shape, got: shapeOf(value) });
  }
  return value;
}
