// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// The two session reads behind a project's sessions and a session's conversation, served from the session store. Every input from the renderer is
// checked here, every failure comes back as `error`, and only the fields in sessionTypes.ts are
// copied out: never the tool's own session id, nor the login email, account or device ids the
// store keeps beside each session.

import type { SessionStore } from "local-session-extractor";
import type { IdeType } from "../shared/extractionTypes";
import { IDE_TYPES, cutText, type SessionList, type SessionListFilter, type SessionTranscript } from "../shared/sessionTypes";

// One message is cut at 64 K characters. Reading a message in pages would lift the cap.
export const MAX_MESSAGE_CHARS = 64 * 1024;
const TRANSCRIPT_PAGE = 100;
const MAX_OFFSET = 10_000_000;

const NOT_OPEN = "The session store is not open, so no session can be shown.";

const isIdeType = (v: unknown): v is IdeType => IDE_TYPES.includes(v as IdeType);
const isOffset = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_OFFSET;
const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
// The store's row id: a SHA-256 of tool and session id, in hex.
const isKey = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const message = (err: unknown): string => (err instanceof Error && err.message ? err.message : String(err) || "unknown error");

/** Checks a filter from the renderer; returns it typed, or why it was refused. */
function checkFilter(raw: unknown): SessionListFilter | string {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "The filter is not an object.";
  const f = raw as Record<string, unknown>;
  if (f.ideType !== undefined && !isIdeType(f.ideType)) return "Unknown tool.";
  if (f.projectPath !== undefined && f.projectPath !== null && !isText(f.projectPath, 4096)) return "The project path is not valid.";
  if (f.query !== undefined && !isText(f.query, 200)) return "The search text is not valid.";
  if (f.limit !== undefined && !(Number.isInteger(f.limit) && (f.limit as number) >= 1 && (f.limit as number) <= 200)) return "The page size is not valid.";
  let after: SessionListFilter["after"];
  if (f.after !== undefined) {
    const a = f.after as Record<string, unknown> | null;
    if (a === null || typeof a !== "object" || !Number.isFinite(a.lastActivityMs) || !isKey(a.key)) return "The page position is not valid.";
    after = { lastActivityMs: a.lastActivityMs as number, key: a.key };
  }
  return {
    ideType: f.ideType as IdeType | undefined,
    projectPath: f.projectPath as string | null | undefined,
    query: f.query as string | undefined,
    limit: (f.limit as number | undefined) ?? 50,
    after,
  };
}

// Both reads run synchronously on the main process. A page of a 100,000-message conversation
// costs up to about 0.3 s, which a worker would take off the main process.
export function listSessions(store: SessionStore | null, raw: unknown): SessionList {
  const filter = checkFilter(raw);
  if (typeof filter === "string") return { rows: [], total: 0, error: filter };
  if (!store) return { rows: [], total: 0, error: NOT_OPEN };
  try {
    const { after, ...rest } = filter;
    const { rows, total } = store.listSessionSummaries({
      ...rest,
      ...(after ? { after: { lastActivityMs: after.lastActivityMs, id: after.key } } : {}),
    });
    return {
      total,
      error: null,
      rows: rows.map((r) => ({
        key: r.id,
        ideType: r.ideType,
        lastActivityMs: r.lastActivityMs,
        projectPath: r.projectPath,
        branch: r.branch,
        title: r.title,
        startedAt: r.startedAt,
        durationMinutes: r.durationMinutes,
        userMessages: r.userMessages,
        assistantMessages: r.assistantMessages,
        models: r.models,
      })),
    };
  } catch (err) {
    return { rows: [], total: 0, error: `The sessions could not be read: ${message(err)}` };
  }
}

export function getTranscript(store: SessionStore | null, key: unknown, offset: unknown): SessionTranscript {
  const refuse = (error: string): SessionTranscript => ({ total: 0, messages: [], error });
  if (!isKey(key)) return refuse("The session key is not valid.");
  if (!isOffset(offset)) return refuse("The offset is not valid.");
  if (!store) return refuse(NOT_OPEN);
  try {
    const page = store.getConversationPage(key, { offset, limit: TRANSCRIPT_PAGE });
    if (!page) return refuse("This session is no longer in the store.");
    return {
      total: page.total,
      error: null,
      messages: page.messages.map((m) => {
        const content = typeof m.content === "string" ? m.content : "";
        return {
          role: m.role,
          content: cutText(content, MAX_MESSAGE_CHARS),
          truncated: content.length > MAX_MESSAGE_CHARS,
          timestamp: m.timestamp,
          model: m.model,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          isSubAgent: m.isSubAgent,
        };
      }),
    };
  } catch (err) {
    return refuse(`The transcript could not be read: ${message(err)}`);
  }
}
