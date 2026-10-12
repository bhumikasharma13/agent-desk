// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeBlockedFolders } from "../permissionHealth";
import type { ProbeResult } from "../folderAccess";
import type { ProtectedFolderKey } from "../../../shared/permissionTypes";

const KEYS: ProtectedFolderKey[] = ["desktop", "documents", "downloads"];

const askedSet = (...keys: ProtectedFolderKey[]) => {
  const set = new Set(keys);
  return (k: ProtectedFolderKey) => set.has(k);
};

const probeMap =
  (map: Partial<Record<ProtectedFolderKey, ProbeResult>>) =>
  async (k: ProtectedFolderKey): Promise<ProbeResult> =>
    map[k] ?? "granted";

describe("computeBlockedFolders", () => {
  it("never probes an un-asked folder (would trigger a native prompt)", async () => {
    const probed: ProtectedFolderKey[] = [];
    const probe = async (k: ProtectedFolderKey): Promise<ProbeResult> => {
      probed.push(k);
      return "blocked";
    };
    const blocked = await computeBlockedFolders(KEYS, askedSet("desktop"), probe);
    assert.deepEqual(probed, ["desktop"]); // only the asked folder was probed
    assert.deepEqual(blocked, ["desktop"]);
  });

  it("returns only folders that probe as blocked", async () => {
    const blocked = await computeBlockedFolders(
      KEYS,
      askedSet("desktop", "documents", "downloads"),
      probeMap({ desktop: "granted", documents: "blocked", downloads: "blocked" }),
    );
    assert.deepEqual(blocked.sort(), ["documents", "downloads"]);
  });

  it("treats indeterminate as not-blocked", async () => {
    const blocked = await computeBlockedFolders(
      KEYS,
      askedSet("desktop"),
      probeMap({ desktop: "indeterminate" }),
    );
    assert.deepEqual(blocked, []);
  });

  it("treats a throwing probe as not-blocked", async () => {
    const blocked = await computeBlockedFolders(KEYS, askedSet("desktop"), async () => {
      throw new Error("boom");
    });
    assert.deepEqual(blocked, []);
  });

  it("nothing asked → nothing blocked", async () => {
    const blocked = await computeBlockedFolders(KEYS, askedSet(), probeMap({ desktop: "blocked" }));
    assert.deepEqual(blocked, []);
  });
});
