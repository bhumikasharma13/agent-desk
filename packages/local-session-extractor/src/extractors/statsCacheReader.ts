// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import path from "node:path";
import fs from "node:fs";
import type { StatsCacheSnapshot } from "../types/session";

/**
 * Reads ~/.claude/stats-cache.json and returns a structured snapshot.
 * Returns null if the file is absent or cannot be parsed.
 */
export function readStatsCache(claudeDir: string): StatsCacheSnapshot | null {
  const filePath = path.join(claudeDir, "stats-cache.json");
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const raw = JSON.parse(content) as Record<string, unknown>;

    const snapshot: StatsCacheSnapshot = {};

    if (typeof raw.hourCounts === "object" && raw.hourCounts !== null) {
      snapshot.hour_counts = raw.hourCounts as Record<string, number>;
    }

    if (Array.isArray(raw.dailyActivity)) {
      snapshot.daily_activity = (raw.dailyActivity as Array<Record<string, unknown>>).map((d) => ({
        date: String(d.date ?? ""),
        message_count: Number(d.messageCount ?? 0),
        session_count: Number(d.sessionCount ?? 0),
        tool_call_count: Number(d.toolCallCount ?? 0),
      }));
    }

    if (Array.isArray(raw.dailyModelTokens)) {
      snapshot.daily_model_tokens = (raw.dailyModelTokens as Array<Record<string, unknown>>).map((d) => ({
        date: String(d.date ?? ""),
        tokens_by_model: (d.tokensByModel ?? {}) as Record<string, number>,
      }));
    }

    if (typeof raw.modelUsage === "object" && raw.modelUsage !== null) {
      const mu: StatsCacheSnapshot["model_usage"] = {};
      for (const [model, val] of Object.entries(raw.modelUsage as Record<string, Record<string, unknown>>)) {
        mu[model] = {
          input_tokens: Number(val.inputTokens ?? 0),
          output_tokens: Number(val.outputTokens ?? 0),
          cache_read_input_tokens: Number(val.cacheReadInputTokens ?? 0),
          cache_creation_input_tokens: Number(val.cacheCreationInputTokens ?? 0),
          web_search_requests: Number(val.webSearchRequests ?? 0),
        };
      }
      snapshot.model_usage = mu;
    }

    if (typeof raw.totalSessions === "number") snapshot.total_sessions = raw.totalSessions;
    if (typeof raw.totalMessages === "number") snapshot.total_messages = raw.totalMessages;
    if (typeof raw.firstSessionDate === "string") snapshot.first_session_date = raw.firstSessionDate;

    const longest = raw.longestSession as Record<string, unknown> | undefined;
    if (longest) {
      if (typeof longest.duration === "number") snapshot.longest_session_duration_ms = longest.duration;
      if (typeof longest.messageCount === "number") snapshot.longest_session_message_count = longest.messageCount;
    }

    return Object.keys(snapshot).length > 0 ? snapshot : null;
  } catch {
    return null;
  }
}
