// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { partitionDirectoryPaths } from "../../internal";

// Probed against a real filesystem rather than a stubbed fs: the whole point of
// this filter is that it asks the OS instead of trusting a vendor tool-name list,
// so a mocked stat would test the mock.
let root: string;

before(() => {
  root = mkdtempSync(join(os.tmpdir(), "cursor-dirfilter-"));
  mkdirSync(join(root, "src", "components"), { recursive: true });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(join(root, "src", "components", "Table.tsx"), "x");
  writeFileSync(join(root, "Dockerfile"), "FROM scratch");
  writeFileSync(join(root, "Makefile"), "all:");
  writeFileSync(join(root, "README"), "hi");
  writeFileSync(join(root, ".env.local"), "K=v");
  // Directories whose basename carries a dot. A version-shaped tail is what the
  // plausible-extension rule exists to keep probing.
  mkdirSync(join(root, "python3.12"), { recursive: true });
  mkdirSync(join(root, "v1.2.3"), { recursive: true });
});

after(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const run = (files: string[], workspaceRoot?: string) =>
  partitionDirectoryPaths(files, workspaceRoot, new Map<string, boolean>());

describe("partitionDirectoryPaths", () => {
  it("still probes a directory whose basename ends in a version segment", () => {
    // `python3.12` and `v1.2.3` have a dot with characters either side, so a bare
    // has-a-dot rule would call them files and retain them. The tail must look like
    // an extension — alphabetic-led and short — to earn the skip.
    const r = run(["python3.12", "v1.2.3"], root);
    assert.deepEqual(r.kept, []);
    assert.equal(r.dropped, 2);
    assert.equal(r.probeFailed, 0);
  });

  it("keeps a vanished path and counts it unresolved, not as a probe failure", () => {
    const r = run(["does/not/exist"], root);
    assert.deepEqual(r.kept, ["does/not/exist"]);
    assert.equal(r.unresolved, 1);
    assert.equal(r.probeFailed, 0);
  });

  it("counts an unreadable path as a probe failure, and still keeps it", () => {
    // The reason the two are split: a vanished file is unremarkable, but a probe
    // that CANNOT RUN means the filter has silently stopped filtering, and one
    // aggregate count cannot tell those apart. Exercises the non-ENOENT arm for
    // real by removing execute permission on the parent, which makes stat EACCES.
    if (process.getuid?.() === 0) return; // root bypasses mode bits
    const locked = join(root, "locked");
    mkdirSync(join(locked, "inner"), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const r = run(["locked/inner"], root);
      assert.deepEqual(r.kept, ["locked/inner"], "a path we cannot stat is never dropped");
      assert.equal(r.probeFailed, 1);
      assert.equal(r.unresolved, 0);
      assert.equal(r.dropped, 0);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("drops a real directory and keeps a real file", () => {
    const r = run([join(root, "src", "components"), join(root, "src", "components", "Table.tsx")]);
    assert.deepEqual(r.kept, [join(root, "src", "components", "Table.tsx")]);
    assert.equal(r.dropped, 1);
  });

  it("keeps extensionless FILES — the regression that guards Dockerfile and Makefile", () => {
    const files = [join(root, "Dockerfile"), join(root, "Makefile"), join(root, "README")];
    const r = run(files);
    assert.deepEqual(r.kept, files);
    assert.equal(r.dropped, 0);
  });

  it("drops a dot-prefixed DIRECTORY — a leading dot is not an extension", () => {
    const r = run([join(root, ".github"), join(root, ".github", "workflows")]);
    assert.deepEqual(r.kept, []);
    assert.equal(r.dropped, 2);
  });

  it("drops `.` and `..` scopes — a trailing dot extends nothing", () => {
    // A search tool scoping itself to the workspace root or its parent is the
    // case a leading-dot-only rule still let through.
    const r = run([".", ".."], join(root, "src"));
    assert.deepEqual(r.kept, []);
    assert.equal(r.dropped, 2);
  });

  it("probes a trailing-dot basename rather than reading it as an extension", () => {
    const r = run([join(root, "src", "components.")]);
    // Does not exist, so it is kept — but it was PROBED, not skipped as a file.
    assert.equal(r.kept.length, 1);
    assert.equal(r.unresolved, 1);
  });

  it("keeps a dotfile that has a real extension, without probing it", () => {
    const r = run([join(root, ".env.local")]);
    assert.deepEqual(r.kept, [join(root, ".env.local")]);
    assert.equal(r.dropped, 0);
    assert.equal(r.unresolved, 0);
  });

  it("keeps a path with an extension without probing it, even when it does not exist", () => {
    const ghost = join(root, "src", "deleted", "gone.ts");
    const r = run([ghost]);
    assert.deepEqual(r.kept, [ghost]);
    assert.equal(r.dropped, 0);
    // Extension short-circuits before the syscall, so it is not counted unresolved.
    assert.equal(r.unresolved, 0);
  });

  it("keeps an extensionless path that no longer exists — a deleted file was still edited", () => {
    const r = run([join(root, "vanished")]);
    assert.equal(r.kept.length, 1);
    assert.equal(r.dropped, 0);
    assert.equal(r.unresolved, 1);
  });

  it("resolves a workspace-relative directory against the workspace root", () => {
    const r = run(["src/components", "src/components/Table.tsx"], root);
    assert.deepEqual(r.kept, ["src/components/Table.tsx"]);
    assert.equal(r.dropped, 1);
  });

  it("keeps a relative extensionless path when there is no workspace root to resolve against", () => {
    const r = run(["src/components"], undefined);
    assert.deepEqual(r.kept, ["src/components"]);
    assert.equal(r.dropped, 0);
    assert.equal(r.unresolved, 1);
  });

  it("probes each distinct path once via the shared cache", () => {
    const cache = new Map<string, boolean>();
    const dir = join(root, "src", "components");
    const a = partitionDirectoryPaths([dir], undefined, cache);
    const b = partitionDirectoryPaths([dir], undefined, cache);
    assert.equal(a.dropped, 1);
    assert.equal(b.dropped, 1);
    assert.equal(cache.size, 1);
  });

  it("passes an empty list through untouched", () => {
    const r = run([]);
    assert.deepEqual(r.kept, []);
    assert.equal(r.dropped, 0);
    assert.equal(r.unresolved, 0);
  });
});
