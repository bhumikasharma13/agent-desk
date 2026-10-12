// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", host: "src/host.ts", cli: "src/cli/bin.ts" },
  format: ["esm"],
  platform: "node",
  target: "node24",
  dts: true,
  sourcemap: true,
  clean: true,
  // node:sqlite exists only under the node: prefix, which tsup strips by default.
  removeNodeProtocol: false,
});
