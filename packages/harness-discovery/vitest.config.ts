// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
    // Many tests build git repos and scan them, one git process per step. Inside a
    // vitest worker on Node 24.17 each git call takes about 90 ms instead of 10 ms
    // (not seen outside vitest, or on Node 24.15 or 26), which put the widest tests
    // past the 5 s default. Thirty seconds leaves room on a slow machine.
    testTimeout: 30_000,
  },
});
