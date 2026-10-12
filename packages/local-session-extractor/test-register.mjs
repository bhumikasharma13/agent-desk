// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Registers the source resolve hook (`test-loader.mjs`) for running the
 * TypeScript sources directly; load it with --import before anything else.
 */
import { register } from "node:module";

register("./test-loader.mjs", import.meta.url);
