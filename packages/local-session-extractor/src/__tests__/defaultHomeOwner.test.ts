// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A scan with no home root still records the owner of the home it read, so an
 * export run later by another account hashes that name in session ids.
 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readAll } from "../scan";
import { homeOwnerName } from "../redaction/anonymizer";
import { readHomeOwners } from "../store/homeOwners";
import { SessionStore } from "../store/SessionStore";

it("records the default home's owner on a scan with no home root", async () => {
  const owner = homeOwnerName(homedir());
  if (owner === undefined) return; // the home is not under Users/ or home/
  const tmp = mkdtempSync(join(tmpdir(), "local-session-extractor-owner-"));
  const store = new SessionStore(join(tmp, "sessions.db"));
  try {
    // Only Codex runs, and both its roots point at an empty directory: nothing real is read.
    await readAll(store, { sources: ["codex"], paths: { CODEX_HOME: tmp, CODEX_SQLITE_HOME: tmp } });
    assert.ok(readHomeOwners(store).includes(owner), "the running user's name is recorded");
  } finally {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
