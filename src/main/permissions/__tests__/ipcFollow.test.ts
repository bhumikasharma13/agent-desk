// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// How the folder-access IPC follows answers after the request: a focus re-probe reports a change,
// and a quit mid-wait reports nothing. Electron and the folder probe are stand-ins.

import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "permissions-follow-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
mock.module("electron", {
  namedExports: {
    ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn) },
    app: { getPath: (name: string) => join(dir, name), getVersion: () => "0.1.0" },
  },
});
let answer: "granted" | "blocked" = "blocked";
// Per-folder answers win over `answer` (the folders are <dir>/desktop and so on).
const answers: Record<string, "granted" | "blocked"> = {};
mock.module("../folderAccess", {
  namedExports: {
    classifyProbeError: () => "indeterminate",
    probeFolderAccess: async (folder: string) => answers[folder.split("/").pop()!] ?? answer,
  },
});
const { registerPermissionsIpc } = await import("../ipc");
const { PermissionStore } = await import("../permissionStore");

test("a focus re-probe that finds a folder now allowed reports it, once", { skip: process.platform !== "darwin" }, async () => {
  mkdirSync(join(dir, "userData"), { recursive: true });
  writeFileSync(join(dir, "userData", "permission-grants.json"), JSON.stringify({ asked: ["desktop"], version: "0.1.0" }));
  PermissionStore.__resetForTests();
  const changes: string[] = [];
  const ipc = registerPermissionsIpc((change) => changes.push(change));
  answer = "blocked";
  await ipc.recheck(); // at launch: where things stand
  await ipc.recheck(); // nothing changed
  answer = "granted"; // allowed in System Settings
  await ipc.recheck();
  await ipc.recheck();
  assert.deepEqual(changes, ["changed"]);
  ipc.stop();
});

test("a folder still blocked at the bound is reported declined once the request ends", { skip: process.platform !== "darwin" }, async () => {
  rmSync(join(dir, "userData", "permission-grants.json"), { force: true });
  PermissionStore.__resetForTests();
  handlers.clear();
  const t = { now: 0 };
  const clock = { now: () => t.now, sleep: async (ms: number) => void (t.now += ms) };
  const changes: string[] = [];
  const ipc = registerPermissionsIpc((change) => changes.push(change), { clock });
  answer = "blocked";
  await handlers.get("permissions:request")!();
  assert.deepEqual(changes, ["asked", "declined"]);
  ipc.stop();
});

test("a quit while folders are still blocked ends the request at once and reports nothing more", { skip: process.platform !== "darwin" }, async () => {
  rmSync(join(dir, "userData", "permission-grants.json"), { force: true });
  PermissionStore.__resetForTests();
  handlers.clear();
  const changes: string[] = [];
  const ipc = registerPermissionsIpc((change) => changes.push(change));
  answer = "blocked";
  const started = Date.now();
  const request = handlers.get("permissions:request")!();
  await new Promise((r) => setTimeout(r, 50));
  ipc.stop(); // quit
  await request;
  assert.ok(Date.now() - started < 2000, "the request ended at the quit, not after the 60 s bound");
  assert.deepEqual(changes, ["asked"], "no declined report and no follow-up after the quit");
  await ipc.recheck();
  assert.deepEqual(changes, ["asked"], "a focus after the quit reports nothing");
});

// A clock that moves only when the request sleeps, so the 60 s bound passes at once.
const instant = () => {
  const t = { now: 0 };
  return { now: () => t.now, sleep: async (ms: number) => void (t.now += ms) };
};
const fresh = () => {
  rmSync(join(dir, "userData", "permission-grants.json"), { force: true });
  PermissionStore.__resetForTests();
  handlers.clear();
  for (const k of Object.keys(answers)) delete answers[k];
};

test("a folder declined in the request and later allowed in System Settings is reported on the next focus", { skip: process.platform !== "darwin" }, async () => {
  fresh();
  const changes: string[] = [];
  const ipc = registerPermissionsIpc((change) => changes.push(change), { clock: instant() });
  answer = "granted";
  answers["desktop"] = "blocked";
  await handlers.get("permissions:request")!();
  assert.deepEqual(changes, ["asked", "declined"]);
  answers["desktop"] = "granted"; // allowed in System Settings
  await ipc.recheck();
  assert.deepEqual(changes, ["asked", "declined", "changed"]);
  ipc.stop();
});

test("a folder granted in the request and later revoked in System Settings is reported on the next focus", { skip: process.platform !== "darwin" }, async () => {
  fresh();
  const changes: string[] = [];
  const ipc = registerPermissionsIpc((change) => changes.push(change), { clock: instant() });
  answer = "granted";
  await handlers.get("permissions:request")!();
  answers["desktop"] = "blocked"; // revoked in System Settings
  await ipc.recheck();
  assert.deepEqual(changes, ["asked", "changed"]);
  ipc.stop();
});

test("a focus while the request is asking reports nothing, and asking() says so", { skip: process.platform !== "darwin" }, async () => {
  fresh();
  // Desktop was allowed at an earlier launch; Documents and Downloads are asked for now.
  writeFileSync(join(dir, "userData", "permission-grants.json"), JSON.stringify({ asked: ["desktop"], version: "0.1.0" }));
  PermissionStore.__resetForTests();
  answers["desktop"] = "granted";
  let wake!: () => void;
  const t = { now: 0 };
  const clock = { now: () => t.now, sleep: () => new Promise<void>((r) => (wake = () => ((t.now += 500), r()))) };
  const changes: string[] = [];
  const ipc = registerPermissionsIpc((change) => changes.push(change), { clock });
  await ipc.recheck(); // at launch
  answer = "blocked";
  const request = handlers.get("permissions:request")!();
  await new Promise((r) => setImmediate(r));
  assert.equal(ipc.asking(), true);
  answers["desktop"] = "blocked"; // revoked in System Settings while a prompt is open
  await ipc.recheck();
  assert.deepEqual(changes, ["asked"], "the focus reported nothing while a prompt may be open");
  answer = "granted";
  wake();
  await request;
  assert.equal(ipc.asking(), false);
  ipc.stop();
});

test("a quit while a folder is still blocked leaves it un-asked, so the primer asks for it at the next launch", { skip: process.platform !== "darwin" }, async () => {
  fresh();
  const ipc = registerPermissionsIpc(() => {});
  answer = "blocked";
  const request = handlers.get("permissions:request")!();
  await new Promise((r) => setTimeout(r, 50));
  ipc.stop(); // quit
  await request;
  PermissionStore.__resetForTests(); // the next launch reads the record from disk
  registerPermissionsIpc();
  const status = handlers.get("permissions:getNeeded")!() as { needed: { key: string }[] };
  assert.ok(status.needed.some((f) => f.key === "desktop"), "Desktop is still needed");
});

