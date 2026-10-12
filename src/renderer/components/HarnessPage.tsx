// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  type HarnessInventory,
  type HarnessAsset,
  type HarnessPlugin,
  type HarnessAssetType,
  type HarnessAssetScope,
} from "../../shared/harnessTypes";
import type { CycleStage } from "../../shared/extractionTypes";
import { Dropdown } from "./Dropdown";
import { agentMark } from "./projectsModel";
import { TYPE_TABS, USER_SOURCE, relTime, showsReadError, sourceFilterKey, sourceLabel, type TabDef } from "./harnessModel";
import { FirstScanReadingPane } from "./ReadProgress";

// ─────────────────────────────────────────────────────────────────────────────
// Harness page — installed-asset inventory served from the stored harness scan
// (no live FS scan on open). One grouped, sortable table per tab, grouped by
// scope, with a row disclosure strip and a "View" action that opens the reader
// modal. A type-tab for every collected type. Refreshes on the harness:updated
// IPC event. rd-* classes only (values live in globals.css); no hex.
// ─────────────────────────────────────────────────────────────────────────────


// Only Skills reliably carry a real, author-written description in practice —
// every other kind is populated inconsistently enough (or, for claude_md/
// agents_md, never) that showing it as an on-canvas column mostly reads as
// noise. Skills-only keeps the column meaningful; every other kind still
// surfaces a real description in the row disclosure strip when one exists,
// just not promoted to its own column.
function hasRealDescription(type: HarnessAssetType): boolean {
  return type === "skill";
}

// Per-type display label; unmapped types fall back to the uppercased type.
const TYPE_LABEL: Partial<Record<HarnessAssetType, string>> = {
  rule: "Rule",
  claude_md: "CLAUDE.md",
  agents_md: "AGENTS.md",
  skill: "Skill",
  command: "Command",
  agent: "Agent",
  hook: "Hook",
  plugin: "Plugin",
  prompt_template: "Prompt Template",
};

// Per-kind type colour (icon + text; class goes on rd-ticon).
const TYPE_COLOR: Record<HarnessAssetType, string> = {
  rule: "c-purple",
  claude_md: "c-purple",
  agents_md: "c-purple",
  // Standing context/instruction data an agent runs under, like a rule.
  prompt_template: "c-purple",
  skill: "c-info",
  command: "c-info",
  agent: "c-caution",
  hook: "c-warning",
  plugin: "c-success",
};

// A small leading SVG per kind: book for rules, file-text for instruction
// files, sparkle for skills, chevrons for commands, bot for agents, link for
// hooks, box for plugins. currentColor + 1.5 stroke so rd-ticon's colour class tints it.
function TypeGlyph({ type }: { type: HarnessAssetType }) {
  const common = {
    width: 13,
    height: 13,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    "aria-hidden": true,
  } as const;
  switch (type) {
    case "rule":
      return (
        <svg {...common}>
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
        </svg>
      );
    case "claude_md":
    case "agents_md":
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M9 13h6" />
          <path d="M9 17h4" />
        </svg>
      );
    case "skill":
      return (
        <svg {...common}>
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      );
    case "command":
      return (
        <svg {...common} strokeWidth={2}>
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      );
    case "agent":
      return (
        <svg {...common}>
          <path d="M12 8V4H8" />
          <rect width="16" height="12" x="4" y="8" rx="2" />
          <path d="M2 14h2" />
          <path d="M20 14h2" />
          <path d="M15 13v2" />
          <path d="M9 13v2" />
        </svg>
      );
    case "hook":
      return (
        <svg {...common}>
          <path d="M18.4 3.6a4 4 0 0 1 0 5.66l-3 3-1.42-1.42 3-3a2 2 0 0 0-2.83-2.83l-3 3-1.42-1.42 3-3a4 4 0 0 1 5.66 0z" />
          <path d="M5.6 20.4a4 4 0 0 1 0-5.66l3-3 1.42 1.42-3 3a2 2 0 0 0 2.83 2.83l3-3 1.42 1.42-3 3a4 4 0 0 1-5.66 0z" />
        </svg>
      );
    case "plugin":
      return (
        <svg {...common}>
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
          <path d="m3.3 7 8.7 5 8.7-5" />
          <path d="M12 22V12" />
        </svg>
      );
    // A newly-collected type (e.g. prompt_template — standing context data, like a
    // rule) must never render a blank glyph. Fall back to the file-text mark.
    default:
      return (
        <svg {...common}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M9 13h6" />
          <path d="M9 17h4" />
        </svg>
      );
  }
}

// Leading type icon for a Name cell — bare glyph, no label chip; the accessible
// name rides on aria-label / the visible type is disambiguated by colour.
function LeadingTypeIcon({ type }: { type: HarnessAssetType }) {
  return (
    <span className={`rd-ticon ${TYPE_COLOR[type]}`} aria-label={TYPE_LABEL[type] ?? type}>
      <TypeGlyph type={type} />
    </span>
  );
}

// ── Agent chips ──────────────────────────────────────────────────────────────
// Each coding agent shows as a chip with its two-letter mark (agentMark); the full
// name rides on title for hover and accessibility.
function AgentChip({ name }: { name: string }) {
  return (
    <span className="rd-v" title={name}>
      {agentMark(name)}
    </span>
  );
}

// A row of vendor chips, one per agent an asset is active in.
function AgentIcons({ agents }: { agents: string[] }) {
  return (
    <span className="rd-vrow" aria-label={`Active in ${agents.join(", ")}`}>
      {agents.map((a) => (
        <AgentChip key={a} name={a} />
      ))}
    </span>
  );
}

// Group key + display order. Groups are ordered User → committed → repo-local,
// each committed/local group keyed by its repo source so two repos stay apart.
function groupKey(a: HarnessAsset): string {
  if (a.scope === "user") return USER_SOURCE;
  return `${a.source} — ${a.scope === "repo-committed" ? "committed" : "local"}`;
}
const SCOPE_ORDER: Record<HarnessAssetScope, number> = {
  user: 0,
  "repo-committed": 1,
  "repo-local": 2,
};

// Collapse the macOS home prefix to ~ for a shorter, readable path (display
// only; the full path stays on the title attribute for hover).
function displayPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+\//, "~/");
}

// Groups larger than this render only their first N rows + a "Show all" row —
// each group is capped independently so a big group never scroll-buries a small
// one.
const GROUP_CAP = 6;

// Sortable column keys shared by asset + plugin tables. Group order is always
// fixed (grouping by scope is permanent); sort only ranks WITHIN each group.
type SortKey = "name" | "scope" | "agents" | "marketplace" | "version";
interface SortState {
  key: SortKey | null;
  dir: 1 | -1;
}

// ── Detail view — a modal showing one asset's contents. File-backed assets are
// read on open via harness:readAsset (allowlisted, symlink-safe, size-capped);
// inline hooks have no disk file, so their command body is shown directly.
// Escape / click-outside / × close it. Uses the @theme tokens (its own
// styling contract, not the rd-* table classes). ────────────────────────
// `list` is the current view's ordered assets; the prev/next arrows step through
// it (ArrowLeft/ArrowRight too). The parent remounts this per selection (key on
// asset.id), so state resets cleanly on navigation.
function AssetDetail({
  asset, list, onSelect, onClose,
}: {
  asset: HarnessAsset;
  list: HarnessAsset[];
  onSelect: (a: HarnessAsset) => void;
  onClose: () => void;
}) {
  // Inline hooks carry their command in inlineBody; their filePath points at the
  // enclosing settings.json (NOT empty), so detect them by the body, not the
  // path — else opening one would preview the whole settings file.
  const isInline = asset.inlineBody != null;
  const [content, setContent] = useState<string | null>(isInline ? (asset.inlineBody ?? null) : null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!isInline);

  const index = list.findIndex((a) => a.id === asset.id);
  const prev = index > 0 ? list[index - 1]! : null;
  const next = index >= 0 && index < list.length - 1 ? list[index + 1]! : null;

  useEffect(() => {
    if (isInline) return;
    let alive = true;
    setLoading(true);
    setContent(null);
    setError(null);
    window.electronAPI?.harness
      ?.readAsset(asset.filePath)
      .then((r) => {
        if (!alive) return;
        setContent(r.content);
        setError(r.error);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [asset.filePath, isInline]);

  // Escape closes; ArrowLeft/ArrowRight step through the list. Latest handlers
  // in a ref so the listener subscribes once, not on every re-render.
  const navRef = useRef({ onClose, onSelect, prev, next });
  navRef.current = { onClose, onSelect, prev, next };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") navRef.current.onClose();
      else if (e.key === "ArrowLeft" && navRef.current.prev) navRef.current.onSelect(navRef.current.prev);
      else if (e.key === "ArrowRight" && navRef.current.next) navRef.current.onSelect(navRef.current.next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Focus the close button on open; restore focus to the opener on close.
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prevEl = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    return () => prevEl?.focus();
  }, []);

  // Two fixed frames chosen by content scale — long files get the doc size.
  const docSize = !isInline && content != null && (content.length > 3000 || content.split("\n").length > 40);

  return (
    <div
      className="rd-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={asset.name}
      onClick={() => {
        onClose();
      }}
    >
      <button
        className="rd-modal-nav"
        aria-label="Previous asset"
        disabled={!prev}
        onClick={(e) => { e.stopPropagation(); if (prev) onSelect(prev); }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m15 18-6-6 6-6" /></svg>
      </button>

      <div className={`rd-modal-dialog${docSize ? " doc-size" : ""}`} onClick={(e) => e.stopPropagation()}>
        <div className="rd-modal-head">
          <div className="min-w-0 flex-1">
            <span className="rd-modal-eyebrow">{TYPE_LABEL[asset.type] ?? asset.type}</span>
            <h2 className="truncate">{asset.invocation ?? asset.name}</h2>
            {!isInline && (
              <div className="rd-modal-path" title={asset.filePath}>
                {displayPath(asset.filePath)}
              </div>
            )}
          </div>
          <button ref={closeBtnRef} className="rd-modal-close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="rd-modal-body">
          <div className="rd-modal-body-inner">
            {loading ? (
              <p className="rd-modal-msg">Loading…</p>
            ) : error ? (
              <p className="rd-modal-msg err">{error}</p>
            ) : (
              <pre className="rd-modal-pre">{content}</pre>
            )}
          </div>
        </div>
      </div>

      <button
        className="rd-modal-nav"
        aria-label="Next asset"
        disabled={!next}
        onClick={(e) => { e.stopPropagation(); if (next) onSelect(next); }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>
      </button>
    </div>
  );
}

// ── Plugin contents modal — a plugin is a bundle, so "Contents" opens a summary
// of its asset counts (the real data we have: HarnessPlugin.assetCounts). Same
// @theme-token dialog shell as AssetDetail; Escape / click-outside / × close. ──
function PluginContents({ plugin, onClose }: { plugin: HarnessPlugin; onClose: () => void }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const closeBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    return () => prev?.focus();
  }, []);

  const c = plugin.assetCounts;
  const rows: [HarnessAssetType, string, number][] = [
    ["skill", "Skills", c.skills],
    ["command", "Commands", c.commands],
    ["agent", "Agents", c.agents],
    ["rule", "Rules", c.rules],
    ["hook", "Hooks", c.hooks],
  ];
  const present = rows.filter(([, , n]) => n > 0);

  return (
    <div
      className="rd-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={plugin.name}
      onClick={() => {
        onClose();
      }}
    >
      <div className="rd-modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="rd-modal-head">
          <div className="min-w-0 flex-1">
            <span className="rd-modal-eyebrow">Plugin</span>
            <h2 className="truncate">{plugin.name}</h2>
            <div className="rd-modal-path">
              {plugin.marketplace}
              {plugin.version ? ` · v${plugin.version}` : ""}
            </div>
          </div>
          <button ref={closeBtnRef} className="rd-modal-close" aria-label="Close" onClick={onClose}>✕</button>
        </div>

        <div className="rd-modal-body">
          <div className="rd-modal-body-inner">
            {present.length === 0 ? (
              <p className="rd-modal-msg">This plugin bundle has no counted assets.</p>
            ) : (
              <div className="rd-mlist">
                {present.map(([type, label, n]) => (
                  <div key={type} className="mrow">
                    <span className={`rd-ticon ${TYPE_COLOR[type]}`} aria-hidden="true">
                      <TypeGlyph type={type} />
                    </span>
                    <span>{label}</span>
                    <span className="mt">{n}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// State column cell, shared by AssetRow and PluginRow: the default "Active"
// state and the "Disabled" exception, both given equal colored-dot weight.
function StateCell({ off }: { off: boolean }) {
  return off ? (
    <span className="rd-disab">
      <i />
      Disabled
    </span>
  ) : (
    <span className="rd-active">
      <i />
      Active
    </span>
  );
}

// ── One asset row + its (conditionally rendered) detail-strip row. ────────────
function AssetRow({
  asset,
  colSpan,
  mixed,
  showState,
  onView,
}: {
  asset: HarnessAsset;
  colSpan: number;
  mixed: boolean;
  showState: boolean;
  onView: (a: HarnessAsset) => void;
}) {
  const [open, setOpen] = useState(false);
  const off = asset.operationalState === "disabled";

  const toggle = () => {
    setOpen((v) => !v);
  };

  return (
    <>
      <tr
       
        className={off ? "dim" : undefined}
        data-d=""
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        tabIndex={0}
        role="button"
        aria-expanded={open}
      >
        <td>
          <span className="cell-name">
            <span className={`rd-chev${open ? " open" : ""}`} aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </span>
            {mixed && <LeadingTypeIcon type={asset.type} />}
            <span className="rd-name">{asset.invocation ?? asset.name}</span>
          </span>
        </td>
        <td>
          <div className="flex items-center gap-1.5 max-w-[300px]">
            {hasRealDescription(asset.type) && (
              <span className="rd-desc flex-1 min-w-0">{asset.description ?? ""}</span>
            )}
            <button
              className="rd-viewbtn flex-shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                onView(asset);
              }}
              onKeyDown={(e) => e.stopPropagation()}
              aria-label={`View ${asset.name}`}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M15 3h6v6" />
                <path d="M10 14 21 3" />
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              </svg>
              View
            </button>
          </div>
        </td>
        <td>
          <span className="rd-scopetx">{sourceLabel(asset)}</span>
        </td>
        <td>
          {asset.activeInAgents.length > 0 && <AgentIcons agents={asset.activeInAgents} />}
        </td>
        {showState && (
          <td>
            <StateCell off={off} />
          </td>
        )}
      </tr>
      {open && (
        <tr>
          <td className="dcell" colSpan={colSpan}>
            <div className="rd-detail-cell">
              <div className="rd-detail">
                {asset.description && <div className="full">{asset.description}</div>}
                <div className="kv">
                  <span className="mono" title={asset.filePath}>
                    {asset.sourcePath || displayPath(asset.filePath)}
                  </span>
                  {off ? (
                    <span>Disabled — not loaded by any agent</span>
                  ) : (
                    asset.activeInAgents.length > 0 && (
                      <span>Active in {asset.activeInAgents.join(", ")}</span>
                    )
                  )}
                  {asset.version && <span>v{asset.version}</span>}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── One plugin row + its detail strip. Plugins are a bundle, so the button
// opens a counts-summary modal rather than a single-file reader — but the
// trigger still reads "View" like every other row's action, for a consistent
// CTA word across the whole table regardless of what kind of modal it opens.
// ─────────────────────────────────────────────────────────────────────────────
function PluginRow({
  plugin,
  colSpan,
  showState,
  onContents,
}: {
  plugin: HarnessPlugin;
  colSpan: number;
  showState: boolean;
  onContents: (p: HarnessPlugin) => void;
}) {
  const [open, setOpen] = useState(false);
  const off = !plugin.enabled;
  const c = plugin.assetCounts;
  const counts = (
    [
      [c.skills, "skills"],
      [c.commands, "commands"],
      [c.agents, "agents"],
      [c.rules, "rules"],
      [c.hooks, "hooks"],
    ] as [number, string][]
  )
    .filter(([n]) => n > 0)
    .map(([n, l]) => `${n} ${l}`)
    .join(" · ");

  const toggle = () => {
    setOpen((v) => !v);
  };

  return (
    <>
      <tr
       
        className={off ? "dim" : undefined}
        data-d=""
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
        tabIndex={0}
        role="button"
        aria-expanded={open}
      >
        <td>
          <span className="cell-name">
            <span className={`rd-chev${open ? " open" : ""}`} aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </span>
            <span className="rd-name">{plugin.name}</span>
          </span>
        </td>
        <td>
          <button
            className="rd-viewbtn"
            onClick={(e) => {
              e.stopPropagation();
              onContents(plugin);
            }}
            onKeyDown={(e) => e.stopPropagation()}
            aria-label={`View ${plugin.name}`}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M15 3h6v6" />
              <path d="M10 14 21 3" />
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            </svg>
            View
          </button>
        </td>
        <td>
          <span className="rd-scopetx">{plugin.marketplace}</span>
        </td>
        <td>
          <span className="rd-scopetx font-mono">{plugin.version ? `v${plugin.version}` : ""}</span>
        </td>
        {showState && (
          <td>
            <StateCell off={off} />
          </td>
        )}
      </tr>
      {open && (
        <tr>
          <td className="dcell" colSpan={colSpan}>
            <div className="rd-detail-cell">
              <div className="rd-detail">
                <div className="full">{counts || "No counted assets in this bundle."}</div>
                <div className="kv">
                  <span>{plugin.marketplace}</span>
                  {plugin.version && <span>v{plugin.version}</span>}
                  {off && <span>Disabled in plugin settings</span>}
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Sortable column header cell. ─────────────────────────────────────────────
function SortableTh({
  label,
  srLabel,
  sortKey,
  sort,
  onSort,
  num,
}: {
  label: string;
  /** Accessible name when the visible label is intentionally blank (e.g. a
   *  column that holds only a per-row action button for some tabs) — without
   *  this an empty label leaves the header with no name for screen readers. */
  srLabel?: string;
  sortKey?: SortKey;
  sort: SortState;
  onSort: (k: SortKey) => void;
  num?: boolean;
}) {
  if (!sortKey)
    return (
      <th className={num ? "num" : undefined} aria-label={label ? undefined : srLabel}>
        {label}
      </th>
    );
  const active = sort.key === sortKey;
  const caret = active && sort.dir === -1 ? "m6 9 6 6 6-6" : "m18 15-6-6-6 6";
  return (
    <th
      className={`sortable${active ? " active" : ""}${num ? " num" : ""}`}
      onClick={() => onSort(sortKey)}
      aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
      aria-label={label ? undefined : srLabel}
    >
      {label}
      <span className="sc" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d={caret} />
        </svg>
      </span>
    </th>
  );
}

// ── The grouped, sortable table. Generic over asset rows and plugin rows;
// grouping is by scope (assets) or marketplace (plugins), order fixed. ───────
function GroupedTable<T>({
  items,
  columns,
  groupKeyOf,
  groupOrderOf,
  sort,
  sortValue,
  renderRow,
  groupLabelLower,
  colSpan,
  groupHeaders = true,
}: {
  items: T[];
  columns: ReactNode;
  groupKeyOf: (item: T) => string;
  groupOrderOf: (item: T) => number;
  sort: SortState;
  sortValue: (item: T, key: SortKey) => string | number;
  renderRow: (item: T, colSpan: number) => ReactNode;
  groupLabelLower: string;
  /** Total columns (4, or 5 when the State column is shown) — for the group
   *  header and empty rows that span the table. */
  colSpan: number;
  /** False when a column already names each row's group (the asset table's Source). */
  groupHeaders?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Group from the natural (unsorted) order first so group order stays fixed
  // regardless of the active within-group sort, then sort each group's items.
  const groups = useMemo(() => {
    const map = new Map<string, { key: string; order: number; items: T[] }>();
    for (const item of items) {
      const k = groupKeyOf(item);
      let g = map.get(k);
      if (!g) {
        g = { key: k, order: groupOrderOf(item), items: [] };
        map.set(k, g);
      }
      g.items.push(item);
    }
    const arr = Array.from(map.values());
    arr.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
    if (sort.key) {
      const key = sort.key;
      for (const g of arr) {
        g.items = g.items.slice().sort((a, b) => {
          const av = sortValue(a, key);
          const bv = sortValue(b, key);
          const cmp =
            typeof av === "number" && typeof bv === "number"
              ? av - bv
              : String(av).localeCompare(String(bv));
          return cmp * sort.dir;
        });
      }
    }
    return arr;
  }, [items, groupKeyOf, groupOrderOf, sort, sortValue]);

  // Group-header sticky offset must match the ACTUAL rendered column-header
  // height, not a guessed constant — write it onto the scroll container so the
  // sticky group headers stack just below the sticky column header.
  useLayoutEffect(() => {
    const th = wrapRef.current?.querySelector("thead th");
    if (th) {
      const h = `${th.getBoundingClientRect().height}px`;
      wrapRef.current?.style.setProperty("--thead-h", h);
    }
  }, [groups]);

  const toggleCollapse = (k: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const expandGroup = (k: string) => {
    setExpanded((prev) => new Set(prev).add(k));
  };

  return (
    <div className="rd-tblwrap" ref={wrapRef} role="table" aria-label="Installed assets">
      <table>
        <thead>
          <tr>{columns}</tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const isCollapsed = collapsed.has(g.key);
            const isExpanded = expanded.has(g.key);
            const shown = isExpanded ? g.items : g.items.slice(0, GROUP_CAP);
            return (
              <Fragment key={g.key}>
                {groupHeaders && (
                  <tr
                   
                    className={`rd-grouprow${isCollapsed ? " collapsed" : ""}`}
                    onClick={() => {
                      toggleCollapse(g.key);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleCollapse(g.key);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                    aria-expanded={!isCollapsed}
                  >
                    <td colSpan={colSpan}>
                      <span className="gchev" aria-hidden="true">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="m9 18 6-6-6-6" />
                        </svg>
                      </span>
                      {g.key} <span className="n">· {g.items.length}</span>
                    </td>
                  </tr>
                )}
                {!isCollapsed && shown.map((item) => renderRow(item, colSpan))}
                {!isCollapsed && !isExpanded && g.items.length > GROUP_CAP && (
                  <tr
                   
                    className="rd-morerow"
                    onClick={() => {
                      expandGroup(g.key);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        expandGroup(g.key);
                      }
                    }}
                    tabIndex={0}
                    role="button"
                  >
                    <td colSpan={colSpan}>
                      Show all {g.items.length} {groupLabelLower} in {g.key}…
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EmptyPane({ text }: { text: string }) {
  return (
    <div className="rd-stub">
      <p>{text}</p>
    </div>
  );
}

const FIRST_SCAN_BODY =
  "Scanning your coding agents for installed skills, commands, rules, hooks and plugins. This usually takes under a minute.";

// ── Agent filter — a thin wrapper over the shared Dropdown (used by every
// rd-dd filter control, not just this one — see Dropdown.tsx) that supplies
// the vendor-chip icon per agent row. ────────────────────────────────────────
function AgentFilter({
  value,
  agents,
  disabled,
  onChange,
}: {
  value: string;
  agents: string[];
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <Dropdown<string>
      label="Agent"
      value={value}
      disabled={disabled}
      allOption={{ value: "all", label: "All agents" }}
      allTriggerLabel="All"
      options={agents.map((a) => ({ value: a, label: a, icon: <AgentChip key={a} name={a} /> }))}
      ariaLabel="Filter by agent"
      onChange={onChange}
    />
  );
}

export function HarnessPage({
  extractionProgress,
  readError,
}: {
  extractionProgress: CycleStage[] | null;
  /** The last read's error, shown while there is no stored scan to show instead. */
  readError: string | null;
}) {
  const [tabId, setTabId] = useState<string>("context");
  const [selected, setSelected] = useState<HarnessAsset | null>(null);
  const [selectedPlugin, setSelectedPlugin] = useState<HarnessPlugin | null>(null);
  const [inv, setInv] = useState<HarnessInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [agent, setAgent] = useState("all");
  const [sort, setSort] = useState<SortState>({ key: null, dir: 1 });


  const activeTab = useMemo(() => TYPE_TABS.find((t) => t.id === tabId) ?? TYPE_TABS[0]!, [tabId]);
  const isPluginTab = activeTab.id === "plugin";
  const mixed = activeTab.types.length > 1;

  const load = useCallback(() => {
    setLoading(true);
    const request = window.electronAPI?.harness?.getInventory();
    if (!request) {
      setInv(null);
      setLoading(false);
      return;
    }
    request
      .then((i) => {
        setInv(i);
      })
      .catch(() => {
        setInv(null);
      })
      .finally(() => setLoading(false));
  }, []);

  // Refresh runs a read (sessions and the harness scan, the scheduler's own path), then shows its result.
  const [reading, setReading] = useState(false);
  const refresh = useCallback(async () => {
    setReading(true);
    try {
      await window.electronAPI?.extraction?.triggerNow();
    } catch {
      // The read reports its own error through the status push.
    } finally {
      setReading(false);
      load();
    }
  }, [load]);

  useEffect(() => {
    load();
    // Live refresh when an extraction cycle re-collected the inventory.
    const off = window.electronAPI?.harness?.onUpdated?.(() => load());
    return () => off?.();
  }, [load]);

  const selectTab = (id: string) => {
    setTabId(id);
    setSearch("");
    setSource("all");
    setAgent("all");
    setSort({ key: null, dir: 1 });
  };

  const onSort = useCallback((key: SortKey) => {
    setSort((cur) => (cur.key === key ? { key, dir: (cur.dir * -1) as 1 | -1 } : { key, dir: 1 }));
  }, []);

  const count = (t: TabDef): number =>
    t.id === "plugin"
      ? inv?.plugins.length ?? 0
      : t.types.reduce((n, k) => n + (inv?.summary.byType[k] ?? 0), 0);

  const availableSources = useMemo(() => {
    if (!inv) return [];
    const values = isPluginTab
      ? inv.plugins.map((p) => p.marketplace)
      : inv.assets.filter((a) => activeTab.types.includes(a.type)).map(sourceFilterKey);
    // Pin the "User" bucket to the top (just under "All sources"); repos follow
    // in the prior lexicographic order.
    return Array.from(new Set(values.filter((v) => v.trim() !== ""))).sort((a, b) => {
      if (a === USER_SOURCE && b !== USER_SOURCE) return -1;
      if (b === USER_SOURCE && a !== USER_SOURCE) return 1;
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }, [inv, activeTab, isPluginTab]);

  const availableAgents = useMemo(() => {
    if (!inv || isPluginTab) return [];
    const values = inv.assets
      .filter((a) => activeTab.types.includes(a.type))
      .flatMap((a) => a.activeInAgents);
    return Array.from(new Set(values.filter((v) => v.trim() !== ""))).sort();
  }, [inv, activeTab, isPluginTab]);

  const query = search.trim().toLowerCase();

  const visiblePlugins = useMemo(() => {
    if (!inv || !isPluginTab) return [];
    return inv.plugins.filter((p) => {
      if (source !== "all" && p.marketplace !== source) return false;
      if (query && !p.name.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [inv, isPluginTab, source, query]);

  const visibleAssets = useMemo(() => {
    if (!inv || isPluginTab) return [];
    return inv.assets.filter((a) => {
      if (!activeTab.types.includes(a.type)) return false;
      if (source !== "all" && sourceFilterKey(a) !== source) return false;
      if (agent !== "all" && !a.activeInAgents.includes(agent)) return false;
      if (
        query &&
        !a.name.toLowerCase().includes(query) &&
        !(a.description ?? "").toLowerCase().includes(query)
      )
        return false;
      return true;
    });
  }, [inv, activeTab, isPluginTab, source, agent, query]);

  const filtersActive = query !== "" || source !== "all" || agent !== "all";

  // The State column is meaningful only when a visible row can be disabled — an
  // asset is disabled only when it rides in on a disabled plugin, so directly-
  // collected assets (every CLAUDE.md/AGENTS.md, repo-committed rule, …) are
  // always enabled. Show the column only when the visible rows actually contain
  // a disabled one; when shown, StateCell gives Active/Disabled equal
  // weight. Otherwise it is dead space (e.g. the Context / Rules tabs).
  const showState = isPluginTab
    ? visiblePlugins.some((p) => !p.enabled)
    : visibleAssets.some((a) => a.operationalState === "disabled");
  const tableColSpan = showState ? 5 : 4;

  // First scan of this app-run still running and nothing collected yet — show
  // "Reading…" instead of empty panes / zero counts. Cleared by the
  // harness:updated push when the first cycle lands (even with zero rows).
  const firstScan =
    inv !== null && inv.collecting && inv.summary.totalAssets === 0 && inv.plugins.length === 0;

  // Sort scalars, keyed by column.
  const assetSortValue = useCallback((a: HarnessAsset, key: SortKey): string | number => {
    switch (key) {
      case "name":
        return (a.invocation ?? a.name).toLowerCase();
      case "scope":
        return sourceLabel(a).toLowerCase();
      case "agents":
        return a.activeInAgents.length;
      default:
        return "";
    }
  }, []);
  const pluginSortValue = useCallback((p: HarnessPlugin, key: SortKey): string | number => {
    switch (key) {
      case "name":
        return p.name.toLowerCase();
      case "marketplace":
        return p.marketplace.toLowerCase();
      case "version":
        return p.version.toLowerCase();
      default:
        return "";
    }
  }, []);

  return (
    <>
      <div className="rd-pagehead">
        <h1>Harness</h1>
        <p>
          Everything installed across your AI coding agents — skills, commands, rules, hooks,
          plugins, subagents and instruction files.
        </p>
      </div>

      <div className="rd-tabs" role="tablist">
        {TYPE_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tabId === t.id}
            onClick={() => selectTab(t.id)}
            className={`rd-tab${tabId === t.id ? " on" : ""}`}
          >
            <span>{t.label}</span>
            {!firstScan && <span className="ct">{count(t)}</span>}
          </button>
        ))}
      </div>

      {inv && !firstScan && (
        <div className="rd-filters">
          <div className="rd-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              placeholder="Search by name or description…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search agent files"
            />
          </div>
          <Dropdown<string>
            label={isPluginTab ? "Marketplace" : "Source"}
            value={source}
            allOption={{ value: "all", label: "All" }}
            options={availableSources.map((s) => ({ value: s, label: s }))}
            ariaLabel={isPluginTab ? "Filter by marketplace" : "Filter by source"}
            onChange={setSource}
          />
          <AgentFilter
            value={agent}
            agents={availableAgents}
            disabled={isPluginTab || availableAgents.length === 0}
            onChange={setAgent}
          />
        </div>
      )}

      <div className="rd-scroll">
        <div className="rd-scroll-inner">
          {!firstScan && (
            <div className="rd-meta-line">
              <span>
                {inv
                  ? filtersActive
                    ? isPluginTab
                      ? `${visiblePlugins.length} of ${inv.plugins.length} plugins match your filters`
                      : `${visibleAssets.length} of ${count(activeTab)} ${activeTab.label} entries match your filters`
                    : `${inv.summary.totalAssets} ${inv.summary.totalAssets === 1 ? "entry" : "entries"}${
                        inv.lastScannedAt ? ` · scanned ${relTime(inv.lastScannedAt)}` : ""
                      }${inv.warnings.length > 0 ? ` · ${inv.warnings.length} skipped` : ""}`
                  : ""}
              </span>
              <button className="refresh" onClick={() => void refresh()} disabled={loading || reading}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                  <path d="M8 16H3v5" />
                </svg>
                {loading || reading ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          )}

          {inv?.lastError && <p className="text-xs text-error mb-3">{inv.lastError}</p>}
          {inv && showsReadError(readError) && (
            <p className="text-xs text-error mb-3">
              The read failed: {readError}.
              {inv.lastScannedAt ? ` The list below is from the last scan, ${relTime(inv.lastScannedAt)}.` : ""}
            </p>
          )}
          {inv?.lastScanFailure && (
            <p className="text-xs text-error mb-3">
              The last scan failed {relTime(inv.lastScanFailure.at)}: {inv.lastScanFailure.message}.
              {inv.lastScannedAt ? ` The list below is from the scan before it, ${relTime(inv.lastScannedAt)}.` : ""}
            </p>
          )}
          {inv && inv.errors.length > 0 && (
            <div className="text-xs text-error mb-3">
              <p>Not scanned, so this inventory is partial:</p>
              <ul className="list-disc pl-4">
                {inv.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {inv && inv.warnings.length > 0 && (
            <details className="text-xs text-muted-foreground mb-3">
              <summary>Skipped while scanning ({inv.warnings.length})</summary>
              <ul className="list-disc pl-4">
                {inv.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </details>
          )}

          {loading && !inv ? (
            <p className="text-sm text-muted-foreground py-10 text-center">Loading agent files…</p>
          ) : firstScan ? (
            <FirstScanReadingPane progress={extractionProgress} body={FIRST_SCAN_BODY} />
          ) : isPluginTab ? (
            visiblePlugins.length > 0 ? (
              <GroupedTable<HarnessPlugin>
                items={visiblePlugins}
                colSpan={tableColSpan}
                columns={
                  <>
                    <SortableTh label="Name" sortKey="name" sort={sort} onSort={onSort} />
                    <SortableTh label="Contents" sort={sort} onSort={onSort} />
                    <SortableTh label="Marketplace" sortKey="marketplace" sort={sort} onSort={onSort} />
                    <SortableTh label="Version" sortKey="version" sort={sort} onSort={onSort} />
                    {showState && <SortableTh label="State" sort={sort} onSort={onSort} />}
                  </>
                }
                groupKeyOf={(p) => p.marketplace}
                groupOrderOf={() => 0}
                sort={sort}
                sortValue={pluginSortValue}
                groupLabelLower="plugins"
                renderRow={(p, colSpan) => (
                  <PluginRow
                    key={p.id}
                    plugin={p}
                    colSpan={colSpan}
                    showState={showState}
                    onContents={setSelectedPlugin}
                  />
                )}
              />
            ) : (
              <EmptyPane text={filtersActive ? "No plugins match your filters." : "No plugins installed."} />
            )
          ) : visibleAssets.length > 0 ? (
            <GroupedTable<HarnessAsset>
              items={visibleAssets}
              colSpan={tableColSpan}
              columns={
                <>
                  <SortableTh label="Name" sortKey="name" sort={sort} onSort={onSort} />
                  <SortableTh
                    label={activeTab.types.some(hasRealDescription) ? "Description" : ""}
                    srLabel="Description"
                    sort={sort}
                    onSort={onSort}
                  />
                  <SortableTh label="Source" sortKey="scope" sort={sort} onSort={onSort} />
                  <SortableTh label="Agents" sortKey="agents" sort={sort} onSort={onSort} />
                  {showState && <SortableTh label="State" sort={sort} onSort={onSort} />}
                </>
              }
              groupKeyOf={groupKey}
              groupOrderOf={(a) => SCOPE_ORDER[a.scope]}
              groupHeaders={false}
              sort={sort}
              sortValue={assetSortValue}
              groupLabelLower={activeTab.label.toLowerCase()}
              renderRow={(a, colSpan) => (
                <AssetRow key={a.id} asset={a} colSpan={colSpan} mixed={mixed} showState={showState} onView={setSelected} />
              )}
            />
          ) : (
            <EmptyPane
              text={
                filtersActive
                  ? `No ${activeTab.label} entries match your filters.`
                  : `No ${activeTab.label} found yet.`
              }
            />
          )}
        </div>
      </div>

      {selected && (
        <AssetDetail
          key={selected.id}
          asset={selected}
          list={visibleAssets}
          onSelect={setSelected}
          onClose={() => setSelected(null)}
        />
      )}
      {selectedPlugin && (
        <PluginContents plugin={selectedPlugin} onClose={() => setSelectedPlugin(null)} />
      )}
    </>
  );
}
