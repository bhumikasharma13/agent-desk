// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Session Intelligence's `Conversation` message (proto `sessionintelligence.v1`,
 * `conversation.proto`) in its protojson form: lowerCamelCase field names, enum
 * values by name, Timestamps as RFC 3339 text. int64 fields are written as JSON
 * numbers, which protojson accepts. Only the fields `toConversation` can fill are
 * listed.
 */

export type IdeType =
  | "IDE_TYPE_CLAUDE_CODE"
  | "IDE_TYPE_CURSOR"
  | "IDE_TYPE_COPILOT"
  | "IDE_TYPE_ANTIGRAVITY"
  | "IDE_TYPE_CODEX"
  | "IDE_TYPE_KIRO";

export type Role = "ROLE_USER" | "ROLE_ASSISTANT";

export type EventCoverage = "EVENT_COVERAGE_COMPLETE" | "EVENT_COVERAGE_PARTIAL" | "EVENT_COVERAGE_NONE";

export type SignalSource =
  | "SIGNAL_SOURCE_UNSPECIFIED"
  | "SIGNAL_SOURCE_SESSION_COMMAND"
  | "SIGNAL_SOURCE_VENDOR_FIELD"
  | "SIGNAL_SOURCE_SESSION_PROSE"
  | "SIGNAL_SOURCE_LOCAL_GIT_WINDOWED";

export type ConversationType =
  | "CONVERSATION_TYPE_PRIMARY"
  | "CONVERSATION_TYPE_SUBAGENT"
  | "CONVERSATION_TYPE_PLUGIN"
  | "CONVERSATION_TYPE_HOOK";

export type LinkageConfidence = "LINKAGE_CONFIDENCE_STRONG" | "LINKAGE_CONFIDENCE_HEURISTIC" | "LINKAGE_CONFIDENCE_NONE";

export interface Conversation {
  ideType?: IdeType;
  sessionId?: string;
  /** The last segment of the redacted project path. */
  projectName?: string;
  prompts: Prompt[];
  conversationStartedAt?: string;
  lastUpdatedAt?: string;
  sessionMeta?: SessionMeta;
  sessionFacets?: SessionFacets;
  installationMetadata?: InstallationMetadata;
  aiAttribution?: AiAttribution;
  statsCache?: StatsCacheSnapshot;
  sessionEvents?: SessionEvent[];
  eventCoverage?: EventCoverage;
  extractorVersion?: number;
}

/** `role` or `content` is absent only when the stored message lacked it. */
export interface Prompt {
  role?: Role;
  content?: string;
  timestamp?: string;
  metadata?: PromptMetadata;
}

export interface PromptMetadata {
  model?: string;
  messageId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
  contextUsagePercent?: number;
  isImageAdded?: boolean;
  relevantFiles?: string[];
  codeBlockCount?: number;
  isSubAgent?: boolean;
  authorship?: "PROMPT_AUTHORSHIP_UNSPECIFIED" | "PROMPT_AUTHORSHIP_HUMAN" | "PROMPT_AUTHORSHIP_INJECTED";
  linesAdded?: number;
  linesRemoved?: number;
  filesEdited?: string[];
  nativeBillingUnits?: number;
  reasoningTokens?: number;
  tokenFidelity?:
    | "TOKEN_FIDELITY_UNSPECIFIED"
    | "TOKEN_FIDELITY_MEASURED"
    | "TOKEN_FIDELITY_NATIVE_PARTIAL"
    | "TOKEN_FIDELITY_ESTIMATE";
  permissionMode?: string;
}

export interface SessionEvent {
  sequence?: number;
  occurredAt?: string;
  kind?:
    | "SESSION_EVENT_KIND_PROMPT_REFERENCE"
    | "SESSION_EVENT_KIND_TOOL_CALL"
    | "SESSION_EVENT_KIND_TOOL_RESULT"
    | "SESSION_EVENT_KIND_SKILL_CALL"
    | "SESSION_EVENT_KIND_HOOK_CALL"
    | "SESSION_EVENT_KIND_COMMAND"
    | "SESSION_EVENT_KIND_GOAL"
    | "SESSION_EVENT_KIND_API_RETRY"
    | "SESSION_EVENT_KIND_COMPACTION"
    | "SESSION_EVENT_KIND_TURN_STARTED"
    | "SESSION_EVENT_KIND_TURN_COMPLETED"
    | "SESSION_EVENT_KIND_SUBAGENT_STARTED"
    | "SESSION_EVENT_KIND_SUBAGENT_COMPLETED";
  operationName?: string;
  callId?: string;
  parentCallId?: string;
  outcome?:
    | "SESSION_EVENT_OUTCOME_SUCCEEDED"
    | "SESSION_EVENT_OUTCOME_FAILED"
    | "SESSION_EVENT_OUTCOME_CANCELLED"
    | "SESSION_EVENT_OUTCOME_UNKNOWN";
  redactedSummary?: string;
  promptOrdinal?: number;
  author?: "SESSION_EVENT_AUTHOR_HUMAN" | "SESSION_EVENT_AUTHOR_AGENT" | "SESSION_EVENT_AUTHOR_DELEGATED_AGENT";
}

export interface PRReference {
  prUrl?: string;
  prNumber?: number;
  prRepository?: string;
  source?: SignalSource;
}

export interface BranchSignal {
  name?: string;
  source?: SignalSource;
}

export interface ContextSegment {
  segment?: string;
  tokens?: number;
  chars?: number;
}

export interface SessionLineage {
  relationType?: ConversationType;
  toolUseId?: string;
  spawnDepth?: number;
  originAgentType?: string;
  pluginName?: string;
  linkageConfidence?: LinkageConfidence;
  tokens?: number;
}

export interface TurnUsage {
  credits?: number;
  activeSeconds?: number;
  contextUsagePercent?: number;
  toolNames?: string[];
  endReason?: string;
  model?: string;
}

export interface SubAgentRun {
  name?: string;
  status?: string;
  subSessionId?: string;
}

export interface AgenticSessionConfig {
  status?: string;
  specWorkflow?: string;
  specPlanEnabled?: boolean;
  semanticReviewEnabled?: boolean;
  ftaEnabled?: boolean;
}

export interface SessionMeta {
  languages?: Record<string, number>;
  linesAdded?: number;
  linesRemoved?: number;
  filesModified?: number;
  gitCommits?: number;
  gitPushes?: number;
  usesMcp?: boolean;
  usesWebSearch?: boolean;
  usesWebFetch?: boolean;
  usesTaskAgent?: boolean;
  userInterruptions?: number;
  toolCounts?: Record<string, number>;
  toolErrors?: number;
  toolErrorCategories?: Record<string, number>;
  userMessageCount?: number;
  assistantMessageCount?: number;
  durationMinutes?: number;
  firstPrompt?: string;
  projectPath?: string;
  startTime?: string;
  compactionCount?: number;
  manualCompactionCount?: number;
  avgPreCompactionTokens?: number;
  prUrl?: string;
  prNumber?: number;
  prRepository?: string;
  prReferences?: PRReference[];
  sessionTitle?: string;
  gitBranch?: string;
  gitBranches?: string[];
  branchSignals?: BranchSignal[];
  source?: string;
  sessionKind?: string;
  trackedFilePaths?: string[];
  lastPrompt?: string;
  bridgeSessionUrl?: string;
  mcpServerNames?: string[];
  subAgentCount?: number;
  agentTranscriptCount?: number;
  toolOutputCount?: number;
  terminalSessionCount?: number;
  projectMcpServerNames?: string[];
  userResponseTimes?: number[];
  userMessageTimestamps?: string[];
  messageHours?: number[];
  cursorLinesChanged?: number;
  cursorFilesModified?: number;
  cursorContextUsagePercent?: number;
  contextComposition?: ContextSegment[];
  reportedCostUsd?: number;
  contextTokensUsed?: number;
  contextTokenLimit?: number;
  gitSha?: string;
  reasoningEffort?: string;
  memoryMode?: string;
  approvalMode?: string;
  sandboxPolicy?: string;
  usesExtendedThinking?: boolean;
  filesEdited?: string[];
  dynamicToolNames?: string[];
  agentMode?: string;
  autonomyMode?: string;
  billingCreditsUsed?: number;
  quotaInvocationsUsed?: number;
  quotaInvocationsLimit?: number;
  totalModelRequestCount?: number;
  totalAgentCycles?: number;
  ideContextUsagePercent?: number;
  mcpContextPercent?: number;
  steeringContextPercent?: number;
  maxOutputTokens?: number;
  specCount?: number;
  steeringFileCount?: number;
  hookCount?: number;
  steeringDocsUsed?: string[];
  steeringInclusionCount?: number;
  sandboxAllowedReadPaths?: string[];
  sandboxAllowedWritePaths?: string[];
  parentSessionId?: string;
  spawnedAgentNames?: string[];
  lineage?: SessionLineage;
  kiroId?: string;
  toolApprovalOutcomes?: Record<string, number>;
  modelRequestAttempts?: number;
  agentActiveSeconds?: number;
  turnUsage?: TurnUsage[];
  subAgentRuns?: SubAgentRun[];
  userPromptChars?: number;
  assistantResponseChars?: number;
  builtinToolUses?: number;
  toolOriginCounts?: Record<string, number>;
  agenticSessionConfig?: AgenticSessionConfig;
}

export interface SessionFacets {
  outcome?: string;
  claudeHelpfulness?: string;
  sessionType?: string;
  briefSummary?: string;
  underlyingGoal?: string;
  goalCategories?: Record<string, number>;
  primarySuccess?: string;
  frictionCounts?: Record<string, number>;
  frictionDetail?: string;
  userSatisfactionCounts?: Record<string, number>;
}

export interface InstallationMetadata {
  planTier?: string;
  planTierSource?: string;
  loginEmail?: string;
  deviceId?: string;
  entrypoint?: string;
  ccVersion?: string;
  platform?: string;
  isOauthAuth?: boolean;
  organizationUuid?: string;
  accountUuid?: string;
  cursorOnboardingDate?: string;
  cursorPrivacyMode?: boolean;
  cursorMemoriesEnabled?: boolean;
  cursorPersonalContextConfigured?: boolean;
  cursorConversationScoring?: string;
  defaultModel?: string;
  lastChatMode?: string;
  ideVersion?: string;
  ideMachineId?: string;
  seatTier?: string;
  organizationType?: string;
  billingType?: string;
  organizationRole?: string;
  organizationRateLimitTier?: string;
  userRateLimitTier?: string;
  subscriptionCreatedAt?: string;
  hasExtraUsageEnabled?: boolean;
  isEnterpriseUser?: boolean;
  isEnterpriseTrialUser?: boolean;
  cursorTeamId?: string;
  cursorTeamRole?: string;
  cursorUserId?: string;
  cursorBillingTier?: string;
  cursorTeamMembershipType?: string;
  cursorIsYearlyPlan?: boolean;
}

export interface AiAttribution {
  tabCompletionCount?: number;
  aiCodePercent?: number;
  tabSuggestedLines?: number;
  tabAcceptedLines?: number;
  composerSuggestedLines?: number;
  composerAcceptedLines?: number;
  tabCompletionModelBreakdown?: Record<string, number>;
  aiCodePercentV2?: number;
  deletedFilesCount?: number;
  trackingStartTime?: string;
}

export interface StatsCacheSnapshot {
  hourCounts?: Record<string, number>;
  totalSessions?: number;
  totalMessages?: number;
  longestSessionDurationMs?: number;
  longestSessionMessageCount?: number;
  firstSessionDate?: string;
  dailyActivity?: Array<{ date?: string; messageCount?: number; sessionCount?: number; toolCallCount?: number }>;
  dailyModelTokens?: Array<{ date?: string; tokensByModel?: Record<string, number> }>;
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
      webSearchRequests?: number;
    }
  >;
}
