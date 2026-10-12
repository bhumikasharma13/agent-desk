// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScannedAsset } from "harness-discovery";
import { readInventory, readStoredScan, toInventory, writeScanFailure, writeStoredScan, type StoredScan } from "../inventory";

const dir = mkdtempSync(join(tmpdir(), "stored-scan-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function asset(over: Omit<Partial<ScannedAsset>, "payload"> & { payload?: Partial<ScannedAsset["payload"]> }): ScannedAsset {
  const { payload, ...rest } = over;
  return {
    id: "id",
    ideType: "claude-code",
    type: "skill",
    name: "review",
    scope: "repo-committed",
    projectPath: "/work/shop",
    filePath: "/work/shop/.claude/skills/review/SKILL.md",
    sourcePath: ".claude/skills/review/SKILL.md",
    contentHash: "h1",
    ...rest,
    payload: { source: "shop", operational_state: "enabled", active_in_agents: ["Claude Code"], ...payload },
  };
}

function stored(assets: ScannedAsset[], extra: Partial<StoredScan["result"]> = {}): StoredScan {
  return { scannedAt: "2026-01-01T00:00:00.000Z", result: { schemaVersion: 1, assets, warnings: [], errors: [], ...extra } };
}

describe("the stored scan file", () => {
  it("round-trips, readable by the owner only", () => {
    const p = join(dir, "inventory.json");
    const scan = stored([asset({})]);
    writeStoredScan(p, scan);
    assert.deepEqual(readStoredScan(p), scan);
    assert.equal(statSync(p).mode & 0o777, 0o600);
  });

  it("reads as null before the first scan", () => {
    assert.equal(readStoredScan(join(dir, "missing.json")), null);
  });

  it("throws on a corrupt or foreign file instead of showing an empty inventory", () => {
    const corrupt = join(dir, "corrupt.json");
    writeFileSync(corrupt, "{not json");
    assert.throws(() => readStoredScan(corrupt));
    const foreign = join(dir, "foreign.json");
    writeFileSync(foreign, JSON.stringify({ hello: "world" }));
    assert.throws(() => readStoredScan(foreign), /not in the expected format/);
  });
});

describe("toInventory", () => {
  it("is the empty inventory before the first scan", () => {
    const inv = toInventory(null);
    assert.equal(inv.lastScannedAt, null);
    assert.equal(inv.summary.totalAssets, 0);
  });

  it("lists plugins as cards with their counts, sorted by name", () => {
    const counts = { skills: 2, commands: 1, rules: 0, hooks: 0, agents: 0 };
    const inv = toInventory(
      stored([
        asset({ id: "p2", type: "plugin", name: "zeta", payload: { marketplace: "m", version: "1.0.0", operational_state: "disabled" } }),
        asset({ id: "p1", type: "plugin", name: "alpha", payload: { plugin_asset_counts: counts, plugin_install_path: "/p/alpha" } }),
      ]),
    );
    assert.deepEqual(
      inv.plugins.map((p) => [p.name, p.marketplace, p.version, p.enabled, p.installPath]),
      [
        ["alpha", "unknown", "unknown", true, "/p/alpha"],
        ["zeta", "m", "1.0.0", false, "/work/shop/.claude/skills/review/SKILL.md"],
      ],
    );
    assert.deepEqual(inv.plugins[0]!.assetCounts, counts);
  });

  it("orders assets by type then name and counts them by type and scope", () => {
    const inv = toInventory(
      stored([
        asset({ id: "3", type: "skill", name: "b" }),
        asset({ id: "1", type: "rule", name: "z", scope: "user", projectPath: "" }),
        asset({ id: "2", type: "skill", name: "a" }),
      ]),
    );
    assert.deepEqual(inv.assets.map((a) => a.id), ["1", "2", "3"]);
    assert.equal(inv.summary.totalAssets, 3);
    assert.equal(inv.summary.byType.skill, 2);
    assert.equal(inv.summary.byScope.user, 1);
    assert.equal(inv.assets[0]!.projectPath, undefined, "a user-scope asset has no project");
  });

  it("carries what the scan skipped and what it could not scan", () => {
    const inv = toInventory(
      stored([], {
        warnings: [{ path: "/work/shop/.claude/settings.json", message: "not valid JSON" }],
        errors: [{ ide: "kiro", message: "boom" }, { root: "/work/gone", message: "not a directory" }],
      }),
    );
    assert.deepEqual(inv.warnings, ["/work/shop/.claude/settings.json: not valid JSON"]);
    assert.deepEqual(inv.errors, ["kiro: boom", "/work/gone: not a directory"]);
    assert.equal(inv.lastScannedAt, "2026-01-01T00:00:00.000Z");
  });
});

describe("readInventory, what the Harness page is served", () => {
  it("shows a failed scan beside the stored scan it kept", () => {
    const p = join(dir, "kept.json");
    writeStoredScan(p, stored([asset({})]));
    writeScanFailure(p, { at: "2026-01-02T00:00:00.000Z", message: "disk gone" });
    const inv = readInventory(p, false);
    assert.equal(inv.status, "idle");
    assert.equal(inv.assets.length, 1, "the stored scan is still shown");
    assert.deepEqual(inv.lastScanFailure, { at: "2026-01-02T00:00:00.000Z", message: "disk gone" });
  });

  it("serves an unreadable stored scan as an error, not as an empty inventory", () => {
    const p = join(dir, "broken.json");
    writeFileSync(p, "{not json");
    const inv = readInventory(p, false);
    assert.equal(inv.status, "error");
    assert.ok(inv.lastError, "the reason is shown");
  });

  it("passes on whether the first read of this run is still going", () => {
    const p = join(dir, "kept.json");
    assert.equal(readInventory(p, true).collecting, true);
    assert.equal(readInventory(p, false).collecting, false);
  });
});
