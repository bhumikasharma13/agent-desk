// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import type { ExtractionStats, IdeType } from "../../shared/extractionTypes";
import type { StackProject } from "../../shared/ipcTypes";
import { agentMark, buildIdeGroups, emptyProjectsText, type IdeGroup, type ProjectRow } from "./projectsModel";
import { stackTagLabel } from "./stackTagLabel";
import { ReadProgress } from "./ReadProgress";
import { ProjectSessions, moveFocus } from "./ProjectSessions";
import { fitChips, ideTypeOfKey, projectRowLabel } from "./sessionsModel";

// ─────────────────────────────────────────────────────────────────────────────
// Projects page — IDE-grouped project lists: one group per AI agent, each
// project row carrying its detected stack tags (StackDetector via
// stack:getProjects) and its session count, on one line. Choosing a row
// replaces the list with that tool's sessions in that project (ProjectSessions),
// and choosing a session replaces those with its conversation.
// ─────────────────────────────────────────────────────────────────────────────

const dragRegion = { WebkitAppRegion: "drag" } as unknown as CSSProperties;

// Agent icon: the agent's two-letter mark.
function AgentBadge({ label }: { label: string }) {
  return (
    <span className="flex h-[18px] w-[18px] items-center justify-center rounded-[var(--r-md)] bg-accent border border-border font-mono text-[8.5px] font-bold text-muted-foreground">
      {agentMark(label)}
    </span>
  );
}

function relativeTime(isoString: string): string {
  const diff = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

const CHIP = "text-[10.5px] px-[7px] py-0.5 rounded-[var(--r-md)] bg-accent text-muted-foreground whitespace-nowrap";

// The stack chips that fit the Stack column on one line, then "+N" with the rest on hover.
// Measured, not estimated: before the first paint, and again when the tags change or a font
// loads, every chip and the "+N" are laid out once and measured; a resize refits from those
// widths. Both apply before the next paint (flushSync), so no frame shows a chip cut off.
function StackTags({ labels }: { labels: string[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<number | null>(null); // null: measuring, every chip laid out
  const sizes = useRef<{ chips: number[]; more: number } | null>(null);
  const key = labels.join("\u0000");
  useLayoutEffect(() => {
    sizes.current = null;
    setFit(null);
  }, [key]);
  const refit = (columnWidth: number): void => {
    if (sizes.current) setFit(fitChips(sizes.current.chips, Math.floor(columnWidth), sizes.current.more));
  };
  useLayoutEffect(() => {
    if (fit !== null || !box.current) return;
    const width = (el: Element | null): number => el?.getBoundingClientRect().width ?? 0;
    sizes.current = { chips: [...box.current.querySelectorAll("[data-chip]")].map(width), more: width(box.current.querySelector("[data-more]")) };
    refit(width(box.current));
  });
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([entry]) => flushSync(() => refit(entry!.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    let alive = true;
    const measureAgain = (): void => {
      if (!alive) return;
      sizes.current = null;
      flushSync(() => setFit(null));
    };
    if (document.fonts.status === "loading") void document.fonts.ready.then(measureAgain);
    document.fonts.addEventListener("loadingdone", measureAgain);
    return () => {
      alive = false;
      document.fonts.removeEventListener("loadingdone", measureAgain);
    };
  }, []);
  const n = fit ?? labels.length;
  const hidden = labels.slice(n);
  return (
    <div ref={box} className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden whitespace-nowrap">
      {labels.slice(0, n).map((t) => (
        <span key={t} data-chip="" className={CHIP}>
          {t}
        </span>
      ))}
      {fit === null ? (
        // Measured with the widest count it can show; out of the flow, so it takes no room.
        <span data-more="" aria-hidden="true" className="invisible absolute text-[10.5px]">+{labels.length}</span>
      ) : (
        hidden.length > 0 && (
          // The hidden tags on hover; the row's description names them all for a screen reader.
          <span data-more="" className="text-[10.5px] text-muted-foreground cursor-default" title={hidden.join(", ")}>
            +{hidden.length}
          </span>
        )
      )}
    </div>
  );
}

/** The project chosen, whose sessions replace the list. */
interface Selection {
  key: string;
  ideType: IdeType;
  path: string | null;
  name: string;
}

// One project row on one line: name, stack tags, session count. A button: choosing it opens its
// sessions. Its description lists the whole stack, the tags behind "+N" included.
function ProjectRowView({
  rowKey, row, tags, label, onSelect,
}: { rowKey: string; row: ProjectRow; tags: string[]; label: string; onSelect: () => void }) {
  const describedBy = useId();
  const labels = row.isFallback ? [] : tags.map(stackTagLabel);
  return (
    <button
      type="button"
      data-project-row={rowKey}
      aria-label={projectRowLabel(row.name, label, row.count)}
      aria-describedby={labels.length > 0 ? describedBy : undefined}
      onClick={onSelect}
      className="flex w-full items-center gap-3 whitespace-nowrap border-b border-border last:border-0 px-1.5 py-1.5 text-left hover:bg-[var(--hv-n)] focus-visible:bg-[var(--sel)]"
    >
      <span
        // Full path on hover of the Project cell only — keeps the path off the
        // Stack area so its "+N" overflow tooltip is the sole hover target there.
        title={row.path ?? "Sessions with no project folder"}
        className={`w-[200px] min-w-0 flex-shrink-0 truncate text-[13px] ${
          row.isFallback ? "italic text-muted-foreground" : "font-medium text-fg"
        }`}
      >
        {row.name}
      </span>
      {labels.length > 0 ? <StackTags labels={labels} /> : <div className="flex-1" />}
      {labels.length > 0 && (
        <span id={describedBy} hidden>
          Stack: {labels.join(", ")}
        </span>
      )}
      <span className="w-16 flex-shrink-0 text-right font-mono text-[11.5px] text-muted-foreground">{row.count}</span>
    </button>
  );
}

function IdeGroupView({
  group, stackByPath, onSelect,
}: {
  group: IdeGroup;
  stackByPath: Map<string, string[]>;
  onSelect: (s: Selection) => void;
}) {
  const ideType = ideTypeOfKey(group.key);
  return (
    <div className="mb-5">
      <div className="flex items-center gap-2 border-b border-border pb-2 mb-1">
        <span className="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center">
          <AgentBadge label={group.label} />
        </span>
        <span className="text-[11.5px] font-bold uppercase tracking-[0.04em]">{group.label}</span>
        <span className="ml-auto font-mono text-[11.5px] text-muted-foreground">
          {group.rows.length} {group.rows.length === 1 ? "project" : "projects"} · {group.sessions}{" "}
          {group.sessions === 1 ? "session" : "sessions"}
        </span>
      </div>
      <div className="flex items-center gap-3 border-b border-border px-1.5 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
        <span className="w-[200px] flex-shrink-0">Project</span>
        <span className="min-w-0 flex-1">Stack</span>
        <span className="w-16 flex-shrink-0 text-right">Sessions</span>
      </div>
      {group.rows.map((row) => {
        const key = `${ideType}\u0000${row.key}`;
        return (
          <ProjectRowView
            key={row.key}
            rowKey={key}
            row={row}
            tags={(row.path && stackByPath.get(row.path)) || []}
            label={group.label}
            onSelect={() => onSelect({ key, ideType, path: row.path, name: row.name })}
          />
        );
      })}
    </div>
  );
}

export function ProjectsPage({ stats, statsError }: { stats: ExtractionStats | null; statsError: string | null }) {
  const [stackProjects, setStackProjects] = useState<StackProject[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);

  useEffect(() => {
    window.electronAPI?.stack?.getProjects()
      .then(setStackProjects)
      .catch(() => {});
    // Refresh when a rescan lands (e.g. the folder primer just unlocked projects
    // that were skipped on first launch), so they appear without a restart.
    return window.electronAPI?.stack?.onProjectsUpdated?.(setStackProjects);
  }, []);

  const stackByPath = useMemo(
    () => new Map(stackProjects.map((p) => [p.path, p.stackTags])),
    [stackProjects],
  );

  // Back from a project's sessions: the list scrolled where it was, the same row focused, or the
  // first row when a read has taken that one away.
  const listRef = useRef<HTMLDivElement>(null);
  const saved = useRef<{ scrollTop: number; key: string } | null>(null);
  const choose = (s: Selection): void => {
    saved.current = { scrollTop: listRef.current?.scrollTop ?? 0, key: s.key };
    setSelection(s);
  };
  useLayoutEffect(() => {
    if (selection || !saved.current || !listRef.current) return;
    const { scrollTop, key } = saved.current;
    listRef.current.scrollTop = scrollTop;
    const rowEls = [...listRef.current.querySelectorAll<HTMLElement>("[data-project-row]")];
    const left = rowEls.find((el) => el.dataset.projectRow === key);
    if (left) left.focus({ preventScroll: true });
    else rowEls[0]?.focus();
  }, [selection]);

  const handleExtractNow = async () => {
    setExtracting(true);
    try {
      await window.electronAPI.extraction.triggerNow();
    } catch {
      // The cycle reports its own error through the status push.
    } finally {
      setExtracting(false);
    }
  };

  const hasData = (stats?.counts.total ?? 0) > 0;
  // Grouping walks every project row of every IDE — memoized (like stackByPath
  // above) so unrelated re-renders don't rebuild it; only a stats change does.
  const groups = useMemo(() => (stats ? buildIdeGroups(stats) : []), [stats]);

  if (selection) {
    return (
      <ProjectSessions
        key={selection.key}
        ideType={selection.ideType}
        projectPath={selection.path}
        projectName={selection.name}
        lastRunAt={stats?.lastRunAt ?? null}
        onBack={() => setSelection(null)}
      />
    );
  }

  return (
    <>
      {/* Page header — draggable */}
      <div className="px-6 pt-6 pb-0" style={dragRegion}>
        <div className="text-[18px] font-bold tracking-tight">Projects</div>
        <div className="text-[12.5px] text-muted-foreground mt-0.5">
          The project folders your AI coding sessions ran in, per tool. Choose one to see its sessions.
        </div>
      </div>
      <div className="mt-3 border-b border-border" />

      {/* Scroll body. Up and Down move between the rows, Enter or Space opens one. */}
      <div ref={listRef} className="flex-1 overflow-y-auto" onKeyDown={(e) => moveFocus(e, "[data-project-row]")}>
        <div className="px-6 py-5 space-y-4">
          {/* Dev-only action button */}
          {import.meta.env.DEV && (
            <div className="flex gap-2">
              <button
                onClick={handleExtractNow}
                disabled={extracting}
                className="flex-1 py-1.5 text-xs rounded-[var(--r-md)] border border-border bg-card text-muted-foreground hover:text-fg hover:bg-accent transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {extracting ? "Extracting…" : "Extract Now"}
              </button>
            </div>
          )}

          {hasData ? (
            <div>
              {groups.map((g) => (
                <IdeGroupView
                  key={g.key}
                  group={g}
                  stackByPath={stackByPath}
                  onSelect={choose}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-10 gap-2">
              <p className="text-sm text-muted-foreground text-center">{emptyProjectsText(stats, statsError)}</p>
              {stats?.lastRunAt && stats.status !== "running" && stats.status !== "error" && !statsError && (
                <p className="text-xs text-muted-foreground/60 text-center">
                  Use Cursor, Claude Code, GitHub Copilot, Antigravity, Codex, or Kiro to start a session, then return here.
                </p>
              )}
            </div>
          )}

          {statsError && <p className="text-xs text-error">The app could not get its session counts: {statsError}</p>}
          {stats?.lastError && <p className="text-xs text-error">{stats.lastError}</p>}
          {stats && stats.problems.length > 0 && (
            <ul className="text-xs text-error list-disc pl-4">
              {stats.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}

          {stats?.status === "running" && stats.progress && stats.progress.length > 0 ? (
            <div className="rounded-[var(--r-lg)] border border-border bg-accent px-3 py-2.5">
              <ReadProgress stages={stats.progress} />
            </div>
          ) : (
            stats?.lastRunAt && (
              <p className="text-xs text-muted-foreground/60 font-mono">
                Last read {relativeTime(stats.lastRunAt)}
              </p>
            )
          )}
        </div>
      </div>
    </>
  );
}
