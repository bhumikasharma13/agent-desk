// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Cursor CLI → normalized session timeline.
 *
 * The CLI is where `/loop` actually runs — the IDE surface has its own store and its own
 * adapter. Its per-session `store.db` holds content-addressed blobs: JSON messages
 * ({role, content}) mixed with binary file snapshots, and the module header warns that the
 * blobs are UNORDERED. That is true of the TABLE, and it is why the usage parser works at
 * conversation grain — but it is not true of the data. Order is recoverable:
 *
 *   a tool blob's id is `call-<uuid>-<N>` + "\n" + `fc_<messageId>_<K>`
 *
 * where N is a per-session ordinal that runs 0,1,2,… across the whole conversation (verified
 * contiguous on a real captured session) and K indexes within one assistant turn. So the tool
 * timeline can be reconstructed exactly, which is what runs, iterations and checks are read
 * from. What stays unrecoverable is the position of user turns relative to it — those blobs
 * carry no id at all — so this emits the TOOL timeline and leaves prompt references to the
 * caller.
 */

import {
  SessionEventBuilder,
  outcomeForExitCode,
  type SessionEvent,
  type SessionEventOutcome,
} from "./sessionEvents";
import { declaredArtifactOf } from "./cursorUsageShared";

/** The trailing ordinal in `call-<uuid>-<N>`, or null when the id is not a tool-call id. */
export function cliToolOrdinal(id: unknown): number | null {
  if (typeof id !== "string") return null;
  // The id carries a newline and a second segment; the ordinal ends the FIRST line.
  const [head] = id.split("\n");
  const m = /-(\d+)$/.exec(head ?? "");
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Outcome from a CLI tool result, read only from statements the tool makes explicitly.
 *
 * Deliberately conservative. `Read` returns the file's contents and says nothing about whether
 * reading succeeded; treating "no error text" as success would manufacture a pass out of an
 * absence, and a consumer reads this as a check's verdict. Only a tool that states its
 * outcome gets one, which means a read-heavy session rates PARTIAL and a check-heavy one
 * rates COMPLETE — that difference is the honest signal, not a defect.
 */
export function cliResultOutcome(result: unknown): SessionEventOutcome {
  const text = typeof result === "string" ? result : "";
  const exit = /^Exit code:\s*(-?\d+)/.exec(text);
  if (exit) return outcomeForExitCode(Number(exit[1]));
  if (text.startsWith("Wrote contents to ")) return "SESSION_EVENT_OUTCOME_SUCCEEDED";
  return "SESSION_EVENT_OUTCOME_UNKNOWN";
}

/** The argument worth naming, in preference order — a path or a command, never a body. */
const ARG_KEYS = ["file_path", "path", "target_file", "command", "pattern", "query"];

function argSummary(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * The artifact this call declares, for `declaredName` — a `Task` dispatch's agent, or a skill
 * whose `SKILL.md` this call read. Undefined leaves the event a plain TOOL_CALL.
 *
 * Shared with the IDE adapter and the usage parsers rather than re-derived: a consumer
 * positions a declaration only when the event's name matches the name the session's own
 * inventory recorded, so a second spelling here would emit events that position nothing.
 */
function declaredNameOf(toolName: string, args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  return declaredArtifactOf(toolName, args as Record<string, unknown>)?.assetName;
}

interface Part {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
}

interface Message {
  role?: string;
  id?: unknown;
  content?: unknown;
}

/**
 * Build the tool timeline for one CLI session from its decoded message blobs.
 *
 * Calls come from assistant turns and results from tool turns; they pair on toolCallId, and
 * the RESULT's blob carries the ordinal that places the pair in the conversation. A call whose
 * result never arrived is emitted at the end rather than dropped — an unanswered tool call is
 * a real thing to have observed, and dropping it would make a truncated session look complete.
 */
export function buildCliSessionEvents(messages: Message[]): {
  events: SessionEvent[];
  coverage: ReturnType<SessionEventBuilder["coverage"]>;
} {
  const calls = new Map<string, Part>();
  const results: Array<{ ordinal: number; part: Part }> = [];

  for (const message of messages) {
    const parts = Array.isArray(message?.content) ? (message.content as Part[]) : [];
    for (const part of parts) {
      if (part?.type === "tool-call" && typeof part.toolCallId === "string") {
        calls.set(part.toolCallId, part);
      } else if (part?.type === "tool-result" && typeof part.toolCallId === "string") {
        const ordinal = cliToolOrdinal(message.id);
        // An unplaceable result still belongs in the timeline; ordering it last is better
        // than discarding evidence that a tool ran.
        results.push({ ordinal: ordinal ?? Number.MAX_SAFE_INTEGER, part });
      }
    }
  }

  results.sort((a, b) => a.ordinal - b.ordinal);

  const builder = new SessionEventBuilder();
  // No per-message timestamp exists in this store, so every event carries the same instant.
  // Sequence is what a consumer orders on; the timestamp is not load-bearing here.
  const at = new Date(0).toISOString();
  const answered = new Set<string>();

  for (const { part } of results) {
    const callId = part.toolCallId!;
    answered.add(callId);
    const call = calls.get(callId);
    const name = call?.toolName ?? part.toolName ?? "unknown";
    builder.addExternalToolCall({
      name,
      at,
      callId,
      declaredName: declaredNameOf(name, call?.args),
      summary: argSummary(call?.args),
    });
    builder.addExternalToolResult({
      at,
      outcome: cliResultOutcome(part.result),
      callId,
      summary: typeof part.result === "string" ? part.result : undefined,
    });
  }

  for (const [callId, call] of calls) {
    if (answered.has(callId)) continue;
    const name = call.toolName ?? "unknown";
    builder.addExternalToolCall({
      name,
      at,
      callId,
      declaredName: declaredNameOf(name, call.args),
      summary: argSummary(call.args),
    });
  }

  return { events: builder.build(), coverage: builder.coverage() };
}
