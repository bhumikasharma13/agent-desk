// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// A second Continue while the macOS prompts are still open asks nothing more: the request
// handler is single-flight. Electron and the folder probe are stand-ins; nothing real is probed.

import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "permissions-ipc-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
mock.module("electron", {
  namedExports: {
    ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) },
    app: { getPath: (name: string) => join(dir, name), getVersion: () => "0.1.0" },
  },
});
const probed: string[] = [];
let answer!: () => void;
mock.module("../folderAccess", {
  namedExports: {
    classifyProbeError: () => "indeterminate",
    probeFolderAccess: (folder: string) => {
      probed.push(folder);
      return new Promise((resolve) => (answer = () => resolve("granted")));
    },
  },
});
const { registerPermissionsIpc } = await import("../ipc");

test("a second request while the prompts are open asks nothing more", { skip: process.platform !== "darwin" }, async () => {
  registerPermissionsIpc();
  const request = handlers.get("permissions:request")!;
  const first = request();
  await new Promise((r) => setImmediate(r));
  const second = request(); // a double Continue
  await new Promise((r) => setImmediate(r));
  const openPrompts = probed.length;
  for (let i = 0; i < 6 && probed.length < 6; i++) {
    answer();
    await new Promise((r) => setImmediate(r));
  }
  answer();
  await Promise.race([Promise.all([first, second]), new Promise((r) => setTimeout(r, 1000))]);
  assert.equal(openPrompts, 1, "only the first request's first prompt is open");
  // The request's own probes, one per folder; after it, the asked folders are probed once more to
  // record where things stand.
  assert.deepEqual(probed.slice(0, 3).sort(), [...new Set(probed.slice(0, 3))].sort(), "each folder was asked once");
  assert.equal(new Set(probed.slice(0, 3)).size, 3);
});
