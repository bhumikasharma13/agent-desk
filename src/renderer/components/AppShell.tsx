// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { ExtractionStats } from "../../shared/extractionTypes";
import appIcon from "../../../resources/icon.svg";
import { ProjectsPage } from "./ProjectsPage";
import { countDistinctProjects, readStatusLabel } from "./projectsModel";
import { HarnessPage } from "./HarnessPage";
import { PermissionBanner } from "./PermissionBanner";

// `-webkit-app-region` makes a strip of the frameless window draggable (and
// excludes interactive controls). It is an Electron-only CSS property not in
// the standard CSSProperties type, so we cast.
const dragRegion = { WebkitAppRegion: "drag" } as unknown as CSSProperties;
const noDrag = { WebkitAppRegion: "no-drag" } as unknown as CSSProperties;

type Section = "projects" | "harness";

// One sidebar nav row. Active row: sel background + accent text + inset edge
// (rd-nav-item.on).
function NavItem({
  active, onClick, icon, label, count,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={noDrag}
      className={`rd-nav-item${active ? " on" : ""}`}
    >
      {icon}
      {label}
      {count != null && count !== "" && <span className="ct">{count}</span>}
    </button>
  );
}

// ── AppShell ────────────────────────────────────────────────────────────────

export function AppShell() {
  const [stats, setStats] = useState<ExtractionStats | null>(null);
  // The main process could not answer for the stats at all (its handler threw).
  const [statsError, setStatsError] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<Section>("projects");
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    window.electronAPI.extraction
      .getStats()
      .then((value) => {
        if (mounted) setStats(value);
      })
      .catch((err: unknown) => {
        if (mounted) setStatsError(err instanceof Error ? err.message : String(err));
      });
    window.electronAPI.getVersion().then(setAppVersion).catch(() => {});
    const cleanupExtraction = window.electronAPI.extraction.onStatusChange((value) => {
      setStatsError(null);
      setStats(value);
    });
    return () => {
      cleanupExtraction();
      mounted = false;
    };
  }, []);

  // Sidebar count: distinct projects across every tool. Memoized — the walk
  // covers every project row and this component re-renders on unrelated state
  // (section switches).
  const projectCount = useMemo(() => (stats ? countDistinctProjects(stats) : 0), [stats]);

  // Per-stage progress of the in-flight cycle, forwarded to the Harness
  // first-scan pane so it shows what is processing instead of a bare
  // "Reading…". Null unless a cycle is actually running.
  const extractionProgress = stats?.status === "running" ? (stats.progress ?? null) : null;

  return (
    <div className="flex h-full overflow-hidden bg-bg text-fg">
      {/* ── Sidebar ── */}
      <aside className="rd-aside">
        {/* App header — draggable strip; rd-brand's 44px top clears the traffic lights */}
        <div className="rd-brand" style={dragRegion}>
          <img src={appIcon} alt="" className="mark" draggable={false} />
          <div className="min-w-0">
            <b className="truncate">Agent Desk</b>
            <span className="st">
              <i
                aria-hidden="true"
                style={{
                  background:
                    stats?.status === "running"
                      ? "var(--warn)"
                      : stats?.status === "error" || statsError
                        ? "var(--err)"
                        : "var(--ok)",
                }}
              />
              {readStatusLabel(stats, statsError)}
            </span>
          </div>
        </div>

        {/* Nav */}
        <nav className="rd-nav">
          <NavItem
            active={activeSection === "projects"}
            onClick={() => setActiveSection("projects")}
            label="Projects"
            count={projectCount}
            icon={
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
            }
          />
          <NavItem
            active={activeSection === "harness"}
            onClick={() => setActiveSection("harness")}
            label="Harness"
            icon={
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M4 4h16v4H4z" />
                <path d="M4 12h10v8H4z" />
                <path d="M18 12h2v8h-2z" />
              </svg>
            }
          />
        </nav>

        {/* Footer — name and version */}
        <div className="rd-sfoot">
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600, color: "var(--fg-2)" }}>
            Agent Desk
            {appVersion && <span style={{ fontWeight: 400, color: "var(--fg-3)" }}>v{appVersion}</span>}
          </span>
        </div>
      </aside>

      {/* ── Main pane ── */}
      <main className="flex-1 flex flex-col overflow-hidden bg-bg">
        {/* Global folder-access banner — spans every page since missing macOS
            access blocks reading app-wide, not just one page. */}
        <PermissionBanner />

        {activeSection === "projects" && <ProjectsPage stats={stats} statsError={statsError} />}
        {activeSection === "harness" && <HarnessPage extractionProgress={extractionProgress} readError={stats?.lastError ?? statsError} />}
      </main>
    </div>
  );
}
