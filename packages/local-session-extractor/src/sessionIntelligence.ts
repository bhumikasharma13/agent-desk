// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * `toConversation`: one exported row as Session Intelligence's `Conversation`
 * (https://github.com/tetriz-ai/session-intelligence, `conversation.proto`), in
 * the protojson form its parser reads.
 *
 * Every field the extractors write is classified in the tables below: kept under
 * its proto JSON name, mapped to the proto field of the same meaning, or dropped
 * because the proto has no field for it. The tables are keyed by the extractor
 * types, so a new extractor field does not compile until it is classified.
 *
 * Nothing is invented. A value whose type does not fit its proto field (a
 * fraction in an int32, a timestamp with no zone) is left out, because protojson
 * would reject the whole conversation over it.
 */
import type { SessionEvent } from "./extractors/sessionEvents";
import type * as SI from "./types/sessionIntelligence";
import type {
  AgenticSessionConfigPayload,
  AiAttributionMetrics,
  ContextSegment,
  ConversationRow,
  IdeType,
  InstallationMetadata,
  PromptMetadata,
  SessionFacetsPayload,
  SessionLineagePayload,
  SessionMetaPayload,
  StatsCacheSnapshot,
  SubAgentRunPayload,
  TurnUsagePayload,
} from "./types/session";

/** A value converted to its protojson form, or `undefined` when it cannot be. */
type Convert = (value: unknown) => unknown;

/** Kept, under the proto field `to` (its JSON name). */
export interface Keep {
  to: string;
  convert: Convert;
}

/** Not in the contract; `drop` says why. */
export interface Drop {
  drop: string;
}

export type Field = Keep | Drop;

/** One table entry per field of `T`, every field required. */
type Fields<T> = { readonly [K in keyof Required<T>]: Field };

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

/**
 * What a converter writes, so a test can check every table against the proto's
 * descriptor without fixture data: a scalar of a proto type, a Timestamp, an
 * enum's value names, a message's field table, or a list or map of one of them.
 */
export type Shape =
  | { readonly kind: "scalar"; readonly type: "string" | "bool" | "double" | "int32" | "int64" }
  | { readonly kind: "timestamp" }
  | { readonly kind: "enum"; readonly names: readonly string[] }
  | { readonly kind: "message"; readonly fields: Readonly<Record<string, Field>> }
  | { readonly kind: "list" | "map"; readonly of: Shape };

const SHAPES = new WeakMap<Convert, Shape>();

/** What `convert` writes. Every converter in the tables has a shape. */
export function shapeOf(convert: Convert): Shape {
  const shape = SHAPES.get(convert);
  if (shape === undefined) throw new Error("a converter with no shape");
  return shape;
}

function shaped(convert: Convert, shape: Shape): Convert {
  SHAPES.set(convert, shape);
  return convert;
}

const string = shaped((v) => (typeof v === "string" ? v : undefined), { kind: "scalar", type: "string" });
const bool = shaped((v) => (typeof v === "boolean" ? v : undefined), { kind: "scalar", type: "bool" });
const double = shaped((v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined), { kind: "scalar", type: "double" });
const int32 = shaped(
  (v) => (Number.isInteger(v) && (v as number) >= INT32_MIN && (v as number) <= INT32_MAX ? v : undefined),
  { kind: "scalar", type: "int32" },
);
/** A JSON number past 2^53 is not exact, so it is left out rather than written rounded. */
const int64 = shaped((v) => (Number.isSafeInteger(v) ? v : undefined), { kind: "scalar", type: "int64" });

/** RFC 3339 as protojson's Timestamp reads it: a `T`, at most nine fraction digits and a zone. */
const RFC3339 = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

/** A Timestamp's range, 0001-01-01T00:00:00Z to 9999-12-31T23:59:59.999999999Z, in whole milliseconds. */
const TIMESTAMP_MIN_MS = -62_135_596_800_000;
const TIMESTAMP_MAX_MS = 253_402_300_799_999;

const inTimestampRange = (ms: number): boolean => ms >= TIMESTAMP_MIN_MS && ms <= TIMESTAMP_MAX_MS;

/**
 * Kept only when protojson would read it: Date.parse rolls `2026-02-30` and
 * `T24:00:00` over to the next day where protojson refuses them, so the date
 * and time must read back as written, and the instant must be in range.
 */
const timestamp = shaped(
  (v) => {
    if (typeof v !== "string") return undefined;
    const m = RFC3339.exec(v);
    if (m === null) return undefined;
    const [, local, , zone] = m;
    const asWritten = Date.parse(`${local}Z`);
    if (Number.isNaN(asWritten) || new Date(asWritten).toISOString().slice(0, 19) !== local) return undefined;
    const at = Date.parse(`${local}${zone}`);
    return !Number.isNaN(at) && inTimestampRange(at) ? v : undefined;
  },
  { kind: "timestamp" },
);

/** A value from a closed set, renamed through `names`. */
function enumOf(names: Readonly<Record<string, string>>): Convert {
  return shaped((v) => (typeof v === "string" && Object.hasOwn(names, v) ? names[v] : undefined), {
    kind: "enum",
    names: Object.values(names),
  });
}

/** The enum whose stored values already are the proto value names. */
function enumNamed(...values: readonly string[]): Convert {
  return enumOf(Object.fromEntries(values.map((v) => [v, v])));
}

/** A list, kept only when every element converts: dropping one would shift the rest. */
function list(element: Convert): Convert {
  return shaped(
    (v) => {
      if (!Array.isArray(v)) return undefined;
      const out = v.map(element);
      return out.includes(undefined) ? undefined : out;
    },
    { kind: "list", of: shapeOf(element) },
  );
}

/** A string-keyed map; an entry whose value does not convert is left out. */
function map(value: Convert): Convert {
  return shaped(
    (v) => {
      if (!isObject(v)) return undefined;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const converted = value(x);
        if (converted !== undefined) define(out, k, converted);
      }
      return out;
    },
    { kind: "map", of: shapeOf(value) },
  );
}

function message<T>(fields: Fields<T>): Convert {
  const table = fields as Readonly<Record<string, Field>>;
  return shaped((v) => (isObject(v) ? convertMessage(table, v) : undefined), { kind: "message", fields: table });
}

function convertMessage(fields: Readonly<Record<string, Field>>, value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!Object.hasOwn(fields, key) || v === null || v === undefined) continue;
    const field = fields[key]!;
    if ("drop" in field) continue;
    const converted = field.convert(v);
    if (converted !== undefined) define(out, field.to, converted);
  }
  return out;
}

/** Kept under the proto field's JSON name: lowerCamelCase of the snake_case name. */
function keep(name: string, convert: Convert): Keep {
  return { to: name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), convert };
}

function drop(reason: string): Drop {
  return { drop: reason };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A data property, so a `__proto__` key stays an entry. */
function define(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

// ── Enums ────────────────────────────────────────────────────────────────────

const IDE_TYPES: Readonly<Record<IdeType, SI.IdeType>> = {
  "claude-code": "IDE_TYPE_CLAUDE_CODE",
  cursor: "IDE_TYPE_CURSOR",
  copilot: "IDE_TYPE_COPILOT",
  antigravity: "IDE_TYPE_ANTIGRAVITY",
  codex: "IDE_TYPE_CODEX",
  kiro: "IDE_TYPE_KIRO",
};

const ROLES: Readonly<Record<string, SI.Role>> = { user: "ROLE_USER", assistant: "ROLE_ASSISTANT" };

const ideTypeOf = enumOf(IDE_TYPES);
const roleOf = enumOf(ROLES);

const signalSource = enumNamed(
  "SIGNAL_SOURCE_UNSPECIFIED",
  "SIGNAL_SOURCE_SESSION_COMMAND",
  "SIGNAL_SOURCE_VENDOR_FIELD",
  "SIGNAL_SOURCE_SESSION_PROSE",
  "SIGNAL_SOURCE_LOCAL_GIT_WINDOWED",
);

const eventCoverage = enumNamed("EVENT_COVERAGE_COMPLETE", "EVENT_COVERAGE_PARTIAL", "EVENT_COVERAGE_NONE");

// ── Field tables ─────────────────────────────────────────────────────────────

const strings = list(string);
const int32Map = map(int32);

export const PROMPT_METADATA_FIELDS: Fields<PromptMetadata> = {
  model: keep("model", string),
  messageId: keep("messageId", string),
  inputTokens: keep("inputTokens", int64),
  outputTokens: keep("outputTokens", int64),
  cacheCreationInputTokens: keep("cacheCreationInputTokens", int64),
  cacheReadInputTokens: keep("cacheReadInputTokens", int64),
  cacheCreation5mInputTokens: keep("cacheCreation5mInputTokens", int64),
  cacheCreation1hInputTokens: keep("cacheCreation1hInputTokens", int64),
  contextUsagePercent: keep("contextUsagePercent", double),
  isImageAdded: keep("isImageAdded", bool),
  relevantFiles: keep("relevantFiles", strings),
  codeBlockCount: keep("codeBlockCount", int32),
  isSubAgent: keep("isSubAgent", bool),
  authorship: keep(
    "authorship",
    enumNamed("PROMPT_AUTHORSHIP_UNSPECIFIED", "PROMPT_AUTHORSHIP_HUMAN", "PROMPT_AUTHORSHIP_INJECTED"),
  ),
  linesAdded: keep("linesAdded", int32),
  linesRemoved: keep("linesRemoved", int32),
  filesEdited: keep("filesEdited", strings),
  nativeBillingUnits: keep("nativeBillingUnits", double),
  reasoningTokens: keep("reasoningTokens", int64),
  tokenFidelity: keep(
    "tokenFidelity",
    enumNamed("TOKEN_FIDELITY_UNSPECIFIED", "TOKEN_FIDELITY_MEASURED", "TOKEN_FIDELITY_NATIVE_PARTIAL", "TOKEN_FIDELITY_ESTIMATE"),
  ),
  permission_mode: keep("permission_mode", string),
};

const LINEAGE_FIELDS: Fields<SessionLineagePayload> = {
  relation_type: keep(
    "relation_type",
    enumOf({
      PRIMARY: "CONVERSATION_TYPE_PRIMARY",
      SUBAGENT: "CONVERSATION_TYPE_SUBAGENT",
      PLUGIN: "CONVERSATION_TYPE_PLUGIN",
      HOOK: "CONVERSATION_TYPE_HOOK",
    }),
  ),
  parent_record_key: drop(
    "the parent row's store id (a hash); the proto's parent_session_id is the parent's bare vendor session id, a different value",
  ),
  linkage_confidence: keep(
    "linkage_confidence",
    enumOf({ STRONG: "LINKAGE_CONFIDENCE_STRONG", HEURISTIC: "LINKAGE_CONFIDENCE_HEURISTIC", NONE: "LINKAGE_CONFIDENCE_NONE" }),
  ),
  tokens: keep("tokens", int64),
  origin_agent_type: keep("origin_agent_type", string),
  plugin_name: keep("plugin_name", string),
  spawn_depth: keep("spawn_depth", int32),
  tool_use_id: keep("tool_use_id", string),
};

const CONTEXT_SEGMENT_FIELDS: Fields<ContextSegment> = {
  segment: keep("segment", string),
  tokens: keep("tokens", int64),
  chars: keep("chars", int64),
};

const TURN_USAGE_FIELDS: Fields<TurnUsagePayload> = {
  credits: keep("credits", double),
  active_seconds: keep("active_seconds", double),
  context_usage_percent: keep("context_usage_percent", double),
  tool_names: keep("tool_names", strings),
  end_reason: keep("end_reason", string),
  model: keep("model", string),
};

const SUB_AGENT_RUN_FIELDS: Fields<SubAgentRunPayload> = {
  name: keep("name", string),
  status: keep("status", string),
  sub_session_id: keep("sub_session_id", string),
};

const AGENTIC_SESSION_CONFIG_FIELDS: Fields<AgenticSessionConfigPayload> = {
  status: keep("status", string),
  spec_workflow: keep("spec_workflow", string),
  spec_plan_enabled: keep("spec_plan_enabled", bool),
  semantic_review_enabled: keep("semantic_review_enabled", bool),
  fta_enabled: keep("fta_enabled", bool),
};

type PrReference = NonNullable<SessionMetaPayload["pr_references"]>[number];
type BranchSignal = NonNullable<SessionMetaPayload["branch_signals"]>[number];

const PR_REFERENCE_FIELDS: Fields<PrReference> = {
  pr_url: keep("pr_url", string),
  pr_number: keep("pr_number", int32),
  pr_repository: keep("pr_repository", string),
  source: keep("source", signalSource),
};

const BRANCH_SIGNAL_FIELDS: Fields<BranchSignal> = {
  name: keep("name", string),
  source: keep("source", signalSource),
};

export const SESSION_META_FIELDS: Fields<SessionMetaPayload> = {
  languages: keep("languages", int32Map),
  lines_added: keep("lines_added", int32),
  lines_removed: keep("lines_removed", int32),
  files_modified: keep("files_modified", int32),
  git_commits: keep("git_commits", int32),
  git_pushes: keep("git_pushes", int32),
  uses_mcp: keep("uses_mcp", bool),
  uses_web_search: keep("uses_web_search", bool),
  uses_web_fetch: keep("uses_web_fetch", bool),
  uses_task_agent: keep("uses_task_agent", bool),
  user_interruptions: keep("user_interruptions", int32),
  tool_counts: keep("tool_counts", int32Map),
  tool_errors: keep("tool_errors", int32),
  tool_error_categories: keep("tool_error_categories", int32Map),
  user_message_count: keep("user_message_count", int32),
  assistant_message_count: keep("assistant_message_count", int32),
  duration_minutes: keep("duration_minutes", double),
  first_prompt: keep("first_prompt", string),
  project_path: keep("project_path", string),
  start_time: keep("start_time", timestamp),
  compaction_count: keep("compaction_count", int32),
  manual_compaction_count: keep("manual_compaction_count", int32),
  avg_pre_compaction_tokens: keep("avg_pre_compaction_tokens", int32),
  pr_url: keep("pr_url", string),
  pr_number: keep("pr_number", int32),
  pr_repository: keep("pr_repository", string),
  pr_references: keep("pr_references", list(message(PR_REFERENCE_FIELDS))),
  session_title: keep("session_title", string),
  git_branch: keep("git_branch", string),
  git_branches: keep("git_branches", strings),
  branch_signals: keep("branch_signals", list(message(BRANCH_SIGNAL_FIELDS))),
  source: keep("source", string),
  session_kind: keep("session_kind", string),
  tracked_file_paths: keep("tracked_file_paths", strings),
  last_prompt: keep("last_prompt", string),
  bridge_session_url: keep("bridge_session_url", string),
  mcp_server_names: keep("mcp_server_names", strings),
  sub_agent_count: keep("sub_agent_count", int32),
  agent_transcript_count: keep("agent_transcript_count", int32),
  tool_output_count: keep("tool_output_count", int32),
  terminal_session_count: keep("terminal_session_count", int32),
  project_mcp_server_names: keep("project_mcp_server_names", strings),
  user_response_times: keep("user_response_times", list(double)),
  user_message_timestamps: keep("user_message_timestamps", strings),
  message_hours: keep("message_hours", list(int32)),
  cursor_lines_changed: keep("cursor_lines_changed", int32),
  cursor_files_modified: keep("cursor_files_modified", int32),
  cursor_context_usage_percent: keep("cursor_context_usage_percent", double),
  context_composition: keep("context_composition", list(message(CONTEXT_SEGMENT_FIELDS))),
  reported_cost_usd: keep("reported_cost_usd", double),
  context_tokens_used: keep("context_tokens_used", int32),
  context_token_limit: keep("context_token_limit", int32),
  git_sha: keep("git_sha", string),
  reasoning_effort: keep("reasoning_effort", string),
  memory_mode: keep("memory_mode", string),
  approval_mode: keep("approval_mode", string),
  sandbox_policy: keep("sandbox_policy", string),
  uses_extended_thinking: keep("uses_extended_thinking", bool),
  files_edited: keep("files_edited", strings),
  dynamic_tool_names: keep("dynamic_tool_names", strings),
  session_duration_seconds: drop("no wall-clock seconds field; duration_minutes is a different measure"),
  agent_mode: keep("agent_mode", string),
  autonomy_mode: keep("autonomy_mode", string),
  billing_credits_used: keep("billing_credits_used", double),
  quota_invocations_used: keep("quota_invocations_used", int32),
  quota_invocations_limit: keep("quota_invocations_limit", int32),
  total_model_request_count: keep("total_model_request_count", int32),
  total_agent_cycles: keep("total_agent_cycles", int32),
  total_input_tokens: drop("no such field; the proto's input_tokens is Claude Code's session-meta count, not shown to be the same measure"),
  total_output_tokens: drop("no such field; the proto's output_tokens is Claude Code's session-meta count, not shown to be the same measure"),
  ide_context_usage_percent: keep("ide_context_usage_percent", double),
  mcp_context_percent: keep("mcp_context_percent", double),
  steering_context_percent: keep("steering_context_percent", double),
  max_output_tokens: keep("max_output_tokens", int32),
  spec_count: keep("spec_count", int32),
  steering_file_count: keep("steering_file_count", int32),
  hook_count: keep("hook_count", int32),
  steering_docs_used: keep("steering_docs_used", strings),
  steering_inclusion_count: keep("steering_inclusion_count", int32),
  sandbox_allowed_read_paths: keep("sandbox_allowed_read_paths", strings),
  sandbox_allowed_write_paths: keep("sandbox_allowed_write_paths", strings),
  parent_session_id: keep("parent_session_id", string),
  spawned_agent_names: keep("spawned_agent_names", strings),
  lineage: keep("lineage", message(LINEAGE_FIELDS)),
  kiro_id: keep("kiro_id", string),
  tool_approval_outcomes: keep("tool_approval_outcomes", int32Map),
  model_request_attempts: keep("model_request_attempts", int32),
  agent_active_seconds: keep("agent_active_seconds", double),
  turn_usage: keep("turn_usage", list(message(TURN_USAGE_FIELDS))),
  sub_agent_runs: keep("sub_agent_runs", list(message(SUB_AGENT_RUN_FIELDS))),
  user_prompt_chars: keep("user_prompt_chars", int32),
  assistant_response_chars: keep("assistant_response_chars", int32),
  builtin_tool_uses: keep("builtin_tool_uses", int32),
  tool_origin_counts: keep("tool_origin_counts", int32Map),
  agentic_session_config: keep("agentic_session_config", message(AGENTIC_SESSION_CONFIG_FIELDS)),
};

const SESSION_FACETS_FIELDS: Fields<SessionFacetsPayload> = {
  outcome: keep("outcome", string),
  claude_helpfulness: keep("claude_helpfulness", string),
  session_type: keep("session_type", string),
  brief_summary: keep("brief_summary", string),
  underlying_goal: keep("underlying_goal", string),
  goal_categories: keep("goal_categories", int32Map),
  primary_success: keep("primary_success", string),
  friction_counts: keep("friction_counts", int32Map),
  friction_detail: keep("friction_detail", string),
  user_satisfaction_counts: keep("user_satisfaction_counts", int32Map),
};

const INSTALLATION_METADATA_FIELDS: Fields<InstallationMetadata> = {
  plan_tier: keep("plan_tier", string),
  plan_tier_source: keep("plan_tier_source", string),
  login_email: keep("login_email", string),
  device_id: keep("device_id", string),
  entrypoint: keep("entrypoint", string),
  cc_version: keep("cc_version", string),
  platform: keep("platform", string),
  is_oauth_auth: keep("is_oauth_auth", bool),
  organization_uuid: keep("organization_uuid", string),
  account_uuid: keep("account_uuid", string),
  cursor_onboarding_date: keep("cursor_onboarding_date", string),
  cursor_privacy_mode: keep("cursor_privacy_mode", bool),
  cursor_memories_enabled: keep("cursor_memories_enabled", bool),
  cursor_personal_context_configured: keep("cursor_personal_context_configured", bool),
  cursor_conversation_scoring: keep("cursor_conversation_scoring", string),
  is_enterprise_user: keep("is_enterprise_user", bool),
  is_enterprise_trial_user: keep("is_enterprise_trial_user", bool),
  cursor_team_id: keep("cursor_team_id", string),
  cursor_team_role: keep("cursor_team_role", string),
  cursor_user_id: keep("cursor_user_id", string),
  cursor_billing_tier: keep("cursor_billing_tier", string),
  cursor_team_membership_type: keep("cursor_team_membership_type", string),
  cursor_is_yearly_plan: keep("cursor_is_yearly_plan", bool),
  default_model: keep("default_model", string),
  last_chat_mode: keep("last_chat_mode", string),
  ide_version: keep("ide_version", string),
  ide_machine_id: keep("ide_machine_id", string),
  seat_tier: keep("seat_tier", string),
  organization_type: keep("organization_type", string),
  billing_type: keep("billing_type", string),
  organization_role: keep("organization_role", string),
  organization_rate_limit_tier: keep("organization_rate_limit_tier", string),
  user_rate_limit_tier: keep("user_rate_limit_tier", string),
  subscription_created_at: keep("subscription_created_at", timestamp),
  has_extra_usage_enabled: keep("has_extra_usage_enabled", bool),
};

const AI_ATTRIBUTION_FIELDS: Fields<AiAttributionMetrics> = {
  tab_completion_count: keep("tab_completion_count", int32),
  ai_code_percent: keep("ai_code_percent", double),
  tab_suggested_lines: keep("tab_suggested_lines", int32),
  tab_accepted_lines: keep("tab_accepted_lines", int32),
  composer_suggested_lines: keep("composer_suggested_lines", int32),
  composer_accepted_lines: keep("composer_accepted_lines", int32),
  tab_completion_model_breakdown: keep("tab_completion_model_breakdown", int32Map),
  ai_code_percent_v2: keep("ai_code_percent_v2", double),
  deleted_files_count: keep("deleted_files_count", int32),
  tracking_start_time: keep("tracking_start_time", string),
};

type DailyActivity = NonNullable<StatsCacheSnapshot["daily_activity"]>[number];
type DailyModelTokens = NonNullable<StatsCacheSnapshot["daily_model_tokens"]>[number];
type ModelUsage = NonNullable<StatsCacheSnapshot["model_usage"]>[string];

const DAILY_ACTIVITY_FIELDS: Fields<DailyActivity> = {
  date: keep("date", string),
  message_count: keep("message_count", int32),
  session_count: keep("session_count", int32),
  tool_call_count: keep("tool_call_count", int32),
};

const DAILY_MODEL_TOKENS_FIELDS: Fields<DailyModelTokens> = {
  date: keep("date", string),
  tokens_by_model: keep("tokens_by_model", map(int64)),
};

const MODEL_USAGE_FIELDS: Fields<ModelUsage> = {
  input_tokens: keep("input_tokens", int64),
  output_tokens: keep("output_tokens", int64),
  cache_read_input_tokens: keep("cache_read_input_tokens", int64),
  cache_creation_input_tokens: keep("cache_creation_input_tokens", int64),
  web_search_requests: keep("web_search_requests", int32),
};

const STATS_CACHE_FIELDS: Fields<StatsCacheSnapshot> = {
  hour_counts: keep("hour_counts", int32Map),
  daily_activity: keep("daily_activity", list(message(DAILY_ACTIVITY_FIELDS))),
  daily_model_tokens: keep("daily_model_tokens", list(message(DAILY_MODEL_TOKENS_FIELDS))),
  model_usage: keep("model_usage", map(message(MODEL_USAGE_FIELDS))),
  total_sessions: keep("total_sessions", int32),
  total_messages: keep("total_messages", int32),
  longest_session_duration_ms: keep("longest_session_duration_ms", int64),
  longest_session_message_count: keep("longest_session_message_count", int32),
  first_session_date: keep("first_session_date", string),
};

const SESSION_EVENT_FIELDS: Fields<SessionEvent> = {
  sequence: keep("sequence", int64),
  occurred_at: keep("occurred_at", timestamp),
  kind: keep(
    "kind",
    enumNamed(
      "SESSION_EVENT_KIND_PROMPT_REFERENCE",
      "SESSION_EVENT_KIND_TOOL_CALL",
      "SESSION_EVENT_KIND_TOOL_RESULT",
      "SESSION_EVENT_KIND_SKILL_CALL",
      "SESSION_EVENT_KIND_HOOK_CALL",
      "SESSION_EVENT_KIND_COMMAND",
      "SESSION_EVENT_KIND_GOAL",
      "SESSION_EVENT_KIND_API_RETRY",
      "SESSION_EVENT_KIND_COMPACTION",
      "SESSION_EVENT_KIND_TURN_STARTED",
      "SESSION_EVENT_KIND_TURN_COMPLETED",
      "SESSION_EVENT_KIND_SUBAGENT_STARTED",
      "SESSION_EVENT_KIND_SUBAGENT_COMPLETED",
    ),
  ),
  operation_name: keep("operation_name", string),
  call_id: keep("call_id", string),
  parent_call_id: keep("parent_call_id", string),
  outcome: keep(
    "outcome",
    enumNamed(
      "SESSION_EVENT_OUTCOME_SUCCEEDED",
      "SESSION_EVENT_OUTCOME_FAILED",
      "SESSION_EVENT_OUTCOME_CANCELLED",
      "SESSION_EVENT_OUTCOME_UNKNOWN",
    ),
  ),
  redacted_summary: keep("redacted_summary", string),
  prompt_ordinal: keep("prompt_ordinal", int32),
  author: keep(
    "author",
    enumNamed("SESSION_EVENT_AUTHOR_HUMAN", "SESSION_EVENT_AUTHOR_AGENT", "SESSION_EVENT_AUTHOR_DELEGATED_AGENT"),
  ),
};

/** The JSON columns, each converted as one proto message (or list of them). */
export const COLUMNS: ReadonlyArray<readonly [column: string, to: keyof SI.Conversation, convert: Convert]> = [
  ["session_meta", "sessionMeta", message(SESSION_META_FIELDS)],
  ["session_facets", "sessionFacets", message(SESSION_FACETS_FIELDS)],
  ["installation_metadata", "installationMetadata", message(INSTALLATION_METADATA_FIELDS)],
  ["ai_attribution", "aiAttribution", message(AI_ATTRIBUTION_FIELDS)],
  ["stats_cache", "statsCache", message(STATS_CACHE_FIELDS)],
  ["session_events", "sessionEvents", list(message(SESSION_EVENT_FIELDS))],
];

const promptMetadata = message(PROMPT_METADATA_FIELDS);

/**
 * Every converter `toConversation` writes a field with outside `COLUMNS`, by the
 * proto message and JSON name it writes, for the descriptor test.
 */
export const DIRECT_FIELDS: ReadonlyArray<readonly [message: "Conversation" | "Prompt", to: string, convert: Convert]> = [
  ["Conversation", "ideType", ideTypeOf],
  ["Conversation", "sessionId", string],
  ["Conversation", "projectName", string],
  ["Conversation", "conversationStartedAt", timestamp],
  ["Conversation", "lastUpdatedAt", timestamp],
  ["Conversation", "eventCoverage", eventCoverage],
  ["Conversation", "extractorVersion", int32],
  ["Prompt", "role", roleOf],
  ["Prompt", "content", string],
  ["Prompt", "timestamp", timestamp],
  ["Prompt", "metadata", promptMetadata],
];

/**
 * One stored message as a Prompt. Every message becomes one, even a malformed one
 * (with what fits): an event's `promptOrdinal` indexes the prompts by position.
 */
function toPrompt(value: unknown): SI.Prompt {
  const prompt: SI.Prompt = {};
  if (!isObject(value)) return prompt;
  const role = roleOf(value["role"]);
  if (role !== undefined) prompt.role = role as SI.Role;
  if (typeof value["content"] === "string") prompt.content = value["content"];
  const ts = timestamp(value["timestamp"]);
  if (ts !== undefined) prompt.timestamp = ts as string;
  const metadata = promptMetadata(value["metadata"]);
  if (metadata !== undefined) prompt.metadata = metadata as SI.PromptMetadata;
  return prompt;
}

/** SQLite's `datetime('now')` text, which is UTC. */
const SQLITE_DATETIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

/** Epoch milliseconds as a Timestamp, or `undefined` outside the range protojson reads. */
function msToTimestamp(v: unknown): string | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const at = new Date(v);
  return inTimestampRange(at.getTime()) ? at.toISOString() : undefined;
}

/** The earliest prompt time, else the source's own start time, else when the store first wrote the row. */
function startedAt(record: Record<string, unknown>, prompts: readonly SI.Prompt[]): string | undefined {
  let earliest: { at: number; text: string } | undefined;
  for (const p of prompts) {
    if (p.timestamp === undefined) continue;
    const at = Date.parse(p.timestamp.replace(/\.(\d{3})\d+/, ".$1"));
    if (earliest === undefined || at < earliest.at) earliest = { at, text: p.timestamp };
  }
  if (earliest !== undefined) return earliest.text;
  const source = msToTimestamp(record["conversation_source_created_at_ms"]);
  if (source !== undefined) return source;
  const created = record["created_at"];
  const m = typeof created === "string" ? SQLITE_DATETIME.exec(created) : null;
  return m === null ? undefined : `${m[1]}T${m[2]}Z`;
}

/** The last segment of a path, `/` or `\` separated, trailing separators ignored. */
function leaf(path: string): string {
  const parts = path.split(/[/\\]/).filter((p) => p.length > 0);
  return parts.at(-1) ?? "";
}

/**
 * One exported row, as `exportSessions` writes it with `shape: "row"` (already
 * redacted), as Session Intelligence's `Conversation`. It redacts nothing itself.
 * A row whose `ide_type` is not a source this package reads gets no `ideType`,
 * which the proto reads as unspecified.
 */
export function toConversation(record: Record<string, unknown>): SI.Conversation {
  const stored = Array.isArray(record["conversation"]) ? (record["conversation"] as unknown[]) : [];
  const prompts = stored.map(toPrompt);
  // Keys in the proto's field order.
  const out = {} as SI.Conversation;
  const ideType = ideTypeOf(record["ide_type"]);
  if (ideType !== undefined) out.ideType = ideType as SI.IdeType;
  if (typeof record["session_id"] === "string") out.sessionId = record["session_id"];
  if (typeof record["project_path"] === "string") {
    const name = leaf(record["project_path"]);
    if (name.length > 0) out.projectName = name;
  }
  out.prompts = prompts;
  const started = startedAt(record, prompts);
  if (started !== undefined) out.conversationStartedAt = started;
  const updated = msToTimestamp(record["last_mtime_ms"]);
  if (updated !== undefined) out.lastUpdatedAt = updated;
  for (const [column, to, convert] of COLUMNS) {
    const value = record[column];
    if (value === null || value === undefined) continue;
    const converted = convert(value);
    if (converted !== undefined) define(out as unknown as Record<string, unknown>, to, converted);
  }
  const coverage = eventCoverage(record["event_coverage"]);
  if (coverage !== undefined) out.eventCoverage = coverage as SI.EventCoverage;
  const version = int32(record["extractor_version"]);
  if (version !== undefined) out.extractorVersion = version as number;
  return out;
}

/**
 * The row columns `toConversation` reads, and the ones it leaves out with the
 * reason. Exported for the field-coverage test and the reference table.
 */
export const ROW_COLUMNS: { readonly [K in keyof ConversationRow | "relation_type"]: string } = {
  ide_type: "ideType",
  session_id: "sessionId",
  project_path: "projectName (its last segment)",
  conversation: "prompts",
  conversation_source_created_at_ms: "conversationStartedAt, when no prompt has a time",
  created_at: "conversationStartedAt, when neither prompts nor the source give a time",
  last_mtime_ms: "lastUpdatedAt",
  session_meta: "sessionMeta",
  session_facets: "sessionFacets",
  installation_metadata: "installationMetadata",
  ai_attribution: "aiAttribution",
  stats_cache: "statsCache",
  session_events: "sessionEvents",
  event_coverage: "eventCoverage",
  extractor_version: "extractorVersion",
  id: "dropped: the store's row key",
  relation_type: "dropped: the same value is sessionMeta.lineage.relationType",
  repo_name: "dropped: no such field",
  last_size: "dropped: store change tracking",
  last_offset: "dropped: store change tracking",
  content_hash: "dropped: store change tracking",
  last_reextract_at: "dropped: store change tracking",
  tokens_observed: "dropped: store change tracking",
  updated_at: "dropped: store bookkeeping",
  last_message_ms: "dropped: the list order, never exported",
  sync_status: "dropped: store outbox state",
  synced_at: "dropped: store outbox state",
};
