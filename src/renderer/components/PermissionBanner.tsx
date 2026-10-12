// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useState } from "react";
import type { FolderPermissionStatus, NeededFolder } from "../../shared/permissionTypes";
import { Button } from "./Button";

// macOS Privacy > Files and Folders deep link, for the denied-access path.
const PRIVACY_DEEP_LINK =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";

/**
 * Global folder-access banner: protected project folders (Documents/Desktop/
 * Downloads) need macOS folder access before the app can read the projects
 * inside them. Rendered at the top of the main pane so it spans every page
 * (Projects, Harness) — the missing access blocks reading app-wide, not one
 * page. "Grant access" fires the native prompt; "Open System
 * Settings" deep-links for the already-denied case. Re-probes on window focus
 * so the banner clears once access is granted.
 */
export function PermissionBanner() {
  const [supported, setSupported] = useState(false);
  const [needed, setNeeded] = useState<NeededFolder[]>([]);
  const [blocked, setBlocked] = useState<NeededFolder[]>([]);
  const [requesting, setRequesting] = useState(false);

  const probe = useCallback(() => {
    // needed = not-yet-asked (a native prompt can still grant these).
    window.electronAPI?.permissions
      ?.getNeeded()
      .then((s: FolderPermissionStatus) => {
        setSupported(s.supported);
        setNeeded(s.needed);
      })
      .catch(() => {
        setSupported(false);
        setNeeded([]);
      });
    // blocked = already asked + denied (only System Settings recovers these).
    // The case getNeeded can't see; this is what makes the banner appear for a
    // folder that was granted once and later revoked.
    window.electronAPI?.permissions
      ?.getBlocked()
      .then(setBlocked)
      .catch(() => setBlocked([]));
  }, []);

  useEffect(() => {
    probe();
    window.addEventListener("focus", probe);
    const off = window.electronAPI?.permissions?.onChanged?.(probe);
    return () => {
      window.removeEventListener("focus", probe);
      off?.();
    };
  }, [probe]);

  if (!supported || (needed.length === 0 && blocked.length === 0)) return null;

  // Union of folders needing attention, de-duped by key.
  const byKey = new Map<string, NeededFolder>();
  for (const f of [...needed, ...blocked]) byKey.set(f.key, f);
  const labels = Array.from(byKey.values())
    .map((f) => f.label)
    .join(", ");

  // "Grant access" fires the native prompt, which only helps un-asked folders —
  // macOS never re-prompts a stored denial. So offer it only when something is
  // still un-asked; blocked-only folders show System Settings alone.
  const canGrant = needed.length > 0;

  const requestAccess = () => {
    setRequesting(true);
    const request = window.electronAPI?.permissions?.request();
    if (!request) {
      setRequesting(false);
      return;
    }
    request
      .then(() => {
        probe();
      })
      .catch(() => {
      })
      .finally(() => setRequesting(false));
  };

  return (
    <div className="px-6 py-3 border-b-2 border-warning/40 border-l-4 border-l-warning bg-warning/10">
      <div className="text-[12.5px] font-semibold text-warning">Grant folder access</div>
      <div className="text-[11.5px] text-muted-foreground mt-1 leading-relaxed">
        {canGrant
          ? `Agent Desk can't read your projects in protected folders (${labels}) until macOS access is granted.`
          : `Agent Desk has no access to protected folders (${labels}), so it can't read your projects there. Turn it on in System Settings, under Privacy & Security, Files and Folders.`}
      </div>
      <div className="flex items-center gap-2 mt-2.5">
        {canGrant && (
          <Button
            variant="default"
            size="sm"
            disabled={requesting}
            onClick={requestAccess}
          >
            {requesting ? "Requesting…" : "Grant access"}
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          onClick={() => window.electronAPI?.openExternal(PRIVACY_DEEP_LINK)}
        >
          Open System Settings
        </Button>
      </div>
    </div>
  );
}
