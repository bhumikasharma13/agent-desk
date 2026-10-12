// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// Vite plugin that inlines local-session-extractor's own version into the bundle.
//
// The package reads its version at load time with
// `createRequire(import.meta.url)("../package.json")`, a path relative to its
// own dist/ folder. Bundled into .vite/build, that path points at a file that
// does not exist, and the main and worker processes would throw on start. The
// transform swaps the call for the version read from the same package.json at
// build time, so the bundle needs no file beside it. This works around the
// package reading a file relative to its own module at load, which no bundler
// can resolve; drop the plugin once the package inlines its version.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const CALL = 'createRequire(import.meta.url)("../package.json").version';

export function packageVersionPlugin(): Plugin {
  return {
    name: "agent-desk:package-version",
    transform(code, id) {
      if (!id.includes("/local-session-extractor/dist/") || !code.includes(CALL)) return null;
      const manifest = path.join(path.dirname(id), "..", "package.json");
      const version = (JSON.parse(readFileSync(manifest, "utf-8")) as { version: string }).version;
      return { code: code.split(CALL).join(JSON.stringify(version)), map: null };
    },
    // Fails the build if any bundled code still reads ../package.json at load,
    // so a changed upstream expression cannot ship a bundle that throws on start.
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === "chunk" && chunk.code.includes('("../package.json")')) {
          this.error(`${chunk.fileName} still reads ../package.json at load; update scripts/vite-plugin-package-version.ts`);
        }
      }
    },
  };
}
