// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import type { CycleStage } from "../../shared/extractionTypes";

// ─────────────────────────────────────────────────────────────────────────────
// Read progress — renders the per-stage progress of the in-flight extraction
// cycle (ExtractionStats.progress). The first cycle after launch can run for
// minutes, so a single opaque "Reading…" hides what is actually happening;
// these show the stage list and a high-level phase line instead. @theme token
// classes only, so they resolve inside the Projects and Harness pages.
// ─────────────────────────────────────────────────────────────────────────────

// Human labels per stage id. `kind` distinguishes per-IDE source scans from the
// data-kind module collectors; new/unknown ids fall back to the raw id so a
// future stage kind never renders blank or crashes.
const STAGE_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  copilot: "GitHub Copilot",
  antigravity: "Antigravity",
  codex: "Codex",
  kiro: "Kiro",
  "harness-assets": "Agent files",
};

function stageLabel(id: string): string {
  return STAGE_LABELS[id] ?? id;
}

// Source stages scan an IDE; module stages collect a data kind. Reads naturally
// for every label ("scanning Cursor", "collecting Harness inventory").
function stageVerb(kind: CycleStage["kind"]): string {
  return kind === "module" ? "collecting" : "scanning";
}

// The stage the cycle is currently on: the running one, else the next pending
// one (its 1-based position is the "step N of M"). Null when nothing is
// running/pending (empty list or every stage done).
function currentStage(stages: CycleStage[]): { stage: CycleStage; index: number } | null {
  const runningIdx = stages.findIndex((s) => s.state === "running");
  const idx = runningIdx !== -1 ? runningIdx : stages.findIndex((s) => s.state === "pending");
  if (idx === -1) return null;
  return { stage: stages[idx]!, index: idx };
}

function readPhaseText(stages: CycleStage[]): string | null {
  const cur = currentStage(stages);
  if (!cur) return null;
  return `Reading — ${stageVerb(cur.stage.kind)} ${stageLabel(cur.stage.id)} (step ${
    cur.index + 1
  } of ${stages.length})…`;
}

function stateWord(state: CycleStage["state"]): string {
  return state === "done" ? "done" : state === "running" ? "in progress" : "pending";
}

// Per-stage status glyph: a check when done, a pulsing accent dot while running,
// a dim dot when pending. Decorative — the row's text + sr-only status carry
// state to assistive tech.
function StageIndicator({ state }: { state: CycleStage["state"] }) {
  if (state === "done") {
    return (
      <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center text-success" aria-hidden="true">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
    );
  }
  return (
    <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center" aria-hidden="true">
      {state === "running" ? (
        <span className="h-1.5 w-1.5 rounded-full bg-ac animate-pulse" />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--bd-s)" }} />
      )}
    </span>
  );
}

function StageRow({ stage }: { stage: CycleStage }) {
  return (
    <li className="flex items-center gap-2 text-[11.5px]">
      <StageIndicator state={stage.state} />
      <span
        className={stage.state === "running" ? "text-foreground font-medium" : "text-muted-foreground"}
        style={stage.state === "pending" ? { color: "var(--fg-3)" } : undefined}
      >
        {stageLabel(stage.id)}
      </span>
      <span className="sr-only">{stateWord(stage.state)}</span>
      {stage.state === "done" && stage.count !== null && (
        <span className="ml-auto font-mono text-[10.5px]" style={{ color: "var(--fg-3)" }}>
          {stage.count}
        </span>
      )}
    </li>
  );
}

/** Detailed stage list — done stages carry a check + row count, the running
 *  stage pulses, pending stages sit dim. Compact enough to nest inside a page. */
export function ReadProgress({ stages }: { stages: CycleStage[] }) {
  if (stages.length === 0) return null;
  return (
    <ul role="list" aria-live="polite" className="flex flex-col gap-1">
      {stages.map((s) => (
        <StageRow key={s.id} stage={s} />
      ))}
    </ul>
  );
}

/** High-level one-liner ("Reading — scanning Cursor (step 7 of 7)…") for the
 *  first-scan panes. Falls back to a plain label when no progress is available. */
export function ReadPhaseLine({ stages, fallback = "Reading…" }: { stages: CycleStage[] | null; fallback?: string }) {
  const text = (stages && readPhaseText(stages)) || fallback;
  return (
    <p aria-live="polite" className="text-sm text-foreground font-semibold animate-pulse">
      {text}
    </p>
  );
}

/** Shared first-scan pane for the Harness table views: the store is empty
 *  because the first collect cycle hasn't finished — distinct from "scanned and
 *  found nothing". Pages differ only in the explanatory body text. */
export function FirstScanReadingPane({ progress, body }: { progress: CycleStage[] | null; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 gap-2">
      <ReadPhaseLine stages={progress} />
      <p className="text-xs text-muted-foreground text-center leading-relaxed max-w-[360px]">{body}</p>
    </div>
  );
}
