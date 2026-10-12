// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import type { IdeType } from "../../../shared/extractionTypes";

export type ExtractionSource = IdeType;

// Cycle run order, shared by the worker (execution) and the scheduler (the
// stage list it seeds for progress reporting) so the two can never drift.
// Cursor runs LAST: its cold crawl of state.vscdb can take minutes, and
// everything sequenced after it would sit invisible for that long. The harness
// scan runs between the two groups.
export const PRE_MODULE_SOURCES: readonly ExtractionSource[] = [
  "claude-code",
  "copilot",
  "antigravity",
  "codex",
  "kiro",
];
export const POST_MODULE_SOURCES: readonly ExtractionSource[] = ["cursor"];

/** The harness inventory stage's id in the progress stage list. */
export const HARNESS_STAGE = "harness-assets";

export interface SpawnInit {
  userDataPath: string;
  /** The session store (`local-session-extractor`'s SQLite file). */
  storePath: string;
  /** Where the last harness scan is kept as JSON. */
  inventoryPath: string;
}

// Per-cycle config passed from main → worker on every `run` message.
export interface RunConfig {
  sources: ExtractionSource[];
  // Protected folders (Desktop, Documents, Downloads) the user has not granted:
  // not yet asked about by the primer, or denied. The harness scan skips every
  // repo inside one, so no scan raises an unexplained macOS prompt. Main
  // computes it each cycle through permissions/folderAccessGuard.ts.
  skipRoots?: string[];
}

// Per-IDE conversation counts — one fixed field per source.
export interface RunCounts {
  claudeCode: number;
  cursor: number;
  copilot: number;
  antigravity: number;
  codex: number;
  kiro: number;
}

export type MainToWorkerMessage =
  | { type: "init"; init: SpawnInit }
  | { type: "run"; config: RunConfig }
  | { type: "shutdown" };

/** The store's count aggregates, as `SessionStore.countByIde` / `countByIdeAndProject` return them. */
export interface CountsAggregates {
  counts: { claudeCode: number; cursor: number; copilot: number; antigravity: number; codex: number; kiro: number; total: number };
  folderRows: { ide_type: string; project_path: string | null; count: number }[];
}

// One source's or the harness scan's lifecycle inside a cycle. `stage`
// discriminates the id namespace: "source" ids are ExtractionSource values,
// "module" ids are HARNESS_STAGE. `count` is the rows written (sessions) or
// assets found, present only on state "done"; `aggregates` rides along when a
// source wrote rows, computed on the worker's connection so the main (UI)
// thread never runs the full-table count queries mid-cycle.
export type WorkerProgressEvent =
  | { stage: "source"; id: ExtractionSource; state: "start" }
  | { stage: "source"; id: ExtractionSource; state: "done"; count: number; aggregates?: CountsAggregates }
  | { stage: "module"; id: string; state: "start" }
  | { stage: "module"; id: string; state: "done"; count: number };

export type WorkerToMainMessage =
  | { type: "ready" }
  | ({ type: "progress" } & WorkerProgressEvent)
  // `problems` names each source that could not be read as a whole, each
  // source with sessions that could not be read, and a failed harness scan,
  // one line each; the rest of the cycle still ran.
  | {
      type: "done";
      counts: RunCounts;
      moduleCounts: Record<string, number>;
      problems: string[];
      durationMs: number;
    }
  | { type: "error"; message: string; stack?: string };
