// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The SDK examples seed or name the folder they read, so none may read the
 * real home: run against a home full of decoy sessions, each prints what it
 * prints against an empty one.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../../", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "lse-examples-home-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function decoyHome(): string {
  const home = join(tmp, "decoy");
  const line = (id: string) => JSON.stringify({ type: "user", uuid: id, timestamp: "2026-04-01T10:00:00.000Z", sessionId: id, cwd: "/Users/you/app", message: { role: "user", content: "decoy" } }) + "\n";
  const projects = join(home, ".claude", "projects", "-Users-you-decoy");
  mkdirSync(projects, { recursive: true });
  writeFileSync(join(projects, "decoy-1.jsonl"), line("decoy-1"));
  const cowork = join(home, "Library", "Application Support", "Claude", "local-agent-mode-sessions", "a", "b", "local_c");
  mkdirSync(cowork, { recursive: true });
  writeFileSync(join(cowork, "audit.jsonl"), line("decoy-2"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "decoy@example.com" } }));
  return home;
}

function run(example: string, home: string): string {
  return execFileSync(process.execPath, ["--no-warnings", "--import", "./test-register.mjs", `examples/${example}/index.mts`], {
    cwd: root,
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

describe("the SDK examples", () => {
  const empty = join(tmp, "empty");
  mkdirSync(empty, { recursive: true });
  const decoy = decoyHome();
  for (const example of ["read-one-session", "sync-to-your-server", "share-sessions-safely", "wire-a-logger-and-metrics"]) {
    it(`${example} reads nothing from the real home`, () => {
      assert.equal(run(example, decoy), run(example, empty));
    });
  }
});
