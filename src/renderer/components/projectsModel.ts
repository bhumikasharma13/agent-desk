// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// What the Projects page and the sidebar show, as plain functions (no React), so the unit
// tests can check them.

import type { ExtractionStats } from "../../shared/extractionTypes";
import { extractBasename } from "../../shared/pathUtils";

// Display order and labels for the AI agents whose sessions are read.
export const AGENT_LABELS: {
  key: keyof ExtractionStats["folders"];
  label: string;
}[] = [
  { key: "claudeCode", label: "Claude Code" },
  { key: "cursor", label: "Cursor" },
  { key: "copilot", label: "GitHub Copilot" },
  { key: "antigravity", label: "Antigravity" },
  { key: "codex", label: "Codex" },
  { key: "kiro", label: "Kiro" },
];

// Two-letter mark derived from the agent label: initials of the first two
// words, or the first two letters of a single-word name ("Cursor" → "CU").
// Words are runs of letters and digits, so punctuation never becomes a letter of
// the mark ("Agents (shared)" → "AS", not "A(").
export function agentMark(label: string): string {
  const words = label.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0] ?? "").slice(0, 2).toUpperCase();
}


export interface ProjectRow {
  key: string;          // React key — full path, or a sentinel for path-less
  path: string | null;
  name: string;         // basename label ("No folder" when path-less)
  count: number;        // sessions for this project under this agent
  isFallback: boolean;  // path-less bucket — demoted and sorted last
}

export interface IdeGroup {
  key: string;
  label: string;
  rows: ProjectRow[];
  sessions: number;
}

/** One group per agent that has sessions, projects sorted by sessions desc;
 *  the path-less bucket ("No folder") always sinks to the bottom. */
export function buildIdeGroups(stats: ExtractionStats): IdeGroup[] {
  const groups: IdeGroup[] = [];
  for (const { key, label } of AGENT_LABELS) {
    const folders = stats.folders[key] ?? [];
    if (folders.length === 0) continue;
    const rows: ProjectRow[] = folders.map((f) => {
      const isFallback = f.path === null;
      return {
        key: f.path ?? "::no-project::",
        path: f.path,
        name: isFallback ? "No folder" : extractBasename(f.path) ?? "Unknown project",
        count: f.count,
        isFallback,
      };
    });
    rows.sort((a, b) => {
      if (a.isFallback !== b.isFallback) return a.isFallback ? 1 : -1;
      if (b.count !== a.count) return b.count - a.count;
      return a.name.localeCompare(b.name);
    });
    groups.push({ key, label, rows, sessions: rows.reduce((s, r) => s + r.count, 0) });
  }
  return groups;
}

/** Distinct projects across all agents (the sidebar count). Distinct by path so
 *  the number matches what the user sees. */
export function countDistinctProjects(stats: ExtractionStats): number {
  const seen = new Set<string | null>();
  for (const { key } of AGENT_LABELS) {
    for (const f of stats.folders[key] ?? []) seen.add(f.path);
  }
  return seen.size;
}

/** The sidebar's one-word read state. */
export function readStatusLabel(stats: ExtractionStats | null, statsError: string | null): string {
  if (stats?.status === "running") return "Reading…";
  if (stats?.status === "error" || statsError) return "Error";
  if (!stats?.lastRunAt) return "Not read since launch";
  return "Up to date";
}

/** The Projects page's text when it has no rows to show. */
export function emptyProjectsText(stats: ExtractionStats | null, statsError: string | null): string {
  if (stats?.status === "running") return "Reading your AI coding sessions. This usually takes a couple of minutes.";
  if (stats?.status === "error" || statsError) return "Sessions could not be read.";
  if (!stats?.lastRunAt) return "Not read since launch.";
  return "No sessions detected yet.";
}
