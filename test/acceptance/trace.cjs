// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// Preloaded into the app's main process by the acceptance test (Electron's -r) and from there
// into the extraction worker (NODE_OPTIONS). Records, as JSON lines in $AGENT_DESK_TRACE, every
// file the process reads, checks or writes through Node's fs, every outbound connection, and
// every command it starts. Native code (node:sqlite, Chromium) and the commands' own reads are
// not seen; the test says so.
//
// With $AGENT_DESK_PROTECTED_ROOT set, it also points the app's Desktop, Documents and Downloads
// at folders of that name inside it: Electron's app.getPath ignores the fixture HOME, and the
// test needs protected folders it owns.
//
// It also keeps the app's windows from taking any input from this Mac: no keyboard focus, no
// mouse, and off-screen, so nothing typed or clicked on this Mac during a run can reach the
// folder-access primer's Continue and grant the fixture's protected folders. Playwright's keys
// and clicks go through the DevTools protocol and still arrive. Every permissions:request is
// traced with its sender.

const fs = require("node:fs");
const path = require("node:path");

const out = process.env.AGENT_DESK_TRACE;
if (out) {
  // One descriptor opened before anything is patched, and a guard against re-entry: Node's own
  // fs functions call each other, and the trace must not trace itself.
  const fd = fs.openSync(out, "a");
  const writeSync = fs.writeSync;
  let busy = false;
  const record = (entry) => {
    if (busy) return;
    busy = true;
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, ...entry }) + "\n");
    } catch {
      // tracing must never break the app
    } finally {
      busy = false;
    }
  };
  // The launcher passes this file with -r, which child processes do not inherit; NODE_OPTIONS
  // carries it into the extraction worker, which Electron forks with this environment.
  process.env.NODE_OPTIONS = `--require ${__filename}`;
  const asPath = (p) => {
    if (typeof p === "string") return path.resolve(p);
    if (p instanceof URL) return p.pathname;
    if (Buffer.isBuffer(p)) return path.resolve(p.toString());
    return null; // a file descriptor
  };
  const wrap = (obj, name, kind, pick = (args) => args[0]) => {
    const orig = obj?.[name];
    if (typeof orig !== "function") return;
    obj[name] = function (...args) {
      const p = asPath(pick(args));
      if (p) record({ kind, op: name, path: p });
      return orig.apply(this, args);
    };
  };
  const isWriteFlag = (flags) => typeof flags === "string" && /[wa+]/.test(flags);
  const openKind = (args) => (isWriteFlag(args[1]) || (typeof args[1] === "number" && (args[1] & 3) !== 0) ? "write" : "read");

  for (const target of [fs, fs.promises]) {
    for (const n of ["readFile", "readFileSync", "readdir", "readdirSync", "opendir", "opendirSync", "readlink", "readlinkSync", "realpath", "realpathSync", "stat", "statSync", "lstat", "lstatSync", "access", "accessSync", "exists", "existsSync"]) wrap(target, n, "read");
    for (const n of ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "mkdir", "mkdirSync", "rm", "rmSync", "unlink", "unlinkSync", "rmdir", "rmdirSync", "rename", "renameSync", "copyFile", "copyFileSync", "cp", "cpSync", "chmod", "chmodSync", "utimes", "utimesSync"]) wrap(target, n, "write");
    for (const n of ["open", "openSync"]) {
      const orig = target[n];
      if (typeof orig !== "function") continue;
      target[n] = function (...args) {
        const p = asPath(args[0]);
        if (p) record({ kind: openKind(args), op: n, path: p });
        return orig.apply(this, args);
      };
    }
  }
  // A rename's destination is a write too.
  for (const target of [fs, fs.promises]) {
    for (const n of ["rename", "renameSync", "copyFile", "copyFileSync"]) wrap(target, n, "write", (args) => args[1]);
  }

  const net = require("node:net");
  const tls = require("node:tls");
  const host = (args) => {
    const a = args[0];
    if (typeof a === "object" && a !== null) return `${a.host ?? a.hostname ?? a.path ?? "?"}:${a.port ?? ""}`;
    return `${args[1] ?? "localhost"}:${a}`;
  };
  for (const [mod, names] of [[net, ["connect", "createConnection"]], [tls, ["connect"]]]) {
    for (const n of names) {
      const orig = mod[n];
      mod[n] = function (...args) {
        record({ kind: "net", op: n, host: host(args) });
        return orig.apply(this, args);
      };
    }
  }
  if (typeof globalThis.fetch === "function") {
    const origFetch = globalThis.fetch;
    globalThis.fetch = function (input, init) {
      record({ kind: "net", op: "fetch", host: String(input instanceof Request ? input.url : input) });
      return origFetch.call(this, input, init);
    };
  }

  const cp = require("node:child_process");
  const { promisify } = require("node:util");
  for (const n of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"]) {
    const orig = cp[n];
    const note = (args) => {
      const opts = args.find((a) => typeof a === "object" && a !== null && !Array.isArray(a));
      record({ kind: "exec", op: n, command: String(args[0]), args: Array.isArray(args[1]) ? args[1] : [], cwd: opts?.cwd ? String(opts.cwd) : null });
    };
    const wrapper = function (...args) {
      note(args);
      return orig.apply(this, args);
    };
    // exec and execFile promisify to { stdout, stderr } through a custom hook; keep it.
    const custom = orig[promisify.custom];
    if (custom) {
      wrapper[promisify.custom] = function (...args) {
        note(args);
        return custom.apply(this, args);
      };
    }
    cp[n] = wrapper;
  }
  record({ kind: "start", argv: process.argv.slice(0, 2), type: process.type ?? "node" });

  if (process.type === "browser") {
    const { app, ipcMain } = require("electron");
    // Only Playwright's protocol input reaches a test window: it takes no keyboard focus and
    // ignores the mouse, and it sits off-screen, so nothing typed or clicked on this Mac does.
    app.on("browser-window-created", (_event, win) => {
      win.setFocusable(false);
      win.setIgnoreMouseEvents(true);
      win.setPosition(-20000, -20000);
      win.on("show", () => win.setPosition(-20000, -20000));
    });
    // A folder-access request is recorded with the page that sent it, so a grant during a run
    // shows its source.
    const handle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, listener) =>
      handle(channel, channel !== "permissions:request" ? listener : (event, ...rest) => {
        record({ kind: "ipc", channel, sender: event.senderFrame?.url ?? null, stack: new Error().stack });
        return listener(event, ...rest);
      });
    const protectedRoot = process.env.AGENT_DESK_PROTECTED_ROOT;
    if (protectedRoot) {
      for (const name of ["Desktop", "Documents", "Downloads"]) app.setPath(name.toLowerCase(), path.join(protectedRoot, name));
    }
  }
}
