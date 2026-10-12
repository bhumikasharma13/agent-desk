// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// forge.config.ts's hooks, called directly with stand-in artifacts: the .app inside every DMG and
// ZIP is verified after make, with or without a Developer ID. Nothing is packaged or signed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Forge loads the config as CommonJS; loaded here as a module, it finds __dirname and require
// on globalThis instead.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
Object.assign(globalThis, { __dirname: root, require: createRequire(path.join(root, "forge.config.ts")) });

async function loadConfig(withDeveloperId: boolean | string) {
  const saved = process.env["ENABLE_CODE_SIGNING"];
  if (typeof withDeveloperId === "string") process.env["ENABLE_CODE_SIGNING"] = withDeveloperId;
  else if (withDeveloperId) process.env["ENABLE_CODE_SIGNING"] = "1";
  else delete process.env["ENABLE_CODE_SIGNING"];
  try {
    // A fresh copy each time: the config reads ENABLE_CODE_SIGNING when it loads.
    return (await import(`../forge.config.ts?signing=${encodeURIComponent(String(withDeveloperId))}`)).default;
  } finally {
    if (saved === undefined) delete process.env["ENABLE_CODE_SIGNING"];
    else process.env["ENABLE_CODE_SIGNING"] = saved;
  }
}

for (const withDeveloperId of [false, true]) {
  test(`after make the DMG and ZIP are verified (${withDeveloperId ? "Developer ID" : "ad hoc"})`, async () => {
    const config = await loadConfig(withDeveloperId);
    const results = [{ artifacts: ["/nonexistent/agent-desk-test/Agent Desk.zip"], platform: "darwin", arch: "arm64", packageJSON: {} }];
    // The stand-in ZIP does not exist, so a verify that runs fails the hook.
    await assert.rejects(() => config.hooks.postMake(config, results), /ditto .* failed/);
  });
}

test("after make, no DMG or ZIP at all fails the hook", async () => {
  const config = await loadConfig(false);
  await assert.rejects(() => config.hooks.postMake(config, [{ artifacts: ["/nonexistent/notes.txt"], platform: "darwin", arch: "arm64", packageJSON: {} }]), /no DMG or ZIP/);
});


test("ENABLE_CODE_SIGNING set to 0, false, no or nothing signs ad hoc, not with a Developer ID", async () => {
  for (const off of ["0", "false", "FALSE", "no", ""]) {
    const config = await loadConfig(off);
    assert.equal(config.packagerConfig.osxSign, undefined, `ENABLE_CODE_SIGNING=${JSON.stringify(off)}`);
  }
  for (const on of ["1", "true"]) {
    const config = await loadConfig(on);
    assert.notEqual(config.packagerConfig.osxSign, undefined, `ENABLE_CODE_SIGNING=${JSON.stringify(on)}`);
  }
});
