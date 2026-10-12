// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The README's network promise: a scan with a home root starts no `ps` and
 * makes no request at all; a default scan runs `ps` once and sends requests
 * only to a local Antigravity server on 127.0.0.1.
 *
 * `ps`, `https`, `http` and `fetch` are stubbed in this process before the
 * scanner loads, so nothing real is listed or contacted.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import https from "node:https";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const FAKE_PS =
  "4242 /Applications/Antigravity.app/Contents/Resources/bin/language_server_macos antigravity --csrf_token tok --extension_server_port 40000 --workspace_id w1\n";

const commands: string[] = [];
const requests: string[] = [];

const stubExec = (() => undefined) as unknown as typeof childProcess.exec;
(stubExec as unknown as Record<symbol, unknown>)[promisify.custom] = async (command: string) => {
  commands.push(command);
  if (/^\s*ps\b/.test(command)) return { stdout: FAKE_PS, stderr: "" };
  throw new Error(`unexpected command in test: ${command}`);
};
childProcess.exec = stubExec;

function stubRequest(scheme: string) {
  return ((options: { hostname?: string; host?: string; port?: number; path?: string }, onResponse?: (res: unknown) => void) => {
    requests.push(`${scheme}://${options.hostname ?? options.host}:${options.port}${options.path}`);
    const req = new EventEmitter() as EventEmitter & { write(): void; end(): void; destroy(): void; setTimeout(): void };
    req.write = () => undefined;
    req.destroy = () => undefined;
    req.setTimeout = () => undefined;
    req.end = () => {
      const res = Object.assign(new EventEmitter(), { statusCode: 500, resume: () => undefined });
      setImmediate(() => {
        onResponse?.(res);
        res.emit("end");
      });
    };
    return req;
  }) as unknown;
}
https.request = stubRequest("https") as typeof https.request;
http.request = stubRequest("http") as typeof http.request;
globalThis.fetch = (async (input: unknown) => {
  requests.push(`fetch ${String(input)}`);
  throw new Error("no network in tests");
}) as typeof fetch;
syncBuiltinESMExports();

const { openStore } = await import("../store/SessionStore");
const { readAll } = await import("../scan");

const tmp = mkdtempSync(join(tmpdir(), "lse-network-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("what a scan starts and contacts", { skip: process.platform !== "darwin" }, () => {
  it("with a home root, runs no ps and makes no request, over every source", async () => {
    commands.length = 0;
    requests.length = 0;
    const home = mkdtempSync(join(tmp, "home-"));
    const store = openStore(join(tmp, "with-home.db"));
    try {
      await readAll(store, { home });
    } finally {
      store.close();
    }
    assert.deepEqual(commands, []);
    assert.deepEqual(requests, []);
  });

  it("without one, runs ps once and sends requests only to 127.0.0.1", async () => {
    commands.length = 0;
    requests.length = 0;
    const store = openStore(join(tmp, "default.db"));
    try {
      await readAll(store);
    } finally {
      store.close();
    }
    assert.deepEqual(commands.map((c) => c.trim().split(/\s+/)[0]), ["ps"]);
    assert.ok(requests.length > 0, "the local Antigravity server was probed");
    for (const r of requests) assert.match(r, /^https:\/\/127\.0\.0\.1:\d+\//);
  });
});
