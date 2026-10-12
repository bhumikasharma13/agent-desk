// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePRUrl, findPRUrlInText } from "../../internal";

describe("parsePRUrl", () => {
  it("parses a GitHub PR URL", () => {
    assert.deepEqual(parsePRUrl("https://github.com/org/repo/pull/5"), {
      pr_url: "https://github.com/org/repo/pull/5",
      pr_number: 5,
      pr_repository: "org/repo",
    });
  });

  it("parses a GitLab MR URL preserving subgroups", () => {
    assert.deepEqual(parsePRUrl("https://gitlab.com/group/sub/proj/-/merge_requests/42"), {
      pr_url: "https://gitlab.com/group/sub/proj/-/merge_requests/42",
      pr_number: 42,
      pr_repository: "group/sub/proj",
    });
  });

  it("parses a Bitbucket PR URL", () => {
    const got = parsePRUrl("https://bitbucket.org/team/repo/pull-requests/7");
    assert.equal(got?.pr_number, 7);
    assert.equal(got?.pr_repository, "team/repo");
  });

  it("returns null for a non-PR URL and for empty input", () => {
    assert.equal(parsePRUrl("https://github.com/org/repo"), null);
    assert.equal(parsePRUrl(""), null);
  });

  it("does not over-capture the repo on a deep path containing /pull/", () => {
    // A file-tree URL that merely contains /pull/N is not a PR — must not yield
    // a corrupted pr_repository like "org/repo/tree/main".
    assert.equal(parsePRUrl("https://github.com/org/repo/tree/main/pull/5"), null);
    assert.equal(parsePRUrl("https://bitbucket.org/team/repo/src/main/pull-requests/7"), null);
  });

  it("captures exactly the two-segment repo for a real GitHub/Bitbucket PR", () => {
    assert.equal(parsePRUrl("https://github.com/org/repo/pull/5")?.pr_repository, "org/repo");
    assert.equal(parsePRUrl("https://bitbucket.org/team/repo/pull-requests/7")?.pr_repository, "team/repo");
  });

  it("rejects a GitLab blob path whose file route contains /-/merge_requests/", () => {
    // The repo capture must not span an interior `/-/`; otherwise this yields a
    // corrupted pr_repository like "group/proj/-/blob/main".
    assert.equal(parsePRUrl("https://gitlab.com/group/proj/-/blob/main/-/merge_requests/42"), null);
  });

  it("parses a self-hosted Bitbucket Server PR URL, normalizing to KEY/NAME", () => {
    const got = parsePRUrl("https://bb.example.com/projects/KEY/repos/svc/pull-requests/12");
    assert.equal(got?.pr_number, 12);
    // Normalized to the git-remote last-2 form, not the raw projects/.../repos/... path.
    assert.equal(got?.pr_repository, "KEY/svc");
  });
});

describe("findPRUrlInText", () => {
  it("finds the first PR/MR URL across GitHub, GitLab, Bitbucket", () => {
    assert.equal(findPRUrlInText("done: https://github.com/org/repo/pull/9 ok")?.pr_number, 9);
    assert.equal(findPRUrlInText("https://gitlab.com/g/p/-/merge_requests/3")?.pr_repository, "g/p");
    assert.equal(findPRUrlInText("see https://bitbucket.org/t/r/pull-requests/4")?.pr_number, 4);
  });

  it("returns null when no PR URL is present", () => {
    assert.equal(findPRUrlInText("just some text https://example.com/docs"), null);
  });

  it("finds a deeply nested GitLab MR URL (group + 20 subgroups + project)", () => {
    const repo = Array.from({ length: 22 }, (_, i) => "s" + i).join("/");
    const url = `https://gitlab.com/${repo}/-/merge_requests/42`;
    assert.equal(findPRUrlInText(`done ${url}`)?.pr_number, 42);
    assert.equal(findPRUrlInText(`done ${url}`)?.pr_repository, repo);
  });

  it("skips a non-PR first hit to find a real PR URL later in the text", () => {
    // The deep /tree/main/pull/5 path is the first scan hit but parsePRUrl
    // rejects it; the real PR URL after it must still be found.
    const text = "ref https://github.com/org/repo/tree/main/pull/5 then https://github.com/org/repo/pull/9";
    assert.equal(findPRUrlInText(text)?.pr_number, 9);
  });

  it("skips a GitLab blob /-/ decoy to find the real MR later in the text", () => {
    const text =
      "https://gitlab.com/group/proj/-/blob/main/-/merge_requests/42 then https://gitlab.com/group/proj/-/merge_requests/77";
    const got = findPRUrlInText(text);
    assert.equal(got?.pr_number, 77);
    assert.equal(got?.pr_repository, "group/proj");
  });

  // Regression guard: a `\S+?` run-to-anchor made this O(n²) on a blob of many
  // `https://x/` fragments with no PR keyword (tens of seconds at ~1MB). The
  // bounded per-segment pattern is linear; the tight timeout trips if it regresses.
  it("does not blow up on a large keyword-less blob (ReDoS guard)", { timeout: 3000 }, () => {
    assert.equal(findPRUrlInText("https://a/".repeat(200_000)), null);
  });
});
