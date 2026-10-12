// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, session, shell } from "electron";
import path from "node:path";
import { openStore, redactPath, unredactPath, type SessionStore } from "local-session-extractor";
import { ExtractionScheduler, failureMessage, statsBeforeScheduler, harnessScanFinished } from "./extraction/extractionScheduler";
import { WorkerHost } from "./extraction/workerHost";
import { readHarnessAsset } from "./harness/assetContent";
import { readInventory, readStoredScan, viewableFilePaths, viewableRoots } from "./harness/inventory";
import { getTranscript, listSessions } from "./sessions";
import { StackDetector, type DetectedProject } from "./stack/stackDetector";
import { registerPermissionsIpc } from "./permissions/ipc";
import { followPermissionChange } from "./permissions/followPermissionChange";
import { evaluateBlockedFolders } from "./permissions/permissionHealth";
import { ungrantedProtectedRoots } from "./permissions/folderAccessGuard";
import { notifyPermissionMissing } from "./permissions/permissionNotifier";
import { initLogger, logger } from "./logging/logger";
import { buildAppMenu } from "./menu/appMenu";
import { contentSecurityPolicy } from "./config/contentSecurityPolicy";
import { isAllowedExternalUrl } from "./config/externalUrl";
import { isAppPageUrl } from "./config/appPage";
import { makeQuitter, quitThen } from "./quit";
import { defaultHarnessInventory, type HarnessAssetContent, type HarnessInventory } from "../shared/harnessTypes";
import type { ExtractionStats } from "../shared/extractionTypes";
import type { StackProject } from "../shared/ipcTypes";

// ── App name (forge.config name only applies to packaged builds) ─────────────
app.setName("Agent Desk");

// ── Single-instance lock ─────────────────────────────────────────────────────
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

// ── State ────────────────────────────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let sessionStore: SessionStore | null = null;
let workerHost: WorkerHost | null = null;
let scheduler: ExtractionScheduler | null = null;
// Where the worker keeps the last harness scan (set once userData is known).
let inventoryPath: string | null = null;
// Surfaces a message to the renderer when an init subsystem fails. Read via
// IPC by the renderer to show a persistent error banner.
let initErrorMessage: string | null = null;

// First-scan signal for the Harness page: true until the first read of this
// app run ends, whether it succeeded or failed, so an empty inventory reads as
// "Reading…", not "no agent files". In-memory is enough — later launches
// already have a stored scan. With no worker (the store failed to open) there is
// no first read, so the page shows its plain empty state.
let firstCycleDone = false;
const collectingFirstCycle = (): boolean => !firstCycleDone && workerHost !== null;

// ── Tray icon ────────────────────────────────────────────────────────────────
// macOS Template image (auto-adapts to light/dark menu bar).
// In dev: loaded from resources/ relative to the project root.
// In production: loaded from the app's Resources directory.
function getTrayIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "resources", "trayTemplate.png");
  }
  return path.join(app.getAppPath(), "resources", "trayTemplate.png");
}

function createTrayIcon(): Electron.NativeImage {
  const icon = nativeImage.createFromPath(getTrayIconPath());
  icon.setTemplateImage(true);
  return icon;
}

// Attention-state tray icon — a COLORED (non-template) badged glyph, so the
// warning reads even in the monochrome menu bar. Same dev/packaged path rule as
// the template icon; Electron auto-loads the @2x sibling for HiDPI.
function getAttentionTrayIconPath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "resources", "trayAttention.png");
  }
  return path.join(app.getAppPath(), "resources", "trayAttention.png");
}

function createAttentionTrayIcon(): Electron.NativeImage {
  const icon = nativeImage.createFromPath(getAttentionTrayIconPath());
  icon.setTemplateImage(false); // keep the amber/red colour
  return icon;
}

type TrayState = "normal" | "attention";
let trayState: TrayState = "normal";

/**
 * Swap the tray icon + tooltip to reflect scan-permission health. Idempotent
 * (no-op when already in `state`) and defensive — an asset load failure keeps
 * the current icon rather than crashing the tray.
 */
function setTrayState(state: TrayState): void {
  if (!tray || state === trayState) return;
  try {
    const img = state === "attention" ? createAttentionTrayIcon() : createTrayIcon();
    if (img.isEmpty()) {
      // createFromPath returns an empty image (no throw) for a missing asset —
      // keep the current icon rather than blanking the menu-bar tray.
      logger.warn("tray", "set_state_icon_empty", { state });
      return;
    }
    tray.setImage(img);
    tray.setToolTip(
      state === "attention" ? `${app.getName()} — folder access needed` : app.getName(),
    );
    trayState = state;
  } catch (err: unknown) {
    logger.warn("tray", "set_state_failed", {
      state,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Re-evaluate scan-permission health and reflect it in the tray. When `notify`
 * is set and access is blocked, also fire the once-per-launch notification.
 * macOS-only; a no-op elsewhere. Best-effort: a probe failure leaves the tray
 * unchanged rather than flapping.
 */
async function refreshPermissionTrayState(opts: { notify: boolean }): Promise<void> {
  if (process.platform !== "darwin") return;
  let blocked: string[] = [];
  try {
    blocked = await evaluateBlockedFolders();
  } catch (err: unknown) {
    logger.warn("permissions", "evaluate_blocked_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (blocked.length > 0) {
    setTrayState("attention");
    // The click focuses the app, where the folder-access banner is rendered on
    // every page.
    if (opts.notify) {
      notifyPermissionMissing(showWindow);
    }
  } else {
    setTrayState("normal");
  }
}

// ── Window factory ───────────────────────────────────────────────────────────
const createWindow = (): void => {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 1000,
    minHeight: 680,
    titleBarStyle: "hiddenInset",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // A packaged build has no DevTools at all (hardenProduction also blocks the shortcuts).
      devTools: !app.isPackaged,
      // Explicit (it is Electron's default): a hidden/occluded window's renderer
      // is throttled by Chromium — the tray-first design keeps the window hidden
      // most of the time, so this must never be disabled.
      backgroundThrottling: true,
    },
  });

  hardenProduction(mainWindow);

  const pageFile = path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`);
  // The window shows only the app's own page: it opens no other window (one would get the
  // preload too) and never navigates or is redirected anywhere else.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const stayOnAppPage = (event: { preventDefault(): void }, url: string): void => {
    if (!isAppPageUrl(url, MAIN_WINDOW_VITE_DEV_SERVER_URL, pageFile)) event.preventDefault();
  };
  mainWindow.webContents.on("will-navigate", stayOnAppPage);
  mainWindow.webContents.on("will-redirect", stayOnAppPage);

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(pageFile);
  }

  // Show window once content is ready (avoids white flash).
  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Hide instead of close — the app stays in the tray
  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // macOS: the app ships as an LSUIElement (agent) app, so it launches with no
  // Dock icon and — critically — no top application menu bar (macOS renders that
  // bar only for regular apps). Promote to a regular app (Dock icon + the
  // buildAppMenu() menu bar) while the window is visible, and demote back to
  // accessory when it hides to the tray, so the menus present like a normal app
  // in use but it stays tray-first when out of the way.
  //
  // The demote must NOT fire during native fullscreen: entering fullscreen moves
  // the window to its own Space and emits a transient hide→show, and switching to
  // accessory mid-transition makes the fullscreen window vanish (an accessory app
  // can't hold a fullscreen window). So keep the dock shown on fullscreen enter,
  // and DEFER the hide one tick — a genuine hide-to-tray stays hidden past the
  // timer, while a fullscreen transition's transient hide is cancelled by its
  // paired show/enter-full-screen first.
  if (process.platform === "darwin") {
    let dockHideTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelDockHide = (): void => {
      if (dockHideTimer) {
        clearTimeout(dockHideTimer);
        dockHideTimer = null;
      }
    };
    const showDock = (): void => {
      cancelDockHide();
      void app.dock?.show();
    };
    mainWindow.on("show", showDock);
    mainWindow.on("enter-full-screen", showDock);
    mainWindow.on("hide", () => {
      cancelDockHide();
      dockHideTimer = setTimeout(() => {
        dockHideTimer = null;
        // Only a real hide-to-tray reaches here: a window still visible or in
        // fullscreen is not tray-hidden, so leave it a regular app.
        if (mainWindow && !mainWindow.isVisible() && !mainWindow.isFullScreen()) {
          app.dock?.hide();
        }
      }, 300);
    });
  }
};

// ── Production hardening ─────────────────────────────────────────────────────

/**
 * Disables DevTools and keyboard shortcuts in packaged builds.
 * No-op in development to preserve the normal DX.
 */
function hardenProduction(win: BrowserWindow): void {
  if (!app.isPackaged) return;

  // The application menu is set centrally at ready (buildAppMenu); in packaged
  // builds it omits the View/DevTools submenu. DevTools shortcuts stay blocked
  // by the guards below.

  // Close DevTools immediately if opened programmatically
  win.webContents.on("devtools-opened", () => {
    win.webContents.closeDevTools();
  });

  // Block DevTools keyboard shortcuts: F12, Cmd+Opt+I, Cmd+Opt+J
  win.webContents.on("before-input-event", (event, input) => {
    if (input.key === "F12") {
      event.preventDefault();
      return;
    }
    if (
      input.meta &&
      input.alt &&
      (input.key === "i" || input.key === "I" || input.key === "j" || input.key === "J")
    ) {
      event.preventDefault();
    }
  });
}

// ── Tray setup ───────────────────────────────────────────────────────────────

/**
 * Builds the tray menu. It is built each time it opens, so "Launch at Login"
 * shows the current setting, also after a change in System Settings.
 */
function trayMenu(): Electron.Menu {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: `Show ${app.getName()}`,
      click: showWindow,
    },
    { type: "separator" },
    {
      label: "Launch at Login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      },
    },
    { type: "separator" },
    { label: `${app.getName()} v${app.getVersion()}`, enabled: false },
    {
      label: `Quit ${app.getName()}`,
      accelerator: "CommandOrControl+Q",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ];

  return Menu.buildFromTemplate(template);
}

function createTray(): void {
  tray = new Tray(createTrayIcon());
  tray.setToolTip(app.getName());

  // A click, right-click or Control-click opens the menu, as a menu bar icon does on macOS:
  // Show first, Quit last.
  const openMenu = (): void => tray?.popUpContextMenu(trayMenu());
  tray.on("click", openMenu);
  tray.on("right-click", openMenu);
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// Builds the local subsystems: the session store (read side), the extraction
// worker and its scheduler, and the stack detector's project source. Attempted
// once per process — a failed open leaves the group dead (with
// initErrorMessage set) until restart.
function initSubsystems(userDataPath: string): void {
  try {
    const storePath = path.join(userDataPath, "sessions.db");
    inventoryPath = path.join(userDataPath, "harness-inventory.json");

    sessionStore = openStore(storePath);
    const store = sessionStore;

    // StackDetector scans the project roots the session store already
    // resolved (the same set backing the Projects-view rows), so its stack tags
    // join onto those rows. `project_path` is stored redacted (username →
    // hash); un-redact it to a real on-disk path so the detector can scan it.
    // `toStackProjects` re-redacts on the way to the renderer, so the tag path
    // still matches the (redacted) row.
    StackDetector.getInstance().setSkipRootsProvider(ungrantedProtectedRoots);
    StackDetector.getInstance().setProjectsProvider(() =>
      store.listDetectedProjects().map((p) => ({
        path: unredactPath(p.project_path),
        lastSeenAt: new Date(p.last_seen_ms),
      })),
    );

    workerHost = new WorkerHost(
      { userDataPath, storePath, inventoryPath },
      (event) => {
        // Advance the renderer-facing stage list (Projects page progress).
        scheduler?.noteWorkerProgress(event);
        if (harnessScanFinished(event)) mainWindow?.webContents.send("harness:updated");
      },
    );

    scheduler = new ExtractionScheduler(
      store,
      workerHost,
      (stats) => {
        mainWindow?.webContents.send("extraction:statusChange", stats);
        // The first read has ended, well or badly: every push but the running
        // ones comes from the end of a read. The mid-cycle push above fires
        // BEFORE this flag flips, so one more push after the flip lets the
        // Harness page refetch with collecting=false and settle on its real
        // state, or on the read's error.
        if (!firstCycleDone && stats.status !== "running") {
          firstCycleDone = true;
          mainWindow?.webContents.send("harness:updated");
        }
      },
      () => {

        // A completed cycle may have added project folders (the source
        // StackDetector reads), so refresh the stack tags. Always a rescan, never
        // the cooldown path: a cold-cache rescan the page asked for before this
        // read found no projects, and its cooldown would hold the tags back
        // until the next read. The rescan pushes to the Projects page via
        // setOnRescanComplete.
        void StackDetector.getInstance().rescan().catch(() => {});
      },
      // The harness scan skips protected folders the user has not granted.
      ungrantedProtectedRoots,
    );
    logger.info("app", "subsystems_initialized");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("app", "subsystem_init_failed", {
      error: message,
      errorName: err instanceof Error ? err.name : "Unknown",
      stack: err instanceof Error ? err.stack ?? "no stack" : "no stack",
      packaged: String(app.isPackaged),
      version: app.getVersion(),
    });
    console.error("[main] Subsystem init failed:", err);
    initErrorMessage = failureMessage(err);
    // Best-effort push: the renderer may not have subscribed yet. It also
    // pulls via app:getInitError on mount, which is the primary delivery.
    mainWindow?.webContents.send("app:initError", initErrorMessage);
  }
}

// ── Scheduler lifecycle ───────────────────────────────────────────────────────

function startSchedulers(): void {
  // The scheduler starts the worker before its first cycle; a worker that
  // cannot start shows as that cycle's error.
  if (scheduler) {
    scheduler.start();
    logger.info("scheduler", "schedulers_started");
  } else {
    logger.error("scheduler", "schedulers_missing");
  }

  // Reflect any prior scan-permission denial in the tray and notify once per
  // launch. Fire-and-forget; refreshPermissionTrayState is macOS-guarded.
  void refreshPermissionTrayState({ notify: true });
  // Where folder access stands now, so a later focus reports only a change.
  void permissionsIpc.recheck();
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle("app:getVersion", (): string => app.getVersion());

ipcMain.handle("app:getInitError", (): string | null => initErrorMessage);

ipcMain.handle("shell:openExternal", async (_event, url: string): Promise<void> => {
  // The System Settings deep link only (externalUrl.ts).
  if (isAllowedExternalUrl(url)) {
    await shell.openExternal(url);
  }
});

// ── Extraction IPC handlers ──────────────────────────────────────────────────

ipcMain.handle("extraction:getStats", (): ExtractionStats => {
  return scheduler ? scheduler.getStats() : statsBeforeScheduler(initErrorMessage);
});

ipcMain.handle("extraction:triggerNow", async (): Promise<void> => {
  if (scheduler) {
    await scheduler.triggerNow();
  }
});

// ── Harness IPC handlers (served from the stored scan, no live scan) ─────────

ipcMain.handle("harness:getInventory", (): HarnessInventory =>
  inventoryPath ? readInventory(inventoryPath, collectingFirstCycle()) : defaultHarnessInventory(),
);

// Detail-view read: serve one asset file's raw contents. Allowlisted to the
// stored inventory's viewable paths and size-capped in readHarnessAsset — this
// IPC can't read an arbitrary path off disk.
ipcMain.handle("harness:readAsset", async (_event, filePath: string): Promise<HarnessAssetContent> => {
  if (!inventoryPath) {
    return { content: null, error: "Inventory is not available yet." };
  }
  let allowed: string[];
  let readRoots: string[];
  let skipRoots: string[];
  try {
    // Checked when served: a folder the user has not granted now is never read.
    skipRoots = await ungrantedProtectedRoots();
    const stored = readStoredScan(inventoryPath);
    allowed = viewableFilePaths(stored, skipRoots);
    readRoots = viewableRoots(stored);
  } catch (err) {
    return { content: null, error: err instanceof Error ? err.message : String(err) };
  }
  return readHarnessAsset(allowed, filePath, skipRoots, readRoots);
});

// ── Sessions IPC handlers (served from the session store) ────────────────────
// Inputs are checked and failures come back as values in sessions.ts. An open
// project's sessions read again after each read cycle, on extraction:statusChange.

ipcMain.handle("sessions:list", (_event, filter: unknown) => listSessions(sessionStore, filter));

ipcMain.handle("sessions:getTranscript", (_event, key: unknown, offset: unknown) => getTranscript(sessionStore, key, offset));

// Detected project stacks for the Projects page tag chips. Serves the cached
// StackDetector scan when available; first call triggers a rescan.
// The detector holds a REAL on-disk `path` (it scans the filesystem); redact it
// here so it matches the ExtractionStats folder paths (stored redacted) for the
// renderer join. `displayName` is already redacted at construction (see
// StackDetector), so it passes through as-is.
const toStackProjects = (projects: DetectedProject[]): StackProject[] =>
  projects.map((p) => ({
    path: redactPath(p.path),
    displayName: p.displayName,
    stackTags: p.stackTags,
  }));

// Cooldown for cold-cache scan kicks from the IPC path — see rescanIfStale.
const STACK_RESCAN_COOLDOWN_MS = 60_000;

ipcMain.handle("stack:getProjects", (): StackProject[] => {
  try {
    const detector = StackDetector.getInstance();
    const cached = detector.getProjects();
    if (cached.length === 0) {
      // Cold cache: kick the scan in the background and return immediately —
      // results land via the stack:projectsUpdated push below (ProjectsPage
      // subscribes). Awaiting the scan here would block the first page
      // paint behind the full project scan.
      detector.rescanIfStale(STACK_RESCAN_COOLDOWN_MS);
    }
    return toStackProjects(cached);
  } catch {
    return [];
  }
});

// Push fresh results to the Projects page whenever a rescan finishes. This is
// what lets folders unlocked by the primer appear without a restart: a
// folder-access change (below) triggers a rescan, which lands here.
StackDetector.getInstance().setOnRescanComplete((projects) => {
  mainWindow?.webContents.send("stack:projectsUpdated", toStackProjects(projects));
});

// ── Permission primer IPC handlers (folder-access) ───────────────────────────
// The renderer shows one consolidated "why" primer before the native macOS
// folder prompts. No-op off macOS. Registered once; logic in src/main/permissions/.
// Each change it reports (asked, granted, declined, changed) is followed at once
// by followPermissionChange: a rescan, the tray state and the banner. Nothing is
// reported after before-quit has stopped it.
const permissionsIpc = registerPermissionsIpc((change) =>
  followPermissionChange(change, {
    rescan: () => void StackDetector.getInstance().rescan().catch(() => {}),
    refreshTray: (opts) => void refreshPermissionTrayState(opts),
    send: (channel) => mainWindow?.webContents.send(channel),
  }),
);

// ── App lifecycle ─────────────────────────────────────────────────────────────

// How long quitting waits for a read in progress before closing the session store.
const QUIT_READ_WAIT_MS = 5000;
let readyToQuit = false;
const quitOnce = makeQuitter(() => ({ scheduler, workerHost, store: sessionStore }), QUIT_READ_WAIT_MS);

// Set the flag before windows receive their close events (covers Cmd+Q, menu quit, etc.).
// The first quit is held until the read in progress finishes (up to QUIT_READ_WAIT_MS), so
// the store is never closed under a running read; then the app quits for real.
app.on("before-quit", (event) => {
  app.isQuitting = true;
  // Any folder re-probing ends here: nothing is rescanned, notified or sent while quitting.
  permissionsIpc.stop();
  if (readyToQuit) return;
  event.preventDefault();
  logger.info("app", "app_quit");
  void quitThen(quitOnce, () => {
    readyToQuit = true;
    app.quit();
  });
});

app.on("ready", () => {
  // ── Content Security Policy ────────────────────────────────────────────────
  const csp = contentSecurityPolicy(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
  // The page asks for no permission (camera, notifications, clipboard, …); Electron
  // would grant any by default.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

  const userDataPath = app.getPath("userData");

  // Logger init has its own try/catch — if it fails (e.g. unwritable
  // userData dir), the rest of init must still proceed so the user isn't
  // stuck with a blank window.
  try {
    initLogger(userDataPath);
    logger.info("app", "app_launched");
  } catch (err) {
    console.error("[main] Logger init failed:", err);
  }

  createTray();

  createWindow();

  // Native About panel content (name, version and copyright) for the app-menu "About" item.
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    copyright: "Copyright © 2026 The Agent Desk Authors",
  });

  // Curated application menu. Wrapped so a build failure can't stop the app
  // from coming up (the tray still works). DevTools stays hardened via the
  // input-event guards in hardenProduction().
  try {
    Menu.setApplicationMenu(buildAppMenu({ appName: app.getName(), isPackaged: app.isPackaged }));
  } catch (err) {
    logger.error("app", "app_menu_build_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Re-evaluate scan-permission state whenever the app regains focus, so a
  // grant/denial the user makes in System Settings while we are running is
  // reflected without a relaunch. Mirrors the in-app banner's own focus
  // re-probe, keeping the two surfaces consistent. refreshPermissionTrayState
  // is macOS-guarded and idempotent, so an off-target focus is a cheap no-op.
  app.on("browser-window-focus", () => {
    if (app.isQuitting) return;
    // While a request is asking, a prompt may be open: its own reports cover the tray then.
    if (!permissionsIpc.asking()) void refreshPermissionTrayState({ notify: true });
    // An Allow or a revoke in System Settings: the banner and the stack tags follow it now.
    void permissionsIpc.recheck();
  });

  initSubsystems(userDataPath);
  // Defer so the window renders and Chromium's message pump delivers IPC
  // before the first cycle starts.
  setTimeout(startSchedulers, 3000);

  logger.info("app", "app_ready", {
    version: app.getVersion(),
    packaged: String(app.isPackaged),
    initOk: initErrorMessage === null,
  });
});

app.on("second-instance", () => {
  showWindow();
});

// Keep app running when all windows are closed (tray stays active)
app.on("window-all-closed", () => {
  // Do nothing — the app lives in the tray
});

app.on("activate", () => {
  showWindow();
});

// ── Initial state ──────────────────────────────────────────────────────────
app.isQuitting = false;

// ── Forge Vite plugin globals ─────────────────────────────────────────────────
declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;
