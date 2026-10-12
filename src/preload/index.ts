// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { contextBridge, ipcRenderer } from "electron";
import type {
  ExtractionStats,
  HarnessInventory,
  HarnessAssetContent,
  StackProject,
  FolderPermissionStatus,
} from "../shared/ipcTypes";
import type { NeededFolder } from "../shared/permissionTypes";
import type { SessionList, SessionListFilter, SessionTranscript } from "../shared/sessionTypes";

// ── Exposed API ───────────────────────────────────────────────────────────────
// The renderer never calls ipcRenderer directly — all communication
// goes through this typed bridge, enforcing contextIsolation.

contextBridge.exposeInMainWorld("electronAPI", {
  /** Open the macOS System Settings deep link; main refuses every other URL (config/externalUrl.ts). */
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke("shell:openExternal", url),

  /** Get the app version from package.json (via Electron's app.getVersion()). */
  getVersion: (): Promise<string> => ipcRenderer.invoke("app:getVersion"),

  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },

  app: {
    /**
     * Returns the most recent init failure message (or null if init succeeded).
     * The renderer reads this on mount to decide whether to show an error banner.
     */
    getInitError: (): Promise<string | null> =>
      ipcRenderer.invoke("app:getInitError"),

    /**
     * Subscribe to init errors pushed from the main process.
     * Fires when a subsystem (e.g. the session store) fails to initialize.
     * Returns a cleanup function.
     */
    onInitError: (callback: (message: string) => void): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        message: string
      ) => callback(message);
      ipcRenderer.on("app:initError", handler);
      return () => ipcRenderer.off("app:initError", handler);
    },
  },

  extraction: {
    getStats: (): Promise<ExtractionStats> =>
      ipcRenderer.invoke("extraction:getStats"),

    triggerNow: (): Promise<void> =>
      ipcRenderer.invoke("extraction:triggerNow"),

    onStatusChange: (
      callback: (stats: ExtractionStats) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        stats: ExtractionStats
      ) => callback(stats);
      ipcRenderer.on("extraction:statusChange", handler);
      return () => ipcRenderer.off("extraction:statusChange", handler);
    },
  },

  harness: {
    /** Installed-asset inventory served from the stored harness scan. */
    getInventory: (): Promise<HarnessInventory> =>
      ipcRenderer.invoke("harness:getInventory"),

    /** Raw contents of one asset file, for the detail view. Allowlisted to the
     *  stored inventory's paths and size-capped in main. */
    readAsset: (filePath: string): Promise<HarnessAssetContent> =>
      ipcRenderer.invoke("harness:readAsset", filePath),

    /** Fires after an extraction cycle refreshed the harness inventory. */
    onUpdated: (callback: () => void): (() => void) => {
      const handler = (): void => callback();
      ipcRenderer.on("harness:updated", handler);
      return () => ipcRenderer.off("harness:updated", handler);
    },
  },

  sessions: {
    /** One page of sessions, the most recently active first; a failure comes back as `error`. */
    list: (filter: SessionListFilter): Promise<SessionList> => ipcRenderer.invoke("sessions:list", filter),

    /** Up to 100 of one session's messages from `offset`, masked as stored. */
    getTranscript: (key: string, offset: number): Promise<SessionTranscript> =>
      ipcRenderer.invoke("sessions:getTranscript", key, offset),
  },

  stack: {
    /** Locally-detected projects with stack-tag fingerprints (read-only). */
    getProjects: (): Promise<StackProject[]> => ipcRenderer.invoke("stack:getProjects"),

    /**
     * Pushed when a rescan finishes (e.g. after the folder primer grants access
     * to projects that were skipped on first launch). Lets the Projects page
     * refresh without a restart. Returns an unsubscribe.
     */
    onProjectsUpdated: (callback: (projects: StackProject[]) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, projects: StackProject[]) =>
        callback(projects);
      ipcRenderer.on("stack:projectsUpdated", handler);
      return () => ipcRenderer.off("stack:projectsUpdated", handler);
    },
  },

  permissions: {
    /**
     * Which protected folders the consolidated primer should list. Computed with
     * NO OS prompt; empty when already handled or off macOS.
     */
    getNeeded: (): Promise<FolderPermissionStatus> =>
      ipcRenderer.invoke("permissions:getNeeded"),

    /**
     * After the user clicks Continue, probe every needed folder, which shows its
     * native macOS prompt, and re-probe until the answers apply (askFolders).
     */
    request: (): Promise<void> => ipcRenderer.invoke("permissions:request"),

    /** Folders the user has denied (already asked + probe blocked). */
    getBlocked: (): Promise<NeededFolder[]> => ipcRenderer.invoke("permissions:getBlocked"),

    /** Fires when a folder-access request has settled; returns the unsubscribe. */
    onChanged: (callback: () => void): (() => void) => {
      const handler = () => callback();
      ipcRenderer.on("permissions:changed", handler);
      return () => ipcRenderer.off("permissions:changed", handler);
    },
  },
});

// ── TypeScript global augmentation ───────────────────────────────────────────
// Keeps the renderer's window.electronAPI type-safe using the shared IPC types.

declare global {
  interface Window {
    electronAPI: {
      openExternal(url: string): Promise<void>;
      getVersion(): Promise<string>;
      app: {
        getInitError(): Promise<string | null>;
        onInitError(callback: (message: string) => void): () => void;
      };
      versions: {
        node: string;
        chrome: string;
        electron: string;
      };
      extraction: {
        getStats(): Promise<ExtractionStats>;
        triggerNow(): Promise<void>;
        onStatusChange(callback: (stats: ExtractionStats) => void): () => void;
      };
      harness: {
        getInventory(): Promise<HarnessInventory>;
        readAsset(filePath: string): Promise<HarnessAssetContent>;
        onUpdated(callback: () => void): () => void;
      };
      sessions: {
        list(filter: SessionListFilter): Promise<SessionList>;
        getTranscript(key: string, offset: number): Promise<SessionTranscript>;
      };
      stack: {
        getProjects(): Promise<StackProject[]>;
        onProjectsUpdated(callback: (projects: StackProject[]) => void): () => void;
      };
      permissions: {
        getNeeded(): Promise<FolderPermissionStatus>;
        request(): Promise<void>;
        getBlocked(): Promise<NeededFolder[]>;
        onChanged(callback: () => void): () => void;
      };
    };
  }
}
