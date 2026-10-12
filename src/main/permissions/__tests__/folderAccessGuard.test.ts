// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeUngrantedRoots } from "../folderAccessGuard";
import type { ProbeResult } from "../folderAccess";
import type { ProtectedFolderKey } from "../../../shared/permissionTypes";

const KEYS: ProtectedFolderKey[] = ["desktop", "documents", "downloads"];
const path = (k: ProtectedFolderKey): string => `/Users/jane/${k}`;

describe("computeUngrantedRoots", () => {
  it("lists folders not yet asked and folders the user denied, and probes only asked ones", async () => {
    const probed: ProtectedFolderKey[] = [];
    const answers: Partial<Record<ProtectedFolderKey, ProbeResult>> = { desktop: "granted", documents: "blocked" };
    const roots = await computeUngrantedRoots(
      KEYS,
      (k) => k !== "downloads",
      async (k) => {
        probed.push(k);
        return answers[k] ?? "granted";
      },
      path,
    );
    assert.deepEqual(roots, ["/Users/jane/documents", "/Users/jane/downloads"]);
    assert.deepEqual(probed, ["desktop", "documents"], "an un-asked folder is never probed (that would prompt)");
  });

  it("treats a failed or indeterminate probe of an asked folder as readable", async () => {
    const roots = await computeUngrantedRoots(
      KEYS,
      () => true,
      async (k) => {
        if (k === "desktop") throw new Error("io");
        return "indeterminate";
      },
      path,
    );
    assert.deepEqual(roots, []);
  });

  it("skips a folder whose location cannot be resolved", async () => {
    const roots = await computeUngrantedRoots(
      KEYS,
      () => false,
      async () => "granted",
      (k) => {
        if (k === "desktop") throw new Error("unavailable");
        return path(k);
      },
    );
    assert.deepEqual(roots, ["/Users/jane/documents", "/Users/jane/downloads"]);
  });
});
