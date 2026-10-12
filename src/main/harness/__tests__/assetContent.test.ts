// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ScannedAsset } from "harness-discovery";
import { readHarnessAsset } from "../assetContent";
import { viewableFilePaths, viewableRoots, type StoredScan } from "../inventory";

// A scanned asset whose filePath points at a real file on disk, so the stored
// scan's viewable paths (the allowlist) include it.
function scanned(id: string, filePath: string, payload: Partial<ScannedAsset["payload"]> = {}): ScannedAsset {
  return {
    id,
    ideType: "claude-code",
    type: "skill",
    name: id,
    scope: "user",
    projectPath: "",
    filePath,
    sourcePath: `.claude/skills/${id}.md`,
    contentHash: "h",
    payload: { source: "user", operational_state: "enabled", active_in_agents: [], ...payload },
  };
}

describe("readHarnessAsset — allowlisted, size-capped, binary-safe file read", () => {
  let dir: string;
  const assets: ScannedAsset[] = [];
  const allowed = (): string[] => {
    const stored: StoredScan = {
      scannedAt: "2026-01-01T00:00:00.000Z",
      result: { schemaVersion: 1, assets, warnings: [], errors: [] },
    };
    return viewableFilePaths(stored);
  };
  let listed: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "harness-read-"));
    listed = join(dir, "listed.md");
    writeFileSync(listed, "# Hello\nbody\n");
    assets.push(scanned("listed", listed));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("serves the contents of a file in the inventory", async () => {
    const r = await readHarnessAsset(allowed(), listed, [], [dir]);
    assert.equal(r.error, null);
    assert.equal(r.content, "# Hello\nbody\n");
  });

  it("refuses a path not in the inventory (the allowlist boundary)", async () => {
    // A real, readable file — refused purely because it is not an inventory asset.
    const outside = join(dir, "secret.txt");
    writeFileSync(outside, "secret");
    const r = await readHarnessAsset(allowed(), outside, [], [dir]);
    assert.equal(r.content, null);
    assert.match(r.error ?? "", /not part of the current inventory/);
  });

  it("refuses an empty path", async () => {
    const r = await readHarnessAsset(allowed(), "", [], [dir]);
    assert.equal(r.content, null);
    assert.match(r.error ?? "", /not part of the current inventory/);
  });

  it("serves a file of exactly 512 KB", async () => {
    const edge = join(dir, "edge.md");
    writeFileSync(edge, "x".repeat(512 * 1024));
    assets.push(scanned("edge", edge));
    const r = await readHarnessAsset(allowed(), edge, [], [dir]);
    assert.equal(r.error, null);
    assert.equal(r.content?.length, 512 * 1024);
  });

  it("refuses a file over the 512 KB cap", async () => {
    const big = join(dir, "big.md");
    writeFileSync(big, "x".repeat(512 * 1024 + 1));
    assets.push(scanned("big", big));
    const r = await readHarnessAsset(allowed(), big, [], [dir]);
    assert.equal(r.content, null);
    assert.match(r.error ?? "", /too large/);
  });

  it("refuses a binary file (NUL byte) rather than rendering garbage", async () => {
    const bin = join(dir, "asset.bin");
    writeFileSync(bin, Buffer.from([0x41, 0x00, 0x42]));
    assets.push(scanned("bin", bin));
    const r = await readHarnessAsset(allowed(), bin, [], [dir]);
    assert.equal(r.content, null);
    assert.match(r.error ?? "", /binary/);
  });

  it("refuses a FIFO at an allowlisted path at once, without waiting for a writer", async () => {
    const fifo = join(dir, "asset.fifo");
    execFileSync("mkfifo", [fifo]);
    assets.push(scanned("fifo", fifo));
    const r = await Promise.race([
      readHarnessAsset(allowed(), fifo, [], [dir]),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    // A read still blocked in open() would hold the test process at exit; a writer releases it.
    if (!r) closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    assert.ok(r, "the read returned within 2 s");
    assert.equal(r.content, null);
    assert.match(r.error ?? "", /Not a file/);
  });

  it("refuses an inline hook's settings.json (inline hooks are not in the allowlist)", async () => {
    // An inline hook's filePath is the enclosing settings.json; only its command
    // is meant to be shown, so the settings file must NOT be readable through
    // this IPC even though the asset points at a real file.
    const settings = join(dir, "settings.json");
    writeFileSync(settings, '{ "env": { "SECRET": "x" }, "hooks": {} }');
    assets.push(scanned("hook1", settings, { inline_body: "echo hi" }));
    const r = await readHarnessAsset(allowed(), settings, [], [dir]);
    assert.equal(r.content, null);
    assert.match(r.error ?? "", /not part of the current inventory/);
  });

  it("refuses a listed file inside a folder the user has not granted now", async () => {
    const stored: StoredScan = {
      scannedAt: "2026-01-01T00:00:00.000Z",
      result: { schemaVersion: 1, assets: [scanned("listed", listed)], warnings: [], errors: [] },
    };
    const r = await readHarnessAsset(viewableFilePaths(stored, [dir]), listed, [], [dir]);
    assert.equal(r.content, null);
    assert.ok(r.error);
  });

  it("refuses a listed file reached through a link into a folder not granted", async () => {
    // The home-folder scan follows ~/.claude/skills/notes -> ~/Documents/notes and lists the file
    // under its link's spelling, outside Documents.
    mkdirSync(join(dir, "Documents", "notes"), { recursive: true });
    writeFileSync(join(dir, "Documents", "notes", "SKILL.md"), "private\n");
    mkdirSync(join(dir, ".claude", "skills"), { recursive: true });
    symlinkSync(join(dir, "Documents", "notes"), join(dir, ".claude", "skills", "notes"));
    const viaLink = join(dir, ".claude", "skills", "notes", "SKILL.md");
    const stored: StoredScan = {
      scannedAt: "2026-01-01T00:00:00.000Z",
      result: { schemaVersion: 1, assets: [scanned("notes", viaLink)], warnings: [], errors: [] },
    };
    const skip = [join(dir, "Documents")];
    const r = await readHarnessAsset(viewableFilePaths(stored, skip), viaLink, skip, [dir]);
    assert.equal(r.content, null);
    assert.ok(r.error);
    assert.equal((await readHarnessAsset(viewableFilePaths(stored, []), viaLink, [], [dir])).content, "private\n", "allowed, it opens");
  });

  it("refuses a listed file swapped, after the scan, for a link out of home and the scanned repos", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "harness-elsewhere-"));
    try {
      writeFileSync(join(elsewhere, "secret.txt"), "outside\n");
      const swapped = join(dir, "swapped.md");
      symlinkSync(join(elsewhere, "secret.txt"), swapped);
      const stored: StoredScan = {
        scannedAt: "2026-01-01T00:00:00.000Z",
        result: { schemaVersion: 1, assets: [scanned("swapped", swapped)], warnings: [], errors: [] },
      };
      const r = await readHarnessAsset(viewableFilePaths(stored), swapped, [], [dir]);
      assert.equal(r.content, null);
      assert.match(r.error ?? "", /outside your home folder and the scanned projects/);
      // A link that stays inside a read root still opens.
      assert.equal((await readHarnessAsset(viewableFilePaths(stored), swapped, [], [dir, elsewhere])).content, "outside\n");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("does not resolve a scanned repo inside a folder not granted to use it as a read root", async () => {
    // A repo spelled through Documents (a link there to a folder outside home): following that
    // link would look inside Documents, so the repo is no read root while Documents is not granted.
    const elsewhere = mkdtempSync(join(tmpdir(), "harness-elsewhere-"));
    try {
      mkdirSync(join(elsewhere, "repo"));
      writeFileSync(join(elsewhere, "repo", "AGENTS.md"), "repo\n");
      mkdirSync(join(dir, "Documents"), { recursive: true });
      symlinkSync(join(elsewhere, "repo"), join(dir, "Documents", "repo"));
      const file = join(elsewhere, "repo", "AGENTS.md");
      const stored: StoredScan = {
        scannedAt: "2026-01-01T00:00:00.000Z",
        result: { schemaVersion: 1, assets: [scanned("agents", file)], warnings: [], errors: [] },
      };
      const roots = [dir, join(dir, "Documents", "repo")];
      const skip = [join(dir, "Documents")];
      const r = await readHarnessAsset(viewableFilePaths(stored, skip), file, skip, roots);
      assert.equal(r.content, null);
      assert.match(r.error ?? "", /outside your home folder and the scanned projects/);
      assert.equal((await readHarnessAsset(viewableFilePaths(stored), file, [], roots)).content, "repo\n", "granted, it opens");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("read roots are the home folder plus every scanned repo", () => {
    const stored: StoredScan = {
      scannedAt: "2026-01-01T00:00:00.000Z",
      result: {
        schemaVersion: 1,
        assets: [scanned("u", join(dir, "u.md")), { ...scanned("r", "/repos/a/AGENTS.md"), scope: "repo-committed", projectPath: "/repos/a" }, { ...scanned("r2", "/repos/a/CLAUDE.md"), scope: "repo-committed", projectPath: "/repos/a" }],
        warnings: [],
        errors: [],
      },
    };
    assert.deepEqual(viewableRoots(stored, "/home/me"), ["/home/me", "/repos/a"]);
    assert.deepEqual(viewableRoots(null, "/home/me"), ["/home/me"]);
  });
});
