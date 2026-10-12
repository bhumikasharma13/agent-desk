// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Shared types for the extraction status the renderer shows.
 * Used by main process, preload, and renderer.
 */

/** The tools whose sessions the app reads. */
export type IdeType = "claude-code" | "cursor" | "copilot" | "antigravity" | "codex" | "kiro";

// ── Extraction stats (sent to renderer via IPC) ──────────────────────────────

export interface ProjectFolderStat {
  path: string | null; // null = no project path recorded
  count: number;
}

// One stage of the running extraction cycle, in execution order. "source"
// stages read one tool's sessions (id: IdeType); the "module" stage is the
// harness scan (id: "harness-assets"). `count` is rows written or assets found,
// set once the stage is done.
export interface CycleStage {
  id: string;
  kind: "source" | "module";
  state: "pending" | "running" | "done";
  count: number | null;
}

export interface ExtractionStats {
  status: "idle" | "running" | "error";
  lastRunAt: string | null;
  lastError: string | null;
  // What the last completed cycle could not read (a source that failed as a
  // whole, sessions skipped, a failed harness scan), one line each.
  problems: string[];
  // Stage-by-stage progress of the in-flight cycle, null when no cycle is
  // running. Lets the UI show what is currently processing instead of a
  // single opaque "Reading…" for the whole (potentially minutes-long) cycle.
  progress: CycleStage[] | null;
  counts: {
    claudeCode: number;
    cursor: number;
    copilot: number;
    antigravity: number;
    codex: number;
    kiro: number;
    total: number;
  };
  folders: {
    claudeCode: ProjectFolderStat[];
    cursor: ProjectFolderStat[];
    copilot: ProjectFolderStat[];
    antigravity: ProjectFolderStat[];
    codex: ProjectFolderStat[];
    kiro: ProjectFolderStat[];
  };
}
