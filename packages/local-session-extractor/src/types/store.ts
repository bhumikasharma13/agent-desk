// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import type { ConversationPrompt, ConversationRow, IdeType, SessionLineagePayload } from "./session";

/** One extracted session, as an extractor hands it to the store. */
export interface UpsertParams {
  ideType: IdeType;
  sessionId: string;
  conversation: ConversationPrompt[];
  projectPath?: string;
  repoName?: string;
  lastMtimeMs: number;
  lastSize: number;
  lastOffset: number;
  conversationSourceCreatedAtMs?: number;
  sessionMeta?: string;       // JSON string
  sessionFacets?: string;     // JSON string
  installationMetadata?: string; // JSON string
  statsCache?: string;        // JSON string
  aiAttribution?: string;     // JSON string
  sessionEvents?: string;     // JSON string — the normalized event timeline
  eventCoverage?: string;     // enum name for how completely it was observed
  // True when the MOST RECENT assistant turn carried nonzero tokens (set by the
  // Cursor extractor). Recorded verbatim — NOT stickied — so a new turn reopens the
  // settle window; the terminal signal for shouldForceCursorReextract.
  tokensObserved?: boolean;
  /**
   * The applied version of this source's extractor, stamped on the row so a
   * consumer can tell which extractor produced it; absent stamps null. The
   * package never invents a number of its own.
   */
  extractorVersion?: number | null;
}

/** One primary session for a list view, read without its conversation text or installation metadata. */
export interface SessionSummary {
  /** The row's id, which `getConversationPage` takes. It names no folder or user. */
  id: string;
  ideType: IdeType;
  sessionId: string;
  /**
   * The session's last activity in Unix ms (`last_message_ms`): its newest message time, else
   * when the reader saw its source last change. The list's order, newest first.
   */
  lastActivityMs: number;
  /** The same time as an ISO string; null when the store has none (0). */
  lastActivityAt: string | null;
  projectPath: string | null;
  repoName: string | null;
  /** The last git branch the session recorded (`git_branches`, else `git_branch`), as stored; null when none. */
  branch: string | null;
  /** `session_title`, else `first_prompt`, else the first message, cut to 200 characters; masked as stored. */
  title: string | null;
  /** The earliest message timestamp. */
  startedAt: string | null;
  /** `duration_minutes` from `session_meta`, else the span between the first and last timestamp. */
  durationMinutes: number | null;
  /** Counted from the stored conversation, so their sum is what `getConversationPage` returns as `total`. */
  userMessages: number;
  assistantMessages: number;
  /** Every distinct model named on a message. */
  models: string[];
}

/**
 * Filters for `listSessionSummaries`. `query` matches every source of the title (the session's
 * own title, its first prompt and its first message) without regard to ASCII case.
 */
export interface SessionSummaryFilter {
  ideType?: IdeType;
  /** One folder's sessions; null for the sessions with no folder, as `countByIdeAndProject` groups them. */
  projectPath?: string | null;
  /** At most 200 characters. */
  query?: string;
  /** 1 to 200, default 50. */
  limit?: number;
  /**
   * The last row of the page before: the next page starts after it, so no unchanged row
   * repeats or is skipped. A row whose activity moves older meanwhile can come again on a
   * later page; de-duplicate by `id`.
   */
  after?: Pick<SessionSummary, "lastActivityMs" | "id">;
}

/** One stored message, with only the metadata a reader shows. */
export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  isSubAgent: boolean;
}

/** The per-session change-tracking fields an extractor reads before re-reading a file. */
export type TrackingRow = Pick<
  ConversationRow,
  | "last_mtime_ms"
  | "last_size"
  | "last_offset"
  | "project_path"
  | "repo_name"
  | "last_reextract_at"
  | "tokens_observed"
>;

/** The store surface the extractors write through; `SessionStore` implements it. */
export interface SessionSink {
  upsert(params: UpsertParams): void;
  getTracking(ideType: IdeType, sessionId: string): TrackingRow | null;
  hasBeenIngested(ideType: IdeType, sessionId: string): boolean;
  stampPendingSubagentLineage(
    ideType: IdeType,
    sessionId: string,
    parentRecordKey: string,
    extras?: Pick<SessionLineagePayload, "origin_agent_type" | "tool_use_id">,
  ): boolean;
  updateProjectPath(ideType: IdeType, sessionId: string, projectPath: string): void;
  updateRepoName(ideType: IdeType, sessionId: string, repoName: string): void;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}
