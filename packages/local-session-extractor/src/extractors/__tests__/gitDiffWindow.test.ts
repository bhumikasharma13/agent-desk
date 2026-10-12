// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A session's diff counts the commits in its window and only the uncommitted
 * changes made during it: re-reading an old session in a repo that is dirty
 * today must not add today's edits to it.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFullSessionDiffStats } from "../../internal";

describe("getFullSessionDiffStats — the session window bounds the uncommitted diff", () => {
  let repo: string;
  const now = Date.now();
  const sessionStart = now - 3 * 60 * 60 * 1000;
  const sessionEnd = now - 2 * 60 * 60 * 1000;
  const iso = (ms: number): string => new Date(ms).toISOString();

  before(() => {
    repo = mkdtempSync(join(tmpdir(), "lse-diff-window-"));
    const git = (env: Record<string, string>, ...args: string[]): void => {
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
        cwd: repo,
        stdio: "ignore",
        env: { ...process.env, ...env },
      });
    };
    git({}, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
    writeFileSync(join(repo, "b.txt"), "one\n");
    git({}, "add", ".");
    const at = iso(sessionStart - 60 * 60 * 1000);
    git({ GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at }, "commit", "-q", "-m", "base");
    // The session commits one line inside its window.
    writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
    git({}, "add", "a.txt");
    const inWindow = iso(sessionStart + 10 * 60 * 1000);
    git({ GIT_AUTHOR_DATE: inWindow, GIT_COMMITTER_DATE: inWindow }, "commit", "-q", "-m", "session work");
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  it("ignores a file edited after the session ended", () => {
    writeFileSync(join(repo, "b.txt"), "one\nlater\nlater\n");
    assert.deepEqual(getFullSessionDiffStats(repo, sessionStart, sessionEnd), {
      linesAdded: 1,
      linesRemoved: 0,
      filesModified: 1,
      gitCommits: 1,
    });
  });

  it("counts a file left uncommitted by the session itself", () => {
    const inWindow = new Date(sessionStart + 20 * 60 * 1000);
    utimesSync(join(repo, "b.txt"), inWindow, inWindow);
    assert.deepEqual(getFullSessionDiffStats(repo, sessionStart, sessionEnd), {
      linesAdded: 3,
      linesRemoved: 0,
      filesModified: 2,
      gitCommits: 1,
    });
  });

  it("with no session start, ignores edits made after the session ended", () => {
    writeFileSync(join(repo, "b.txt"), "one\nlater\nlater\n");
    assert.deepEqual(getFullSessionDiffStats(repo, undefined, sessionEnd), {
      linesAdded: 0,
      linesRemoved: 0,
      filesModified: 0,
      gitCommits: 0,
    });
  });
});
