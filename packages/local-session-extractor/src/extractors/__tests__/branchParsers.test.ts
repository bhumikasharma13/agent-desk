// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The pushed and created branch names read from shell commands, across the
 * spellings git accepts: a force-push `+`, a full `refs/heads/` ref, a `git -C`
 * working-directory prefix, and the force-create forms of checkout and switch.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { commandCreatesBranch, commandPushesToGit, parseCreateBranch, parsePushBranch } from "../../internal";

describe("parsePushBranch", () => {
  const cases: Array<[string, string | null]> = [
    ["git push origin feat/x", "feat/x"],
    ["git push origin +feat/x", "feat/x"],
    ["git push origin refs/heads/feat/x", "feat/x"],
    ["git push origin HEAD:refs/heads/feat/x", "feat/x"],
    ["git -C /tmp/repo push origin feat/x", "feat/x"],
    ["git -C /tmp/repo push -u origin feat/x", "feat/x"],
    ["git push origin", null],
  ];
  for (const [command, want] of cases) {
    it(`${command} -> ${want}`, () => assert.equal(parsePushBranch(command), want));
  }
});

describe("parseCreateBranch", () => {
  const cases: Array<[string, string | null]> = [
    ["git checkout -b feat/x", "feat/x"],
    ["git checkout -B feat/x", "feat/x"],
    ["git switch -c feat/x", "feat/x"],
    ["git switch -C feat/x", "feat/x"],
    ["git switch --create feat/x", "feat/x"],
    ["git -C /tmp/repo checkout -b feat/x", "feat/x"],
    ["git checkout feat/x", null],
  ];
  for (const [command, want] of cases) {
    it(`${command} -> ${want}`, () => assert.equal(parseCreateBranch(command), want));
  }
});

describe("commandPushesToGit / commandCreatesBranch accept the same git invocations", () => {
  it("recognises git -C <dir> push and checkout -B", () => {
    assert.equal(commandPushesToGit("git -C /tmp/repo push origin feat/x"), true);
    assert.equal(commandCreatesBranch("git checkout -B feat/x"), true);
    assert.equal(commandCreatesBranch("git -C /tmp/repo switch --create feat/x"), true);
    assert.equal(commandPushesToGit('echo "git -C /tmp/repo push"'), false);
  });
});
