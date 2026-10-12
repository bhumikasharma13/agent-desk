// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "permission-store-"));
after(() => rmSync(dir, { recursive: true, force: true }));
mock.module("electron", { namedExports: { app: { getPath: () => dir, getVersion: () => "0.2.0" } } });
const { PermissionStore } = await import("../permissionStore");
const file = join(dir, "permission-grants.json");

test("a record written by another version is forgotten at launch, so the primer explains again", () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ asked: ["desktop", "documents"], version: "0.1.0" }));
  PermissionStore.__resetForTests();
  const store = PermissionStore.getInstance();
  assert.equal(store.isAsked("desktop"), false);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { asked: [], version: "0.2.0" });
});

test("a record with no version (written before versions were kept) is forgotten too", () => {
  writeFileSync(file, JSON.stringify({ asked: ["downloads"] }));
  PermissionStore.__resetForTests();
  assert.equal(PermissionStore.getInstance().isAsked("downloads"), false);
});

test("a record from this version is kept", () => {
  writeFileSync(file, JSON.stringify({ asked: ["desktop"], version: "0.2.0" }));
  PermissionStore.__resetForTests();
  const store = PermissionStore.getInstance();
  assert.equal(store.isAsked("desktop"), true);
  store.markAsked("downloads");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { asked: ["desktop", "downloads"], version: "0.2.0" });
});

test("a corrupt record is cleared and rewritten", () => {
  writeFileSync(file, "{not json");
  PermissionStore.__resetForTests();
  assert.equal(PermissionStore.getInstance().isAsked("desktop"), false);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { asked: [], version: "0.2.0" });
});

test("a record from a newer version (a downgrade) is cleared and rewritten", () => {
  writeFileSync(file, JSON.stringify({ asked: ["desktop"], version: "0.3.0" }));
  PermissionStore.__resetForTests();
  assert.equal(PermissionStore.getInstance().isAsked("desktop"), false);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { asked: [], version: "0.2.0" });
});
