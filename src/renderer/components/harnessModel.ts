// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// What the Harness page shows, as plain functions (no React and only type imports), so the
// unit tests can check them and scripts/example-show.mjs can print the same labels.

import type { HarnessAsset, HarnessAssetType } from "../../shared/harnessTypes";

// A tab can span several asset types. "Context / Rules" folds the instruction
// files (CLAUDE.md, AGENTS.md) in with rules — they're all the same thing to a
// reader: the standing context/rules the agent runs under — and leads the tabs.
// Multi-type tabs render a leading type icon on the Name cell so the distinctions
// stay legible.
export interface TabDef {
  id: string;
  label: string;
  types: HarnessAssetType[];
}
export const TYPE_TABS: TabDef[] = [
  { id: "context", label: "Context / Rules", types: ["rule", "claude_md", "agents_md"] },
  // Prompt templates (.claude/templates/*.md) — a distinct installed kind, so
  // it gets its own tab. Without one, a collected template would count into the
  // "N agent files" total yet appear in no tab (the sum of the per-tab counts would
  // undershoot the total, and the rows would be unreachable).
  { id: "template", label: "Templates", types: ["prompt_template"] },
  { id: "skill", label: "Skills", types: ["skill"] },
  { id: "agent", label: "Subagents", types: ["agent"] },
  { id: "command", label: "Commands", types: ["command"] },
  { id: "plugin", label: "Plugins", types: ["plugin"] },
  { id: "hook", label: "Hooks", types: ["hook"] },
];

// The "source" filter is a scope picker, not a raw origin list: every
// user-scope asset (global ~/.claude, cursor, plugins) collapses into one
// "User" bucket, while repo-scoped assets stay grouped by their repo name.
export const USER_SOURCE = "User";
export function sourceFilterKey(a: Pick<HarnessAsset, "scope" | "source">): string {
  return a.scope === "user" ? USER_SOURCE : a.source;
}

// Quiet meta text for an asset's scope: "User", or "<repo> · committed/local".
export function sourceLabel(a: Pick<HarnessAsset, "scope" | "source">): string {
  if (a.scope === "user") return USER_SOURCE;
  return `${a.source} · ${a.scope === "repo-committed" ? "committed" : "local"}`;
}

/** The tab an asset type is listed under. Every type has exactly one. */
export function tabForType(type: HarnessAssetType): TabDef | undefined {
  return TYPE_TABS.find((t) => t.types.includes(type));
}

/**
 * Whether the Harness page shows the last read's error: whenever there is one, above
 * the stored scan and beside a recorded scan failure too (a read error is not a scan
 * failure, and an old scan failure stays on record until the next good scan).
 */
export function showsReadError(readError: string | null): boolean {
  return readError !== null && readError !== "";
}

/** How long ago a time was, as "5m ago"; "—" when there is none. */
export function relTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "—";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
