// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { createHash } from "node:crypto";
import type { ConversationPrompt, IdeType } from "../types/session";

/**
 * The deterministic primary key of a conversation row, and the record key a
 * consumer joins on. A delegated child sets its
 * lineage.parent_record_key to conversationId(ideType, parentSessionId) so it
 * matches its parent's id exactly — reuse this, never re-derive the hash
 * inline, so the two can never drift.
 */
export function conversationId(ideType: IdeType, sessionId: string): string {
  return createHash("sha256").update(`${ideType}:${sessionId}`).digest("hex");
}

/** Sum per-message input+output tokens across a conversation's prompts. */
export function sumPromptTokens(prompts: ConversationPrompt[]): number {
  let n = 0;
  for (const p of prompts) {
    n += (p.metadata?.inputTokens ?? 0) + (p.metadata?.outputTokens ?? 0);
  }
  return n;
}
