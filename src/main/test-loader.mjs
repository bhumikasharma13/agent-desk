// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Custom ESM loader for TypeScript test files under ELECTRON_RUN_AS_NODE=1.
 *
 * Problem: Node 24 (ESM mode) requires explicit file extensions in imports.
 * TypeScript source files use bare imports like `import x from "../module"`.
 * This loader adds .ts extension and resolves directory imports to index.ts.
 *
 * Usage:
 *   ELECTRON_RUN_AS_NODE=1 electron --loader ./src/main/test-loader.mjs --test ...
 */

import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as pathResolve } from "node:path";

// Under ELECTRON_RUN_AS_NODE the `electron` package resolves to a CJS shim whose
// named exports (app, shell, BrowserWindow, …) Node's ESM loader
// cannot statically detect, so `import { app } from "electron"` throws at module
// load. Tests never exercise the real Electron runtime, so we redirect the bare
// `electron` specifier to an ESM stub that exports those names. Source files keep
// their normal named imports; only CALLING a stubbed API in a test would need an
// override, which a test does by injecting a seam.
const ELECTRON_STUB = "electron-stub.mjs";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "electron") {
    const stubURL = pathToFileURL(pathResolve(fileURLToPath(import.meta.url), "..", ELECTRON_STUB)).href;
    return { url: stubURL, shortCircuit: true };
  }
  // Only handle relative imports
  if (specifier.startsWith(".") && context.parentURL) {
    const parentPath = fileURLToPath(context.parentURL);
    const parentDir = pathResolve(parentPath, "..");
    const candidatePath = pathResolve(parentDir, specifier);

    // Raw Node ESM requires `with { type: "json" }` on JSON imports; source
    // files omit it because the Vite build injects it. Supply it here so a test
    // whose import graph reaches a `.json` module loads instead of throwing
    // ERR_IMPORT_ATTRIBUTE_MISSING — the same Vite-vs-raw-Node gap this loader
    // already bridges for extensionless `.ts` imports. The attribute must be set
    // on the *returned* result: Node validates against what the resolve hook
    // returns, so passing importAttributes via nextResolve's context does NOT
    // satisfy validateAttributes. Existence-check first so a mistyped `.json`
    // path still fails at resolve with Node's own module-not-found error.
    if (specifier.endsWith(".json")) {
      if (existsSync(candidatePath)) {
        return {
          url: pathToFileURL(candidatePath).href,
          format: "json",
          importAttributes: { type: "json" },
          shortCircuit: true,
        };
      }
      return nextResolve(specifier, context);
    }

    // If it already has a recognized extension, pass through
    if (specifier.match(/\.[cm]?[jt]sx?$/)) {
      return nextResolve(specifier, context);
    }

    // Try as a .ts file first
    for (const ext of [".ts", ".tsx"]) {
      const withExt = candidatePath + ext;
      if (existsSync(withExt)) {
        return nextResolve(pathToFileURL(withExt).href, context);
      }
    }

    // Try as a directory import (index.ts)
    try {
      const stat = statSync(candidatePath);
      if (stat.isDirectory()) {
        for (const idx of ["index.ts", "index.tsx"]) {
          const indexPath = pathResolve(candidatePath, idx);
          if (existsSync(indexPath)) {
            return nextResolve(pathToFileURL(indexPath).href, context);
          }
        }
      }
    } catch {
      // not a directory, fall through
    }
  }
  return nextResolve(specifier, context);
}
