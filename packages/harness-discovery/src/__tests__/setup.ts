// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// Test-wide guard: every test file starts with HOME (and USERPROFILE) pointing at an empty
// throwaway directory and git ignoring the machine's global and system config, so a test
// that forgets its fixture can never read the real home directory or its git settings.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const guardHome = realpathSync(mkdtempSync(join(tmpdir(), "hd-guard-home-")));
process.env.HOME = guardHome;
process.env.USERPROFILE = guardHome;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
delete process.env.CODEX_HOME;
afterAll(() => rmSync(guardHome, { recursive: true, force: true }));
