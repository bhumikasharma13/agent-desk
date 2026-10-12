// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundledPackages, staleLicenses } from "./third-party-licenses.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("third_party/licenses holds the licence texts of everything a build bundles, unchanged", () => {
  assert.deepEqual(staleLicenses(), [], "run: node scripts/third-party-licenses.mjs write");
});

test("the bundled set covers React, the fonts and the Electron runtime", () => {
  const pkgs = bundledPackages();
  for (const name of ["react", "react-dom", "@fontsource-variable/geist", "@fontsource/geist-mono", "electron"]) {
    assert.ok(pkgs.includes(name), `${name} is listed`);
  }
});

test("workspace packages are first-party, and every third-party file they carry ships with the app", () => {
  for (const name of ["local-session-extractor", "harness-discovery"]) {
    assert.ok(!bundledPackages().includes(name), `${name} is under the root LICENSE`);
  }
  const carried = []; // [package's third_party folder, file below it]
  const walk = (base, dir) => {
    for (const e of readdirSync(dir)) {
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walk(base, p);
      else carried.push([base, p]);
    }
  };
  const packages = path.join(ROOT, "packages");
  for (const pkg of readdirSync(packages)) {
    const own = path.join(packages, pkg, "third_party");
    if (existsSync(own)) walk(own, own);
  }
  assert.ok(carried.length > 0, "the workspace packages carry third-party files");
  for (const [base, file] of carried) {
    const rel = path.relative(base, file);
    const copy = path.join(ROOT, "third_party", rel);
    assert.ok(existsSync(copy) && readFileSync(copy).equals(readFileSync(file)), `third_party/${rel} is a copy of ${path.relative(ROOT, file)}`);
  }
});
