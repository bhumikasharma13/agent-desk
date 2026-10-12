// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        // Override the default [name].js → index.js.
        // Both main and preload entries are named index.ts, so without this
        // they both output to .vite/build/index.js and overwrite each other.
        entryFileNames: "preload.js",
      },
    },
  },
});
