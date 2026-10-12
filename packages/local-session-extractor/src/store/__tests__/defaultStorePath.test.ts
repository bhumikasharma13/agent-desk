// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * With no path, the store lives at `~/.local-session-extractor/sessions.db`,
 * and opening it there creates the directory at mode 0700 and the file at 0600.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultStorePath, openStore } from "../SessionStore";

describe("defaultStorePath", () => {
  it("is ~/.local-session-extractor/sessions.db", () => {
    assert.equal(defaultStorePath(), join(homedir(), ".local-session-extractor", "sessions.db"));
  });

  it("is where openStore() writes, private to the user", () => {
    // HOME is the test-wide temp home (test-setup.mjs), so nothing real is touched.
    const store = openStore();
    try {
      assert.equal(store.path, defaultStorePath());
      assert.equal(statSync(dirname(store.path)).mode & 0o777, 0o700);
      assert.equal(statSync(store.path).mode & 0o777, 0o600);
    } finally {
      store.close();
    }
  });
});
