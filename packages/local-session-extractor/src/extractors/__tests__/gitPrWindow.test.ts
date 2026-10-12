// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A PR is recovered from commit messages only inside the session's own time
 * window: with no known session start there is no window, so no commit-message
 * PR is attributed at all rather than whatever PR the last commits name.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionPRLink } from "../../internal";

describe("getSessionPRLink — the session window", () => {
  let repo: string;
  const now = Date.now();
  const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

  before(() => {
    repo = mkdtempSync(join(tmpdir(), "lse-pr-window-"));
    const git = (env: Record<string, string>, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd: repo, stdio: "ignore", env: { ...process.env, ...env } });
    git({}, "init", "-q", "-b", "main");
    git({}, "remote", "add", "origin", "git@github.com:example-org/example-repo.git");
    writeFileSync(join(repo, "a.txt"), "x\n");
    git({}, "add", "a.txt");
    const at = new Date(monthAgo).toISOString();
    git({ GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }, "commit", "-q", "-m", "Merge pull request #7 from example-org/old-work");
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  it("attributes no PR when the session start is unknown", () => {
    assert.equal(getSessionPRLink(repo, undefined, now), null);
  });

  it("does not reach a PR merged long before the session", () => {
    assert.equal(getSessionPRLink(repo, now - 60 * 60 * 1000, now), null);
  });

  it("finds the PR merged inside the session window", () => {
    const link = getSessionPRLink(repo, monthAgo - 60_000, monthAgo + 60_000);
    assert.equal(link?.prNumber, 7);
  });
});
