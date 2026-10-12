// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { NeededFolder } from "../../shared/permissionTypes";
import appIcon from "../../../resources/icon.svg";

// ─────────────────────────────────────────────────────────────────────────────
// Consolidated folder-permission primer.
//
// One modal, shown once before any native macOS prompt. Explains why we need
// folder access and previews the system dialog that follows. Continue starts
// the native prompts, which macOS shows in turn; Escape / click-outside defer
// (no deny branch). Self-contained: mount once near the app root; renders nothing when
// there is nothing to ask. The app's @theme tokens for colour; the macOS replica uses
// OS colours (inline styles) so it reads as the system dialog, not our UI.
// ─────────────────────────────────────────────────────────────────────────────

// What folder access is used for — app-level, shown so the prompt is never a
// mystery. Inline SVGs (the renderer uses SVG, not an icon font).
const ROWS: { icon: ReactNode; text: string }[] = [
  {
    text: "See your AI coding sessions for every project",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
        <path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" />
      </svg>
    ),
  },
  {
    text: "See the skills, rules, agents and hooks your coding agents load",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
        <line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="17" x2="20" y2="17" />
        <circle cx="9" cy="7" r="2.5" fill="currentColor" stroke="none" /><circle cx="15" cy="17" r="2.5" fill="currentColor" stroke="none" />
      </svg>
    ),
  },
  {
    text: "See each project's stack at a glance",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
        <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" /><path d="M19 14l.7 1.8 1.8.7-1.8.7L19 19l-.7-1.8-1.8-.7 1.8-.7z" />
      </svg>
    ),
  },
  {
    text: "Search every skill, rule and hook across your projects",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]">
        <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
      </svg>
    ),
  },
];

function PrimerHeader() {
  return (
    <div className="px-6 pt-6">
      {/* The last words bound with NBSP + text-balance → no single-word widow. */}
      <h2 id="primer-title" className="text-[21px] font-bold leading-tight tracking-tight text-balance">
        See your AI coding sessions and the files your{"\u00A0"}agents{"\u00A0"}load
      </h2>
      <p id="primer-description" className="text-[13px] text-muted-foreground mt-2 leading-relaxed">
        Agent Desk needs access to your project folders so it can show your AI coding sessions per project, the agent files your coding agents load, and each project's stack. It only reads them.
      </p>
    </div>
  );
}

function FeatureColumn() {
  return (
    <div className="flex flex-col gap-5">
      <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        What you'll get
      </span>

      {/* 4 value rows — medium weight for contrast, 2x spacing (gap-7) */}
      <div className="flex flex-col gap-7">
        {ROWS.map((row) => (
          <div key={row.text} className="flex items-start gap-3">
            <span className="w-9 h-9 flex-shrink-0 bg-accent text-ac flex items-center justify-center rounded-[10px]" aria-hidden="true">
              {row.icon}
            </span>
            <span className="text-[12.5px] font-medium text-foreground leading-snug pt-1">{row.text}</span>
          </div>
        ))}
      </div>

      <div className="flex gap-2.5 bg-accent border border-border rounded-[10px] px-3 py-2.5">
        <span className="text-ac flex-shrink-0 pt-0.5" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-[15px] w-[15px]">
            <rect x="5" y="11" width="14" height="9" rx="1" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
          </svg>
        </span>
        <span className="text-[11.5px] text-muted-foreground leading-relaxed">
          Agent Desk never changes your files, and nothing leaves your Mac.
        </span>
      </div>
    </div>
  );
}

// Faithful replica of the native macOS folder-access dialog. Deliberately uses
// macOS's own light-vibrancy palette + the real app icon (inline styles, not app
// tokens) — the point is to look like the system dialog the user is about to see,
// with Allow highlighted as the default button and the pointer hovering it.
function MacPromptPreview() {
  return (
    <div
      className="relative mx-auto w-[232px] px-4 pt-4 pb-3.5 text-center"
      style={{
        background: "rgba(243,243,245,0.92)",
        backdropFilter: "blur(20px) saturate(160%)",
        WebkitBackdropFilter: "blur(20px) saturate(160%)",
        borderRadius: 14,
        boxShadow:
          "0 0 0 0.5px rgba(0,0,0,0.12), inset 0 0.5px 0 rgba(255,255,255,0.7), 0 22px 48px -14px rgba(0,0,0,0.5)",
      }}
    >
      <img
        src={appIcon}
        alt="Agent Desk"
        className="mx-auto mb-2.5 h-[52px] w-[52px]"
        style={{ filter: "drop-shadow(0 3px 7px rgba(0,0,0,0.25))" }}
      />
      <div className="text-[12px] font-semibold leading-snug" style={{ color: "#1d1d1f" }}>
        “Agent Desk” would like to access files in your Desktop folder.
      </div>
      <div className="mt-3 flex gap-2 justify-center">
        <span
          className="text-[10.5px] px-3 py-1.5"
          style={{ background: "rgba(255,255,255,0.92)", color: "#1d1d1f", border: "0.5px solid rgba(0,0,0,0.16)", borderRadius: 6 }}
        >
          Don't Allow
        </span>
        <span
          className="relative text-[10.5px] px-3 py-1.5 font-semibold"
          style={{ background: "#0a84ff", color: "#ffffff", borderRadius: 6, boxShadow: "0 1px 2px rgba(0,0,0,0.18), 0 0 0 3px rgba(10,132,255,0.32)" }}
        >
          Allow
          {/* macOS pointer hovering Allow — communicates the action without extra copy */}
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className="absolute h-[18px] w-[18px]"
            style={{ left: "58%", top: "46%", filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.4))" }}
          >
            <path d="M5 2.2 19.2 11l-6.7 1.7L9.6 19.3z" fill="#fff" stroke="#111" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
    </div>
  );
}

// The dialog on a "screen" that fills its column height (no empty void) so it
// reads as a real moment on the user's Mac. Sits on the LEFT (image-left layout),
// keeping the blue OS Allow button away from the purple Continue (bottom-right).
function PreviewColumn() {
  return (
    <div
      className="relative flex items-center justify-center rounded-[10px] overflow-hidden p-4"
      style={{
        minHeight: 240,
        background:
          "radial-gradient(120% 90% at 28% 18%, rgba(255,255,255,0.20), transparent 55%), linear-gradient(150deg, #5d6e80 0%, #475667 48%, #3a4757 100%)",
      }}
    >
      <MacPromptPreview />
    </div>
  );
}

export function PermissionPrimer({ onOpenChange }: { onOpenChange?: (open: boolean) => void } = {}) {
  // null = not yet resolved / nothing to show; a list = show the consolidated popup.
  const [needed, setNeeded] = useState<NeededFolder[] | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const open = needed !== null && needed.length > 0;

  // A real modal: the app behind it is inert (App.tsx), which also keeps Tab inside the
  // dialog, and focus starts on the dialog itself, not on Continue, so a stray Return or
  // Space asks for nothing.
  useEffect(() => {
    onOpenChange?.(open);
    if (open) dialog.current?.focus();
  }, [open, onOpenChange]);
  const [busy, setBusy] = useState(false);
  // Synchronous re-entrancy guard — immune to React's async state flush, so a
  // rapid double Continue can't fire the request twice.
  const requesting = useRef(false);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.permissions
      ?.getNeeded()
      .then((status) => {
        if (!cancelled) setNeeded(status.supported ? status.needed : []);
      })
      .catch(() => {
        if (!cancelled) setNeeded([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = () => {
    if (!busy) {
      setNeeded([]);
    }
  };

  // Escape defers (non-committal), never while the native prompts are firing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        setNeeded([]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy]);

  if (!open) return null;

  const onContinue = async () => {
    if (requesting.current) return;
    requesting.current = true;
    setBusy(true);
    try {
      await window.electronAPI?.permissions?.request();
    } catch {
      // Best-effort — features degrade gracefully if a prompt was declined.
    }
    setNeeded([]);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
      style={{ animation: "fade-in 150ms ease" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="primer-title"
      aria-describedby="primer-description"
      tabIndex={-1}
      ref={dialog}
      onClick={dismiss}
    >
      <div
        className="w-full max-w-[640px] border border-border bg-background rounded-[14px] shadow-none overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <PrimerHeader />

        {/* Image left, hairline divider, text right — balances the layout and keeps the OS Allow button away from Continue */}
        <div className="px-6 pt-5 grid grid-cols-[1fr_1px_1fr] gap-5 items-stretch">
          <PreviewColumn />
          <div className="bg-border" aria-hidden="true" />
          <FeatureColumn />
        </div>

        {/* Footer — Continue is the only action; Escape / click-outside defer. */}
        <div className="flex items-center justify-end border-t border-border mt-5 px-6 py-4">
          {/* Not autofocused: a stray Return or Space must not start the macOS prompts. Tab reaches it. */}
          <button
            onClick={onContinue}
            disabled={busy}
            className="text-[13px] px-5 py-2 rounded-[8px] bg-ac text-[#1a1230] font-semibold transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {busy ? "Waiting for system prompts…" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}
