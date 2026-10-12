// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Masks secrets, email addresses and the local user name in text, paths and
 * prompts. Every function is idempotent.
 */

import type { ConversationPrompt, SessionMetaPayload } from "../types/session";
import { redactSecrets } from "./secrets";
import { anonymizeText, anonymizePath, deanonymizePath } from "./anonymizer";

/**
 * Redacts secrets and anonymizes usernames/paths in free text.
 * Pipeline: anonymize paths/usernames first, then scrub secrets.
 */
export function redactText(text: string): string {
  if (text.length === 0) return text;
  return redactSecrets(anonymizeText(text));
}

/**
 * Anonymizes an absolute file path (replaces real username with hash).
 */
export function redactPath(path: string): string {
  return anonymizePath(path);
}

/**
 * An error's message, redacted. A Node fs error ends its message with the path it
 * failed on, quoted (`EACCES: permission denied, scandir '<path>'`, or `… '<path>' ->
 * '<dest>'`), and the quoted-string rule would mask that path whole, hiding which
 * folder failed. Those paths come back through `redactPath` and then `redactText` as
 * bare text, so the user name is hashed and a token in a folder name is still masked;
 * the rest of the message goes through `redactText`.
 */
export function redactErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const { path, dest } = (typeof err === "object" && err !== null ? err : {}) as { path?: unknown; dest?: unknown };
  if (typeof path !== "string") return redactText(message);
  // Node writes ` '<path>'`, then ` -> '<dest>'` when the call had one.
  const tail = (show: (p: string) => string): string =>
    ` '${show(path)}'` + (typeof dest === "string" ? ` -> '${show(dest)}'` : "");
  const raw = tail((p) => p);
  if (!message.endsWith(raw)) return redactText(message);
  return redactText(message.slice(0, message.length - raw.length)) + tail((p) => redactText(redactPath(p)));
}

/**
 * Inverse of `redactPath`, local-only: reconstructs a real on-disk path from one
 * this machine redacted (the username hash → real username). Non-home and
 * foreign-hash paths pass through unchanged.
 */
export function unredactPath(path: string): string {
  return deanonymizePath(path);
}

// Redaction class for every SessionMetaPayload field. Because this is
// `Record<keyof SessionMetaPayload, …>`, adding a field to the payload without
// classifying it here is a **compile error** — a new leak-capable field cannot
// silently ship unredacted, which is the recurring failure this choke point exists
// to end. "text" → redactText (user/model prose that can reproduce a secret or a
// path); "path" → redactPath per element (absolute paths carrying the home/username
// segment); "nested" → a JSON value (or its JSON text) whose string leaves each go
// through redactPath then redactText; "structured" → left as-is (ids, counts, timestamps, enums, branch /
// tool / mcp / agent names — none of which carry the home segment or free text).
//
// "names" → redactPath per string member (names, but a writer can put a path there);
// "bridge" → the URL's host and leading path kept, its last segment masked and its query
// dropped, because the last segment is an opaque session token no pattern recognises.
type FieldKind = "text" | "path" | "nested" | "names" | "bridge" | "structured";

const SESSION_META_FIELD_KIND: Record<keyof SessionMetaPayload, FieldKind> = {
  // free text
  first_prompt: "text",
  last_prompt: "text",
  session_title: "text",
  bridge_session_url: "bridge",
  // filesystem paths
  project_path: "path",
  tracked_file_paths: "path",
  files_edited: "path",
  sandbox_allowed_read_paths: "path",
  sandbox_allowed_write_paths: "path",
  // Names today, but they reference steering files — "path" is a no-op on a bare
  // name and redacts the home segment if a writer ever emits an absolute path.
  steering_docs_used: "path",
  // structured — no home segment, no free text
  languages: "structured",
  lines_added: "structured",
  lines_removed: "structured",
  files_modified: "structured",
  git_commits: "structured",
  git_pushes: "structured",
  uses_mcp: "structured",
  uses_web_search: "structured",
  uses_web_fetch: "structured",
  uses_task_agent: "structured",
  user_interruptions: "structured",
  tool_counts: "structured",
  tool_errors: "structured",
  tool_error_categories: "structured",
  user_message_count: "structured",
  assistant_message_count: "structured",
  duration_minutes: "structured",
  start_time: "structured",
  compaction_count: "structured",
  manual_compaction_count: "structured",
  avg_pre_compaction_tokens: "structured",
  pr_url: "text",
  pr_number: "structured",
  pr_repository: "structured",
  pr_references: "structured",
  git_branch: "structured",
  git_branches: "structured",
  branch_signals: "structured",
  source: "structured",
  session_kind: "structured",
  mcp_server_names: "names",
  sub_agent_count: "structured",
  agent_transcript_count: "structured",
  tool_output_count: "structured",
  terminal_session_count: "structured",
  project_mcp_server_names: "names",
  user_response_times: "structured",
  user_message_timestamps: "structured",
  message_hours: "structured",
  cursor_lines_changed: "structured",
  cursor_files_modified: "structured",
  cursor_context_usage_percent: "structured",
  context_composition: "structured",
  reported_cost_usd: "structured",
  context_tokens_used: "structured",
  context_token_limit: "structured",
  git_sha: "structured",
  reasoning_effort: "structured",
  memory_mode: "structured",
  approval_mode: "structured",
  // Codex's policy object, stored as its JSON text: its writable roots are
  // absolute home paths. "nested" redacts every string leaf and keeps the shape.
  sandbox_policy: "nested",
  uses_extended_thinking: "structured",
  dynamic_tool_names: "structured",
  session_duration_seconds: "structured",
  agent_mode: "structured",
  autonomy_mode: "structured",
  billing_credits_used: "structured",
  quota_invocations_used: "structured",
  quota_invocations_limit: "structured",
  total_model_request_count: "structured",
  total_agent_cycles: "structured",
  total_input_tokens: "structured",
  total_output_tokens: "structured",
  ide_context_usage_percent: "structured",
  mcp_context_percent: "structured",
  steering_context_percent: "structured",
  max_output_tokens: "structured",
  spec_count: "structured",
  steering_file_count: "structured",
  hook_count: "structured",
  steering_inclusion_count: "structured",
  parent_session_id: "structured",
  spawned_agent_names: "structured",
  lineage: "structured",

  // Agentic session detail. All structured by construction: these carry ids,
  // counts, enums and vendor tokens only. The two free-text values the sources
  // offer — a sub_agent_start `prompt`/`explanation`, and the shell command in a
  // tool-approval `question` — are deliberately NOT captured into any of them,
  // so no field here needs redactText.
  kiro_id: "structured",
  tool_approval_outcomes: "structured",
  model_request_attempts: "structured",
  agent_active_seconds: "structured",
  turn_usage: "structured",
  sub_agent_runs: "structured",
  user_prompt_chars: "structured",
  assistant_response_chars: "structured",
  builtin_tool_uses: "structured",
  tool_origin_counts: "structured",
  agentic_session_config: "structured",
};

/**
 * Redacts every text and path field of a session's details and keeps the rest.
 * A key this version does not classify, or a classified field holding a value of
 * a type its kind does not expect, has every string and every object key in it
 * redacted. Never throws. Idempotent.
 */
export function sanitizeSessionMeta(meta: SessionMetaPayload): SessionMetaPayload {
  const out = { ...meta } as Record<string, unknown>;

  // A key this version does not classify (a newer writer's field) gets every leaf redacted.
  for (const key of Object.keys(out)) {
    if (!Object.hasOwn(SESSION_META_FIELD_KIND, key)) out[key] = redactLeaves(out[key]);
  }

  for (const key of Object.keys(SESSION_META_FIELD_KIND) as (keyof SessionMetaPayload)[]) {
    const kind = SESSION_META_FIELD_KIND[key];
    if (kind === "structured") continue;
    if (!(key in out)) continue;
    const val = out[key];
    // A path or a name list member that is not a string is not the expected shape either.
    const eachPath = (items: unknown[]) => items.map((p) => (typeof p === "string" ? redactPath(p) : redactLeaves(p)));
    if (kind === "text") {
      out[key] = typeof val === "string" ? redactText(val) : redactLeaves(val);
    } else if (kind === "bridge") {
      out[key] = typeof val === "string" ? maskBridgeUrl(val) : redactLeaves(val, maskBridgeUrl);
    } else if (kind === "nested") {
      out[key] = redactNested(val);
    } else if (kind === "names") {
      out[key] = Array.isArray(val) ? eachPath(val) : redactLeaves(val);
    } else {
      // "path" — a scalar path or an array of paths.
      out[key] = typeof val === "string" ? redactPath(val) : Array.isArray(val) ? eachPath(val) : redactLeaves(val);
    }
  }

  return out as SessionMetaPayload;
}

/** A bridge URL with its host and leading path kept, its last segment masked and its query dropped. */
function maskBridgeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return redactText(url);
  }
  const segments = parsed.pathname.split("/");
  // The last non-empty segment is the session token, with or without a trailing slash.
  for (let i = segments.length - 1; i > 0; i--) {
    if (segments[i] !== "") {
      segments[i] = "████████";
      break;
    }
  }
  return redactText(`${parsed.origin}${segments.join("/")}`);
}

/**
 * Redacts every string leaf of a JSON value, keeping its shape. A string that
 * parses to an object or array is JSON text: its leaves are redacted and it is
 * re-serialized. Any other string is a single leaf.
 */
function redactNested(val: unknown): unknown {
  if (typeof val !== "string") return redactLeaves(val);
  let parsed: unknown;
  try {
    parsed = JSON.parse(val);
  } catch {
    return redactLeaves(val);
  }
  return parsed !== null && typeof parsed === "object" ? JSON.stringify(redactLeaves(parsed)) : redactLeaves(val);
}

/** Every string leaf (through `leaf`) and every object key redacted, the shape kept. */
export function redactLeaves(val: unknown, leaf: (s: string) => string = (s) => redactText(redactPath(s))): unknown {
  if (typeof val === "string") return leaf(val);
  if (Array.isArray(val)) return val.map((v) => redactLeaves(v, leaf));
  if (val !== null && typeof val === "object") {
    return Object.fromEntries(Object.entries(val).map(([k, v]) => [redactText(redactPath(k)), redactLeaves(v, leaf)]));
  }
  return val;
}

/**
 * Returns a new array of prompts with redacted content and metadata.
 * The original array is not mutated.
 */
export function redactPrompts(prompts: ConversationPrompt[]): ConversationPrompt[] {
  return prompts.map((prompt) => {
    const redactedContent = redactText(prompt.content);

    // Deep-copy metadata only if it has a path-bearing field that needs
    // redaction. Both relevantFiles (referenced) and filesEdited (per-message
    // edits) hold absolute paths that can carry the username/home segment, so
    // both go through anonymizePath — the rest of the metadata is structured.
    let metadata = prompt.metadata;
    if (
      (metadata?.relevantFiles && metadata.relevantFiles.length > 0) ||
      (metadata?.filesEdited && metadata.filesEdited.length > 0)
    ) {
      metadata = {
        ...metadata,
        ...(metadata.relevantFiles && metadata.relevantFiles.length > 0
          ? { relevantFiles: metadata.relevantFiles.map(anonymizePath) }
          : {}),
        ...(metadata.filesEdited && metadata.filesEdited.length > 0
          ? { filesEdited: metadata.filesEdited.map(anonymizePath) }
          : {}),
      };
    }

    return {
      ...prompt,
      content: redactedContent,
      metadata,
    };
  });
}
