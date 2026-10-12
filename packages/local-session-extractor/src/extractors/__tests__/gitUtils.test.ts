// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { setHomeOverride, parseRepoName, parseGitConfigRemoteUrl, findGitRoot, resolveProjectAndRepo, parseNumstat, getFullSessionDiffStats, getSessionPRLink, canonicalRepoKey, findPRNumberInCommitText, prLinkFromCommitRef, recoverWindowedBranches, parseCheckoutReflog } from "../../internal";

// ── Integration test helpers ─────────────────────────────────────────────────

/**
 * Creates a temp git repo, runs fn(repoPath), then deletes the repo.
 * The repo is pre-configured with a test identity so commits work without
 * a global git config.
 */
function withTempRepo(fn: (repoPath: string, git: (...args: string[]) => void, writeAndCommit: (filename: string, lines: string[], msg: string, date?: string) => void) => void): void {
  const repoPath = mkdtempSync(join(tmpdir(), "lse-gitdiff-test-"));
  try {
    const git = (...args: string[]) => {
      execFileSync("git", args, { cwd: repoPath, stdio: ["ignore", "ignore", "ignore"] });
    };
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");

    /** Writes a file with the given lines and commits it. date (ISO) pins the commit time. */
    const writeAndCommit = (filename: string, lines: string[], msg: string, date?: string) => {
      const filePath = join(repoPath, filename);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, lines.join("\n") + "\n");
      git("add", filename);
      const env = date
        ? { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }
        : process.env;
      execFileSync("git", ["commit", "-m", msg], { cwd: repoPath, stdio: "ignore", env });
    };

    fn(repoPath, git, writeAndCommit);
  } finally {
    rmSync(repoPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

describe("canonicalRepoKey", () => {
  it("reduces a full GitLab subgroup path to last-2, lowercased", () => {
    assert.equal(canonicalRepoKey("group/sub/proj"), "sub/proj");
    assert.equal(canonicalRepoKey("Group/Sub/Proj"), "sub/proj");
  });

  it("leaves a two-segment repo unchanged (but lowercased)", () => {
    assert.equal(canonicalRepoKey("org/repo"), "org/repo");
    assert.equal(canonicalRepoKey("Org/Repo"), "org/repo");
  });

  it("returns undefined for fewer than two segments or empty/undefined", () => {
    assert.equal(canonicalRepoKey("single"), undefined);
    assert.equal(canonicalRepoKey(""), undefined);
    assert.equal(canonicalRepoKey(undefined), undefined);
  });

  it("matches a subgroup MR path against the git-remote last-2", () => {
    assert.equal(canonicalRepoKey("group/sub/proj"), canonicalRepoKey("sub/proj"));
  });
});

describe("parseRepoName", () => {
  it("parses SSH colon format", () => {
    assert.equal(parseRepoName("git@github.com:example-org/example-repo.git"), "example-org/example-repo");
  });

  it("parses SSH colon format without .git", () => {
    assert.equal(parseRepoName("git@github.com:example-org/example-repo"), "example-org/example-repo");
  });

  it("parses HTTPS format", () => {
    assert.equal(parseRepoName("https://github.com/example-org/example-repo.git"), "example-org/example-repo");
  });

  it("parses HTTPS format without .git", () => {
    assert.equal(parseRepoName("https://github.com/example-org/example-repo"), "example-org/example-repo");
  });

  it("parses SSH slash format", () => {
    assert.equal(parseRepoName("ssh://git@github.com/example-org/example-repo.git"), "example-org/example-repo");
  });

  it("parses enterprise GitHub URLs", () => {
    assert.equal(
      parseRepoName("https://github.example.com/team/project.git"),
      "team/project"
    );
  });

  it("parses GitLab/Bitbucket URLs", () => {
    assert.equal(parseRepoName("git@gitlab.com:org/repo.git"), "org/repo");
    assert.equal(parseRepoName("https://bitbucket.org/org/repo.git"), "org/repo");
  });

  it("handles subgroup paths by taking last two segments", () => {
    assert.equal(
      parseRepoName("https://gitlab.com/group/subgroup/repo.git"),
      "subgroup/repo"
    );
  });

  it("returns undefined for empty string", () => {
    assert.equal(parseRepoName(""), undefined);
  });

  it("returns undefined for single-segment path", () => {
    assert.equal(parseRepoName("https://github.com/repo.git"), undefined);
  });

  it("returns undefined for local file path", () => {
    assert.equal(parseRepoName("/Users/dev/repos/core"), undefined);
  });
});

describe("parseGitConfigRemoteUrl", () => {
  it("extracts origin URL from standard config", () => {
    const config = `[core]
\trepositoryformatversion = 0
\tfilemode = true
[remote "origin"]
\turl = git@github.com:example-org/example-repo.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "master"]
\tremote = origin`;
    assert.equal(parseGitConfigRemoteUrl(config), "git@github.com:example-org/example-repo.git");
  });

  it("extracts HTTPS URL", () => {
    const config = `[remote "origin"]
\turl = https://github.com/example-org/example-repo.git
\tfetch = +refs/heads/*:refs/remotes/origin/*`;
    assert.equal(parseGitConfigRemoteUrl(config), "https://github.com/example-org/example-repo.git");
  });

  it("returns undefined when no remote origin section", () => {
    const config = `[core]
\trepositoryformatversion = 0
[remote "upstream"]
\turl = git@github.com:other/repo.git`;
    assert.equal(parseGitConfigRemoteUrl(config), undefined);
  });

  it("returns undefined for empty config", () => {
    assert.equal(parseGitConfigRemoteUrl(""), undefined);
  });

  it("ignores other remotes", () => {
    const config = `[remote "upstream"]
\turl = git@github.com:upstream/repo.git
[remote "origin"]
\turl = git@github.com:example-org/example-repo.git`;
    assert.equal(parseGitConfigRemoteUrl(config), "git@github.com:example-org/example-repo.git");
  });

  it("handles url with spaces around equals", () => {
    const config = `[remote "origin"]
\turl = git@github.com:example-org/example-repo.git`;
    assert.equal(parseGitConfigRemoteUrl(config), "git@github.com:example-org/example-repo.git");
  });
});

describe("findGitRoot", () => {
  it("finds the git root from a subdirectory of a repo", () => {
    withTempRepo((repoPath) => {
      const sub = join(repoPath, "a", "b");
      mkdirSync(sub, { recursive: true });
      assert.equal(findGitRoot(sub), repoPath);
    });
  });

  it("returns undefined for a path with no git repo", () => {
    assert.equal(findGitRoot("/tmp"), undefined);
  });

  it("never takes the home folder, or a folder above it, as the repo of a folder inside home", () => {
    // A dotfiles repo at ~/.git must not swallow every non-git project under ~.
    const base = mkdtempSync(join(tmpdir(), "git-home-"));
    const home = join(base, "home");
    const project = join(home, "notes", "sub");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(home, ".git"));
    mkdirSync(join(base, ".git"));
    setHomeOverride(home);
    try {
      assert.equal(findGitRoot(project), undefined);
      rmSync(join(home, ".git"), { recursive: true });
      assert.equal(findGitRoot(home), undefined, "home looks in itself only, never above");
      mkdirSync(join(home, ".git"));
      assert.equal(findGitRoot(home), home, "home itself can still be its own repo");
      mkdirSync(join(home, "notes", ".git"));
      assert.equal(findGitRoot(project), join(home, "notes"), "a repo below home is still found");
    } finally {
      setHomeOverride(undefined);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("resolves `..` in the path before deciding it is inside home", () => {
    const base = mkdtempSync(join(tmpdir(), "git-home-dotdot-"));
    const home = join(base, "home");
    mkdirSync(join(home, ".git"), { recursive: true });
    mkdirSync(join(base, ".git"));
    setHomeOverride(home);
    try {
      assert.equal(findGitRoot(`${home}/a/../proj`), undefined, "home/proj never takes home as its repo");
      assert.equal(findGitRoot(`${home}/../../elsewhere/x`), undefined, "the walk starts where the path points, not through home's parent");
      mkdirSync(join(home, "proj", ".git"), { recursive: true });
      assert.equal(findGitRoot(`${home}/a/../proj/sub`), join(home, "proj"), "the repo comes back as a plain path");
    } finally {
      setHomeOverride(undefined);
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("resolveProjectAndRepo — the repo name", () => {
  it("resolves org/repo from a repo's origin remote", () => {
    withTempRepo((repoPath, git) => {
      git("remote", "add", "origin", "git@github.com:example-org/example-repo.git");
      assert.equal(resolveProjectAndRepo(repoPath)?.repoName, "example-org/example-repo");
    });
  });
});

describe("parseNumstat", () => {
  it("parses standard lines", () => {
    const output = "14\t3\tsrc/foo.ts\n5\t0\tsrc/bar.ts";
    const entries = parseNumstat(output);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], { added: 14, removed: 3, file: "src/foo.ts" });
    assert.deepEqual(entries[1], { added: 5, removed: 0, file: "src/bar.ts" });
  });

  it("handles binary files (- - filename)", () => {
    const output = "-\t-\tassets/image.png";
    const entries = parseNumstat(output);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], { added: 0, removed: 0, file: "assets/image.png" });
  });

  it("skips blank lines", () => {
    const output = "10\t2\tsrc/a.ts\n\n3\t1\tsrc/b.ts\n";
    assert.equal(parseNumstat(output).length, 2);
  });

  it("skips malformed lines with fewer than 3 tab-separated parts", () => {
    const output = "10\t2\n5\t1\tsrc/ok.ts";
    const entries = parseNumstat(output);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.file, "src/ok.ts");
  });

  it("returns empty array for empty output", () => {
    assert.deepEqual(parseNumstat(""), []);
    assert.deepEqual(parseNumstat("   "), []);
  });
});

describe("getFullSessionDiffStats", () => {
  it("returns all-zeros for a path with no git repo", () => {
    const stats = getFullSessionDiffStats("/tmp", undefined, Date.now());
    assert.deepEqual(stats, { linesAdded: 0, linesRemoved: 0, filesModified: 0, gitCommits: 0 });
  });

  it("returns all-zeros for a non-existent path", () => {
    const stats = getFullSessionDiffStats("/nonexistent/path/xyz", undefined, Date.now());
    assert.deepEqual(stats, { linesAdded: 0, linesRemoved: 0, filesModified: 0, gitCommits: 0 });
  });

  it("counts the uncommitted diff when startMs is undefined (uncommitted-only mode)", () => {
    withTempRepo((repoPath, _git, writeAndCommit) => {
      writeAndCommit("a.txt", ["one"], "init");
      writeFileSync(join(repoPath, "a.txt"), "one\ntwo\n");
      const stats = getFullSessionDiffStats(repoPath, undefined, Date.now());
      assert.deepEqual(stats, { linesAdded: 1, linesRemoved: 0, filesModified: 1, gitCommits: 0 });
    });
  });
});

// ── Integration tests: exact values via controlled temp git repos ─────────────

describe("getFullSessionDiffStats — integration (controlled git repo)", () => {
  it("reports exact line counts for lines added in a commit during the session", () => {
    withTempRepo((repoPath, _git, writeAndCommit) => {
      // Baseline commit before session starts (pinned to the past)
      writeAndCommit("readme.md", ["# Project"], "initial", "2020-01-01T00:00:00Z");

      const startMs = Date.now() - 5000;
      writeAndCommit("src/foo.ts", ["line1", "line2", "line3", "line4", "line5"], "add foo.ts");
      const endMs = Date.now() + 5000;

      const stats = getFullSessionDiffStats(repoPath, startMs, endMs);
      assert.equal(stats.linesAdded, 5, "should count the 5 added lines");
      assert.equal(stats.linesRemoved, 0);
      assert.equal(stats.filesModified, 1);
    });
  });

  it("reports exact line counts for lines removed in a commit during the session", () => {
    withTempRepo((repoPath, _git, writeAndCommit) => {
      // Baseline: file with 5 lines, committed before session
      writeAndCommit("src/foo.ts", ["line1", "line2", "line3", "line4", "line5"], "initial", "2020-01-01T00:00:00Z");

      const startMs = Date.now() - 5000;
      // Remove 3 lines — overwrite the file with only 2
      writeAndCommit("src/foo.ts", ["line1", "line2"], "remove lines");
      const endMs = Date.now() + 5000;

      const stats = getFullSessionDiffStats(repoPath, startMs, endMs);
      assert.equal(stats.linesRemoved, 3, "should count the 3 removed lines");
      assert.equal(stats.linesAdded, 0);
      assert.equal(stats.filesModified, 1);
    });
  });

  it("counts multiple modified files correctly", () => {
    withTempRepo((repoPath, _git, writeAndCommit) => {
      writeAndCommit("readme.md", ["# Project"], "initial", "2020-01-01T00:00:00Z");

      const startMs = Date.now() - 5000;
      writeAndCommit("src/a.ts", ["a1", "a2"], "add a");
      writeAndCommit("src/b.ts", ["b1", "b2", "b3"], "add b");
      const endMs = Date.now() + 5000;

      const stats = getFullSessionDiffStats(repoPath, startMs, endMs);
      assert.equal(stats.filesModified, 2, "should count 2 modified files");
      assert.equal(stats.linesAdded, 5, "2 + 3 lines added");
    });
  });

  it("counts uncommitted (dirty) changes in the working tree", () => {
    withTempRepo((repoPath, _git, writeAndCommit) => {
      writeAndCommit("readme.md", ["# Project"], "initial", "2020-01-01T00:00:00Z");

      // Write but do NOT commit — dirty working tree
      mkdirSync(join(repoPath, "src"), { recursive: true });
      writeFileSync(join(repoPath, "src/bar.ts"), "line1\nline2\nline3\n");
      execFileSync("git", ["add", "src/bar.ts"], { cwd: repoPath, stdio: "ignore" });

      // The only commit is from 2020, outside the window: only the dirty file,
      // edited inside the window, counts.
      const stats = getFullSessionDiffStats(repoPath, Date.now() - 60000, Date.now() + 60000);
      assert.equal(stats.linesAdded, 3, "should count 3 uncommitted lines");
      assert.equal(stats.filesModified, 1);
    });
  });

  it("combines committed and uncommitted changes without double-counting files", () => {
    withTempRepo((repoPath, _git, writeAndCommit) => {
      writeAndCommit("readme.md", ["# Project"], "initial", "2020-01-01T00:00:00Z");

      const startMs = Date.now() - 5000;
      // Committed: add 2 lines to src/a.ts
      writeAndCommit("src/a.ts", ["a1", "a2"], "add a");
      // Uncommitted: add 3 more lines to a different file
      mkdirSync(join(repoPath, "src"), { recursive: true });
      writeFileSync(join(repoPath, "src/b.ts"), "b1\nb2\nb3\n");
      execFileSync("git", ["add", "src/b.ts"], { cwd: repoPath, stdio: "ignore" });
      const endMs = Date.now() + 5000;

      const stats = getFullSessionDiffStats(repoPath, startMs, endMs);
      assert.equal(stats.linesAdded, 5, "2 committed + 3 uncommitted");
      assert.equal(stats.filesModified, 2, "2 distinct files, no double-count");
    });
  });

  it("returns zeros when no commits fall within the session window", () => {
    withTempRepo((repoPath, _git, writeAndCommit) => {
      // All commits are pinned to the past, far outside the session window
      writeAndCommit("src/a.ts", ["line1", "line2"], "old commit", "2020-01-01T00:00:00Z");

      // Session window is 1 hour from now — no commits, clean working tree
      const startMs = Date.now() + 3600000;
      const endMs = startMs + 3600000;

      const stats = getFullSessionDiffStats(repoPath, startMs, endMs);
      assert.deepEqual(stats, { linesAdded: 0, linesRemoved: 0, filesModified: 0, gitCommits: 0 });
    });
  });

  it("handles the initial commit (no prior history) correctly", () => {
    withTempRepo((repoPath, _git, writeAndCommit) => {
      // No baseline — this IS the first commit in the repo
      const startMs = Date.now() - 5000;
      writeAndCommit("src/new.ts", ["x1", "x2", "x3"], "initial commit");
      const endMs = Date.now() + 5000;

      const stats = getFullSessionDiffStats(repoPath, startMs, endMs);
      assert.equal(stats.linesAdded, 3, "initial commit lines should be counted");
      assert.equal(stats.filesModified, 1);
    });
  });
});

describe("getSessionPRLink — multi-VCS URL detection (integration)", () => {
  const commitDate = "2026-06-15T12:00:00Z";
  const startMs = Date.parse(commitDate) - 1000;
  const endMs = Date.parse(commitDate) + 1000;

  it("detects a GitLab merge-request URL in a session-window commit", () => {
    withTempRepo((repoPath, _git, writeAndCommit) => {
      writeAndCommit(
        "a.ts",
        ["x"],
        "feat: thing\n\nSee https://gitlab.com/group/sub/proj/-/merge_requests/42",
        commitDate
      );
      assert.deepEqual(getSessionPRLink(repoPath, startMs, endMs), {
        prUrl: "https://gitlab.com/group/sub/proj/-/merge_requests/42",
        prNumber: 42,
        prRepository: "group/sub/proj",
      });
    });
  });

  it("detects a Bitbucket pull-request URL", () => {
    withTempRepo((repoPath, _git, writeAndCommit) => {
      writeAndCommit("b.ts", ["x"], "fix\n\nhttps://bitbucket.org/team/repo/pull-requests/7", commitDate);
      const got = getSessionPRLink(repoPath, startMs, endMs);
      assert.equal(got?.prNumber, 7);
      assert.equal(got?.prRepository, "team/repo");
    });
  });

  it("still detects a GitHub PR URL (parity with the old GitHub-only scan)", () => {
    withTempRepo((repoPath, _git, writeAndCommit) => {
      writeAndCommit("c.ts", ["x"], "chore\n\nhttps://github.com/org/repo/pull/99", commitDate);
      const got = getSessionPRLink(repoPath, startMs, endMs);
      assert.equal(got?.prNumber, 99);
      assert.equal(got?.prRepository, "org/repo");
    });
  });

  it("multi-commit window: URL from the newer commit wins over URL from an older commit", () => {
    // git log is newest-first. Per-commit scan ensures the URL from the commit
    // nearest session-end (first in log output) is returned, not a URL buried
    // in an older commit's body that happens to appear later in the log string.
    const olderDate = new Date(Date.parse(commitDate) - 60_000).toISOString();
    withTempRepo((repoPath, _git, writeAndCommit) => {
      // Older commit (appears second in git log) with a stale PR URL.
      writeAndCommit("a.ts", ["x"], "stale\n\nhttps://github.com/org/repo/pull/50", olderDate);
      // Newer commit (appears first in git log) with the actual session PR URL.
      writeAndCommit("b.ts", ["x"], "feat: actual PR\n\nhttps://github.com/org/repo/pull/99", commitDate);
      const got = getSessionPRLink(repoPath, startMs, endMs);
      assert.equal(got?.prNumber, 99, "newer commit's PR URL should win");
    });
  });
});

// The commit-message fallback exists because some teams record the PR only in the
// commit trailer. Its host handling is load-bearing: a number names no host, so the
// link is built for the repo's own forge, never github.com by default.
describe("commit-message PR reference — every platform, not just GitHub", () => {
  it("reads each vendor's own footer form", () => {
    // GitHub, GitLab and Bitbucket each write their own footer form.
    assert.equal(findPRNumberInCommitText("Merge pull request #123 from feat/x"), 123);
    assert.equal(findPRNumberInCommitText("Fix rounding (#4821)"), 4821);
    assert.equal(findPRNumberInCommitText("Fixes #77"), 77);
    assert.equal(findPRNumberInCommitText("See merge request group/project!456"), 456);
    assert.equal(findPRNumberInCommitText("Merged in feature/x (pull request #88)"), 88);
    // A bare `!` is too common in prose to spend a reference on.
    assert.equal(findPRNumberInCommitText("This broke!42 things"), undefined);
    assert.equal(findPRNumberInCommitText("no reference here"), undefined);
  });

  it("does not read a mid-sentence PR citation as a reference, in ANY vendor dialect", () => {
    // A merge form counts only as a commit's SUBJECT, and a trailer only with its
    // lead-in keyword — so a citation in the body is prose about a PR, not a claim
    // to have merged it. Matching one mints a confidence-1.0 DIRECT_PR_REF, and on
    // an ungated IDE nothing re-examines that. Every vendor shape is
    // checked, because closing the class for only `pull request` left the same
    // sentence exploitable one keystroke away in the others.
    const prose = [
      // bare "pull request #N" in a body
      "fix: address review\n\nStacked on pull request #2201; do not merge first.",
      // the SAME sentence parenthesised — the Bitbucket footer's shape, in prose
      "fix: restore the null check\n\nRegression from the parser refactor (pull request #2201).",
      // a body line that happens to START with the GitHub merge subject
      "revert: parser rewrite\n\nMerge pull request #2201 broke the nightly build; reverting it here.",
      // the GitLab dialect of the same citation
      "fix: rebase onto main\n\nStacked on merge request !2201; do not merge first.",
      "Reverts part of pull request #2201",
      "Superseded by pull request #99",
    ];
    for (const t of prose) assert.equal(findPRNumberInCommitText(t), undefined, t);

    // The real forms still read — a merge subject with a body after it, and a
    // Bitbucket merge whose subject IS the parenthesised line (as Bitbucket writes
    // it, never buried in a body).
    assert.equal(findPRNumberInCommitText("Merge pull request #123 from feat/x\n\nbody"), 123);
    assert.equal(findPRNumberInCommitText("Merged in feature/x (pull request #88)\n\nbody"), 88);
    // A trailer keeps working from the body, with its lead-in.
    assert.equal(findPRNumberInCommitText("chore: sync\n\nCloses #55"), 55);
  });

  const cases: Array<{ name: string; remote: string; want: { url: string; repo: string } }> = [
    {
      name: "GitHub",
      remote: "git@github.com:org/app.git",
      want: { url: "https://github.com/org/app/pull/7", repo: "org/app" },
    },
    {
      name: "GitHub Enterprise keeps its own host",
      remote: "https://github.corp.example.com/org/app.git",
      want: { url: "https://github.corp.example.com/org/app/pull/7", repo: "org/app" },
    },
    {
      name: "GitLab uses /-/merge_requests and keeps subgroups",
      remote: "git@gitlab.com:group/subgroup/project.git",
      want: {
        url: "https://gitlab.com/group/subgroup/project/-/merge_requests/7",
        repo: "group/subgroup/project",
      },
    },
    {
      name: "Bitbucket Cloud uses /pull-requests",
      remote: "https://bitbucket.org/team/repo.git",
      want: { url: "https://bitbucket.org/team/repo/pull-requests/7", repo: "team/repo" },
    },
    {
      name: "Bitbucket Server browses at /projects/KEY/repos/NAME, not its /scm/ clone path",
      remote: "https://bb.corp.example.com/scm/ENG/app.git",
      want: {
        url: "https://bb.corp.example.com/projects/ENG/repos/app/pull-requests/7",
        repo: "ENG/app",
      },
    },
  ];

  for (const c of cases) {
    it(`builds the right shape for ${c.name}`, () => {
      const got = prLinkFromCommitRef(c.remote, 7);
      assert.equal(got?.prUrl, c.want.url);
      assert.equal(got?.prRepository, c.want.repo);
      assert.equal(got?.prNumber, 7);
    });
  }

  it("drops an ssh:// remote's SSH port rather than pointing the browse URL at it", () => {
    // Bitbucket Server clones over 7999, which serves no web UI.
    const got = prLinkFromCommitRef("ssh://git@bb.corp.example.com:7999/ENG/app.git", 7);
    assert.equal(got?.prUrl, "https://bb.corp.example.com/ENG/app/pull/7");
  });

  it("returns null rather than a fiction when the remote names no repo", () => {
    assert.equal(prLinkFromCommitRef("git@github.com:core.git", 7), null);
    assert.equal(prLinkFromCommitRef("", 7), null);
    assert.equal(prLinkFromCommitRef("not a remote at all", 7), null);
  });
});

// ── time-bound branch recovery, against real git ────────────────────────────
//
// Section 5.3 does not close on reasoning: it names seven cases that must pass
// against a real `git` invocation, because this design has already been bitten once
// by a reflog field that read correctly and behaved differently (%gd vs %cI). Each
// `it` below is one of those rows.
//
// Reflog entry times come from the committer date, so gitAt() pins them and the
// window can be asserted at real instants rather than at "now".
function withReflogRepo(
  fn: (
    repoPath: string,
    gitAt: (iso: string, ...args: string[]) => void,
    gitAtIn: (cwd: string, iso: string, ...args: string[]) => void,
  ) => void,
): void {
  const repoPath = mkdtempSync(join(tmpdir(), "lse-reflog-test-"));
  try {
    const gitAtIn = (cwd: string, iso: string, ...args: string[]): void => {
      execFileSync("git", args, {
        cwd,
        stdio: ["ignore", "ignore", "ignore"],
        env: { ...process.env, GIT_COMMITTER_DATE: iso, GIT_AUTHOR_DATE: iso },
      });
    };
    const gitAt = (iso: string, ...args: string[]): void => gitAtIn(repoPath, iso, ...args);
    // -b pins the trunk name: git's default is version- and config-dependent, so a
    // test that says "master" fails on a machine defaulting to main for a reason
    // that has nothing to do with what it asserts.
    gitAt("2026-01-01T00:00:00+00:00", "init", "-b", "main");
    gitAt("2026-01-01T00:00:00+00:00", "config", "user.email", "test@example.com");
    gitAt("2026-01-01T00:00:00+00:00", "config", "user.name", "Test");
    writeFileSync(join(repoPath, "seed.txt"), "seed\n");
    gitAt("2026-01-01T00:00:00+00:00", "add", "seed.txt");
    gitAt("2026-01-01T00:00:00+00:00", "commit", "-m", "seed");
    fn(repoPath, gitAt, gitAtIn);
  } finally {
    rmSync(repoPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const ms = (iso: string): number => Date.parse(iso);

describe("recoverWindowedBranches — real git reflog", () => {
  it("records BOTH branches when the session switched mid-way", () => {
    // The union, not the last entry: a session that moved feat/a → feat/b worked on
    // both, and taking only the final checkout reintroduces a single-value collapse.
    withReflogRepo((repoPath, gitAt) => {
      gitAt("2026-06-01T09:00:00+00:00", "checkout", "-b", "feat/a");
      gitAt("2026-06-01T10:00:00+00:00", "checkout", "-b", "feat/b");
      const got = recoverWindowedBranches(repoPath, ms("2026-06-01T08:30:00+00:00"), ms("2026-06-01T11:00:00+00:00"));
      assert.deepEqual([...got].sort(), ["feat/a", "feat/b"]);
    });
  });

  it("supplies `before` from moved_from when the reflog is trimmed below session start", () => {
    // A reflog holding only the session's own entries has no pre-session record, yet
    // `checkout: moving from feat/work to feat/other` still names feat/work
    // explicitly. Without it a session that began on the work branch and switched
    // away mid-window reports only where it went.
    withReflogRepo((repoPath, gitAt) => {
      gitAt("2026-06-01T08:00:00+00:00", "checkout", "-b", "feat/work");
      gitAt("2026-06-01T09:30:00+00:00", "checkout", "-b", "feat/other");
      // Window opens AFTER the feat/work checkout, so `before` is unavailable and the
      // oldest in-window entry's moved_from has to supply it.
      const got = recoverWindowedBranches(repoPath, ms("2026-06-01T09:00:00+00:00"), ms("2026-06-01T10:00:00+00:00"));
      assert.deepEqual([...got].sort(), ["feat/other", "feat/work"]);
    });
  });

  it("reports the branch in effect when the session switched nothing", () => {
    // The common case: no in-window entry at all, yet the session plainly ran
    // somewhere. `before` carries it.
    withReflogRepo((repoPath, gitAt) => {
      gitAt("2026-06-01T07:00:00+00:00", "checkout", "-b", "feat/steady");
      const got = recoverWindowedBranches(repoPath, ms("2026-06-01T09:00:00+00:00"), ms("2026-06-01T10:00:00+00:00"));
      assert.deepEqual(got, ["feat/steady"]);
    });
  });

  it("emits nothing when the reflog holds no checkout entries", () => {
    // A fresh clone or an expired reflog must produce ABSENCE, never a live HEAD
    // read — an ambient guess is the thing this walk exists to remove.
    withReflogRepo((repoPath) => {
      assert.deepEqual(recoverWindowedBranches(repoPath, ms("2026-06-01T09:00:00+00:00"), ms("2026-06-01T10:00:00+00:00")), []);
    });
  });

  it("emits nothing outside a git repo rather than guessing", () => {
    const plain = mkdtempSync(join(tmpdir(), "lse-norepo-"));
    try {
      assert.deepEqual(recoverWindowedBranches(plain, ms("2026-06-01T09:00:00+00:00"), ms("2026-06-01T10:00:00+00:00")), []);
    } finally {
      rmSync(plain, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("rejects a detached checkout so the literal HEAD never enters the set", () => {
    withReflogRepo((repoPath, gitAt) => {
      gitAt("2026-06-01T09:00:00+00:00", "checkout", "-b", "feat/real");
      // Detaching writes "moving from feat/real to <sha>"; neither HEAD nor a hex id
      // is a branch.
      gitAt("2026-06-01T09:30:00+00:00", "checkout", "--detach");
      const got = recoverWindowedBranches(repoPath, ms("2026-06-01T08:00:00+00:00"), ms("2026-06-01T10:00:00+00:00"));
      assert.ok(!got.includes("HEAD"), "the literal HEAD must never be recorded as a branch");
      assert.deepEqual(got, ["feat/real"]);
    });
  });

  it("rejects an explicit commit checkout, not just a bare --detach", () => {
    // Verified against real git: `--detach` writes "moving from feat/x to HEAD" (which
    // validateBranch catches), but `git checkout <sha>` writes the resolved 40-hex id
    // — and the reverse move writes that id as moved_from. A hex id is not a branch
    // name any candidate can carry, so admitting it puts a value in the branch set
    // that can never match, silently.
    withReflogRepo((repoPath, gitAt) => {
      gitAt("2026-06-01T09:00:00+00:00", "checkout", "-b", "feat/real");
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }).trim();
      gitAt("2026-06-01T09:20:00+00:00", "checkout", sha);
      gitAt("2026-06-01T09:40:00+00:00", "checkout", "feat/real");
      const got = recoverWindowedBranches(repoPath, ms("2026-06-01T08:00:00+00:00"), ms("2026-06-01T10:00:00+00:00"));
      assert.deepEqual(got, ["feat/real"], `a commit id must never be recorded as a branch, got ${JSON.stringify(got)}`);
    });
  });

  it("excludes a checkout made after the session's last message", () => {
    // The drift this whole subsection removes: a checkout the developer made after
    // the session ended but before the poll must not be admitted. This is why the
    // window's end is the DECLARED last message, not the wider lookupEnd.
    withReflogRepo((repoPath, gitAt) => {
      gitAt("2026-06-01T09:00:00+00:00", "checkout", "-b", "feat/during");
      gitAt("2026-06-01T18:00:00+00:00", "checkout", "-b", "feat/after-the-fact");
      const got = recoverWindowedBranches(repoPath, ms("2026-06-01T08:30:00+00:00"), ms("2026-06-01T10:00:00+00:00"));
      assert.deepEqual(got, ["feat/during"]);
      assert.ok(!got.includes("feat/after-the-fact"));
    });
  });

  it("compares window edges as instants, not as wall-clock strings", () => {
    // The entry is written under +09:00; the window is expressed in UTC. The same
    // moment must land inside it — a string comparison would put 18:00+09:00 outside
    // a window ending 10:00Z even though it is 09:00Z.
    withReflogRepo((repoPath, gitAt) => {
      gitAt("2026-06-01T18:00:00+09:00", "checkout", "-b", "feat/offset");
      const got = recoverWindowedBranches(repoPath, ms("2026-06-01T08:00:00+00:00"), ms("2026-06-01T10:00:00+00:00"));
      assert.deepEqual(got, ["feat/offset"], "09:00Z written as 18:00+09:00 is inside an 08:00–10:00Z window");
    });
  });

  it("reads a linked worktree's own reflog, not its parent clone's", () => {
    // findGitRoot resolves a worktree to its PARENT, so running the walk there would
    // answer for a checkout the session never touched. A worktree keeps its own HEAD
    // reflog under .git/worktrees/<name>.
    withReflogRepo((repoPath, gitAt, gitAtIn) => {
      gitAt("2026-06-01T09:00:00+00:00", "checkout", "-b", "feat/in-parent-only");
      const wt = join(repoPath, "..", `wt-${Date.now()}`);
      try {
        gitAt("2026-06-01T09:10:00+00:00", "worktree", "add", "-b", "feat/wt-base", wt);
        // A checkout made INSIDE the worktree is what writes a `checkout:` entry to
        // .git/worktrees/<name>/logs/HEAD. `worktree add` itself writes a `branch:`
        // entry, which is not a checkout and carries no moved-from/to pair.
        gitAtIn(wt, "2026-06-01T09:15:00+00:00", "checkout", "-b", "feat/in-worktree");
        const got = recoverWindowedBranches(wt, ms("2026-06-01T08:00:00+00:00"), ms("2026-06-01T10:00:00+00:00"));
        assert.ok(got.includes("feat/in-worktree"), `expected the worktree's own branch, got ${JSON.stringify(got)}`);
        assert.ok(
          !got.includes("feat/in-parent-only"),
          "the parent clone's checkout must not leak into a worktree session",
        );
      } finally {
        rmSync(wt, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      }
    });
  });

  it("never emits a remote-qualified or trunk name", () => {
    // Ref-name normalization: matchBranch does a raw map lookup on the exact string,
    // so a remote-qualified name silently misses every candidate. validateBranch is
    // the same admissibility every other producer applies — trunks rejected too.
    assert.deepEqual(
      parseCheckoutReflog(
        "HEAD@{2026-06-01T09:00:00+00:00}|checkout: moving from main to feat/x\n" +
          "HEAD@{2026-06-01T09:30:00+00:00}|checkout: moving from feat/x to master\n",
      ).map((e) => e.movedTo),
      ["feat/x", "master"],
      "the parser reports what git said; admissibility is applied by the walk",
    );
    withReflogRepo((repoPath, gitAt) => {
      gitAt("2026-06-01T09:00:00+00:00", "checkout", "-b", "feat/keep");
      // main, matching the trunk the harness pins with `init -b main`.
      gitAt("2026-06-01T09:30:00+00:00", "checkout", "main");
      const got = recoverWindowedBranches(repoPath, ms("2026-06-01T08:00:00+00:00"), ms("2026-06-01T10:00:00+00:00"));
      assert.deepEqual(got, ["feat/keep"], "a trunk the session switched to is not attribution evidence");
    });
  });
});
