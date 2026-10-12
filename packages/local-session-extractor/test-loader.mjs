// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * ESM resolve hook for running the package's TypeScript sources directly with
 * Node's built-in type stripping (registered by `test-register.mjs`). Source files use extensionless
 * relative imports and unattributed `.json` imports, as the bundlers expect;
 * raw Node ESM needs the extension and the `type: "json"` attribute.
 */

import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as pathResolve } from "node:path";

/**
 * Resolves a relative specifier to a result the hook can return, or null when
 * the specifier is not one this loader rewrites.
 */
/** The package's own entry points, resolved to their sources so examples run under the tests. */
const PACKAGE_ENTRY = { "local-session-extractor": "src/index.ts", "local-session-extractor/host": "src/host.ts" };

function resolveSourceSpecifier(specifier, parentURL) {
  if (Object.hasOwn(PACKAGE_ENTRY, specifier)) {
    return { url: new URL(PACKAGE_ENTRY[specifier], import.meta.url).href, shortCircuit: true };
  }
  if (!specifier.startsWith(".") || !parentURL) return null;
  const candidatePath = pathResolve(fileURLToPath(parentURL), "..", specifier);

  // Node validates the attribute against what the hook returns, so it must be
  // set on the result, not passed through nextResolve's context.
  if (specifier.endsWith(".json")) {
    if (!existsSync(candidatePath)) return null;
    return {
      url: pathToFileURL(candidatePath).href,
      format: "json",
      importAttributes: { type: "json" },
      shortCircuit: true,
    };
  }
  if (/\.[cm]?[jt]sx?$/.test(specifier)) return null;

  for (const ext of [".ts", ".tsx"]) {
    if (existsSync(candidatePath + ext)) return { url: pathToFileURL(candidatePath + ext).href };
  }
  try {
    if (statSync(candidatePath).isDirectory()) {
      for (const idx of ["index.ts", "index.tsx"]) {
        const indexPath = pathResolve(candidatePath, idx);
        if (existsSync(indexPath)) return { url: pathToFileURL(indexPath).href };
      }
    }
  } catch {
    // not a directory
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const hit = resolveSourceSpecifier(specifier, context.parentURL);
  if (hit?.shortCircuit) return hit;
  if (hit) return nextResolve(hit.url, context);
  return nextResolve(specifier, context);
}
