// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * `exportSessions` beyond the golden: it redacts on the way out, replaces the
 * file whole at mode 0600, refuses a symlink, leaves the old file on failure,
 * writes a stream directly and leaves it open, and reads one snapshot of the
 * store, inside a caller's own transaction when there is one.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { exportSessions, writeExport, writeExportToStream } from "../export";
import { setRunningUsernameForTests } from "../redaction/anonymizer";
import { SCANNED_HOME_OWNERS_KEY } from "../store/homeOwners";
import { SessionStore } from "../store/SessionStore";
import type { UpsertParams } from "../types/store";

let tmp: string;
before(() => (tmp = mkdtempSync(join(tmpdir(), "local-session-extractor-export-"))));
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

function row(sessionId: string, over: Partial<UpsertParams> = {}): UpsertParams {
  return {
    ideType: "claude-code",
    sessionId,
    conversation: [{ role: "user", content: `hello from ${sessionId}`, timestamp: "2026-01-01T00:00:00.000Z" }],
    lastMtimeMs: 1,
    lastSize: 2,
    lastOffset: 3,
    ...over,
  } as UpsertParams;
}

/** A store at `name` holding sessions `s-0` … `s-<n-1>`, `s-0` the most recently updated. */
function storeWith(name: string, n: number): SessionStore {
  const store = new SessionStore(join(tmp, `${name}.db`));
  for (let i = 0; i < n; i++) {
    store.upsert(row(`s-${i}`));
    store.raw().prepare("UPDATE conversations SET updated_at = ? WHERE session_id = ?").run(`2026-01-0${9 - i} 00:00:00`, `s-${i}`);
  }
  return store;
}

const exportedIds = (out: string): string[] =>
  readFileSync(out, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => (JSON.parse(l) as { session_id: string }).session_id);

describe("exportSessions", () => {
  it("anonymizes project_path again, for a row stored unredacted", async () => {
    const user = userInfo().username;
    const store = new SessionStore(join(tmp, "project-path.db"));
    store.upsert(row("pp", { projectPath: `/Users/${user}/src/app` } as Partial<UpsertParams>));
    store.raw().prepare("UPDATE conversations SET project_path = ? WHERE session_id = ?").run(`/Users/${user}/src/app`, "pp");
    const out = join(tmp, "project-path.jsonl");
    await exportSessions(store, { format: "jsonl", shape: "row", out });
    assert.ok(!readFileSync(out, "utf8").includes(`/Users/${user}/`), "the home segment must not survive in project_path");
    store.close();
  });

  it("redacts the remaining free-text columns fully, and keeps installation_metadata as stored", async () => {
    const restore = setRunningUsernameForTests("janedoe");
    const store = new SessionStore(join(tmp, "columns.db"));
    try {
      store.upsert(row("cols"));
      const secret = "AKIAABCDEFGHIJKLMNOP"; // fake credential, test fixture. gitleaks:allow
      const planted = `janedoe edited /Users/janedoe/app with ${secret}`;
      const installation = JSON.stringify({ login_email: "janedoe@example.com", note: planted });
      store
        .raw()
        .prepare("UPDATE conversations SET session_facets = ?, stats_cache = ?, ai_attribution = ?, installation_metadata = ? WHERE session_id = ?")
        .run(
          JSON.stringify({ summary: planted, nested: [{ goal: planted }] }),
          JSON.stringify({ model_usage: { "claude-x": { input_tokens: 1 } }, dirs: ["-Users-janedoe-app"], note: planted }),
          JSON.stringify([{ file: "/Users/janedoe/app/a.ts", note: planted }]),
          installation,
          "cols",
        );
      const out = join(tmp, "columns.jsonl");
      await exportSessions(store, { format: "jsonl", shape: "row", out });
      const rec = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
      const facets = JSON.stringify(rec["session_facets"]);
      assert.ok(!/janedoe/i.test(facets) && !facets.includes(secret), facets);
      for (const column of ["stats_cache", "ai_attribution"]) {
        const text = JSON.stringify(rec[column]);
        assert.ok(!/janedoe/i.test(text), `${column}: ${text}`);
        assert.ok(!text.includes(secret), `${column}: ${text}`);
      }
      assert.deepEqual((rec["stats_cache"] as { model_usage: object }).model_usage, { "claude-x": { input_tokens: 1 } });
      assert.deepEqual(rec["installation_metadata"], JSON.parse(installation));
    } finally {
      store.close();
      restore();
    }
  });

  it("hashes the recorded scanned-home owners in session ids and text paths", async () => {
    const store = new SessionStore(join(tmp, "owners.db"));
    try {
      store.upsert(row("-Users-alice-proj::abc"));
      store.setMeta(SCANNED_HOME_OWNERS_KEY, JSON.stringify(["alice"]));
      const out = join(tmp, "owners.jsonl");
      await exportSessions(store, { format: "jsonl", shape: "row", out, includeSyncState: true });
      const text = readFileSync(out, "utf8");
      assert.ok(!text.includes("alice"), text);
    } finally {
      store.close();
    }
  });

  it("redacts session event summaries again, for events stored unredacted", async () => {
    const user = "janedoe";
    const restore = setRunningUsernameForTests(user);
    const store = new SessionStore(join(tmp, "events.db"));
    try {
      store.upsert(row("ev"));
      const events = JSON.stringify([{ kind: "tool_call", redacted_summary: `ps aux\\n${user} 36636 node /Users/${user}/x` }]);
      store.raw().prepare("UPDATE conversations SET session_events = ? WHERE session_id = ?").run(events, "ev");
      const out = join(tmp, "events.jsonl");
      await exportSessions(store, { format: "jsonl", shape: "row", out });
      const text = readFileSync(out, "utf8");
      assert.ok(!text.includes(user), `the username must not survive in an exported summary: ${text}`);
    } finally {
      store.close();
      restore();
    }
  });

  it("redacts session_meta and the conversation again, for a row stored unredacted", async () => {
    const user = userInfo().username;
    const home = `/Users/${user}`;
    const secret = "AKIAABCDEFGHIJKLMNOP"; // fake credential, test fixture. gitleaks:allow
    const store = new SessionStore(join(tmp, "resanitize.db"));
    store.upsert(
      row("raw", {
        conversation: [{ role: "user", content: `deploy with ${secret} from ${home}/src/app`, timestamp: "2026-01-01T00:00:00.000Z" }],
        sessionMeta: JSON.stringify({ project_path: `${home}/src/app`, first_prompt: `key ${secret}` }),
      }),
    );
    const out = join(tmp, "resanitize.jsonl");
    await exportSessions(store, { format: "jsonl", shape: "row", out });
    const text = readFileSync(out, "utf8");
    assert.ok(!text.includes(secret), text);
    assert.ok(!text.includes(`${home}/`), text);
    store.close();
  });

  it("redacts the encoded project dir in a Claude Code session_id, and keeps the stored id", async () => {
    const user = userInfo().username;
    const sessionId = `-Users-${user}-src-app::87a61969-4a8b-4dca-8f01-33a50e532c65`;
    const store = new SessionStore(join(tmp, "session-id.db"));
    store.upsert(row(sessionId));
    const out = join(tmp, "session-id.jsonl");
    await exportSessions(store, { format: "jsonl", shape: "row", out });
    const [exported] = exportedIds(out);
    assert.ok(!exported!.includes(`-${user}-`), exported);
    assert.ok(exported!.endsWith("-src-app::87a61969-4a8b-4dca-8f01-33a50e532c65"), exported);
    const stored = store.raw().prepare("SELECT session_id FROM conversations").get() as { session_id: string };
    assert.equal(stored.session_id, sessionId);
    store.close();
  });

  it("replaces an existing 0644 file with one at 0600", async () => {
    const store = storeWith("mode", 2);
    const out = join(tmp, "mode.jsonl");
    writeFileSync(out, "old\n");
    chmodSync(out, 0o644);
    await exportSessions(store, { format: "jsonl", shape: "row", out });
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.deepEqual(exportedIds(out), ["s-0", "s-1"]);
    store.close();
  });

  it("refuses a symlink and leaves its target alone", async () => {
    const store = storeWith("symlink", 1);
    const target = join(tmp, "symlink-target.txt");
    writeFileSync(target, "target\n");
    const out = join(tmp, "symlink.jsonl");
    symlinkSync(target, out);
    await assert.rejects(exportSessions(store, { format: "jsonl", shape: "row", out }), /symlink/);
    assert.ok(lstatSync(out).isSymbolicLink());
    assert.equal(readFileSync(target, "utf8"), "target\n");
    store.close();
  });

  it("leaves an existing file intact and no temp file behind when the export fails", () => {
    const store = storeWith("failure", 3);
    const dir = mkdtempSync(join(tmp, "failure-"));
    const out = join(dir, "failure.jsonl");
    writeFileSync(out, "old\n");
    assert.throws(
      () =>
        writeExport(store, { format: "jsonl", shape: "row", out }, {
          pageSize: 1,
          afterPage: () => {
            throw new Error("disk full");
          },
        }),
      /disk full/,
    );
    assert.equal(readFileSync(out, "utf8"), "old\n");
    assert.deepEqual(readdirSync(dir), ["failure.jsonl"]);
    store.close();
  });

  it("reads one snapshot: an update from another connection between pages neither drops nor duplicates a row", () => {
    const store = storeWith("snapshot", 3);
    const writer = new SessionStore(join(tmp, "snapshot.db"));
    const out = join(tmp, "snapshot.jsonl");
    let pages = 0;
    const { written } = writeExport(store, { format: "jsonl", shape: "row", out }, {
      pageSize: 1,
      afterPage: () => {
        // Moves the last row, not yet exported, to the top of the export order.
        if (++pages === 1) writer.raw().prepare("UPDATE conversations SET updated_at = '2099-01-01 00:00:00' WHERE session_id = 's-2'").run();
      },
    });
    assert.equal(written, 3);
    assert.deepEqual(exportedIds(out).sort(), ["s-0", "s-1", "s-2"]);
    assert.equal(
      (store.raw().prepare("SELECT updated_at FROM conversations WHERE session_id = 's-2'").get() as { updated_at: string }).updated_at,
      "2099-01-01 00:00:00",
      "the update committed",
    );
    writer.close();
    store.close();
  });

  it("writes a stream the same rows as a file, and leaves the stream open", async () => {
    const store = storeWith("stream", 3);
    const out = join(tmp, "stream.jsonl");
    await exportSessions(store, { format: "jsonl", shape: "row", out });
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    const { written } = await exportSessions(store, { format: "jsonl", shape: "row", out: stream });
    assert.equal(written, 3);
    assert.equal(Buffer.concat(chunks).toString("utf8"), readFileSync(out, "utf8"));
    assert.equal(stream.writableEnded, false, "the caller ends the stream");
    stream.end();
    store.close();
  });

  it("reads inside a transaction the caller already holds, and leaves it open", async () => {
    const store = storeWith("caller-tx", 2);
    const db = store.raw();
    db.exec("BEGIN");
    const out = join(tmp, "caller-tx.jsonl");
    await exportSessions(store, { format: "jsonl", shape: "row", out });
    assert.deepEqual(exportedIds(out), ["s-0", "s-1"]);
    const stream = new PassThrough();
    stream.resume();
    await exportSessions(store, { format: "jsonl", shape: "row", out: stream });
    assert.equal(db.isTransaction, true, "the caller's transaction is still open");
    db.exec("COMMIT");
    store.close();
  });

  it("reports the export's own error when ending its read transaction also fails", async () => {
    const store = storeWith("commit-fails", 3);
    const db = store.raw();
    const failing = {
      pageSize: 1,
      afterPage: () => {
        // Ends the export's transaction, so its closing COMMIT fails too.
        db.exec("COMMIT");
        throw new Error("disk full");
      },
    };
    assert.throws(() => writeExport(store, { format: "jsonl", shape: "row", out: join(tmp, "commit-fails.jsonl") }, failing), /disk full/);
    const stream = new PassThrough();
    stream.resume();
    await assert.rejects(writeExportToStream(store, { format: "jsonl", shape: "row", out: stream }, failing), /disk full/);
    store.close();
  });

  it("leaves the store usable while a slow stream drains", async () => {
    const store = storeWith("slow-stream", 3);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = new Writable({
      write(_chunk, _enc, done) {
        void gate.then(() => done());
      },
    });
    const exporting = exportSessions(store, { format: "jsonl", shape: "row", out: slow });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.raw().isTransaction, false, "no read transaction is held while the stream drains");
    store.upsert(row("written-during-export"));
    release();
    assert.deepEqual(await exporting, { written: 3 });
    store.close();
  });

  it("rejects, rather than throwing uncaught, when the stream emits an error", async () => {
    const store = storeWith("broken-pipe", 2);
    const broken = new Writable({
      write(_chunk, _enc, done) {
        done(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      },
    });
    await assert.rejects(exportSessions(store, { format: "jsonl", shape: "row", out: broken }), /EPIPE/);
    store.close();
  });
});
