// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The record types every extractor writes and the store keeps.
 */

// ── IDE source types ─────────────────────────────────────────────────────────

export type IdeType = "claude-code" | "cursor" | "copilot" | "antigravity" | "codex" | "kiro";

// Runtime enumeration of every IdeType. Kept in lockstep with the union above by
// the exhaustiveness check below: adding a member to the union without adding it
// here (or vice versa) is a compile error. Consumers that must iterate all sources
// at runtime (e.g. the per-ide smoke sampling query) use this rather than
// re-listing the literals.
export const IDE_TYPES = [
  "claude-code",
  "cursor",
  "copilot",
  "antigravity",
  "codex",
  "kiro",
] as const satisfies readonly IdeType[];

// Compile-time guard that IDE_TYPES covers the whole union (not just a subset).
// `satisfies` above already proves every array member is a valid IdeType; this
// proves the reverse — every IdeType is present in the array — by assigning an
// IdeType to the array's element-union type. A union member missing from the
// array makes IdeType wider than that element type, so this assignment errors.
const _ideTypesExhaustive: (typeof IDE_TYPES)[number] = (null as unknown as IdeType);
void _ideTypesExhaustive;

// ── Per-message metadata (consistent across all IDE extractors) ─────────────

// Whose words a user-role message's text is. The absent case is UNSPECIFIED and is read as NOT human, so
// a surface that cannot attest authorship leaves the field unset rather than guess.
export type PromptAuthorship =
  | "PROMPT_AUTHORSHIP_UNSPECIFIED"
  | "PROMPT_AUTHORSHIP_HUMAN"
  | "PROMPT_AUTHORSHIP_INJECTED";

/**
 * Trust tier of a message's token counts.
 * Stamped by the extractor on every token-bearing message so a consumer can hold
 * ESTIMATE-sourced counts to a lower bar than MEASURED ones. UNSPECIFIED is a
 * message with no token counts at all.
 */
export type TokenFidelity =
  | "TOKEN_FIDELITY_UNSPECIFIED"
  | "TOKEN_FIDELITY_MEASURED"
  | "TOKEN_FIDELITY_NATIVE_PARTIAL"
  | "TOKEN_FIDELITY_ESTIMATE";

export interface PromptMetadata {
  model?: string;
  // Provider's stable per-response id (Claude Code: message.id), repeated on
  // every content-block line of one billed response. Empty for sources with no
  // such id.
  messageId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  // Anthropic prompt-caching write TTL split. Read from
  // usage.cache_creation.ephemeral_{5m,1h}_input_tokens. Anthropic guarantees
  // the flat cacheCreationInputTokens equals the sum of these two.
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
  contextUsagePercent?: number;
  isImageAdded?: boolean;
  relevantFiles?: string[];
  codeBlockCount?: number;
  // Marks a turn produced by a delegated agent rather than by the human and the
  // session's main agent. Set only where a surface folds a sub-agent transcript
  // into its parent conversation instead of emitting a separate session (Kiro).
  // Anything measuring human interaction must exclude these.
  isSubAgent?: boolean;
  // Whose words this user-role message is — HUMAN for a typed prompt, INJECTED for
  // machine text wearing the user role (skill/slash-command expansion, command
  // output, a folded sub-agent turn). Absent = UNSPECIFIED, read as not-human; left
  // absent on assistant messages and on surfaces that cannot attest it (Codex).
  authorship?: PromptAuthorship;
  // Device-counted added/removed line totals across this message's edit
  // operations. PRESENT (incl. 0) means a count was available; ABSENT means the
  // message's edits were uncountable (e.g. Cursor edit_file_v2 blob pointers) or
  // it edited nothing — the wire keeps that unset-vs-zero distinction via presence.
  linesAdded?: number;
  linesRemoved?: number;
  // Files this message's edit operations touched (paths, not contents).
  filesEdited?: string[];
  // The vendor's own measured cost for the native turn this message closes
  // (Kiro: credits), stamped on the assistant message carrying the turn's usage.
  nativeBillingUnits?: number;
  // The provider-reported reasoning-token bucket, where the provider breaks it out
  // (Codex last_token_usage.reasoning_output_tokens). A subset of outputTokens.
  reasoningTokens?: number;
  // Trust tier of THIS message's token counts. Stamped on token-bearing messages.
  tokenFidelity?: TokenFidelity;
  // The HITL (human-in-the-loop) gate this turn ran under, captured verbatim: Claude Code
  // permissionMode ("default"|"plan"|"acceptEdits"|"auto"|"bypassPermissions") or Codex
  // turn_context.approval_policy. The extractor stamps the active (forward-filled) mode on each user
  // turn — Claude's inline value is sparse, so a switch delivered by a `permission-mode` event still
  // lands on the following turn; a consumer forward-fills any leading gap. Absent for sources with
  // no per-turn mode (Kiro/Cursor).
  permission_mode?: string;
}

// ── Context-window composition ───────────────────────────────────────────────

/**
 * One segment of a turn's assembled context window (Cursor CLI field 5→3): how
 * many tokens/chars a named part of the prompt (system_prompt, tools, rules,
 * skills, conversation, …) occupied.
 */
export interface ContextSegment {
  segment: string;
  tokens: number;
  chars: number;
}

// Bounds on the untrusted per-segment context composition: at most 64 segments,
// each id at most 64 characters. Shared by the reader (which caps as it decodes)
// and the row-builder (which re-clamps before the row is written).
export const MAX_CONTEXT_SEGMENTS = 64;
export const MAX_SEGMENT_ID_CHARS = 64;

// ── Conversation prompt ──────────────────────────────────────────────────────

export interface ConversationPrompt {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  metadata?: PromptMetadata;
}

// ── Session-level metadata from local IDE files ─────────────────────────────

/** The session_meta record: session-level facts from local IDE files. */
export interface SessionMetaPayload {
  languages?: Record<string, number>;
  lines_added?: number;
  lines_removed?: number;
  files_modified?: number;
  git_commits?: number;
  git_pushes?: number;
  uses_mcp?: boolean;
  uses_web_search?: boolean;
  uses_web_fetch?: boolean;
  uses_task_agent?: boolean;
  user_interruptions?: number;
  tool_counts?: Record<string, number>;
  tool_errors?: number;
  tool_error_categories?: Record<string, number>;
  user_message_count?: number;
  assistant_message_count?: number;
  duration_minutes?: number;
  first_prompt?: string;
  project_path?: string;
  start_time?: string;
  compaction_count?: number;
  manual_compaction_count?: number;
  avg_pre_compaction_tokens?: number;
  pr_url?: string;
  pr_number?: number;
  pr_repository?: string;
  /**
   * All PRs referenced during the session, in first-seen order. `source` records
   * how each was obtained, which is what decides whether it may support an
   * attribution or only narrow the search; absent means unclassified.
   */
  pr_references?: Array<{
    pr_url: string;
    pr_number: number;
    pr_repository: string;
    source?: string;
  }>;
  session_title?: string;
  /** @deprecated prefer git_branches */
  git_branch?: string;
  /** Every distinct git branch observed during the session, in first-seen order. */
  git_branches?: string[];
  /**
   * The same branches, each carrying how it was obtained. Written alongside
   * `git_branches` rather than instead of it: a reader can merge the two, so a
   * reader that predates provenance keeps working while one that reads it can
   * tell a branch the session proved from one the workspace merely held.
   */
  branch_signals?: Array<{ name: string; source: string }>;
  /** Which surface of the tool ran the session: "cli", "vscode", "desktop", etc. */
  source?: string;
  /**
   * Per-session run mode: "interactive" or "background" (headless). Read per
   * session from ~/.claude/sessions/ keyed by session id. Unset when the session
   * is not currently live and its kind is unknown — never guessed.
   */
  session_kind?: string;
  // JSONL event: file-history-snapshot — per-message file edit tracking
  tracked_file_paths?: string[];
  // JSONL event: last-prompt — most recent user prompt text
  last_prompt?: string;
  // JSONL event: bridge_status — remote control session URL
  bridge_session_url?: string;
  // MCP server names configured in the IDE (names only, not secrets).
  mcp_server_names?: string[];
  // Cursor 3+ per-project signals (null = Cursor 2.x or directory absent)
  sub_agent_count?: number;
  agent_transcript_count?: number;
  tool_output_count?: number;
  terminal_session_count?: number;
  project_mcp_server_names?: string[];
  // Seconds between each assistant response and the next user message.
  user_response_times?: number[];
  // ISO 8601 timestamps of all user messages in the session.
  user_message_timestamps?: string[];
  // Hour of day (0-23, UTC) of each user message.
  message_hours?: number[];
  // Cursor 3+ workspace sidebar metadata (per-conversation, null = Cursor 2.x)
  cursor_lines_changed?: number;
  cursor_files_modified?: number;
  cursor_context_usage_percent?: number;
  // Per-segment context-window composition of the session's peak turn (Cursor CLI
  // field 5→3): the token/char breakdown across system_prompt, tools, rules,
  // conversation, etc. Stored in session_meta as `context_composition`.
  context_composition?: ContextSegment[];
  // Vendor-reported ACTUAL cost in USD (sum of composerData.usageData[*].costInCents ÷ 100).
  // Consumer prefers this over the token-derived estimate when > 0.
  reported_cost_usd?: number;
  // Absolute context-window occupancy (Cursor composerData.contextTokensUsed / contextTokenLimit).
  context_tokens_used?: number;
  context_token_limit?: number;
  // Git commit SHA at session start. Populated by Codex (session_meta.git.commit_hash)
  // and Copilot CLI (session.start.data.context.headCommit).
  git_sha?: string;
  // Agent configuration signals (Codex-specific, from SQLite threads columns).
  reasoning_effort?: string;   // "low" | "medium" | "high"
  memory_mode?: string;        // "enabled" | "disabled"
  // Cross-IDE HITL posture, captured verbatim: Codex approval_policy
  // ("suggest"|"auto-edit"|"full-auto"|"never"|"on-request"|"on-failure"|"untrusted")
  // OR Claude Code permissionMode ("default"|"plan"|"acceptEdits"|"auto"|"bypassPermissions").
  // A consumer can normalize it to its own enum (structured, no redaction needed).
  approval_mode?: string;
  sandbox_policy?: string;
  // Whether the session used extended/chain-of-thought reasoning.
  // Copilot CLI: assistant.message.data.reasoningText non-empty.
  uses_extended_thinking?: boolean;
  // Files changed by AI (from patch_apply_end events — Codex; from toolInvocationSerialized — Copilot VS Code).
  files_edited?: string[];
  // Dynamic tools registered per Codex session (from thread_dynamic_tools table).
  dynamic_tool_names?: string[];
  // Wall-clock elapsed seconds (createdAt → lastUpdatedAt). Used as PRD M1 fallback
  // Wall-clock elapsed seconds (createdAt → lastUpdatedAt). Used as a coarse fallback
  // when active agent time is unavailable. Consumer displays with asterisk qualifier.
  session_duration_seconds?: number;

  // ── Agentic IDE signals — currently populated by Kiro only ─────────────────

  // Agent execution mode (e.g., "agent", "spec", "vibe"). Currently populated by Kiro only.
  agent_mode?: "agent" | "spec" | "vibe";
  // Supervision level ("supervised" or "autopilot"). Currently populated by Kiro only.
  autonomy_mode?: "supervised" | "autopilot";

  // Billing credits consumed (IDE-specific unit). Currently populated by Kiro only.
  billing_credits_used?: number;
  // Billing quota invocations consumed. Currently populated by Kiro only.
  quota_invocations_used?: number;
  // Billing quota invocation limit. Currently populated by Kiro only.
  quota_invocations_limit?: number;

  // Total model API requests (CLI sessions). Currently populated by Kiro CLI only.
  total_model_request_count?: number;
  // Total agentic execution cycles (CLI sessions). Currently populated by Kiro CLI only.
  total_agent_cycles?: number;
  // Total input tokens consumed across all turns. Currently populated by Kiro CLI only.
  total_input_tokens?: number;
  // Total output tokens generated across all turns. Currently populated by Kiro CLI only.
  total_output_tokens?: number;

  // IDE-reported context window utilization (0.0–1.0). Currently populated by Kiro only.
  ide_context_usage_percent?: number;
  // MCP tool context fraction (0.0–1.0). Currently populated by Kiro only.
  mcp_context_percent?: number;
  // Steering / rules-file context fraction (0.0–1.0). Currently populated by Kiro only.
  steering_context_percent?: number;
  // Maximum output tokens configured. Currently populated by Kiro only.
  max_output_tokens?: number;

  // Count of spec files in the workspace. Currently populated by Kiro only (.kiro/specs/).
  spec_count?: number;
  // Count of steering / rules files. Currently populated by Kiro only (.kiro/steering/).
  steering_file_count?: number;
  // Count of lifecycle hook files. Currently populated by Kiro only (.kiro/hooks/).
  hook_count?: number;
  // Names of steering / rules docs injected into context. Currently populated by Kiro only.
  steering_docs_used?: string[];
  // Number of steering files included in context. Currently populated by Kiro only.
  steering_inclusion_count?: number;

  // Allowed read paths (permission sandbox). Currently populated by Kiro CLI only.
  sandbox_allowed_read_paths?: string[];
  // Allowed write paths (permission sandbox). Currently populated by Kiro CLI only.
  sandbox_allowed_write_paths?: string[];

  // Parent session ID for sub-agent sessions. Currently populated by Kiro only.
  parent_session_id?: string;
  // Names of sub-agents spawned. Currently populated by Kiro only.
  spawned_agent_names?: string[];

  // Session lineage: set on a delegated child conversation (subagent, plugin,
  // hook) so a consumer links it to its parent and folds it instead of
  // analyzing it as a standalone session. Absent on a primary session.
  lineage?: SessionLineagePayload;

  // ── Agentic session detail (SessionMeta 83–93) ─────────────────────────────
  // Populated by Kiro today; surface-neutral so another agentic extractor fills
  // the same fields. Omit a field entirely when the surface did not report it —
  // a written 0 means "measured zero", which is a different claim.

  // The surface-qualified session key — "kiro-ide:<vendor id>" or
  // "kiro-cli:<vendor id>", identical to the row's session_id. Both Kiro
  // extractors write the same shape, so one field keys a session across the two
  // surfaces. Strip the prefix to recover the id Kiro's own logs and UI use.
  kiro_id?: string;
  // Tool-approval prompts keyed by the vendor's option token
  // (allow_once / allow_always / reject_once / reject_always).
  tool_approval_outcomes?: Record<string, number>;
  // Model API attempts INCLUDING retries; the excess over
  // total_model_request_count is the retry count.
  model_request_attempts?: number;
  // Vendor-measured seconds the agent actually worked (not wall-clock).
  agent_active_seconds?: number;
  // Per-turn metering; billing_credits_used / agent_active_seconds are its sums.
  turn_usage?: TurnUsagePayload[];
  // Sub-agent delegations and their outcomes.
  sub_agent_runs?: SubAgentRunPayload[];
  // Characters typed by the user / produced by the assistant, vendor-reported.
  user_prompt_chars?: number;
  assistant_response_chars?: number;
  // Built-in (non-MCP) tool invocations as counted by the vendor.
  builtin_tool_uses?: number;
  // Tool calls keyed by the vendor's tool-origin token (Kiro: "default", "acp").
  // Not folded into uses_mcp — ACP is not MCP.
  tool_origin_counts?: Record<string, number>;
  // Agent-mode configuration the session ran under.
  agentic_session_config?: AgenticSessionConfigPayload;
}

/** One user turn's metering. */
export interface TurnUsagePayload {
  /** Vendor billing units (Kiro meters in credits, not tokens). */
  credits?: number;
  /** Seconds the agent worked on this turn. */
  active_seconds?: number;
  /** Context occupancy after the turn, 0–100. */
  context_usage_percent?: number;
  /** Tools invoked, in call order — repeats are meaningful. */
  tool_names?: string[];
  /** Verbatim vendor token for why the turn ended. */
  end_reason?: string;
  /** Model that served the turn; may be a router alias such as "auto". */
  model?: string;
}

/** One sub-agent delegation. */
export interface SubAgentRunPayload {
  /** Display name, e.g. "context-gatherer" — never the child's opaque id. */
  name?: string;
  /** Terminal status verbatim from the vendor, e.g. "success". */
  status?: string;
  /** The vendor's child-execution id. Not a conversation record key. */
  sub_session_id?: string;
}

/** Agent-mode configuration. */
export interface AgenticSessionConfigPayload {
  status?: string;
  spec_workflow?: string;
  spec_plan_enabled?: boolean;
  semantic_review_enabled?: boolean;
  /** Fast tool approval — suppresses per-tool prompts, so it explains a low
   *  tool_approval_outcomes sum. */
  fta_enabled?: boolean;
}

// SessionLineagePayload tags a child conversation with its relation to a parent.
export interface SessionLineagePayload {
  // ConversationType without the CONVERSATION_TYPE_ prefix. A delegated child is
  // SUBAGENT | PLUGIN; HOOK is a non-interactive automation run (parentless).
  // (PRIMARY is a top-level session — usually absent.)
  relation_type: "PRIMARY" | "SUBAGENT" | "PLUGIN" | "HOOK";
  // The parent's conversationId (== the parent's row id), so a consumer can
  // match this child to its parent. Empty when unresolved.
  parent_record_key?: string;
  // STRONG when the parent link is certain; a weaker link is captured but should
  // not be aggregated or attributed.
  linkage_confidence?: "STRONG" | "HEURISTIC" | "NONE";
  // The child's own token count, added into the parent's subagent-usage total.
  tokens?: number;
  // The spawning agent, e.g. "Explore" or "feature-dev:code-reviewer".
  origin_agent_type?: string;
  // The plugin that spawned the child, when the origin is a plugin.
  plugin_name?: string;
  // Delegation nesting depth (0 = direct child of a primary).
  spawn_depth?: number;
  // The Task tool_use id linking the child to the parent turn that spawned it.
  tool_use_id?: string;
}

/** The session_facets record. */
export interface SessionFacetsPayload {
  outcome?: string;
  claude_helpfulness?: string;
  session_type?: string;
  brief_summary?: string;
  underlying_goal?: string;
  goal_categories?: Record<string, number>;
  primary_success?: string;
  friction_counts?: Record<string, number>;
  friction_detail?: string;
  user_satisfaction_counts?: Record<string, number>;
}

// ── Per-scan installation metadata ────────────────────────────────────────

/** IDE installation metadata, read once per scan (not per conversation). */
export interface InstallationMetadata {
  plan_tier?: string;          // "free", "pro", "team", "enterprise", "pro_or_free"
  plan_tier_source?: string;   // "cursor_vscdb" or "cc_telemetry_inferred"
  login_email?: string;
  device_id?: string;
  entrypoint?: string;         // "claude-vscode", "claude-code"
  cc_version?: string;
  platform?: string;           // "darwin", "linux", "win32"
  is_oauth_auth?: boolean;
  organization_uuid?: string;
  account_uuid?: string;
  // session_kind moved to SessionMetaPayload: it is a per-session fact, not an
  // install-level one. entrypoint stays here because it is read from install-level
  // telemetry and cannot answer session-mode questions.
  // Cursor-specific
  cursor_onboarding_date?: string;
  cursor_privacy_mode?: boolean;
  cursor_memories_enabled?: boolean;
  cursor_personal_context_configured?: boolean;
  cursor_conversation_scoring?: string;

  // ── Cursor Statsig account record (`user.custom`). Raw values; the canonical
  //    plan_tier is derived from these by a consumer.
  //
  //    plan_tier carries Cursor's `stripeMembershipType`, which reports
  //    "enterprise" for every team seat — Teams Standard, Teams Premium and
  //    negotiated Enterprise Custom alike — so it cannot price a seat on its
  //    own. These four are what separate those cases. ──
  // True only for a negotiated Enterprise Custom contract (no list price).
  is_enterprise_user?: boolean;
  // True during an Enterprise trial; is_enterprise_user stays false for a trial,
  // so both must be false before a seat counts as paid self-serve Teams.
  is_enterprise_trial_user?: boolean;
  // Cursor team identifier, present exactly when the account belongs to a team.
  // Its presence — not plan_tier — is what identifies a team seat. Cursor emits
  // it as a NUMBER; it is stringified here to match the wire type.
  cursor_team_id?: string;
  // Member role within the Cursor team, e.g. "member". Not price-bearing.
  cursor_team_role?: string;
  // Cursor's stable per-member account id — one person, unlike the team-wide
  // cursor_team_id, and stable across an email change. Captured for seat
  // identity.
  cursor_user_id?: string;

  // ── Cursor seat tier, reported by Cursor's own dashboard API ──
  //
  //    The Statsig fields above cannot separate Teams Standard from Teams
  //    Premium — the local `stripeMembershipType` reads "enterprise" for both —
  //    so these three carry what only the vendor knows. Verbatim vendor
  //    vocabulary: a consumer derives the canonical tier and the billing period
  //    from them; this package does not.
  //
  // Cursor's per-member billing tier, e.g. "TEAM_MEMBER_BILLING_TIER_TIER_2000".
  // Absent is not evidence of any tier — it means no lookup ran or none succeeded.
  cursor_billing_tier?: string;
  // Cursor's team subscription kind, e.g. "SELF_SERVE". Absent is not evidence
  // of any subscription kind.
  cursor_team_membership_type?: string;
  // Whether Cursor bills this subscription annually. Absent means Cursor did not
  // report a billing period — distinct from a reported false, because the two
  // price differently, so an unreported value must never be written as false.
  cursor_is_yearly_plan?: boolean;
  // Currently active model per VS Code context (from chat.currentLanguageModel.panel).
  default_model?: string;
  // Last used chat mode (from chat.lastChatMode). e.g. "agent", "chat", "edit".
  last_chat_mode?: string;

  // IDE version string. Currently populated by Kiro only (CC equivalent: cc_version).
  ide_version?: string;
  // IDE device / machine identifier. Currently populated by Kiro only.
  ide_machine_id?: string;

  // ── Claude Code authoritative account record (~/.claude.json `oauthAccount`).
  //    Raw values; a consumer derives the canonical plan_tier from these. ──
  // Anthropic seat tier, e.g. "team_tier_1".
  seat_tier?: string;
  // Anthropic org classification, e.g. "claude_team", "claude_enterprise".
  organization_type?: string;
  // Billing mechanism, e.g. "stripe_subscription".
  billing_type?: string;
  // Member role within the org, e.g. "user", "admin".
  organization_role?: string;
  // Org-level rate-limit tier, e.g. "default_raven".
  organization_rate_limit_tier?: string;
  // User-level rate-limit tier, e.g. "default_claude_max_5x".
  user_rate_limit_tier?: string;
  // Subscription creation time, ISO-8601 string.
  subscription_created_at?: string;
  // Whether the account has extra-usage / overage enabled (oauthAccount.
  // hasExtraUsageEnabled). Flag only; overage cost is not exposed by the file.
  has_extra_usage_enabled?: boolean;
}

// ── AI code attribution metrics ─────────────────────────────────────────────

/** AI code attribution metrics from Cursor's ai-tracking.db. */
export interface AiAttributionMetrics {
  tab_completion_count?: number;
  ai_code_percent?: number;           // 0.0–1.0, from scored_commits
  tab_suggested_lines?: number;
  tab_accepted_lines?: number;
  composer_suggested_lines?: number;
  composer_accepted_lines?: number;
  // Cursor 3+ expanded signals
  tab_completion_model_breakdown?: Record<string, number>; // model → count from ai_code_hashes.model
  ai_code_percent_v2?: number;        // 0.0–1.0, from scored_commits.v2AiPercentage (more accurate)
  deleted_files_count?: number;       // Count of files removed during AI sessions
  tracking_start_time?: string;       // ISO timestamp from tracking_state table
}

// ── Aggregate usage stats from Claude Code stats-cache.json ─────────────────

/** Aggregate usage stats from Claude Code stats-cache.json. */
export interface StatsCacheSnapshot {
  hour_counts?: Record<string, number>;
  daily_activity?: Array<{
    date: string;
    message_count: number;
    session_count: number;
    tool_call_count: number;
  }>;
  daily_model_tokens?: Array<{
    date: string;
    tokens_by_model: Record<string, number>;
  }>;
  model_usage?: Record<string, {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    web_search_requests: number;
  }>;
  total_sessions?: number;
  total_messages?: number;
  longest_session_duration_ms?: number;
  longest_session_message_count?: number;
  first_session_date?: string;
}

// ── Database row shape ───────────────────────────────────────────────────────

export interface ConversationRow {
  id: string;
  ide_type: IdeType;
  session_id: string;
  conversation: string; // JSON string of ConversationPrompt[]
  project_path: string | null;
  // Git repository name in "org/repo" format (e.g. "example-org/example-repo") from remote origin.
  // Null when the git remote could not be determined.
  repo_name: string | null;
  last_mtime_ms: number;
  last_size: number;
  last_offset: number;
  // Unix ms timestamp from the source IDE (e.g. Cursor composerData.createdAt).
  // Null for IDEs that don't expose a conversation start time (Claude Code, Antigravity).
  conversation_source_created_at_ms: number | null;
  session_meta: string | null;    // JSON string of SessionMetaPayload
  session_facets: string | null;  // JSON string of SessionFacetsPayload
  installation_metadata: string | null; // JSON string of InstallationMetadata
  stats_cache: string | null;       // JSON string of StatsCacheSnapshot
  ai_attribution: string | null;    // JSON string of AiAttributionMetrics
  // session_events is the normalized event timeline (JSON array of SessionEvent);
  // event_coverage is the adapter's rating of how completely it observed the session.
  // NULL on rows extracted before loop capture existed — a consumer reads a missing
  // coverage as NONE, so such a session is excluded from observed rates rather than
  // counted as having no loops.
  session_events: string | null;
  event_coverage: string | null;
  // Cursor token-settle bookkeeping (see shouldForceCursorReextract in cursorExtractor.ts).
  // content_hash gates re-sync; last_reextract_at throttles forced re-reads;
  // tokens_observed=1 means the latest assistant turn's tokens have landed (terminal).
  // content_hash/last_reextract_at are null on rows written before migration 14 added them;
  // that migration backfills tokens_observed (0 unless the last turn already had tokens).
  content_hash: string | null;
  last_reextract_at: number | null;
  tokens_observed: number;
  // extractor_version: the caller's extractor version applied when this row was
  // written — stamped at extraction. A re-extract under a bumped version
  // restamps it; an un-re-extracted pending row keeps the version it was produced
  // under. NULL on rows written before this column existed → read as "unset",
  // which a consumer reads as predating the field.
  extractor_version: number | null;
  // The session's last activity in Unix ms: its newest message timestamp, else
  // last_mtime_ms. Set at every upsert; migration 20 fills older rows.
  last_message_ms: number;
  sync_status: "pending" | "syncing" | "synced" | "failed" | "skipped_out_of_scope";
  synced_at: string | null;
  updated_at: string;
  created_at: string;
}
