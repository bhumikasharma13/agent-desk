// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { followPermissionChange } from "../followPermissionChange";
import type { PermissionChange } from "../ipc";

test("each change rescans unless declined, notifies only when declined or changed, and always tells the banner", () => {
  const seen: Record<string, string[]> = {};
  for (const change of ["asked", "granted", "declined", "changed"] as PermissionChange[]) {
    const did: string[] = [];
    followPermissionChange(change, {
      rescan: () => did.push("rescan"),
      refreshTray: ({ notify }) => did.push(notify ? "tray, notify" : "tray"),
      send: (channel) => did.push(channel),
    });
    seen[change] = did;
  }
  assert.deepEqual(seen, {
    asked: ["rescan", "tray", "permissions:changed"],
    granted: ["rescan", "tray", "permissions:changed"],
    declined: ["tray, notify", "permissions:changed"],
    changed: ["rescan", "tray, notify", "permissions:changed"],
  });
});
