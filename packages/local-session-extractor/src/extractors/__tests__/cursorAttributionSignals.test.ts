// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAuthoringPRCommand, parsePushBranch, parseCreateBranch, parseSummaryBranch, collectCursorAttribution, type AttributionEvent } from "../../internal";

const toolEvent = (over: Partial<AttributionEvent>): AttributionEvent => ({
  role: "assistant",
  text: "",
  status: "completed",
  ...over,
});

describe("isAuthoringPRCommand", () => {
  it("accepts gh pr create / merge and glab mr create", () => {
    assert.ok(isAuthoringPRCommand("gh pr create --fill"));
    assert.ok(isAuthoringPRCommand("gh pr merge 12 --squash"));
    assert.ok(isAuthoringPRCommand("glab mr create --fill"));
  });

  it("rejects viewing commands", () => {
    assert.ok(!isAuthoringPRCommand("gh pr view 12"));
    assert.ok(!isAuthoringPRCommand("gh pr diff 12"));
    assert.ok(!isAuthoringPRCommand("gh pr list"));
  });

  it("accepts a Bitbucket curl POST to the pullrequests collection", () => {
    assert.ok(
      isAuthoringPRCommand(
        "curl -u u:t -X POST https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests -d '{}'"
      )
    );
    assert.ok(
      isAuthoringPRCommand(
        "curl --json '{}' https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests"
      )
    );
    // Client-agnostic: httpie names the method as a positional verb.
    assert.ok(
      isAuthoringPRCommand(
        "http POST https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests title=x"
      )
    );
  });

  it("rejects a Bitbucket GET via httpie (no POST)", () => {
    assert.ok(
      !isAuthoringPRCommand(
        "http GET https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests state==OPEN"
      )
    );
  });

  it("rejects a Bitbucket GET list and a comment POST (not authoring)", () => {
    // GET list (comment flow) — no POST/data flag.
    assert.ok(
      !isAuthoringPRCommand(
        "curl -u u:t https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests?state=OPEN"
      )
    );
    // Comment POST is on the /<n>/comments sub-resource, not the collection.
    assert.ok(
      !isAuthoringPRCommand(
        "curl -X POST https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/7/comments -d '{}'"
      )
    );
  });

  it("rejects Bitbucket sub-resource POSTs on an existing PR (merge/approve/decline)", () => {
    for (const action of ["merge", "approve", "decline"]) {
      assert.ok(
        !isAuthoringPRCommand(
          `curl -X POST https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests/7/${action} -d '{}'`
        ),
        `should reject /${action}`
      );
    }
  });
});

describe("branch parsers", () => {
  it("parsePushBranch reads the refspec, never origin/HEAD", () => {
    assert.equal(parsePushBranch("git push -u origin featX"), "featX");
    assert.equal(parsePushBranch("git push origin HEAD:featX"), "featX");
    assert.equal(parsePushBranch("git push origin jdoe/fix-x"), "jdoe/fix-x");
    assert.equal(parsePushBranch("git push origin"), null);
    assert.equal(parsePushBranch("git push -u origin HEAD"), null);
    assert.equal(parsePushBranch("git push"), null);
  });

  it("parsePushBranch handles non-origin remotes and delete pushes", () => {
    // The branch is the refspec after the remote — a non-origin remote name is not the branch.
    assert.equal(parsePushBranch("git push -u upstream featX"), "featX");
    assert.equal(parsePushBranch("git push upstream HEAD:featX"), "featX");
    // Delete pushes carry no feature head.
    assert.equal(parsePushBranch("git push origin :featX"), null); // refspec delete
    assert.equal(parsePushBranch("git push origin --delete featX"), null); // flag delete
    assert.equal(parsePushBranch("git push -d origin featX"), null);
  });

  it("parsePushBranch skips value-taking options like -o (CI-skip pushes)", () => {
    assert.equal(parsePushBranch("git push -o ci.skip origin feat"), "feat");
    assert.equal(parsePushBranch("git push --push-option=ci.skip origin feat"), "feat");
    assert.equal(parsePushBranch("git push -o ci.skip -u origin feat"), "feat");
  });

  it("allows feature branches whose path prefix is a trunk word, rejects remote-qualified", () => {
    // Trunk *word* as a namespace is a real head; only remote-qualified refs are dropped.
    assert.equal(parsePushBranch("git push origin release/1.2-fix"), "release/1.2-fix");
    assert.equal(parsePushBranch("git push origin dev/alice/fix"), "dev/alice/fix");
    assert.equal(parseSummaryBranch("pushed to `origin/master`"), null);
  });

  it("parseCreateBranch reads -b / -c but not plain checkout", () => {
    assert.equal(parseCreateBranch("git checkout -b featX"), "featX");
    assert.equal(parseCreateBranch("git switch -c featX"), "featX");
    assert.equal(parseCreateBranch("git checkout master"), null);
  });

  it("parseSummaryBranch reads echoed commands and back-tick names, not bare prose", () => {
    assert.equal(
      parseSummaryBranch("Branch: `docs/audit-package` (from `origin/master`)"),
      "docs/audit-package"
    );
    assert.equal(parseSummaryBranch("pushed to `featX`"), "featX");
    assert.equal(parseSummaryBranch("I worked on the feature branch featX today"), null);
    // Remote-qualified trunk refs are not a usable head.
    assert.equal(parseSummaryBranch("pushed to `origin/master`"), null);
    // Delegates to the command parsers when the summary echoes a git command.
    assert.equal(parseSummaryBranch("Then I ran git push origin featX to publish"), "featX");
    assert.equal(parseSummaryBranch("created it with git checkout -b newfeature"), "newfeature");
  });
});

describe("collectCursorAttribution", () => {
  it("captures a PR ref from gh pr create output even when the shell exited non-zero", () => {
    // Tool status completed and the command printed the URL; the exit code does not matter.
    const { prReferences } = collectCursorAttribution(
      [
        toolEvent({
          command: "gh pr create --fill",
          output: "https://github.com/example-org/example-repo/pull/4821\n",
        }),
      ],
      "example-org/example-repo"
    );
    assert.deepEqual(prReferences, [
      {
        pr_url: "https://github.com/example-org/example-repo/pull/4821",
        pr_number: 4821,
        pr_repository: "example-org/example-repo",
      },
    ]);
  });

  it("captures a Bitbucket PR ref from a curl POST response", () => {
    const { prReferences } = collectCursorAttribution(
      [
        toolEvent({
          command:
            "curl -X POST https://api.bitbucket.org/2.0/repositories/ws/repo/pullrequests -d '{}'",
          output: '{"url":"https://bitbucket.org/ws/repo/pull-requests/12"}',
        }),
      ],
      "ws/repo"
    );
    assert.equal(prReferences.length, 1);
    assert.equal(prReferences[0]!.pr_number, 12);
    assert.equal(prReferences[0]!.pr_repository, "ws/repo");
  });

  it("does NOT capture a URL from gh pr view output (viewing, not authoring)", () => {
    const { prReferences } = collectCursorAttribution(
      [
        toolEvent({
          command: "gh pr view 9 --json url",
          output: "https://github.com/example-org/example-repo/pull/9",
        }),
      ],
      "example-org/example-repo"
    );
    assert.equal(prReferences.length, 0);
  });

  it("accepts a same-repo summary URL but drops a different-repo one (repo-scope gate)", () => {
    const same = collectCursorAttribution(
      [{ role: "assistant", text: "PR is open: https://github.com/example-org/example-repo/pull/5" }],
      "example-org/example-repo"
    );
    assert.equal(same.prReferences.length, 1);

    const diff = collectCursorAttribution(
      [{ role: "assistant", text: "see https://github.com/someone-else/other/pull/5" }],
      "example-org/example-repo"
    );
    assert.equal(diff.prReferences.length, 0);
  });

  it("repo-scopes tool-output refs too: a cross-repo gh pr create is dropped", () => {
    const { prReferences } = collectCursorAttribution(
      [
        toolEvent({
          command: "gh pr create --fill",
          output: "https://github.com/other-org/other/pull/3",
        }),
      ],
      "example-org/example-repo"
    );
    assert.equal(prReferences.length, 0);
  });

  it("when repoName is undefined: keeps tool-output refs, drops summary refs", () => {
    const { prReferences } = collectCursorAttribution(
      [
        toolEvent({
          command: "gh pr create --fill",
          output: "https://github.com/example-org/example-repo/pull/1",
        }),
        { role: "assistant", text: "see https://github.com/example-org/example-repo/pull/2" },
      ],
      undefined
    );
    // Tool output is authoritative even without a repo gate; summary needs the gate.
    assert.deepEqual(
      prReferences.map((r) => r.pr_number),
      [1]
    );
  });

  it("only parses the CLOSING summary, not a mid-conversation PR URL", () => {
    const { prReferences } = collectCursorAttribution(
      [
        // Mid-conversation: agent discusses a same-repo PR it viewed — must NOT attribute.
        { role: "assistant", text: "Looking at https://github.com/example-org/example-repo/pull/99 for context" },
        toolEvent({ command: "gh pr view 99" }),
        // Closing summary carries no PR URL.
        { role: "assistant", text: "Done — refactored the helper." },
      ],
      "example-org/example-repo"
    );
    assert.equal(prReferences.length, 0);
  });

  it("ignores a branch from a cancelled/failed push command", () => {
    const cancelled = collectCursorAttribution(
      [toolEvent({ status: "cancelled", command: "git push origin featX" })],
      "example-org/example-repo"
    );
    assert.equal(cancelled.branch, null);
    const ok = collectCursorAttribution(
      [toolEvent({ command: "git push origin featX" })],
      "example-org/example-repo"
    );
    assert.equal(ok.branch, "featX");
  });

  it("skips a tool call that did not complete", () => {
    const { prReferences } = collectCursorAttribution(
      [
        toolEvent({
          // Cursor's real failure spelling. The gate is `status === "completed"`, so any
          // non-completed spelling exercises the same branch; the real one keeps the corpus honest.
          status: "error",
          command: "gh pr create --fill",
          output: "https://github.com/example-org/example-repo/pull/4821",
        }),
      ],
      "example-org/example-repo"
    );
    assert.equal(prReferences.length, 0);
  });

  it("dedupes repeated refs and picks branch by precedence (push > create > summary)", () => {
    const { prReferences, branch } = collectCursorAttribution(
      [
        toolEvent({ command: "git checkout -b local-name" }),
        toolEvent({
          command: "gh pr create --fill",
          output: "https://github.com/example-org/example-repo/pull/4821",
        }),
        toolEvent({ command: "git push origin featX" }),
        { role: "assistant", text: "PR: https://github.com/example-org/example-repo/pull/4821 on `summaryBranch`" },
      ],
      "example-org/example-repo"
    );
    assert.equal(prReferences.length, 1); // deduped across tool output + summary
    assert.equal(branch, "featX"); // push wins over checkout -b and summary
  });
});
