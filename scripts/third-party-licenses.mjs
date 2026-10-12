// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// Keeps third_party/licenses/ in step with what a build bundles: every production dependency
// (package.json "dependencies" and what they depend on), plus the build tools whose output ships
// (Tailwind's generated CSS, Vite's module-preload helper) and the Electron runtime. For each it
// copies the package's licence file, its NOTICE and its own third_party/ folder. forge.config.ts
// ships the folder inside the app. A workspace package (`workspace:` in package.json) is this
// repository's own code under its LICENSE, so it is left out; its dependencies are not.
//
//   node scripts/third-party-licenses.mjs write   regenerate the folder from node_modules
//   node scripts/third-party-licenses.mjs check   exit 1 when the folder differs from node_modules

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "third_party", "licenses");
const SHIPPED_BUILD_TOOLS = ["tailwindcss", "vite", "electron"];
const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function manifest(name) {
  return readJson(path.join(ROOT, "node_modules", name, "package.json"));
}

/** Production dependencies and their dependencies, plus the shipped build tools, sorted. */
export function bundledPackages() {
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const dep of Object.keys(manifest(name).dependencies ?? {})) visit(dep);
  };
  const ownWorkspace = new Set();
  for (const [dep, spec] of Object.entries(readJson(path.join(ROOT, "package.json")).dependencies ?? {})) {
    if (spec.startsWith("workspace:")) ownWorkspace.add(dep);
    visit(dep);
  }
  for (const tool of SHIPPED_BUILD_TOOLS) seen.add(tool);
  return [...seen].filter((name) => !ownWorkspace.has(name)).sort();
}

/** Writes each package's licence, NOTICE and third_party/ under `dir`, plus an index. */
export function writeLicenses(dir) {
  rmSync(dir, { recursive: true, force: true });
  const index = ["Third-party software bundled in Agent Desk builds.", ""];
  for (const name of bundledPackages()) {
    const pkgDir = path.join(ROOT, "node_modules", name);
    const files = readdirSync(pkgDir).filter((f) => LICENSE_FILE.test(f) || f === "NOTICE" || f === "third_party");
    if (!files.some((f) => LICENSE_FILE.test(f))) throw new Error(`${name} has no licence file`);
    for (const f of files) cpSync(path.join(pkgDir, f), path.join(dir, name, f), { recursive: true });
    const m = manifest(name);
    index.push(`${name} ${m.version}: ${m.license ?? "see its licence file"}`);
  }
  writeFileSync(path.join(dir, "INDEX.txt"), index.join("\n") + "\n");
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = path.join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out.sort();
}

/** The paths that differ between the committed folder and a fresh generation; empty when in step. */
export function staleLicenses() {
  const fresh = mkdtempSync(path.join(tmpdir(), "third-party-"));
  try {
    writeLicenses(fresh);
    const a = listFiles(OUT);
    const b = listFiles(fresh);
    const diff = [...new Set([...a, ...b])].filter(
      (f) => !a.includes(f) || !b.includes(f) || !readFileSync(path.join(OUT, f)).equals(readFileSync(path.join(fresh, f))),
    );
    return diff.sort();
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode === "write") {
    writeLicenses(OUT);
    console.log(`wrote ${OUT}: ${bundledPackages().join(", ")}`);
  } else if (mode === "check") {
    const stale = staleLicenses();
    if (stale.length > 0) {
      console.error(`third_party/licenses is out of date; run: node scripts/third-party-licenses.mjs write\n${stale.join("\n")}`);
      process.exit(1);
    }
    console.log("third_party/licenses is up to date");
  } else {
    console.error("usage: node scripts/third-party-licenses.mjs write|check");
    process.exit(2);
  }
}
