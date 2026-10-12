// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * When a local Antigravity server answers the discovery probe but every data
 * call fails, the scan still reads the offline store: only a server that was
 * actually read replaces the offline fallback.
 *
 * `ps` and the loopback server are stubbed in this process before the extractor
 * loads, so nothing real is scanned or contacted.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const FAKE_PS =
  "4242 /Applications/Antigravity.app/Contents/Resources/bin/language_server_macos antigravity --csrf_token tok --extension_server_port 40000 --workspace_id w1\n";

const stubExec = (() => undefined) as unknown as typeof childProcess.exec;
(stubExec as unknown as Record<symbol, unknown>)[promisify.custom] = async (command: string) => {
  if (/^\s*ps\b/.test(command)) return { stdout: FAKE_PS, stderr: "" };
  throw new Error(`unexpected command in test: ${command}`);
};
childProcess.exec = stubExec;
const paths: string[] = [];
https.request = ((options: { path: string }, onResponse: (res: EventEmitter & { statusCode: number; resume(): void }) => void) => {
  paths.push(options.path);
  const req = new EventEmitter() as EventEmitter & { write(): void; end(): void; destroy(): void };
  req.write = () => undefined;
  req.destroy = () => undefined;
  req.end = () => {
    const res = Object.assign(new EventEmitter(), { statusCode: options.path.endsWith("/GetUnleashData") ? 200 : 500, resume: () => undefined });
    setImmediate(() => {
      onResponse(res);
      res.emit("end");
    });
  };
  return req;
}) as unknown as typeof https.request;
syncBuiltinESMExports();

const { openStore } = await import("../../store/SessionStore");
const { readAll } = await import("../../scan");

function writeVarint(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0);
  return Buffer.from(bytes);
}
const lenField = (field: number, payload: Buffer): Buffer => Buffer.concat([writeVarint((field << 3) | 2), writeVarint(payload.length), payload]);
const strField = (field: number, value: string): Buffer => lenField(field, Buffer.from(value, "utf8"));

const tmp = mkdtempSync(join(tmpdir(), "lse-ag-fallback-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

describe("antigravityExtractor — a discovered server whose data calls fail", { skip: process.platform !== "darwin" }, () => {
  it("falls back to the offline store", async () => {
    // The offline store at the default location under the test's temp home.
    const dir = join(homedir(), "Library", "Application Support", "Antigravity", "User", "globalStorage");
    mkdirSync(dir, { recursive: true });
    const inner = strField(1, "Offline title");
    const entry = Buffer.concat([strField(1, "traj-offline"), lenField(2, strField(1, inner.toString("base64")))]);
    const raw = new DatabaseSync(join(dir, "state.vscdb"));
    raw.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    raw.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run("antigravityUnifiedStateSync.trajectorySummaries", lenField(1, entry).toString("base64"));
    raw.close();

    const store = openStore(join(tmp, "sessions.db"));
    try {
      const result = await readAll(store, { sources: ["antigravity"] });
      assert.ok(paths.some((p) => p.endsWith("/GetAllCascadeTrajectories")), "the data call was attempted");
      assert.equal(result.counts.antigravity, 1, "the offline session is read");
    } finally {
      store.close();
    }
  });
});
