// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import path from "node:path";
import fs from "node:fs";
import type { AiAttributionMetrics } from "../types/session";
import { openVendorDb, type VendorDb } from "./sqliteReader";

const AI_TRACKING_DB = "ai-tracking/ai-code-tracking.db";

/** Check if a table exists in the SQLite database. */
function tableExists(db: VendorDb, tableName: string): boolean {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName) as { name: string } | undefined;
    return row != null;
  } catch {
    return false;
  }
}

/** Check if a column exists on a SQLite table via PRAGMA table_info. */
function columnExists(db: VendorDb, tableName: string, columnName: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return rows.some((r) => r.name === columnName);
  } catch {
    return false;
  }
}

/**
 * Reads Cursor's AI code tracking SQLite database for attribution metrics.
 * Handles missing DB or schema changes gracefully (returns null).
 *
 * Uses PRAGMA-based column/table probing so the same code works on both
 * Cursor 2.x (fewer tables) and Cursor 3+ (expanded schema) without errors.
 */
export function readCursorAiTracking(cursorDir: string): AiAttributionMetrics | null {
  const dbPath = path.join(cursorDir, AI_TRACKING_DB);
  if (!fs.existsSync(dbPath)) return null;

  try {
    const db = openVendorDb(dbPath, 5000);

    const metrics: AiAttributionMetrics = {};

    // Tab completions count.
    try {
      const countRow = db.prepare("SELECT COUNT(*) as cnt FROM ai_code_hashes").get() as { cnt: number } | undefined;
      if (countRow) metrics.tab_completion_count = countRow.cnt;
    } catch {
      // Table may not exist in older Cursor versions.
    }

    // AI code percent from scored_commits (the plain mean over scored commits).
    try {
      const avgRow = db.prepare(
        "SELECT AVG(ai_percentage) as avg_pct FROM scored_commits WHERE ai_percentage IS NOT NULL"
      ).get() as { avg_pct: number | null } | undefined;
      if (avgRow?.avg_pct != null) metrics.ai_code_percent = avgRow.avg_pct / 100;
    } catch {
      // Table may not exist.
    }

    // Cursor 3+: model breakdown for tab completions.
    if (columnExists(db, "ai_code_hashes", "model")) {
      try {
        const rows = db.prepare(
          "SELECT model, COUNT(*) as cnt FROM ai_code_hashes WHERE model IS NOT NULL AND model != '' GROUP BY model"
        ).all() as Array<{ model: string; cnt: number }>;
        if (rows.length > 0) {
          metrics.tab_completion_model_breakdown = {};
          for (const r of rows) {
            metrics.tab_completion_model_breakdown[r.model] = r.cnt;
          }
        }
      } catch { /* schema mismatch — skip */ }
    }

    // Cursor 3+: more accurate v2 AI percentage.
    if (columnExists(db, "scored_commits", "v2AiPercentage")) {
      try {
        const avgRow = db.prepare(
          "SELECT AVG(v2AiPercentage) as avg_pct FROM scored_commits WHERE v2AiPercentage IS NOT NULL"
        ).get() as { avg_pct: number | null } | undefined;
        if (avgRow?.avg_pct != null) metrics.ai_code_percent_v2 = avgRow.avg_pct / 100;
      } catch { /* skip */ }
    }

    // Cursor 3+: files removed during AI sessions.
    if (tableExists(db, "deleted_files")) {
      try {
        const countRow = db.prepare("SELECT COUNT(*) as cnt FROM deleted_files").get() as { cnt: number } | undefined;
        if (countRow && countRow.cnt > 0) metrics.deleted_files_count = countRow.cnt;
      } catch { /* skip */ }
    }

    // Tracking state: when AI code tracking was first enabled.
    if (tableExists(db, "tracking_state")) {
      try {
        const row = db.prepare("SELECT value FROM tracking_state LIMIT 1").get() as { value: string } | undefined;
        if (row?.value) metrics.tracking_start_time = row.value;
      } catch { /* skip */ }
    }

    db.close();
    return Object.keys(metrics).length > 0 ? metrics : null;
  } catch {
    // DB access failed — skip gracefully.
    return null;
  }
}

/**
 * Reads Cursor's pre-aggregated daily AI stats from state.vscdb.
 * Keys: aiCodeTracking.dailyStats.v1.5.<date>
 * Each value: {tabSuggestedLines, tabAcceptedLines, composerSuggestedLines, composerAcceptedLines}
 *
 * The caller provides a callback that queries keys matching a LIKE pattern
 * from the cursorDiskKV table (reusing the already-open SQLiteReader).
 */
export function readCursorDailyStats(
  queryKeys: (pattern: string) => Array<{ key: string; value: string }>
): Pick<
  AiAttributionMetrics,
  "tab_suggested_lines" | "tab_accepted_lines" | "composer_suggested_lines" | "composer_accepted_lines"
> | null {
  try {
    const rows = queryKeys("aiCodeTracking.dailyStats.v1.5.%");
    if (rows.length === 0) return null;

    let tabSuggested = 0;
    let tabAccepted = 0;
    let composerSuggested = 0;
    let composerAccepted = 0;

    for (const row of rows) {
      try {
        const stats = JSON.parse(row.value) as Record<string, unknown>;
        if (typeof stats.tabSuggestedLines === "number") tabSuggested += stats.tabSuggestedLines;
        if (typeof stats.tabAcceptedLines === "number") tabAccepted += stats.tabAcceptedLines;
        if (typeof stats.composerSuggestedLines === "number") composerSuggested += stats.composerSuggestedLines;
        if (typeof stats.composerAcceptedLines === "number") composerAccepted += stats.composerAcceptedLines;
      } catch {
        // Skip malformed entries.
      }
    }

    return {
      tab_suggested_lines: tabSuggested,
      tab_accepted_lines: tabAccepted,
      composer_suggested_lines: composerSuggested,
      composer_accepted_lines: composerAccepted,
    };
  } catch {
    return null;
  }
}
