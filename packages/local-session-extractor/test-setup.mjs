// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Package test setup, loaded with --import before any test file.
 *
 * A test-wide guard, so a test that forgets its own fixture paths cannot read the
 * developer's real sessions, credentials or git config:
 *  - HOME and USERPROFILE point at an empty temp home shaped `…/Users/<name>`, so
 *    every default vendor location resolves inside it;
 *  - git reads no global or system config (no signing, hooks or templates);
 *  - `node:https` requests and the `ps` process scan throw, so no test reaches a
 *    live local server; a test that needs either stubs it itself.
 *
 * Cowork is drained inside every Claude Code pass, so its two stores default to
 * paths that never exist; a test that exercises Cowork sets its own override.
 */
import childProcess from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPathOverrides } from "./src/extractors/pathResolver.ts";

const home = join(mkdtempSync(join(tmpdir(), "lse-test-")), "Users", "lse-test-home");
mkdirSync(home, { recursive: true });
process.env["HOME"] = home;
process.env["USERPROFILE"] = home;
process.env["GIT_CONFIG_GLOBAL"] = "/dev/null";
process.env["GIT_CONFIG_NOSYSTEM"] = "1";

https.request = () => {
  throw new Error("test guard: node:https is blocked in tests");
};
const exec = childProcess.exec;
const isPs = (command) => typeof command === "string" && /^\s*ps\b/.test(command);
const guardedExec = (command, ...rest) => {
  if (isPs(command)) throw new Error("test guard: the ps process scan is blocked in tests");
  return exec(command, ...rest);
};
// promisify(exec) resolves { stdout, stderr } through exec's custom form; keep it.
guardedExec[promisify.custom] = (command, ...rest) =>
  isPs(command) ? Promise.reject(new Error("test guard: the ps process scan is blocked in tests")) : exec[promisify.custom](command, ...rest);
childProcess.exec = guardedExec;
syncBuiltinESMExports();

setPathOverrides({
  COWORK_AGENT_MODE_SESSIONS_PATH: join(tmpdir(), `local-session-extractor-cowork-absent-agentmode-${process.pid}`),
  COWORK_CLAUDE_CODE_SESSIONS_PATH: join(tmpdir(), `local-session-extractor-cowork-absent-ccsessions-${process.pid}`),
});
