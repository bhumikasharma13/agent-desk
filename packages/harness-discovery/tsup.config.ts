// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { defineConfig } from "tsup";

// Every built file carries the license header the sources do.
const HEADER = "// Copyright 2026 The Agent Desk Authors\n// SPDX-License-Identifier: MIT";

export default defineConfig({
  entry: ["src/index.ts", "src/types.ts", "src/cli.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  dts: { entry: ["src/index.ts", "src/types.ts"], banner: HEADER },
  // The published file names (package.json `exports` and `bin`) are .mjs.
  outExtension: () => ({ js: ".mjs" }),
  // No source maps: they would point at src/, which the package does not ship.
  banner: { js: HEADER },
  clean: true,
});
