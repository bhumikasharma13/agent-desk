// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,

  // ── Project rules ──────────────────────────────────────────────────────────
  {
    rules: {
      // Allow _-prefixed parameters/variables (intentionally unused by convention).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Disallow `any` — use `unknown` and narrow instead.
      "@typescript-eslint/no-explicit-any": "error",

      // Ban eval() — code injection vector.
      "no-eval": "error",

      // Not enabled: max-lines-per-function and max-lines. The pages are long
      // JSX trees and the stack detector is a long table of file rules;
      // splitting them for a line count would not make them clearer.
    },
  },
);
