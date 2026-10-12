// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// verifyArtifacts against a stand-in for codesign, ditto and hdiutil: nothing is mounted or signed.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdirSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { adHocSign, verifyArtifacts, verifyMakeResults } = require("./adHocSign.cjs");

/** A stand-in runner. `valid` decides codesign's verify; `detach` is the exit of each hdiutil detach in turn. */
function fakeExec({ valid = true, detach = [0] } = {}) {
  const calls = [];
  const detaches = [...detach];
  const exec = (cmd, args) => {
    calls.push(`${cmd} ${args.filter((a) => !a.includes("/")).join(" ")}`.trim());
    if (cmd === "ditto") {
      mkdirSync(path.join(args[3], "Agent Desk.app"), { recursive: true });
      return { status: 0, stdout: "", stderr: "" };
    }
    if (cmd === "hdiutil" && args[0] === "attach") {
      mkdirSync(path.join(args[args.indexOf("-mountpoint") + 1], "Agent Desk.app"), { recursive: true });
      return { status: 0, stdout: "", stderr: "" };
    }
    if (cmd === "hdiutil" && args[0] === "detach") return { status: detaches.shift() ?? 0, stdout: "", stderr: "resource busy" };
    if (cmd === "codesign" && args[0] === "--verify") return valid ? { status: 0, stdout: "", stderr: "" } : { status: 1, stdout: "", stderr: "invalid Info.plist (plist or signature have been modified)" };
    if (cmd === "codesign" && args[0] === "-dv") return { status: 0, stdout: "", stderr: "Identifier=dev.agentdesk.app\n" };
    if (cmd === "codesign" && args[0] === "--force") return { status: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected ${cmd}`);
  };
  return { exec, calls };
}

test("a ZIP and a DMG whose apps verify pass, and the DMG is detached", () => {
  const { exec, calls } = fakeExec();
  verifyArtifacts(["a.zip", "a.dmg", "notes.txt"], "Agent Desk", "dev.agentdesk.app", exec);
  assert.ok(calls.includes("hdiutil detach -quiet"));
});

test("an artifact whose app does not verify fails the make", () => {
  const { exec } = fakeExec({ valid: false });
  assert.throws(() => verifyArtifacts(["a.zip"], "Agent Desk", "dev.agentdesk.app", exec), /does not verify: invalid Info.plist/);
});

test("a busy detach is retried with -force, and the verify's error is the one reported", () => {
  const { exec, calls } = fakeExec({ valid: false, detach: [16, 0] });
  assert.throws(() => verifyArtifacts(["a.dmg"], "Agent Desk", "dev.agentdesk.app", exec), /does not verify/);
  assert.deepEqual(calls.filter((c) => c.startsWith("hdiutil detach")), ["hdiutil detach -quiet", "hdiutil detach -force -quiet"]);
});

test("when the verify fails and even the forced detach fails, the verify's error is reported", () => {
  const { exec } = fakeExec({ valid: false, detach: [16, 16] });
  assert.throws(() => verifyArtifacts(["a.dmg"], "Agent Desk", "dev.agentdesk.app", exec), /does not verify: invalid Info\.plist/);
});

test("a DMG that cannot be detached even by force fails the make, after the verify passed", () => {
  const { exec } = fakeExec({ valid: true, detach: [16, 16] });
  assert.throws(() => verifyArtifacts(["a.dmg"], "Agent Desk", "dev.agentdesk.app", exec), /detach .*-force .*failed: resource busy/);
});

test("an app signed as something else fails", () => {
  const exec = (cmd, args) =>
    cmd === "codesign" && args[0] === "-dv" ? { status: 0, stdout: "", stderr: "Identifier=com.github.Electron\n" } : fakeExec().exec(cmd, args);
  assert.throws(() => verifyArtifacts(["a.zip"], "Agent Desk", "dev.agentdesk.app", exec), /signed as com\.github\.Electron/);
});

test("a make that produced no DMG or ZIP fails, rather than reporting a verified app", () => {
  const { exec } = fakeExec();
  assert.throws(() => verifyMakeResults([{ platform: "darwin", artifacts: ["notes.txt"] }], "Agent Desk", "dev.agentdesk.app", exec), /no DMG or ZIP/);
  assert.equal(verifyMakeResults([{ platform: "darwin", artifacts: ["a.zip", "a.dmg"] }], "Agent Desk", "dev.agentdesk.app", exec), 2);
});


// The hardened runtime keeps another process from loading code into the app through DYLD_*
// variables and so reaching the folders the user granted it.
test("ad hoc signing turns on the hardened runtime, with the ad hoc entitlements", () => {
  const calls = [];
  const { exec } = fakeExec();
  adHocSign("/x/Agent Desk.app", "dev.agentdesk.app", (cmd, args) => {
    calls.push([cmd, ...args]);
    return exec(cmd, args);
  });
  const sign = calls.find((c) => c[0] === "codesign" && c[1] === "--force");
  assert.ok(sign, "codesign signs the app");
  assert.equal(sign[sign.indexOf("--options") + 1], "runtime");
  const entitlements = readFileSync(sign[sign.indexOf("--entitlements") + 1], "utf8");
  // Electron's V8 needs JIT; an ad hoc framework has no Team ID, so library validation must be off.
  for (const key of ["com.apple.security.cs.allow-jit", "com.apple.security.cs.disable-library-validation"]) {
    assert.match(entitlements, new RegExp(`<key>${key.replaceAll(".", "\\.")}</key>\\s*<true/>`), key);
  }
  assert.doesNotMatch(entitlements, /allow-dyld-environment-variables/);
});
