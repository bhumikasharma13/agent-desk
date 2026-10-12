// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The examples and this config are plain Node ES modules.
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
  {
    rules: {
      // The sanitisers match control characters on purpose: stripping and escaping them
      // is what they are for (src/sanitize.ts, the CLI's field escaper).
      "no-control-regex": "off",
    },
  },
);
