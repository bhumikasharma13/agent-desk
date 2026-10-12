// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { useEffect, useState } from "react";
import { AppShell } from "./components/AppShell";
import { PermissionPrimer } from "./components/PermissionPrimer";

export function App() {
  const [initError, setInitError] = useState<string | null>(null);
  // While the folder-access primer is open, the app behind it takes no clicks or keys.
  const [primerOpen, setPrimerOpen] = useState(false);

  useEffect(() => {
    // Surface init failures so the user knows when the app is broken. The main
    // process emits these when the session store or the worker cannot start.
    const appApi = window.electronAPI?.app;
    if (!appApi) {
      console.error("[App] window.electronAPI is unavailable — preload may have failed to load");
      return;
    }
    appApi.getInitError().then((message) => {
      if (message) setInitError(message);
    }).catch(() => {
      // IPC unavailable — main process may have crashed before registering
      // the handler. Banner stays hidden in this case.
    });
    return appApi.onInitError(setInitError);
  }, []);

  return (
    <>
      {initError && (
        <div className="fixed top-0 inset-x-0 z-40 mx-3 mt-3 px-4 py-3 border border-error/30 bg-error/10 backdrop-blur rounded">
          <p className="text-xs font-semibold text-error">Initialization failed</p>
          <p className="text-xs text-error/80 mt-1 font-mono break-all">{initError}</p>
          <p className="text-xs text-muted-foreground mt-2">
            Sessions and agent files are not being read. Restart the app. If the
            error stays, the log is in ~/Library/Application Support/Agent Desk/logs.
          </p>
        </div>
      )}
      <div style={{ display: "contents" }} inert={primerOpen}>
        <AppShell />
      </div>
      {/* Consolidated folder-permission primer — shown once, before any native
          macOS prompt. Renders nothing when there's nothing to ask. */}
      <PermissionPrimer onOpenChange={setPrimerOpen} />
    </>
  );
}
