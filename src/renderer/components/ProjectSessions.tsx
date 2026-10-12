// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { IdeType } from "../../shared/extractionTypes";
import type { SessionList, SessionListFilter, SessionMessage, SessionRow } from "../../shared/sessionTypes";
import { extractBasename } from "../../shared/pathUtils";
import { relTime } from "./harnessModel";
import {
  COLLAPSE_AT, afterLoadMore, appendPage, countLabel, durationLabel, groupRows, headerCount, listKeyApplies, messageParts, sessionTitle, timeLabel, tokenLabel, toolLabel, visibleText,
} from "./sessionsModel";

// ─────────────────────────────────────────────────────────────────────────────
// The Projects page's drill-down: one tool's sessions in one project, under date
// headings, then a chosen session's masked conversation, each full width. Both are read
// in pages (50 sessions, 100 messages), so the page never holds a whole store.
// ─────────────────────────────────────────────────────────────────────────────

const PAGE = 50;
const MAX_PAGE = 200; // the most rows one sessions:list read returns
const dragRegion = { WebkitAppRegion: "drag" } as unknown as CSSProperties;
const noDrag = { WebkitAppRegion: "no-drag" } as unknown as CSSProperties;
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Up and Down move the focus between the `selector` buttons inside a list; Enter or Space then presses one. */
export function moveFocus(e: ReactKeyboardEvent<HTMLElement>, selector: string): void {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)];
  if (items.length === 0) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = items[e.key === "ArrowDown" ? Math.min(i + 1, items.length - 1) : Math.max(i - 1, 0)];
  e.preventDefault();
  next?.focus();
}

function MessageView({ m }: { m: SessionMessage }) {
  const [open, setOpen] = useState(false);
  const tokens = m.role === "assistant" ? tokenLabel(m) : null;
  const time = timeLabel(m.timestamp);
  return (
    <div className={`rounded-[var(--r-lg)] border border-border px-3.5 py-2.5 ${m.role === "user" ? "bg-card" : "bg-accent"}`}>
      <div className="mb-1 flex flex-wrap items-center gap-x-2.5 text-[11px] text-muted-foreground">
        <b className="font-semibold text-fg">{m.role === "user" ? "User" : "Assistant"}</b>
        {m.isSubAgent && <span className="rounded-[var(--r-sm)] border border-border px-1.5">Subagent</span>}
        {time && <span>{time}</span>}
        {m.role === "assistant" && m.model && <span className="font-mono">{m.model}</span>}
        {tokens && <span className="font-mono">{tokens}</span>}
      </div>
      <div className="select-text whitespace-pre-wrap break-words text-[12.5px] leading-[1.6] text-fg">
        {messageParts(m.role, visibleText(m.content, open)).map((p, i) =>
          p.tool ? (
            <span key={i} className="mx-0.5 rounded-[var(--r-sm)] bg-[var(--bg-e3)] px-1.5 py-px font-mono text-[11px] text-muted-foreground">
              {p.text}
            </span>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </div>
      {m.content.length > COLLAPSE_AT && (
        <button type="button" className="rd-viewbtn mt-1" onClick={() => setOpen((v) => !v)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
      {m.truncated && <p className="mt-1 text-[11px] text-muted-foreground">Only the first 64 K characters of this message are shown.</p>}
    </div>
  );
}

// The parent remounts this per session (key), so its state starts fresh on each one.
function Transcript({ row, backLabel, lastRunAt, onBack }: { row: SessionRow; backLabel: string; lastRunAt: string | null; onBack: () => void }) {
  const [messages, setMessages] = useState<SessionMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchPage = (offset: number): void => {
    setLoading(true);
    window.electronAPI.sessions
      .getTranscript(row.key, offset)
      .then((r) => {
        setError(r.error);
        if (r.error) return;
        setTotal(r.total);
        setMessages((m) => (offset === 0 ? r.messages : [...m, ...r.messages]));
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => fetchPage(0), []);

  // A finished read may have added messages: re-read every page already shown, in place, so
  // the view keeps its scroll position and each message its Show more state.
  const shown = useRef(0);
  shown.current = messages.length;
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    let alive = true;
    void (async () => {
      const read: SessionMessage[] = [];
      for (let offset = 0; ; offset += 100) {
        const r = await window.electronAPI.sessions.getTranscript(row.key, offset);
        if (!alive) return;
        if (r.error) return setError(r.error);
        read.push(...r.messages);
        if (r.messages.length < 100 || read.length >= Math.max(shown.current, 1)) {
          setError(null);
          setTotal(r.total);
          setMessages(read);
          return;
        }
      }
    })().catch((e) => alive && setError(errorText(e)));
    return () => {
      alive = false;
    };
  }, [lastRunAt]);

  // The back control takes the focus, so Escape and Enter work without a click first.
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => backRef.current?.focus(), []);

  const duration = durationLabel(row.durationMinutes);
  const started = timeLabel(row.startedAt);
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="border-b border-border px-6 pb-3 pt-5" style={dragRegion}>
        <button ref={backRef} type="button" aria-label={`Back to ${backLabel}`} className="rd-viewbtn -ml-1 mb-1.5" style={noDrag} onClick={onBack}>
          <span aria-hidden="true">←</span> {backLabel}
        </button>
        <h2 className="select-text text-[15px] font-bold leading-snug tracking-tight text-fg">{sessionTitle(row)}</h2>
        <div className="mt-1 flex flex-wrap gap-x-3 text-[11.5px] text-muted-foreground">
          <span>{toolLabel(row.ideType)}</span>
          <span title={row.projectPath ?? "No project folder"}>{extractBasename(row.projectPath) ?? "No folder"}</span>
          {row.branch && <span className="font-mono">{row.branch}</span>}
          {started && <span>Started {started}</span>}
          {duration && <span>{duration}</span>}
          {row.models.length > 0 && <span className="font-mono">{row.models.join(", ")}</span>}
        </div>
        {row.ideType === "antigravity" && (
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">
            An Antigravity session read while Antigravity was not running holds only its title and summary.
          </p>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-6 py-4 select-text">
        <div className="space-y-2.5">
          {messages.map((m, i) => (
            <MessageView key={i} m={m} />
          ))}
        </div>
        {error && <p className="mt-3 text-xs text-error">{error}</p>}
        {loading && <p className="rd-stub">Loading…</p>}
        {!loading && !error && (
          <div className="rd-pager">
            <span>
              {messages.length} of {total} {total === 1 ? "message" : "messages"}
            </span>
            {messages.length < total && (
              <div className="rd-pager-ctrls">
                <button type="button" className="pg" onClick={() => fetchPage(messages.length)}>
                  Show the next {Math.min(100, total - messages.length)}
                </button>
              </div>
            )}
          </div>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground/70">
          Tool results and thinking are not stored, so they are not shown. Secrets, email addresses and your user name are masked.
        </p>
      </div>
    </div>
  );
}

/** One tool's sessions in one project folder (null: its "No folder" row), full width. The parent remounts it per project. */
export function ProjectSessions({
  ideType, projectPath, projectName, lastRunAt, onBack,
}: {
  ideType: IdeType;
  projectPath: string | null;
  projectName: string;
  lastRunAt: string | null;
  /** Back to the Projects list. */
  onBack: () => void;
}) {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [list, setList] = useState<(SessionList & { query: string }) | null>(null); // query: the search it answers
  const [projectTotal, setProjectTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<SessionRow | null>(null);
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);

  // The search runs once typing pauses, not on every key.
  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 200);
    return () => clearTimeout(t);
  }, [search]);

  const filter = useMemo<SessionListFilter>(() => ({ ideType, projectPath, ...(query ? { query } : {}) }), [ideType, projectPath, query]);

  // The first page for a new filter. After a read that finishes (lastRunAt moves), every row
  // that is loaded, read in pages of MAX_PAGE, so the pages loaded with Load more and the row
  // left open stay.
  const loaded = useRef(0);
  loaded.current = list?.rows.length ?? 0;
  const lastFilter = useRef(filter);
  useEffect(() => {
    const refresh = lastFilter.current === filter;
    lastFilter.current = filter;
    const want = refresh ? Math.max(PAGE, loaded.current) : PAGE;
    const answers = filter.query ?? "";
    let alive = true;
    void (async () => {
      let got: SessionList | null = null;
      for (;;) {
        const last = got?.rows.at(-1);
        const page: SessionList = await window.electronAPI.sessions.list({
          ...filter,
          limit: Math.min(MAX_PAGE, want - (got?.rows.length ?? 0)),
          ...(last ? { after: { lastActivityMs: last.lastActivityMs, key: last.key } } : {}),
        });
        if (!alive) return;
        const before = got?.rows.length ?? 0;
        got = got ? { rows: appendPage(got.rows, page.rows), total: page.error ? got.total : page.total, error: page.error } : page;
        if (got.error || got.rows.length === before || got.rows.length >= Math.min(want, got.total)) break;
      }
      setList({ ...got, query: answers });
    })().catch((e) => alive && setList({ rows: [], total: 0, error: errorText(e), query: answers }));
    // The header counts the whole project, while a search narrows the list too; when this read
    // fails, the header falls back to what it can know (headerCount).
    window.electronAPI.sessions
      .list({ ideType, projectPath, limit: 1 })
      .then((r) => alive && setProjectTotal(r.error ? null : r.total))
      .catch(() => alive && setProjectTotal(null));
    return () => {
      alive = false;
    };
  }, [filter, lastRunAt]);

  const loadMore = (): void => {
    const last = list?.rows.at(-1);
    if (!list || !last) return;
    const base = list;
    setLoadingMore(true);
    window.electronAPI.sessions
      .list({ ...filter, limit: PAGE, after: { lastActivityMs: last.lastActivityMs, key: last.key } })
      .then((next) =>
        setList((cur) => {
          const merged = afterLoadMore(cur, base, next);
          return merged === cur ? cur : merged && { ...merged, query: base.query };
        }),
      )
      .catch((e) => setList((cur) => (cur === base ? { ...base, error: errorText(e) } : cur)))
      .finally(() => setLoadingMore(false));
  };

  const openSession = (r: SessionRow): void => {
    opened.current = true;
    savedScroll.current = listRef.current?.scrollTop ?? 0;
    setSelected(r);
    setOpen(true);
  };
  // Back from a conversation: the list scrolled where it was, the session that was open focused,
  // or the first one when a read has taken it away.
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (open || !listRef.current || !opened.current) return;
    listRef.current.scrollTop = savedScroll.current;
    const left = listRef.current.querySelector<HTMLElement>('[aria-current="true"]');
    if (left) left.focus({ preventScroll: true });
    else listRef.current.querySelector<HTMLElement>("[data-session-row]")?.focus();
  }, [open]);

  // On the way in, the first session takes the focus once the list arrives, so Up, Down and
  // Escape work at once.
  const focusedIn = useRef(false);
  useEffect(() => {
    if (focusedIn.current || !list || !listRef.current) return;
    focusedIn.current = true;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (listRef.current.querySelector<HTMLElement>("[data-session-row]") ?? backRef.current)?.focus();
  }, [list]);
  const backRef = useRef<HTMLButtonElement>(null);

  // A list update can re-mount the focused row (a read moves it under another heading) or drop
  // it, and the focus falls to the page: give it back to that row, else to the first.
  const focusedKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (open || !listRef.current || focusedKey.current === null) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const rowEls = [...listRef.current.querySelectorAll<HTMLElement>("[data-session-row]")];
    (rowEls.find((el) => el.dataset.sessionRow === focusedKey.current) ?? rowEls[0])?.focus();
  }, [list]);

  // Escape goes back one view: from a conversation to the list, from the list to Projects.
  const nav = useRef({ open, onBack });
  nav.current = { open, onBack };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || !listKeyApplies(e.defaultPrevented, e.target instanceof Element ? e.target : null)) return;
      if (nav.current.open) setOpen(false);
      else nav.current.onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rows = list?.rows ?? [];
  if (open && selected) {
    return (
      <Transcript
        key={selected.key}
        row={rows.find((r) => r.key === selected.key) ?? selected}
        backLabel={`${projectName} sessions`}
        lastRunAt={lastRunAt}
        onBack={() => setOpen(false)}
      />
    );
  }

  const n = headerCount(projectTotal, list, query !== "");
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden" role="region" aria-label={`Sessions of ${projectName}`}>
      <div className="border-b border-border px-6 pb-3 pt-5" style={dragRegion}>
        <button ref={backRef} type="button" aria-label="Back to Projects" className="rd-viewbtn -ml-1 mb-1" style={noDrag} onClick={onBack}>
          <span aria-hidden="true">←</span> Projects
        </button>
        <h2 className="truncate text-[17px] font-bold tracking-tight text-fg">
          {projectName} · {toolLabel(ideType)} · {n === null ? "…" : `${n} ${n === 1 ? "session" : "sessions"}`}
        </h2>
        <div className="rd-search mt-2.5" style={noDrag}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            placeholder="Search this project's sessions…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              // Escape clears the search first, then leaves for Projects.
              if (e.key !== "Escape") return;
              e.preventDefault();
              if (search) setSearch("");
              else onBack();
            }}
            maxLength={200}
            aria-label="Search this project's sessions"
          />
        </div>
      </div>
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto"
        onKeyDown={(e) => moveFocus(e, "[data-session-row]")}
        onFocus={(e) => {
          const key = (e.target as HTMLElement).dataset.sessionRow;
          if (key) focusedKey.current = key;
        }}
      >
        {query && list?.query === query && <div className="rd-meta-line px-6 pt-3">{`${list.total} ${list.total === 1 ? "session matches" : "sessions match"} the search`}</div>}
        {list?.error && <p className="px-6 py-2 text-xs text-error">{list.error}</p>}
        {!list && <p className="rd-stub">Loading…</p>}
        {groupRows(rows, new Date()).map((group) => (
          <div key={group.label} role="group" aria-label={group.label}>
            <div className="sticky top-0 z-[1] border-b border-border bg-[var(--bg-e2)] px-6 py-1 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
              {group.label}
            </div>
            {group.rows.map((r) => {
              const on = selected !== null && selected.key === r.key;
              return (
                <button
                  key={r.key}
                  type="button"
                  data-session-row={r.key}
                  aria-current={on}
                  onClick={() => openSession(r)}
                  className={`flex w-full items-center gap-4 whitespace-nowrap border-b border-border px-6 py-2 text-left text-[12.5px] ${on ? "bg-[var(--sel)]" : "hover:bg-[var(--hv-n)]"}`}
                >
                  <span className="min-w-0 flex-1 truncate font-medium text-fg">{sessionTitle(r)}</span>
                  <span className="w-[160px] flex-shrink-0 truncate font-mono text-[11px] text-muted-foreground" title={r.branch ? `Branch ${r.branch}` : undefined}>
                    {r.branch ?? ""}
                  </span>
                  <span className="w-[96px] flex-shrink-0 text-right font-mono text-[11px] text-muted-foreground">{countLabel(r)}</span>
                  <span className="w-[64px] flex-shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                    {relTime(r.lastActivityMs > 0 ? new Date(r.lastActivityMs).toISOString() : null)}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
        {list && !list.error && list.total === 0 && (
          <p className="rd-stub px-6">{list.query ? "No session here matches the search." : "No sessions in this project."}</p>
        )}
        {list && rows.length < list.total && (
          <div className="px-6 py-3">
            <button type="button" className="rd-viewbtn" disabled={loadingMore} onClick={loadMore}>
              {loadingMore ? "Loading…" : `Load more (${list.total - rows.length} left)`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
