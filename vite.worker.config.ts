// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { defineConfig } from "vite";
import { loggerCallerPlugin } from "./scripts/vite-plugin-logger-caller";
import { packageVersionPlugin } from "./scripts/vite-plugin-package-version";

// Bundle config for the extraction utility process (a separate Electron
// utilityProcess fork running the same Node-flavoured code as main). The logger
// plugin stamps the worker's own log calls with their source file and line, as
// in main.
export default defineConfig({
  plugins: [loggerCallerPlugin({ projectRoot: process.cwd() }), packageVersionPlugin()],
});
