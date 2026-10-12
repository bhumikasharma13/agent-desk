// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { process: "readonly", console: "readonly", Buffer: "readonly", setImmediate: "readonly", setTimeout: "readonly", clearTimeout: "readonly", URL: "readonly" },
    },
    rules: {
      // `_`-prefixed names are deliberately unused (a callback's positional argument).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
);
