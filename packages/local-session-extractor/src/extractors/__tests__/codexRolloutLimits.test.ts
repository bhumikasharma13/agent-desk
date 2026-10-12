// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A Codex rollout the scan will not read whole is reported as an unreadable
 * session, never dropped without a word: one past the 128 MB transcript limit,
 * one that decompresses past it, and one that is not a regular file. A FIFO at
 * the rollout path is reported at once rather than blocking the scan.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { openStore, readAll, type ScanResult } from "../../index";

const LIMIT = 128 * 1024 * 1024;
const UUID = "88888888-8888-4888-8888-888888888888";
const ROLLOUT = `rollout-2026-01-01T00-00-00-${UUID}.jsonl`;
const FIXTURES = resolve(import.meta.dirname, "..", "..", "..", "fixtures", "extraction", "codex");

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "lse-codex-limits-")));
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

/** A home whose Codex sessions folder holds `name` under one day, and that file's path. */
function homeWithRollout(dir: string, name: string): { home: string; file: string } {
  const home = join(tmp, dir);
  const day = join(home, ".codex", "sessions", "2026", "01", "01");
  mkdirSync(day, { recursive: true });
  return { home, file: join(day, name) };
}

async function scan(home: string): Promise<ScanResult> {
  const store = openStore(join(home, "store.db"));
  try {
    return await readAll(store, { home, sources: ["codex"] });
  } finally {
    store.close();
  }
}

/**
 * Scans with a FIFO at `fifo`, and a writer that opens it after 5 s, so a scan
 * that blocks on it finishes late instead of never. Returns the result and how long it took.
 */
async function scanBesideFifo(home: string, fifo: string): Promise<{ result: ScanResult; ms: number }> {
  execFileSync("mkfifo", [fifo]);
  const writer = spawn("sh", ["-c", `sleep 5; : > "${fifo}"`], { stdio: "ignore" });
  const t0 = Date.now();
  try {
    const result = await scan(home);
    return { result, ms: Date.now() - t0 };
  } finally {
    writer.kill();
  }
}

function sessionErrors(result: ScanResult): { sessionId: string | null; file: string | null; message: string }[] {
  return result.errors.filter((e) => e.scope === "session").map(({ sessionId, file, message }) => ({ sessionId, file, message }));
}

describe("codexExtractor — a rollout it will not read whole", () => {
  it("reports a rollout past the 128 MB limit, without reading it", async () => {
    const { home, file } = homeWithRollout("oversized", ROLLOUT);
    writeFileSync(file, "");
    truncateSync(file, LIMIT + 1);
    const result = await scan(home);
    assert.equal(result.counts.codex, 0);
    assert.deepEqual(sessionErrors(result), [
      { sessionId: UUID, file, message: `the rollout is ${LIMIT + 1} bytes, over the ${LIMIT}-byte limit` },
    ]);
  });

  it("reports an archived rollout that decompresses past the 128 MB limit", async () => {
    const { home, file } = homeWithRollout("oversized-zst", `${ROLLOUT}.zst`);
    writeFileSync(file, zstdCompressSync(Buffer.alloc(LIMIT + 1, "x")));
    const result = await scan(home);
    assert.equal(result.counts.codex, 0);
    assert.deepEqual(sessionErrors(result), [
      { sessionId: UUID, file, message: `the rollout decompresses to over the ${LIMIT}-byte limit` },
    ]);
  });

  it("reports a FIFO in the sessions folder at once, without blocking on it", async () => {
    const { home, file } = homeWithRollout("fifo-dir", ROLLOUT);
    const { result, ms } = await scanBesideFifo(home, file);
    assert.ok(ms < 4000, `the scan waited ${ms} ms on the FIFO`);
    assert.deepEqual(sessionErrors(result), [{ sessionId: UUID, file, message: "the rollout is not a regular file" }]);
  });

  it("reports a FIFO named as a thread's rollout_path at once, without blocking on it", async () => {
    const home = join(tmp, "fifo-sqlite");
    const codexHome = join(home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const fifo = join(tmp, "fifo-sqlite-rollout.jsonl");
    const sqlite = join(codexHome, "state_5.sqlite");
    copyFileSync(join(FIXTURES, "state_5.sqlite"), sqlite);
    const db = new DatabaseSync(sqlite);
    db.prepare("UPDATE threads SET rollout_path = ? WHERE id = ?").run(fifo, "thread-fixture-001");
    db.close();
    const { result, ms } = await scanBesideFifo(home, fifo);
    assert.ok(ms < 4000, `the scan waited ${ms} ms on the FIFO`);
    assert.deepEqual(sessionErrors(result), [{ sessionId: "thread-fixture-001", file: fifo, message: "the rollout is not a regular file" }]);
  });
});
