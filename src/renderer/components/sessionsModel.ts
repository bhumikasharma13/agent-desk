// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// What the Projects page's sessions pane shows, as plain functions (no React), so the unit tests can check them.

import type { ExtractionStats, IdeType } from "../../shared/extractionTypes";
import { cutText, type SessionList, type SessionRow } from "../../shared/sessionTypes";
import { AGENT_LABELS } from "./projectsModel";

const STATS_KEY: Record<IdeType, keyof ExtractionStats["folders"]> = {
  "claude-code": "claudeCode",
  cursor: "cursor",
  copilot: "copilot",
  antigravity: "antigravity",
  codex: "codex",
  kiro: "kiro",
};

/** The tool's name as the Projects page writes it. */
export function toolLabel(ideType: IdeType): string {
  return AGENT_LABELS.find((a) => a.key === STATS_KEY[ideType])?.label ?? ideType;
}

/** A row's title on one line, or "Untitled session". */
export function sessionTitle(row: Pick<SessionRow, "title">): string {
  return row.title?.replace(/\s+/g, " ").trim() || "Untitled session";
}

/**
 * The sessions header's count: the project's own total, else, with no search narrowing it, the
 * list's total; null (shown as "…") while neither is known.
 */
export function headerCount(projectTotal: number | null, list: Pick<SessionList, "total" | "error"> | null, searching: boolean): number | null {
  if (projectTotal !== null) return projectTotal;
  return !searching && list && !list.error ? list.total : null;
}

export function countLabel(row: Pick<SessionRow, "userMessages" | "assistantMessages">): string {
  const n = row.userMessages + row.assistantMessages;
  return `${n} ${n === 1 ? "message" : "messages"}`;
}

export function durationLabel(minutes: number | null): string | null {
  if (minutes === null || minutes < 0) return null;
  if (minutes < 1) return "under a minute";
  const m = Math.round(minutes);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The tool a Projects group (keyed as ExtractionStats.folders) stands for. */
export function ideTypeOfKey(key: string): IdeType {
  const hit = (Object.entries(STATS_KEY) as [IdeType, string][]).find(([, k]) => k === key);
  if (!hit) throw new Error(`no tool for the Projects group ${key}`);
  return hit[0];
}

/** The space between two stack chips (Tailwind gap-1.5). */
export const CHIP_GAP_PX = 6;

/**
 * How many stack chips, of the measured `widths`, fit `width` pixels on one line: all of them,
 * or as many as leave room for the "+N" of measured width `more` after them.
 */
export function fitChips(widths: number[], width: number, more: number, gap = CHIP_GAP_PX): number {
  const total = widths.reduce((sum, w, i) => sum + w + (i > 0 ? gap : 0), 0);
  if (total <= width) return widths.length;
  let used = more;
  let n = 0;
  for (const w of widths) {
    if (used + gap + w > width) break;
    used += gap + w;
    n++;
  }
  return n;
}

/** A Projects row's accessible name: its folder, its tool and its session count. */
export function projectRowLabel(name: string, tool: string, count: number): string {
  return `${name}, ${tool}, ${count} ${count === 1 ? "session" : "sessions"}`;
}

/** Messages longer than this show their first part, with Show more. */
export const COLLAPSE_AT = 500;

export function visibleText(content: string, expanded: boolean): string {
  return expanded || content.length <= COLLAPSE_AT ? content : `${cutText(content, COLLAPSE_AT)}…`;
}

const DAY_MS = 86_400_000;

/**
 * The heading a session sits under, by its last activity in local time, as Claude Code's
 * session pickers group them: Today, Yesterday, Previous 7 days, Previous 30 days, then
 * one per month. A session with no time (0) sits under "No date".
 */
export function dateGroup(ms: number, now: Date): string {
  if (!(ms > 0)) return "No date";
  const midnight = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const at = new Date(ms);
  // Rounded, so a day of 23 or 25 hours (a clock change) still counts as one.
  const days = Math.round((midnight(now) - midnight(at)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return at.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

/** Rows, in their order, under their date headings. */
export function groupRows<T extends { lastActivityMs: number }>(rows: T[], now: Date): { label: string; rows: T[] }[] {
  const groups: { label: string; rows: T[] }[] = [];
  for (const row of rows) {
    const label = dateGroup(row.lastActivityMs, now);
    if (groups.at(-1)?.label === label) groups.at(-1)!.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}

/**
 * The list after Load more answers: the next page added to `base`, the list it was asked
 * for. A list read again meanwhile (a filter change or a finished read) is newer, so the
 * page is dropped and `current` kept.
 */
export function afterLoadMore(current: SessionList | null, base: SessionList, next: SessionList): SessionList | null {
  if (current !== base) return current;
  return { rows: appendPage(base.rows, next.rows), total: next.error ? base.total : next.total, error: next.error };
}

/** Splits a message into text and the `[Tool: …]` markers the readers write for tool calls. */
export function splitToolMarkers(content: string): { text: string; tool: boolean }[] {
  const parts: { text: string; tool: boolean }[] = [];
  let at = 0;
  for (const m of content.matchAll(/\[Tool: [^\]\n]*\]/g)) {
    if (m.index > at) parts.push({ text: content.slice(at, m.index), tool: false });
    parts.push({ text: m[0].slice(1, -1), tool: true });
    at = m.index + m[0].length;
  }
  if (at < content.length) parts.push({ text: content.slice(at), tool: false });
  return parts;
}

/** A timestamp in the viewer's locale, or null when there is none or it does not parse. */
export function timeLabel(iso: string | null): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toLocaleString();
}

/** The loaded rows with a next page after them, less any row already loaded. */
export function appendPage<T extends { key: string }>(loaded: T[], next: T[]): T[] {
  const have = new Set(loaded.map((r) => r.key));
  return [...loaded, ...next.filter((r) => !have.has(r.key))];
}

/** The parts of a message to show: tool-call labels in an assistant's text only, a user's own text as typed. */
export function messageParts(role: string, content: string): { text: string; tool: boolean }[] {
  return role === "assistant" ? splitToolMarkers(content) : [{ text: content, tool: false }];
}

/**
 * Whether an Escape is the sessions views' to go back with: not when something already handled
 * it, nor when it comes from a text field (the search box handles its own) or a dialog.
 */
export function listKeyApplies(defaultPrevented: boolean, target: { closest(selector: string): unknown } | null): boolean {
  if (defaultPrevented) return false;
  return !target?.closest('input, textarea, select, [role="dialog"]');
}

export function tokenLabel(m: { inputTokens: number | null; outputTokens: number | null }): string | null {
  if (m.inputTokens === null && m.outputTokens === null) return null;
  return `${m.inputTokens ?? 0} in · ${m.outputTokens ?? 0} out`;
}
