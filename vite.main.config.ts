// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { defineConfig } from "vite";
import { loggerCallerPlugin } from "./scripts/vite-plugin-logger-caller";
import { packageVersionPlugin } from "./scripts/vite-plugin-package-version";

// Main-process bundle. The logger plugin stamps each log call with its source
// file and line, since the bundle collapses every caller into one file.
export default defineConfig({
  plugins: [loggerCallerPlugin({ projectRoot: process.cwd() }), packageVersionPlugin()],
});
