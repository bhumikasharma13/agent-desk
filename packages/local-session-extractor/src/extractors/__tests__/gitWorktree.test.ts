// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A session in a linked worktree reports that worktree's own HEAD and diff; its repo name still comes from the main repository's remote.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFullSessionDiffStats, getGitHeadSha, resolveProjectAndRepo } from "../../internal";

describe("git helpers in a linked worktree", () => {
  let tmp: string;
  let main: string;
  let wt: string;
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "lse-worktree-"));
    main = join(tmp, "main");
    wt = join(tmp, "wt");
    execFileSync("git", ["init", "-q", "-b", "main", main]);
    writeFileSync(join(main, "a.txt"), "one\n");
    git(main, "add", "a.txt");
    git(main, "commit", "-q", "-m", "init");
    git(main, "remote", "add", "origin", "git@github.com:example-org/example-repo.git");
    git(main, "worktree", "add", "-q", "-b", "feature", wt);
    writeFileSync(join(wt, "b.txt"), "x\ny\n");
    git(wt, "add", "b.txt");
    git(wt, "commit", "-q", "-m", "feature work");
    writeFileSync(join(wt, "a.txt"), "one\ntwo\n");
  });
  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("reports the worktree's HEAD", () => {
    assert.equal(getGitHeadSha(wt), git(wt, "rev-parse", "HEAD"));
    assert.notEqual(getGitHeadSha(wt), getGitHeadSha(main));
  });

  it("diffs the worktree's own uncommitted changes", () => {
    assert.deepEqual(getFullSessionDiffStats(wt, undefined, Date.now()), { linesAdded: 1, linesRemoved: 0, filesModified: 1, gitCommits: 0 });
    assert.deepEqual(getFullSessionDiffStats(main, undefined, Date.now()), { linesAdded: 0, linesRemoved: 0, filesModified: 0, gitCommits: 0 });
  });

  it("still names the repository from the main checkout's remote", () => {
    assert.equal(resolveProjectAndRepo(wt)?.repoName, "example-org/example-repo");
  });
});
