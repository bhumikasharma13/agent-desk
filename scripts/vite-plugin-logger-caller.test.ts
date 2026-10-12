// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// The build-time caller literal always lands in the logger's 4th parameter, whatever the
// call passes, so it never reaches `data` (where a string would be logged index by index).

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loggerCallerPlugin } from "./vite-plugin-logger-caller";

const root = "/project";
const id = path.join(root, "src", "main", "index.ts");
const plugin = loggerCallerPlugin({ projectRoot: root });
const transform = (code: string): string => {
  const out = (plugin.transform as (code: string, id: string) => { code: string } | null)(code, id);
  return out ? out.code : code;
};

/** Runs the built call against a recording logger and returns the four arguments it received. */
function call(code: string): unknown[] {
  let received: unknown[] = [];
  const logger = { info: (...args: unknown[]) => (received = args) };
  new Function("logger", "data", transform(code))(logger, { n: 1 });
  return received;
}

test("a two-argument call gets undefined data and the caller in the 4th slot", () => {
  assert.equal(transform('logger.info("app", "app_launched");'), 'logger.info("app", "app_launched", undefined, "src/main/index.ts:1");');
  assert.deepEqual(call('logger.info("app", "app_launched");'), ["app", "app_launched", undefined, "src/main/index.ts:1"]);
});

test("a call with data gets only the caller", () => {
  assert.deepEqual(call('logger.info("app", "x", data);'), ["app", "x", { n: 1 }, "src/main/index.ts:1"]);
});

test("a trailing comma, a comma inside a string and a nested call do not miscount", () => {
  assert.deepEqual(call('logger.info("a,b", String("x"),);'), ["a,b", "x", undefined, "src/main/index.ts:1"]);
  assert.deepEqual(call("logger.info(`c`, `e ${[1, 2].join(',')}`, { a: [1, 2] });"), ["c", "e 1,2", { a: [1, 2] }, "src/main/index.ts:1"]);
});

test("a call that already passes a caller is left as it is", () => {
  assert.equal(transform('logger.info("a", "b", data, "x:1");'), 'logger.info("a", "b", data, "x:1");');
});
