// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState, type ReactNode } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Shared custom icon dropdown — every rd-dd
// filter control uses this instead of a native <select>, so open-state UI is
// one consistent pattern across the Harness filters (Source, Marketplace,
// Agent): each row can carry an icon + label, with a checkmark on the
// current selection. Closes on outside-click and Escape.
// ─────────────────────────────────────────────────────────────────────────────

function CheckMark() {
  return (
    <span className="ck" aria-hidden="true">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  );
}

export interface DropdownOption<T> {
  value: T;
  label: string;
  icon?: ReactNode;
}

export function Dropdown<T extends string | number>({
  label,
  value,
  options,
  allOption,
  allTriggerLabel,
  disabled,
  triggerIcon,
  align = "right",
  ariaLabel,
  onChange,
}: {
  label: string;
  value: T;
  options: DropdownOption<T>[];
  /** An "All X" entry rendered above a separator, mirroring the Agent filter's
   *  "All agents" row — omit for a dropdown with no all-of-them case. */
  allOption?: DropdownOption<T>;
  /** Trigger-only label for the "all" state, when it should read shorter than
   *  the menu row (e.g. trigger "All", menu row "All agents") — falls back to
   *  allOption.label if omitted. */
  allTriggerLabel?: string;
  disabled?: boolean;
  /** Optional leading icon on the trigger itself. */
  triggerIcon?: ReactNode;
  /** Which edge the menu grows from. Default "right" is correct for a
   *  dropdown that isn't the leftmost control in its filter row (a
   *  left-anchored menu can overflow the window's right edge there). Use
   *  "left" for a dropdown that sits near the window's LEFT edge instead, or
   *  a right-anchored menu wider than the trigger can clip offscreen. */
  align?: "left" | "right";
  ariaLabel: string;
  onChange: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close on outside mousedown + Escape; only subscribe while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // Handled: the page behind the menu leaves this Escape alone.
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // A disabled trigger (e.g. Agent filter on the plugin tab / no agents) is a
  // bare, non-interactive control — always reads "All" (a greyed control; a disabled dropdown never carries a specific selection).
  if (disabled) {
    return (
      <div className="rd-dd disabled" aria-disabled="true">
        <span>{label}</span>:&nbsp;<b>{allTriggerLabel ?? allOption?.label ?? "All"}</b>
      </div>
    );
  }

  const pick = (v: T) => {
    onChange(v);
    setOpen(false);
  };

  const current = allOption && value === allOption.value ? allOption : options.find((o) => o.value === value);
  // If `value` matches neither allOption nor any option — the option set can
  // change out from under a selected filter via a live data refresh (a new
  // extraction cycle) — fall back to the "all" wording
  // instead of the raw internal value; a stale selection should read as "no
  // filter applied", not as an unrecognized key like "claude_md".
  const triggerLabel = current
    ? current === allOption
      ? (allTriggerLabel ?? allOption.label)
      : current.label
    : (allTriggerLabel ?? allOption?.label);

  return (
    <div className="rd-dd-wrap" ref={wrapRef}>
      <button
        type="button"
        className="rd-dd"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
      >
        {triggerIcon}
        <span>{label}</span>:&nbsp;
        {current?.icon ? (
          <b className="rd-vrow" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {current.icon}
            {triggerLabel}
          </b>
        ) : (
          <b>{triggerLabel ?? value}</b>
        )}
      </button>
      {open && (
        <div className={`rd-menu${align === "left" ? " align-left" : ""}`} role="listbox" aria-label={label}>
          {allOption && (
            <>
              <button
                type="button"
                className="rd-mi mute"
                role="option"
                aria-selected={value === allOption.value}
                onClick={() => pick(allOption.value)}
              >
                {allOption.label}
                {value === allOption.value && <CheckMark />}
              </button>
              <div className="rd-msep" />
            </>
          )}
          {options.map((o, i) => (
            <button
              type="button"
              key={`${String(o.value)}-${i}`}
              className="rd-mi"
              role="option"
              aria-selected={value === o.value}
              onClick={() => pick(o.value)}
            >
              {o.icon}
              {o.label}
              {value === o.value && <CheckMark />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
