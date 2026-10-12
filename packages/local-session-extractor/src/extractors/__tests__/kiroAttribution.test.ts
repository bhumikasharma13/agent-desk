// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectKiroAttribution, mergeWindowedBranches } from "../../internal";
import { SIGNAL_SOURCE, type BranchSignal } from "../../internal";
import { commandCreatesBranch, commandPushesToGit } from "../../internal";
import { normalizeBranch, parseSummaryBranch, parsePushBranch, parseCreateBranch } from "../../internal";

const REPO = "example-org/example-repo";

describe("normalizeBranch — remote-qualified refs", () => {
  it("strips a remote prefix instead of dropping the branch", () => {
    // Kiro's prose names heads this way: "pushed to `origin/feat/x`". Dropping
    // the whole token lost a real branch.
    assert.equal(normalizeBranch("origin/feat/kiro-ide-session-extraction"), "feat/kiro-ide-session-extraction");
    assert.equal(normalizeBranch("upstream/fix/bug-123"), "fix/bug-123");
    // `fork/` is NOT stripped — `fork/redesign` is as plausibly a literal branch
    // name as a remote-qualified ref, so it falls through to validateBranch and
    // is rejected outright. null ("unknown") beats a guessed `redesign`.
    assert.equal(normalizeBranch("fork/redesign"), null);
  });

  it("still rejects a remote-qualified trunk once stripped", () => {
    assert.equal(normalizeBranch("origin/master"), null);
    assert.equal(normalizeBranch("origin/HEAD"), null);
    assert.equal(normalizeBranch("master"), null);
  });

  it("does NOT strip a remote-looking prefix from a command's branch token", () => {
    // A repo can genuinely have a branch called `upstream/sync-deps`. In a
    // command the token IS the branch, so stripping would report `sync-deps` —
    // confidently wrong — where null merely says "unknown".
    assert.equal(parsePushBranch("git push origin upstream/sync-deps"), null);
    assert.equal(parseCreateBranch("git checkout -b origin/mirror-fix"), null);
    // The ordinary case still resolves.
    assert.equal(parsePushBranch("git push origin feat/x"), "feat/x");
  });

  it("keeps a trunk word used as a path prefix", () => {
    // `release/1.2` and `dev/alice` are real feature heads.
    assert.equal(normalizeBranch("release/1.2"), "release/1.2");
    assert.equal(normalizeBranch("dev/alice"), "dev/alice");
  });
});

describe("commandPushesToGit", () => {
  it("ignores a `git push` that only appears inside a quoted string", () => {
    // The separator test alone is quote-blind: the `;` here sits inside a string
    // literal, so counting it would invent a push that never happened.
    assert.equal(commandPushesToGit('echo "run tests; git push"'), false);
    assert.equal(commandPushesToGit("echo 'deploy: git push origin main'"), false);
  });

  it("does not count a push written into a heredoc body", () => {
    // `cat <<EOF > deploy.sh … git push … EOF` writes a file that mentions a
    // push; nothing was pushed.
    assert.equal(commandPushesToGit("cat <<'EOF' > deploy.sh\ngit push\nEOF"), false);
    // …but a real push after the heredoc still counts.
    assert.equal(commandPushesToGit("cat <<EOF > r.md\nremember to git push\nEOF\ngit push origin x"), true);
  });

  it("drops the remainder after an unterminated quote rather than trusting it", () => {
    // A dangling quote leaves the rest unparseable. Naive pair-stripping left it
    // fully visible, so `; git push` matched and invented a push.
    assert.equal(commandPushesToGit('git commit -m "note: remember to; git push after this'), false);
  });

  it("counts a push wrapped in shell control flow or a command prefix", () => {
    // A real push does not stop being one because it sits inside an `if` or is
    // timed. These undercounted while the looser branch parser still recovered
    // the branch, so the same session reported a branch and no push.
    assert.equal(commandPushesToGit("if git push origin feat; then echo ok; fi"), true);
    assert.equal(commandPushesToGit("time git push origin feat"), true);
    assert.equal(commandPushesToGit("while ! git push; do sleep 1; done"), true);
    assert.equal(commandPushesToGit("(cd repo && git push)"), true);
  });

  it("still requires a boundary before the push, not any preceding word", () => {
    // The keyword list is closed on purpose: an open "any word" rule would make
    // the boundary meaningless and match a push named as an argument.
    assert.equal(commandPushesToGit("man git push"), false);
    assert.equal(commandPushesToGit("grep -r git push ."), false);
  });

  it("rejects an unquoted push that is data to another command", () => {
    // Nothing to strip here — the words are unquoted — so only the command
    // position separates `echo git push origin x` from a push that ran.
    assert.equal(commandPushesToGit("echo git push origin other-branch"), false);
    assert.equal(commandPushesToGit("printf 'x' && echo git push origin other"), false);
  });

  it("recognises branch creation in command position only", () => {
    assert.equal(commandCreatesBranch("git checkout -b feat/x"), true);
    assert.equal(commandCreatesBranch("cd repo && git switch -c feat/x"), true);
    assert.equal(commandCreatesBranch("if git checkout -b feat/x; then echo ok; fi"), true);
    assert.equal(commandCreatesBranch("echo git checkout -b other-branch"), false);
    assert.equal(commandCreatesBranch('echo "git switch -c other-branch"'), false);
  });

  it("handles shell quote-escaping without losing a real push", () => {
    assert.equal(commandPushesToGit('echo "a \\" ; git push"'), false);
    // The `'it'\''s` idiom for embedding a quote must not swallow the command.
    assert.equal(commandPushesToGit("echo 'it'\\''s fine' && git push"), true);
  });

  it("still recognises a real push, chained or bare", () => {
    assert.equal(commandPushesToGit("git push origin HEAD"), true);
    assert.equal(commandPushesToGit("cd /tmp/project && git push origin HEAD"), true);
    assert.equal(commandPushesToGit('git commit -m "wip" && git push'), true);
  });
});

describe("collectKiroAttribution", () => {
  it("recovers the branch from the exact prose Kiro writes", () => {
    const out = collectKiroAttribution(
      [{ text: "Done — pushed to `origin/feat/kiro-ide-session-extraction`.", isTurnFinal: true }],
      REPO,
    );
    assert.deepEqual(out.branches, ["feat/kiro-ide-session-extraction"]);
  });

  it("returns every branch the session touched, not just one", () => {
    // git_branches is repeated and BRANCH_MATCH iterates it, so a session that
    // moved between branches should offer all of them.
    const out = collectKiroAttribution([
      { command: "git checkout -b feat/one", ok: true },
      { command: "git push origin feat/two", ok: true },
    ], REPO);
    assert.deepEqual(out.branches.sort(), ["feat/one", "feat/two"]);
  });

  it("ignores a branch that was only printed, never checked out", () => {
    // The command succeeded and the words are unquoted, so neither success nor
    // data-stripping rules it out — only command position does. Recovering it
    // would let BRANCH_MATCH attribute the session to whatever PR heads that
    // branch, which the matcher cannot distinguish from a real checkout.
    const out = collectKiroAttribution([
      { command: "echo git push origin other-branch", ok: true },
      { command: "echo git checkout -b another-branch", ok: true },
    ], REPO);
    assert.deepEqual(out.branches, []);
  });

  it("ignores commands that did not succeed", () => {
    // A failed push published nothing, so it is not evidence of a head.
    const out = collectKiroAttribution([
      { command: "git push origin feat/failed", ok: false },
    ], REPO);
    assert.deepEqual(out.branches, []);
  });

  it("takes a PR ref from gh pr create output, without needing a repo gate", () => {
    const out = collectKiroAttribution([{
      command: "gh pr create --title x --body-file pr-body.md",
      output: "https://github.com/example-org/example-repo/pull/2201\n",
      ok: true,
    }], undefined);
    assert.deepEqual(out.prReferences, [{
      pr_url: "https://github.com/example-org/example-repo/pull/2201",
      pr_number: 2201,
      pr_repository: "example-org/example-repo",
      source: "SIGNAL_SOURCE_SESSION_COMMAND",
    }]);
  });

  it("does not take a PR receipt from a dry run", () => {
    // A dry run created nothing, and its preview echoes the body — which here
    // cites an unrelated PR. Stamping that as a command receipt would be the
    // strongest provenance the system has, on a PR the session never opened.
    const out = collectKiroAttribution([{
      command: `gh pr create --dry-run --title x --body "Context: https://github.com/${REPO}/pull/50"`,
      output: `Would create pull request:\n\nx\n\nContext: https://github.com/${REPO}/pull/50\n`,
      ok: true,
    }], REPO);
    assert.deepEqual(out.prReferences, []);
  });

  it("reads --dry-run as a flag, not as body text that mentions one", () => {
    // Only a top-level flag makes the run a simulation. This command really did
    // open the PR; discarding its receipt leaves a gated session with nothing but
    // its ambient reference, which attributes nothing at all.
    const out = collectKiroAttribution([{
      command: `gh pr create --title "feat: support --dry-run for the seed script" --body x`,
      output: `https://github.com/${REPO}/pull/52\n`,
      ok: true,
    }], REPO);
    assert.equal(out.prReferences.length, 1, "a quoted --dry-run must not suppress a real receipt");
    assert.equal(out.prReferences[0]!.pr_number, 52);
    assert.equal(out.prReferences[0]!.source, "SIGNAL_SOURCE_SESSION_COMMAND");
  });

  it("takes the created PR's own line, not a PR the body merely cites", () => {
    // gh prints the new PR's URL on a line of its own; a URL inside prose is the
    // body being echoed back, and bodies routinely cite a different PR.
    const out = collectKiroAttribution([{
      command: "gh pr create --title x --body-file pr-body.md",
      output: `Warning: supersedes https://github.com/${REPO}/pull/50 per the body\nhttps://github.com/${REPO}/pull/51\n`,
      ok: true,
    }], REPO);
    assert.equal(out.prReferences.length, 1);
    assert.equal(out.prReferences[0]!.pr_number, 51);
    assert.equal(out.prReferences[0]!.source, "SIGNAL_SOURCE_SESSION_COMMAND");
  });

  // Each forge's CLI prints a new PR differently, and only GitHub prints the URL on a
  // bare line. A receipt reader that assumed that shape would stamp nothing for
  // GitLab-subgroup and Bitbucket repos, which reads the same as a repo with no PRs.
  const receipts: Array<{ vendor: string; command: string; output: string; repo: string; num: number }> = [
    {
      vendor: "GitLab (subgroups preserved)",
      command: "glab mr create --fill",
      output: "https://gitlab.com/group/subgroup/project/-/merge_requests/77\n",
      repo: "group/subgroup/project",
      num: 77,
    },
    {
      vendor: "Bitbucket Cloud (JSON body, no bare URL line)",
      command:
        "curl -X POST -H 'Content-Type: application/json' https://api.bitbucket.org/2.0/repositories/team/repo/pullrequests -d '{\"title\":\"x\"}'",
      output: '{"id":88,"links":{"html":{"href":"https://bitbucket.org/team/repo/pull-requests/88"}}}',
      repo: "team/repo",
      num: 88,
    },
    {
      vendor: "Bitbucket Server (projects/KEY/repos/NAME normalized)",
      command:
        "curl -X POST https://bb.corp.example.com/rest/api/1.0/projects/ENG/repos/app/pull-requests --json '{}'",
      output: "Created: https://bb.corp.example.com/projects/ENG/repos/app/pull-requests/99\n",
      repo: "ENG/app",
      num: 99,
    },
  ];

  for (const r of receipts) {
    it(`takes a command receipt from ${r.vendor}`, () => {
      const out = collectKiroAttribution([{ command: r.command, output: r.output, ok: true }], r.repo);
      assert.equal(out.prReferences.length, 1, "the receipt must be recovered");
      assert.equal(out.prReferences[0]!.pr_repository, r.repo);
      assert.equal(out.prReferences[0]!.pr_number, r.num);
      assert.equal(out.prReferences[0]!.source, "SIGNAL_SOURCE_SESSION_COMMAND");
    });
  }

  it("stamps a branch from a push command as session-produced, prose as prose", () => {
    // The distinction the matcher acts on: a branch the session pushed is
    // evidence about this session, while one it merely narrated is weaker. Both
    // scope a search; only the classified ones can support an attribution.
    const out = collectKiroAttribution([
      { command: "git push origin feat/pushed", ok: true },
      // A keyword plus a back-tick-quoted name is the only prose shape
      // parseSummaryBranch accepts; bare prose has no distinguishing form.
      { text: "Summary — branch `feat/narrated` holds the change.", isTurnFinal: true },
    ], REPO);
    assert.deepEqual(out.branchSignals, [
      { name: "feat/pushed", source: "SIGNAL_SOURCE_SESSION_COMMAND" },
      { name: "feat/narrated", source: "SIGNAL_SOURCE_SESSION_PROSE" },
    ]);
    // The bare-name field stays in step, derived from the same list.
    assert.deepEqual(out.branches, ["feat/pushed", "feat/narrated"]);
  });

  it("keeps the stronger source when one branch is both pushed and narrated", () => {
    // Order reversed deliberately: prose is seen first, so a first-wins rule
    // would freeze the weaker reading and understate what we know.
    const out = collectKiroAttribution([
      { text: "Pushed to `feat/x`.", isTurnFinal: true },
      { command: "git push origin feat/x", ok: true },
    ], REPO);
    assert.deepEqual(out.branchSignals, [
      { name: "feat/x", source: "SIGNAL_SOURCE_SESSION_COMMAND" },
    ]);
  });

  it("stamps a prose-recovered PR reference as prose, not as a command receipt", () => {
    const out = collectKiroAttribution([{
      text: `Opened https://github.com/${REPO}/pull/9001 for review.`,
      isTurnFinal: true,
    }], REPO);
    assert.deepEqual(out.prReferences, [{
      pr_url: `https://github.com/${REPO}/pull/9001`,
      pr_number: 9001,
      pr_repository: REPO,
      source: "SIGNAL_SOURCE_SESSION_PROSE",
    }]);
  });

  it("ignores prose that is not the close of a turn", () => {
    // Kiro emits many assistant messages per turn; mid-turn narration routinely
    // quotes PRs the session is only reading about.
    const out = collectKiroAttribution([
      { text: "Looking at https://github.com/example-org/example-repo/pull/999 for context", isTurnFinal: false },
    ], REPO);
    assert.deepEqual(out.prReferences, []);
  });

  it("drops a turn-final PR ref belonging to another repo", () => {
    const out = collectKiroAttribution([
      { text: "See https://github.com/other-org/other-repo/pull/12", isTurnFinal: true },
    ], REPO);
    assert.deepEqual(out.prReferences, []);
  });

  it("dedupes a PR reported by both the command output and the summary", () => {
    const out = collectKiroAttribution([
      {
        command: "gh pr create",
        output: "https://github.com/example-org/example-repo/pull/2201",
        ok: true,
      },
      { text: "Raised https://github.com/example-org/example-repo/pull/2201", isTurnFinal: true },
    ], REPO);
    assert.equal(out.prReferences.length, 1);
  });

  it("does not treat a viewing command's output as an authored PR", () => {
    const out = collectKiroAttribution([{
      command: "gh pr view 2201",
      output: "https://github.com/example-org/example-repo/pull/2201",
      ok: true,
    }], REPO);
    assert.deepEqual(out.prReferences, []);
  });

  it("does not extract a bare prose branch name", () => {
    // Only a structured form (echoed command, or backticks next to a keyword).
    assert.equal(parseSummaryBranch("I worked on the feat/x branch today"), null);
  });
});

// The reflog walk CONTRIBUTES; it never replaces. These pin the rank, which is the
// part most easily got wrong — a reflog read feels more mechanical than prose and
// therefore stronger, but prose is the session's own account of its work while the
// reflog is the workspace's.
describe("mergeWindowedBranches", () => {
  const base = { prReferences: [], branchSignals: [] as BranchSignal[], branches: [] as string[] };
  // Typed so a fixture cannot drift from the union the field actually accepts.
  const bs = (name: string, source: BranchSignal["source"]): BranchSignal => ({ name, source });

  it("adds a branch the transcript never mentioned", () => {
    // The case the transcript cannot cover: a session that switched branches without
    // ever narrating or pushing one.
    const got = mergeWindowedBranches(base, ["feat/only-in-reflog"]);
    assert.deepEqual(got.branchSignals, [
      { name: "feat/only-in-reflog", source: "SIGNAL_SOURCE_LOCAL_GIT_WINDOWED" },
    ]);
    assert.deepEqual(got.branches, ["feat/only-in-reflog"]);
  });

  it("does not lower a branch the session proved by pushing", () => {
    const got = mergeWindowedBranches(
      { ...base, branchSignals: [bs("feat/x", SIGNAL_SOURCE.SESSION_COMMAND)], branches: ["feat/x"] },
      ["feat/x"],
    );
    assert.deepEqual(got.branchSignals, [{ name: "feat/x", source: "SIGNAL_SOURCE_SESSION_COMMAND" }]);
  });

  it("does not lower a branch the session narrated", () => {
    // Ranking the walk above prose would be the tempting error.
    const got = mergeWindowedBranches(
      { ...base, branchSignals: [bs("feat/y", SIGNAL_SOURCE.SESSION_PROSE)], branches: ["feat/y"] },
      ["feat/y"],
    );
    assert.deepEqual(got.branchSignals, [{ name: "feat/y", source: "SIGNAL_SOURCE_SESSION_PROSE" }]);
  });

  it("raises an unclassified entry to the walk's own reading", () => {
    const got = mergeWindowedBranches(
      { ...base, branchSignals: [bs("feat/z", SIGNAL_SOURCE.UNSPECIFIED)], branches: ["feat/z"] },
      ["feat/z"],
    );
    assert.deepEqual(got.branchSignals, [{ name: "feat/z", source: "SIGNAL_SOURCE_LOCAL_GIT_WINDOWED" }]);
  });

  it("is a no-op when the walk found nothing", () => {
    const recovered = { ...base, branchSignals: [bs("feat/a", SIGNAL_SOURCE.SESSION_COMMAND)], branches: ["feat/a"] };
    assert.equal(mergeWindowedBranches(recovered, []), recovered, "same object; nothing to merge");
  });
});
