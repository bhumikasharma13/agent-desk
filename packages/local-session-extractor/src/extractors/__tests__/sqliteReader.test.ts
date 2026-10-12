// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SQLiteReader, openVendorDb } from "../sqliteReader";

describe("openVendorDb", () => {
  let dir = "";
  let path = "";

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "sqlite-reader-"));
    path = join(dir, "vendor.vscdb");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE ItemTable (key TEXT, value BLOB, n INTEGER)");
    db.prepare("INSERT INTO ItemTable VALUES (?, ?, ?)").run("blob", Buffer.from("hello", "utf8"), 7);
    db.prepare("INSERT INTO ItemTable VALUES (?, ?, ?)").run("big", "x", 9007199254740993n);
    db.close();
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it("returns BLOBs as Buffers and rows as plain objects", () => {
    const db = openVendorDb(path, 3000);
    try {
      const row = db.prepare("SELECT value, n FROM ItemTable WHERE key = ?").get("blob");
      assert.ok(row);
      assert.equal(Object.getPrototypeOf(row), Object.prototype);
      assert.ok(Buffer.isBuffer(row["value"]));
      assert.equal((row["value"] as Buffer).toString("utf8"), "hello");
      assert.equal(row["n"], 7);
    } finally {
      db.close();
    }
  });

  it("degrades an integer beyond 2^53 to the nearest number instead of throwing", () => {
    const db = openVendorDb(path, 3000);
    try {
      const rows = db.prepare("SELECT n FROM ItemTable WHERE key = 'big'").all();
      assert.equal(typeof rows[0]?.["n"], "number");
      assert.equal(rows[0]?.["n"], Number(9007199254740993n));
    } finally {
      db.close();
    }
  });

  it("applies the timeout as the busy timeout", () => {
    const db = openVendorDb(path, 1234);
    try {
      assert.equal(db.prepare("PRAGMA busy_timeout").get()?.["timeout"], 1234);
    } finally {
      db.close();
    }
  });

  it("throws on a missing file instead of creating one", () => {
    assert.throws(() => openVendorDb(join(dir, "absent.vscdb"), 3000));
  });

  it("backs SQLiteReader, which takes untyped parameters", () => {
    const reader = new SQLiteReader(path);
    reader.open();
    try {
      const row = reader.queryOne<{ value: Buffer }>("SELECT value FROM ItemTable WHERE key = ?", ["blob"]);
      assert.ok(row && Buffer.isBuffer(row.value));
    } finally {
      reader.close();
    }
  });
});
