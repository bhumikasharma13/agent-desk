// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// Signing checks for a build (forge.config.ts hooks).
//
// Without a Developer ID: the packager copies Electron's own ad-hoc-signed binary, then writes
// the app's Info.plist, and plugin-fuses rewrites the executable, so the bundle's signature no
// longer matches it. macOS identifies an app to its folder-access (TCC) checks by that
// signature, and with an invalid one it denies Desktop, Documents and Downloads without asking.
// So once the bundle is final, it is signed again, ad hoc, and verified. The identifier comes
// from the bundle's CFBundleIdentifier (the packager's appBundleId). The signature turns on the
// hardened runtime, so no other process can load code into the app through DYLD_* variables and
// reach the folders the user granted it. Its entitlements (entitlements.adhoc.mac.plist) are the
// Developer ID build's plus disable-library-validation: an ad hoc framework has no Team ID, which
// library validation would refuse to load.
//
// With or without a Developer ID, the .app inside every DMG and ZIP is verified after make.
// Every command goes through `exec`, so the tests can stand in for codesign, ditto and hdiutil.

const { spawnSync } = require("node:child_process");
const { mkdtempSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

/** Runs a command: { status, stdout, stderr }. */
const realExec = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
};

/** Runs a command and throws its stderr when it fails. */
function must(exec, cmd, args) {
  const r = exec(cmd, args);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr.trim()}`);
  return r;
}

/** What `codesign -dv` says about `app` (it writes to stderr). */
function signatureDetails(app, exec = realExec) {
  return must(exec, "codesign", ["-dv", app]).stderr;
}

/** Throws unless `app` passes a deep, strict verify and is signed as `bundleId`. */
function verifyBundle(app, bundleId, exec = realExec) {
  const r = exec("codesign", ["--verify", "--deep", "--strict", app]);
  if (r.status !== 0) throw new Error(`${app} does not verify: ${r.stderr.trim()}`);
  const id = /^Identifier=(.+)$/m.exec(signatureDetails(app, exec))?.[1];
  if (id !== bundleId) throw new Error(`${app} is signed as ${id ?? "nothing"}, not ${bundleId}`);
}

const AD_HOC_ENTITLEMENTS = path.resolve(__dirname, "..", "entitlements.adhoc.mac.plist");

/** Signs the finished `app` ad hoc with the hardened runtime, nested code included, and verifies it. */
function adHocSign(app, bundleId, exec = realExec) {
  must(exec, "codesign", ["--force", "--deep", "--sign", "-", "--options", "runtime", "--entitlements", AD_HOC_ENTITLEMENTS, app]);
  verifyBundle(app, bundleId, exec);
}

/**
 * Verifies the .app inside each ZIP and DMG artifact, unpacked or mounted read-only in a temp
 * folder. A DMG is always detached again: a failing detach is retried with -force, and the
 * first error (the verify's, if it failed) is the one thrown.
 */
function verifyArtifacts(artifacts, appName, bundleId, exec = realExec) {
  for (const artifact of artifacts) {
    if (!/\.(zip|dmg)$/.test(artifact)) continue;
    const dir = mkdtempSync(path.join(tmpdir(), "agent-desk-verify-"));
    try {
      if (artifact.endsWith(".zip")) {
        must(exec, "ditto", ["-x", "-k", artifact, dir]);
        verifyBundle(path.join(dir, `${appName}.app`), bundleId, exec);
        continue;
      }
      must(exec, "hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", dir, artifact]);
      let first = null;
      try {
        const app = readdirSync(dir).find((f) => f.endsWith(".app"));
        if (!app) throw new Error(`${artifact} holds no .app`);
        verifyBundle(path.join(dir, app), bundleId, exec);
      } catch (err) {
        first = err;
      }
      if (exec("hdiutil", ["detach", dir, "-quiet"]).status !== 0) {
        try {
          must(exec, "hdiutil", ["detach", dir, "-force", "-quiet"]);
        } catch (err) {
          first ??= err;
        }
      }
      if (first) throw first;
    } finally {
      // A mount point still attached (both detaches failed) cannot be removed; that error is thrown above.
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // left for the error above
      }
    }
  }
}

/** postMake: verifies every darwin DMG and ZIP; a make that produced none of them fails. */
function verifyMakeResults(results, appName, bundleId, exec = realExec) {
  const artifacts = results.filter((r) => r.platform === "darwin").flatMap((r) => r.artifacts).filter((a) => /\.(zip|dmg)$/.test(a));
  if (artifacts.length === 0) throw new Error("make produced no DMG or ZIP to verify");
  verifyArtifacts(artifacts, appName, bundleId, exec);
  return artifacts.length;
}

module.exports = { adHocSign, verifyBundle, verifyArtifacts, verifyMakeResults, signatureDetails };
