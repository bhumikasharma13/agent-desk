// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Test-only ESM stub for the `electron` module.
 *
 * Under ELECTRON_RUN_AS_NODE the real `electron` package is a CJS shim whose
 * named exports the ESM loader cannot statically detect, so a plain
 * `import { app } from "electron"` throws at load time. test-loader.mjs redirects
 * the bare `electron` specifier here so any source file in a test's import graph
 * loads. These are inert no-ops — tests that need real behavior inject seams
 * (a constructor parameter or a module mock) rather than relying on these.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fresh directory per test process, removed on exit, so nothing a test persists through
// app.getPath() lands in a shared or fixed location.
const userData = mkdtempSync(join(tmpdir(), "agent-desk-test-"));
process.on("exit", () => rmSync(userData, { recursive: true, force: true }));

export const app = {
  getPath: () => userData,
  isReady: () => false,
  on: () => {},
  whenReady: () => Promise.resolve(),
  quit: () => {},
};

export const shell = {
  openExternal: () => Promise.resolve(),
};

export class BrowserWindow {
  static getAllWindows() {
    return [];
  }
}

export const ipcMain = { handle: () => {}, on: () => {} };
export const utilityProcess = {
  fork: () => ({ on: () => {}, once: () => {}, postMessage: () => {}, kill: () => true }),
};
export const Tray = class {};
export const Menu = { buildFromTemplate: () => ({}) };
export const nativeImage = { createFromPath: () => ({}) };

export class Notification {
  static isSupported() {
    return true;
  }

  constructor(opts) {
    this.opts = opts;
  }

  on() {}

  show() {}
}

export default { app, shell, BrowserWindow, ipcMain, utilityProcess, Tray, Menu, nativeImage, Notification };
