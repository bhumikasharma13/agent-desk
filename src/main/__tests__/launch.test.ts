// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Loads the real main-process entry against a recording stand-in for the Electron API and fires
// its "ready" handler as a packaged launch, so what a launch does to the user's system is
// observable without starting Electron. Every call into the stand-in is recorded by its path,
// e.g. "app.setLoginItemSettings".

const userData = mkdtempSync(join(tmpdir(), "launch-test-"));
after(() => rmSync(userData, { recursive: true, force: true }));

const calls: { path: string; args: unknown[] }[] = [];
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const values: Record<string, unknown> = {
  "app.isPackaged": true,
  "app.dock": undefined,
};
const returns: Record<string, (...args: unknown[]) => unknown> = {
  "app.getPath": () => userData,
  "app.getName": () => "Agent Desk",
  "app.getVersion": () => "0.1.0",
  "app.requestSingleInstanceLock": () => true,
  "app.getLoginItemSettings": () => ({ openAtLogin: false }),
  "app.on": (event, cb) => {
    handlers.set(String(event), cb as (...args: unknown[]) => unknown);
  },
  "nativeImage.createFromPath": () => fake("image", { isEmpty: () => false }),
};

function fake(path: string, own: Record<string, unknown> = {}): unknown {
  const target = function () {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => path;
      if (prop === "then") return undefined;
      const key = `${path}.${String(prop)}`;
      if (prop in own) return own[prop as string];
      if (key in values) return values[key];
      return fake(key);
    },
    set(_t, prop, value) {
      values[`${path}.${String(prop)}`] = value;
      return true;
    },
    apply(_t, _this, args) {
      calls.push({ path, args });
      const r = returns[path];
      return r ? r(...args) : fake(`${path}()`);
    },
    construct(_t, args) {
      calls.push({ path: `new ${path}`, args });
      return fake(`${path}#instance`) as object;
    },
  });
}

const names = ["app", "BrowserWindow", "ipcMain", "Tray", "Menu", "nativeImage", "session", "shell", "Notification", "utilityProcess"];
const electron = Object.fromEntries(names.map((n) => [n, fake(n)]));
mock.module("electron", { namedExports: electron, defaultExport: electron });
// The session store cannot be opened, as with a corrupt or unreadable sessions.db, and the error
// carries no message.
mock.module("local-session-extractor", {
  namedExports: {
    openStore: () => {
      throw new Error("");
    },
    redactPath: (p: string) => p,
    unredactPath: (p: string) => p,
  },
});

// The folder probe answers what `folderAnswer` says (the folders are the stand-in's userData).
let folderAnswer: "granted" | "blocked" = "granted";
let folderProbes = 0;
const realFolderAccess = await import("../permissions/folderAccess");
mock.module("../permissions/folderAccess", {
  namedExports: {
    ...realFolderAccess,
    probeFolderAccess: async () => {
      folderProbes++;
      return folderAnswer;
    },
  },
});

// The quit sequence fails (quit.test.ts pins the sequence itself), to show the app still quits.
const realQuit = await import("../quit");
mock.module("../quit", {
  namedExports: { ...realQuit, makeQuitter: () => () => Promise.reject(new Error("the store would not close")) },
});

Object.assign(globalThis, {
  __dirname: "/nonexistent",
  MAIN_WINDOW_VITE_DEV_SERVER_URL: undefined,
  MAIN_WINDOW_VITE_NAME: "main_window",
});

await import("../index");

test("a packaged launch writes no login item; the tray toggle is off, writes one only when clicked, and follows System Settings", async () => {
  // The deferred scheduler start and the logger's flush stay queued: this test is about the launch.
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const ready = handlers.get("ready");
    assert.ok(ready, "index.ts registers a ready handler");
    // The store's open fails on purpose (the mock above); its console line is expected, not shown.
    const quiet = mock.method(console, "error", () => {});
    try {
      await ready();
    } finally {
      quiet.mock.restore();
    }
    assert.match(String(quiet.mock.calls[0]?.arguments[0]), /Subsystem init failed/);
    assert.deepEqual(
      calls.filter((c) => c.path === "app.setLoginItemSettings"),
      [],
      "a launch must not register the app to start at login",
    );

    const rightClick = calls.find((c) => c.path === "Tray#instance.on" && c.args[0] === "right-click")?.args[1] as
      | (() => void)
      | undefined;
    assert.ok(rightClick, "a right-click opens the tray menu");
    rightClick();
    const template = [...calls].reverse().find((c) => c.path === "Menu.buildFromTemplate")?.args[0] as
      | { label?: string; checked?: boolean; click?: (item: { checked: boolean }) => void }[]
      | undefined;
    const toggle = template?.find((i) => i.label === "Launch at Login");
    assert.ok(toggle, "the tray menu has a Launch at Login item");
    assert.equal(toggle.checked, false);
    toggle.click?.({ checked: true });
    assert.deepEqual(
      calls.filter((c) => c.path === "app.setLoginItemSettings").map((c) => c.args[0]),
      [{ openAtLogin: true }],
    );

    // Turned on in System Settings meanwhile: the next time the menu opens, it says so.
    returns["app.getLoginItemSettings"] = () => ({ openAtLogin: true });
    rightClick();
    const reopened = [...calls].reverse().find((c) => c.path === "Menu.buildFromTemplate")?.args[0] as { label?: string; checked?: boolean }[];
    assert.equal(reopened.find((i) => i.label === "Launch at Login")?.checked, true);
  } finally {
    mock.timers.reset();
  }
});

test("the About panel names the copyright holder", () => {
  const options = calls.find((c) => c.path === "app.setAboutPanelOptions")?.args[0] as { copyright?: string } | undefined;
  assert.ok(options, "index.ts sets the About panel's options");
  assert.equal(options.copyright, "Copyright © 2026 The Agent Desk Authors");
});

test("the open-external handler opens the System Settings deep link and nothing else", async () => {
  const handler = calls.find((c) => c.path === "ipcMain.handle" && c.args[0] === "shell:openExternal")?.args[1] as
    | ((event: unknown, url: unknown) => Promise<void>)
    | undefined;
  assert.ok(handler, "index.ts registers shell:openExternal");
  const opened = () => calls.filter((c) => c.path === "shell.openExternal").map((c) => c.args[0]);
  await handler({}, "https://example.com");
  await handler({}, "file:///etc/passwd");
  assert.deepEqual(opened(), []);
  await handler({}, "x-apple.systempreferences:com.apple.preference.security");
  assert.deepEqual(opened(), ["x-apple.systempreferences:com.apple.preference.security"]);
});

test("a session store that cannot be opened shows as the stats' error, not as nothing read", async () => {
  const handler = calls.find((c) => c.path === "ipcMain.handle" && c.args[0] === "extraction:getStats")?.args[1] as
    | (() => { status: string; lastError: string | null })
    | undefined;
  assert.ok(handler, "index.ts registers extraction:getStats");
  const stats = handler();
  assert.equal(stats.status, "error");
  assert.equal(stats.lastError, "The read failed (no message)", "an empty message still reads as a failure");
});

test("with no session store, the session reads get an error, not an empty list, and bad input is refused first", () => {
  const handler = (channel: string) =>
    calls.find((c) => c.path === "ipcMain.handle" && c.args[0] === channel)?.args[1] as
      | ((...args: unknown[]) => { error: string | null; total: number })
      | undefined;
  const list = handler("sessions:list");
  const transcript = handler("sessions:getTranscript");
  assert.ok(list && transcript, "index.ts registers sessions:list and sessions:getTranscript");
  assert.match(list({}, {}).error ?? "", /not open/);
  assert.match(transcript({}, "a".repeat(64), 0).error ?? "", /not open/);
  assert.equal(list({}, { ideType: "vim" }).error, "Unknown tool.");
  assert.match(list({}, { ideType: "codex", projectPath: null }).error ?? "", /not open/, "a No folder row's filter is valid");
  assert.equal(transcript({}, "-Users-jane-src::s1", 0).error, "The session key is not valid.");
});

test("the file viewer refuses a listed file inside a folder not granted", { skip: process.platform !== "darwin" }, async () => {
  const handler = calls.find((c) => c.path === "ipcMain.handle" && c.args[0] === "harness:readAsset")?.args[1] as
    | ((event: unknown, filePath: string) => Promise<{ content: string | null; error?: string }>)
    | undefined;
  assert.ok(handler, "index.ts registers harness:readAsset");
  // The stand-in's app.getPath answers userData for every name, so Documents is userData here,
  // never asked about; a folder outside it is readable.
  const outside = mkdtempSync(join(tmpdir(), "launch-test-outside-"));
  after(() => rmSync(outside, { recursive: true, force: true }));
  const inside = join(userData, "notes", "SKILL.md");
  const readable = join(outside, "SKILL.md");
  mkdirSync(join(userData, "notes"));
  for (const f of [inside, readable]) writeFileSync(f, "a skill\n");
  // The readable file is outside HOME, so it is listed as a scanned repo's, as a real scan lists it.
  const asset = (filePath: string, projectPath = "") => ({ filePath, projectPath, payload: {} });
  writeFileSync(
    join(userData, "harness-inventory.json"),
    JSON.stringify({ scannedAt: "2026-01-01T00:00:00.000Z", result: { schemaVersion: 1, assets: [asset(inside), asset(readable, outside)], warnings: [], errors: [] } }),
  );
  assert.equal((await handler({}, readable)).content, "a skill\n");
  const refused = await handler({}, inside);
  assert.equal(refused.content, null);
  assert.ok(refused.error);
});

test("the file viewer refuses a listed file reached through a link into a folder not granted", { skip: process.platform !== "darwin" }, async () => {
  const handler = calls.find((c) => c.path === "ipcMain.handle" && c.args[0] === "harness:readAsset")?.args[1] as
    | ((event: unknown, filePath: string) => Promise<{ content: string | null; error?: string }>)
    | undefined;
  assert.ok(handler, "index.ts registers harness:readAsset");
  // Documents is the stand-in's userData (see above); a skill folder outside it links into it.
  const home = mkdtempSync(join(tmpdir(), "launch-test-home-"));
  after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(userData, "linked-notes"));
  writeFileSync(join(userData, "linked-notes", "SKILL.md"), "private\n");
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  symlinkSync(join(userData, "linked-notes"), join(home, ".claude", "skills", "notes"));
  const viaLink = join(home, ".claude", "skills", "notes", "SKILL.md");
  writeFileSync(
    join(userData, "harness-inventory.json"),
    JSON.stringify({ scannedAt: "2026-01-01T00:00:00.000Z", result: { schemaVersion: 1, assets: [{ filePath: viaLink, payload: {} }], warnings: [], errors: [] } }),
  );
  const refused = await handler({}, viaLink);
  assert.equal(refused.content, null);
  assert.ok(refused.error);
});

// The folder-access request through the real handler: a probe of the stand-in's folders (all
// userData, so readable) reads as granted at once.
const sentChanged = () => calls.filter((c) => c.path.endsWith("webContents.send") && c.args[0] === "permissions:changed").length;
const notifications = () => calls.filter((c) => c.path === "new Notification").length;
const attentionTray = () => calls.filter((c) => c.path === "Tray#instance.setToolTip" && String(c.args[0]).includes("folder access needed")).length;
async function requestFolderAccess(): Promise<void> {
  const { PermissionStore } = await import("../permissions/permissionStore");
  rmSync(join(userData, "permission-grants.json"), { force: true });
  PermissionStore.__resetForTests();
  const request = calls.find((c) => c.path === "ipcMain.handle" && c.args[0] === "permissions:request")?.args[1] as () => Promise<void>;
  assert.ok(request, "index.ts registers permissions:request");
  await request();
}

test("a window focus while the folders are being asked for neither notifies nor flags the menu bar icon", { skip: process.platform !== "darwin" }, async () => {
  const { PermissionStore } = await import("../permissions/permissionStore");
  // Desktop was declined at an earlier launch; Documents and Downloads are asked for now.
  writeFileSync(join(userData, "permission-grants.json"), JSON.stringify({ asked: ["desktop"], version: "0.1.0" }));
  PermissionStore.__resetForTests();
  const request = calls.find((c) => c.path === "ipcMain.handle" && c.args[0] === "permissions:request")?.args[1] as () => Promise<void>;
  const focus = handlers.get("browser-window-focus");
  assert.ok(focus, "index.ts follows window focus");
  folderAnswer = "blocked"; // the prompts are open
  const asking = request();
  await new Promise((r) => setTimeout(r, 50));
  const [notifiedBefore, flaggedBefore] = [notifications(), attentionTray()];
  focus();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(notifications(), notifiedBefore, "no notification while a prompt may be open");
  assert.equal(attentionTray(), flaggedBefore, "the icon is not flagged while a prompt may be open");
  folderAnswer = "granted"; // the user allows; the next re-probe ends the request
  await asking;
});

test("a folder-access request tells the banner to re-read", { skip: process.platform !== "darwin" }, async () => {
  const before = sentChanged();
  await requestFolderAccess();
  assert.ok(sentChanged() > before, "permissions:changed sent");
});

test("a quit whose closing fails still lets the app quit", async () => {
  const beforeQuit = handlers.get("before-quit");
  assert.ok(beforeQuit, "index.ts registers before-quit");
  let held = false;
  beforeQuit({ preventDefault: () => (held = true) });
  assert.ok(held, "the first quit waits for reading to close");
  await new Promise((r) => setImmediate(r));
  assert.ok(calls.some((c) => c.path === "app.quit"), "then quits anyway");
});

test("once quitting, a folder-access request sends, rescans and notifies nothing", { skip: process.platform !== "darwin" }, async () => {
  const { StackDetector } = await import("../stack/stackDetector");
  const rescan = mock.method(StackDetector.getInstance(), "rescan", async () => []);
  try {
    const [sent, notified] = [sentChanged(), notifications()];
    await requestFolderAccess();
    assert.equal(sentChanged(), sent, "nothing sent after before-quit");
    assert.equal(rescan.mock.callCount(), 0, "no rescan");
    assert.equal(notifications(), notified, "no notification");
  } finally {
    rescan.mock.restore();
  }
});

test("once quitting, a window focus re-probes nothing", { skip: process.platform !== "darwin" }, async () => {
  const { PermissionStore } = await import("../permissions/permissionStore");
  writeFileSync(join(userData, "permission-grants.json"), JSON.stringify({ asked: ["desktop"], version: "0.1.0" }));
  PermissionStore.__resetForTests(); // an asked folder a focus would probe
  const before = folderProbes;
  handlers.get("browser-window-focus")!();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(folderProbes, before);
});

test("a click on the menu bar icon opens its menu: Show first, Quit last", () => {
  const click = calls.find((c) => c.path === "Tray#instance.on" && c.args[0] === "click")?.args[1] as (() => void) | undefined;
  assert.ok(click, "the icon handles a click");
  const before = calls.filter((c) => c.path === "Tray#instance.popUpContextMenu").length;
  click();
  assert.equal(calls.filter((c) => c.path === "Tray#instance.popUpContextMenu").length, before + 1, "the click pops the menu up");
  const template = [...calls].reverse().find((c) => c.path === "Menu.buildFromTemplate")?.args[0] as { label?: string; type?: string }[];
  const items = template.filter((i) => i.type !== "separator" && i.label !== undefined);
  assert.equal(items[0]?.label, "Show Agent Desk");
  assert.equal(items.at(-1)?.label, "Quit Agent Desk");
});

test("the application menu quits with Cmd+Q and closes the window with Cmd+W", () => {
  type Item = { role?: string; submenu?: Item[] };
  const menus = calls.filter((c) => c.path === "Menu.buildFromTemplate").map((c) => c.args[0] as Item[]);
  const roles = (items: Item[]): string[] => items.flatMap((i) => [i.role ?? "", ...roles(i.submenu ?? [])]);
  const appMenu = menus.find((m) => roles(m).includes("quit"));
  assert.ok(appMenu, "an application menu with a quit role");
  for (const role of ["quit", "close", "copy", "paste"]) assert.ok(roles(appMenu).includes(role), role);
  assert.deepEqual(
    roles(appMenu).filter(Boolean),
    ["about", "hide", "hideOthers", "unhide", "quit", "undo", "redo", "cut", "copy", "paste", "selectAll", "minimize", "zoom", "close", "front"],
    "the packaged menu's whole role set, View (dev only) left out",
  );
});

