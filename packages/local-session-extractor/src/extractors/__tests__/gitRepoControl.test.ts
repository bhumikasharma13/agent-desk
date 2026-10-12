// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The git a scan runs reads a repository; it runs none of the commands the repository's
 * own config names that a flag can turn off, writes nothing into it, and answers for the
 * repository it was pointed at whatever `GIT_*` variable the host process carries.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFullSessionDiffStats, getGitHeadSha, getSessionPRLink, recoverWindowedBranches } from "../../internal";

const tmp = mkdtempSync(join(tmpdir(), "lse-git-repo-control-"));
after(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
}

/** A repository with a.txt and b.txt committed, a.txt then given one more line. */
function dirtyRepo(name: string): string {
  const repo = join(tmp, name);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  writeFileSync(join(repo, "b.txt"), "b\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  writeFileSync(join(repo, "a.txt"), "a\nb\n");
  return repo;
}

/** An executable that creates `marker` and passes its input through. */
function markerScript(name: string): { script: string; marker: string } {
  const script = join(tmp, `${name}.sh`);
  const marker = join(tmp, `${name}-ran`);
  writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
  chmodSync(script, 0o755);
  return { script, marker };
}

const ONE_LINE_ADDED = { linesAdded: 1, linesRemoved: 0, filesModified: 1, gitCommits: 0 };

describe("git — a repository's own config runs nothing", () => {
  it("does not run the repository's fsmonitor, and still counts its uncommitted diff", () => {
    const repo = dirtyRepo("fsmonitor");
    const { script, marker } = markerScript("fsmonitor");
    git(repo, "config", "core.fsmonitor", script);
    git(repo, "diff", "HEAD", "--numstat");
    assert.ok(existsSync(marker), "the fixture's fsmonitor runs under a plain git diff");
    rmSync(marker);

    assert.deepEqual(getFullSessionDiffStats(repo, undefined, Date.now()), ONE_LINE_ADDED);
    assert.equal(existsSync(marker), false, "the diff ran the repository's fsmonitor");
  });

  it("leaves .git/index as it was, and so runs no post-index-change hook", () => {
    const repo = dirtyRepo("index");
    const { script, marker } = markerScript("post-index-change");
    writeFileSync(join(repo, ".git", "hooks", "post-index-change"), readFileSync(script));
    chmodSync(join(repo, ".git", "hooks", "post-index-change"), 0o755);
    // b.txt's content is unchanged, but its time is not the one the index recorded: a plain
    // `git diff` refreshes that entry and writes the index back.
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(repo, "b.txt"), past, past);
    const index = join(repo, ".git", "index");
    const before = { bytes: readFileSync(index), mtimeMs: statSync(index).mtimeMs };

    assert.deepEqual(getFullSessionDiffStats(repo, undefined, Date.now()), ONE_LINE_ADDED);
    assert.equal(statSync(index).mtimeMs, before.mtimeMs, "the diff rewrote .git/index");
    assert.ok(readFileSync(index).equals(before.bytes), "the diff changed .git/index");
    assert.equal(existsSync(marker), false, "the diff ran the repository's post-index-change hook");

    git(repo, "diff", "HEAD", "--numstat");
    assert.ok(existsSync(marker), "the fixture's hook runs when a plain git diff rewrites the index");
  });

  describe("a signed commit under log.showSignature", () => {
    let repo: string;
    let marker: string;
    const now = Date.now();

    before(() => {
      repo = dirtyRepo("signed");
      const gpg = markerScript("gpg");
      marker = gpg.marker;
      // A commit carrying a signature header, made now, then checked out onto a branch so the
      // reflog has a checkout entry pointing at it.
      const tree = git(repo, "rev-parse", "HEAD^{tree}").trim();
      const parent = git(repo, "rev-parse", "HEAD").trim();
      const at = `${Math.floor(now / 1000)} +0000`;
      const body = `tree ${tree}\nparent ${parent}\nauthor t <t@example.com> ${at}\ncommitter t <t@example.com> ${at}\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\nsigned\n`;
      const signed = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: repo, input: body, encoding: "utf8" }).trim();
      git(repo, "update-ref", "HEAD", signed);
      git(repo, "checkout", "-q", "-b", "feat/signed");
      git(repo, "config", "log.showSignature", "true");
      git(repo, "config", "gpg.program", gpg.script);
      git(repo, "log", "--format=%H", "-1");
      assert.ok(existsSync(marker), "the fixture's gpg.program runs under a plain git log");
      rmSync(marker);
    });

    it("runs no gpg.program for the commits in the session window", () => {
      assert.equal(getFullSessionDiffStats(repo, now - 60_000, now + 60_000).gitCommits, 2);
      getSessionPRLink(repo, now - 60_000, now + 60_000);
      assert.equal(existsSync(marker), false, "git log ran the repository's gpg.program");
    });

    it("runs no gpg.program for the reflog walk", () => {
      assert.deepEqual(recoverWindowedBranches(repo, now - 60_000, now + 60_000), ["feat/signed"]);
      assert.equal(existsSync(marker), false, "git reflog ran the repository's gpg.program");
    });
  });
});

describe("git — the host's GIT_* variables", () => {
  it("answers for the repository it runs in, with GIT_DIR naming another", () => {
    const repo = dirtyRepo("own");
    const other = join(tmp, "other");
    mkdirSync(other);
    git(other, "init", "-q");
    writeFileSync(join(other, "x.txt"), "x\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "other");
    const head = git(repo, "rev-parse", "HEAD").trim();

    const saved = process.env["GIT_DIR"];
    process.env["GIT_DIR"] = join(other, ".git");
    try {
      assert.equal(getGitHeadSha(repo), head);
      assert.deepEqual(getFullSessionDiffStats(repo, undefined, Date.now()), ONE_LINE_ADDED);
    } finally {
      if (saved === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = saved;
    }
  });

  it("still reads the config file GIT_CONFIG_GLOBAL names, which only chooses a file to read", () => {
    const repo = dirtyRepo("global");
    // The global config names an attributes file that marks *.txt as binary, so the dirty
    // a.txt counts no lines; git reading some other global config would count one.
    writeFileSync(join(tmp, "binary.attributes"), "*.txt -diff\n");
    writeFileSync(join(tmp, "global.gitconfig"), `[core]\n\tattributesFile = ${join(tmp, "binary.attributes")}\n`);
    const saved = process.env["GIT_CONFIG_GLOBAL"];
    process.env["GIT_CONFIG_GLOBAL"] = join(tmp, "global.gitconfig");
    try {
      assert.equal(getFullSessionDiffStats(repo, undefined, Date.now()).linesAdded, 0);
    } finally {
      if (saved === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
      else process.env["GIT_CONFIG_GLOBAL"] = saved;
    }
  });
});
