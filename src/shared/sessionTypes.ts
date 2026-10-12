// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * What a project's sessions and a session's conversation ask for and get back over IPC. A failure comes back
 * as `error`, never as an empty list.
 */

import type { IdeType } from "./extractionTypes";

/** Every tool whose sessions are read, in the Projects page's order. */
export const IDE_TYPES: readonly IdeType[] = ["claude-code", "cursor", "copilot", "antigravity", "codex", "kiro"];

export interface SessionListFilter {
  ideType?: IdeType;
  /** A project path exactly as the Projects page's row has it; null for its "No folder" row. */
  projectPath?: string | null;
  /** Matched against every source of the title: the session's own, its first prompt, its first message. */
  query?: string;
  /** 1 to 200; the page asks for 50. */
  limit?: number;
  /** The last row of the page before: the next page starts after it. */
  after?: Pick<SessionRow, "lastActivityMs" | "key">;
}

/**
 * One session row. The login email, account and device ids never cross IPC, and neither does
 * the tool's own session id.
 */
export interface SessionRow {
  /**
   * An opaque key, a hash of tool and session id, to ask for the transcript with. It hides the
   * session id: its uuid and, for Claude Code, the encoded folder path with the user name in it.
   */
  key: string;
  ideType: IdeType;
  /** The session's last activity in Unix ms: its newest message, else its source's last change. The list's order. */
  lastActivityMs: number;
  /** The session's folder, as stored and as the Projects page shows it. */
  projectPath: string | null;
  /** The last git branch the session recorded, as the tool wrote it. */
  branch: string | null;
  title: string | null;
  startedAt: string | null;
  durationMinutes: number | null;
  userMessages: number;
  assistantMessages: number;
  models: string[];
}

export interface SessionList {
  rows: SessionRow[];
  total: number;
  error: string | null;
}

/** The first `max` UTF-16 units of `text`, one fewer when the cut would split a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  /** The content was cut at the size the page shows. */
  truncated: boolean;
  timestamp: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  isSubAgent: boolean;
}

export interface SessionTranscript {
  /** How many messages the session has. */
  total: number;
  /** Up to 100, starting at the offset asked for. */
  messages: SessionMessage[];
  error: string | null;
}
