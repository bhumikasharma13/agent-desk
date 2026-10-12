// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../../store/SessionStore";
import { extractAntigravity } from "../../internal";
import { DatabaseSync } from "node:sqlite";
import { setPathOverrides } from "../pathResolver";
import { encodeSummaryInner, encodeTrajectorySummariesValue } from "./antigravityFixture";

// ESM-compatible __dirname
const __dirname = dirname(fileURLToPath(import.meta.url));

const fixtureDb = join(__dirname, "../../../fixtures/extraction", "antigravity", "state.vscdb");

// ── Fixture mode ─────────────────────────────────────────────────────────────

describe("antigravityExtractor — fixture", () => {
  let tmpDir: string;
  let db: SessionStore;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-ag-smoke-"));
    db = new SessionStore(join(tmpDir, "test.db"));
    setPathOverrides({ ANTIGRAVITY_DB_PATH: fixtureDb });
  });

  after(() => {
    setPathOverrides({ ANTIGRAVITY_DB_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("happy path: does not throw and returns a number", async () => {
    // Antigravity reads base64-encoded protobuf from ItemTable — constructing a valid
    // protobuf blob in a fixture is impractical, so this test verifies crash-safety only.
    const count = await extractAntigravity(db);
    assert.ok(typeof count === "number", "count must be a number");
    assert.ok(count >= 0, "count must be non-negative");
  });

  it("does not throw on missing db path", async () => {
    setPathOverrides({ ANTIGRAVITY_DB_PATH: "/tmp/does-not-exist-ag.vscdb" });
    const emptyDb = new SessionStore(join(tmpDir, "empty.db"));
    const count = await extractAntigravity(emptyDb);
    assert.equal(count, 0, "should return 0 when DB not found");
  });
});

// ── Offline path — session_title from a real protobuf fixture ─────────────────

describe("antigravityExtractor — offline session_title", () => {
  let tmpDir: string;
  let db: SessionStore;
  let builtFixtureDb: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-ag-title-"));
    builtFixtureDb = join(tmpDir, "state_built.vscdb");

    const nowSecs = Math.floor(Date.now() / 1000);
    const inner = encodeSummaryInner({
      title: "Fix auth bug",
      stepCount: 3,
      updatedAtSecs: nowSecs,
      createdAtSecs: nowSecs - 60,
      workspaceUri: "file:///Users/dev/repo",
    });
    const value = encodeTrajectorySummariesValue([{ id: "traj-001", inner }]);

    const raw = new DatabaseSync(builtFixtureDb);
    raw.exec(`CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)`);
    raw
      .prepare(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`)
      .run("antigravityUnifiedStateSync.trajectorySummaries", value);
    raw.close();

    db = new SessionStore(join(tmpDir, "test.db"));
    setPathOverrides({ ANTIGRAVITY_DB_PATH: builtFixtureDb });
  });

  after(() => {
    setPathOverrides({ ANTIGRAVITY_DB_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("extracts session_title from the offline protobuf summary's title field", async () => {
    const count = await extractAntigravity(db);
    assert.equal(count, 1, "expected exactly one extracted trajectory");
    const rows = db.getPendingConversations(100);
    assert.equal(rows.length, 1, "expected one pending conversation");
    assert.ok(rows[0]!.session_meta, "session_meta must be populated");
    const meta = JSON.parse(rows[0]!.session_meta!) as { session_title?: string };
    assert.equal(meta.session_title, "Fix auth bug", "session_title must match the summary title");
  });
});

