// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../../store/SessionStore";
import { extractClaudeCode } from "../../internal";
import { setPathOverrides } from "../pathResolver";

// patchProjectMetadata's attempt memo suppresses re-parsing an UNCHANGED
// transcript whose row is still missing repo_name — but resolution also depends
// on EXTERNAL git state (a checkout restored, `git init`, a remote added later
// — under the cwd OR under a tool-touched path). The memo therefore stores the
// failed attempt's resolution inputs (cwd + a capped tool-path sample) and, on
// a hit, probes them with the same fs-only resolution the full attempt uses:
// git state materializing under either input drops the memo and the full
// attempt reruns, so a repo appearing later is never permanently missed.
// The probe is THROTTLED per entry (PATCH_PROBE_THROTTLE_MS) so a dormant
// backlog costs bounded steady-state work — the Date is mocked here to step
// across throttle windows deterministically.

// Comfortably past PATCH_PROBE_THROTTLE_MS (30 minutes).
const PAST_THROTTLE_MS = 31 * 60 * 1000;

function transcriptLine(cwd: string | null, sessionId = "s1", toolFilePath?: string): string {
  const assistantContent: unknown[] = [{ type: "text", text: "hi" }];
  if (toolFilePath) {
    assistantContent.unshift({ type: "tool_use", id: "tu-1", name: "Edit", input: { file_path: toolFilePath } });
  }
  return (
    JSON.stringify({
      type: "user",
      uuid: "m1",
      timestamp: "2026-04-01T10:00:00.000Z",
      sessionId,
      ...(cwd !== null ? { cwd } : {}),
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    }) +
    "\n" +
    JSON.stringify({
      type: "assistant",
      uuid: "m2",
      timestamp: "2026-04-01T10:00:05.000Z",
      sessionId,
      message: {
        id: "r1",
        role: "assistant",
        content: assistantContent,
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 5, output_tokens: 5 },
      },
    }) +
    "\n"
  );
}

describe("patchProjectMetadata — memo retries when git state materializes", () => {
  let projectsRoot: string;
  let workDir: string;
  let dbDir: string;
  let db: SessionStore;
  let clock: number;

  const advancePastThrottle = (): void => {
    clock += PAST_THROTTLE_MS;
    mock.timers.setTime(clock);
  };

  before(() => {
    clock = Date.now();
    mock.timers.enable({ apis: ["Date"], now: clock });
    projectsRoot = mkdtempSync(join(tmpdir(), "lse-patch-projects-"));
    workDir = mkdtempSync(join(tmpdir(), "lse-patch-work-"));
    dbDir = mkdtempSync(join(tmpdir(), "lse-patch-db-"));
    db = new SessionStore(join(dbDir, "test.db"));
    const projDir = join(projectsRoot, "workproj");
    mkdirSync(projDir);
    writeFileSync(join(projDir, "sess1.jsonl"), transcriptLine(workDir));
    setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: projectsRoot });
  });
  after(() => {
    mock.timers.reset();
    setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: undefined });
    db.close();
    for (const d of [projectsRoot, workDir, dbDir]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const repoName = (): string | null =>
    db.getTracking("claude-code", "workproj::sess1")?.repo_name ?? null;

  it("resolves repo_name once the cwd's git state yields one; throttle + remote-less root keep skipping", () => {
    // Cycle 1: full extraction. cwd is a plain dir → project_path set, no repo.
    extractClaudeCode(db);
    assert.equal(repoName(), null, "non-git cwd yields no repo_name");

    // Cycle 2: unchanged file → patch attempt runs, fails the same way, and is
    // memoized with the derived inputs (probe timestamp stamped).
    extractClaudeCode(db);
    assert.equal(repoName(), null, "still unresolved while the cwd has no git state");

    // A remote-less repo appears: past the throttle, the probe runs — a git
    // root now exists but no repo identity is derivable, so the probe must NOT
    // thrash into a full re-attempt and the row stays unresolved.
    execFileSync("git", ["init", "-q"], { cwd: workDir });
    advancePastThrottle();
    extractClaudeCode(db);
    assert.equal(repoName(), null, "a root without a remote yields no repo identity");

    // The remote lands — but we are still INSIDE the throttle window of the
    // probe above, so this cycle must not probe (and must not resolve).
    execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/widget.git"], { cwd: workDir });
    extractClaudeCode(db);
    assert.equal(repoName(), null, "within the throttle window the probe does not run");

    // Past the window: the probe derives a NEW repoName → the memo drops and
    // the full attempt resolves the row. (With a stat-only memo this would
    // skip forever.)
    advancePastThrottle();
    extractClaudeCode(db);
    assert.equal(repoName(), "acme/widget", "materialized repo identity must be picked up");
  });

  it("resolves via a TOOL-TOUCHED path when the repo materializes there (cwd never becomes a root)", () => {
    // The repo appears under a path the session's tools edited, not under the
    // cwd — the probe must mirror the full attempt's inputs (cwd + tool paths),
    // or this row could never backfill until the transcript changes.
    const workDir2 = mkdtempSync(join(tmpdir(), "lse-patch-work2-"));
    const toolDir = mkdtempSync(join(tmpdir(), "lse-patch-tool-"));
    try {
      const toolFile = join(toolDir, "src", "a.ts");
      writeFileSync(
        join(projectsRoot, "workproj", "sess2.jsonl"),
        transcriptLine(workDir2, "s2", toolFile),
      );
      const repo2 = (): string | null =>
        db.getTracking("claude-code", "workproj::sess2")?.repo_name ?? null;

      extractClaudeCode(db); // full extraction — neither dir is a repo
      extractClaudeCode(db); // patch attempt fails; memo records cwd + tool paths
      assert.equal(repo2(), null, "unresolved while no git state exists anywhere");

      // The repo materializes under the TOOL path only.
      execFileSync("git", ["init", "-q"], { cwd: toolDir });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/gadget.git"], { cwd: toolDir });
      advancePastThrottle();
      extractClaudeCode(db);
      assert.equal(repo2(), "acme/gadget", "tool-path-derived repo identity must be picked up");
    } finally {
      rmSync(workDir2, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      rmSync(toolDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("never probes a row with NO transcript-derived inputs (no cwd, no tool paths)", () => {
    // Project dir name encodes a real path (decodeProjectDirName turns
    // "-tmp-x" into "/tmp/x"). If the probe ran for this inputless row, the
    // repo materialized at that decoded path WOULD resolve it — so staying
    // null past the throttle proves the short-circuit.
    const decodedDir = `/tmp/lsepatchnull${process.pid}`;
    const encodedName = decodedDir.replace(/\//g, "-"); // "-tmp-lsepatchnullPID"
    const projDir = join(projectsRoot, encodedName);
    mkdirSync(projDir);
    try {
      writeFileSync(join(projDir, "sess3.jsonl"), transcriptLine(null, "s3"));
      const repo3 = (): string | null =>
        db.getTracking("claude-code", `${encodedName}::sess3`)?.repo_name ?? null;

      extractClaudeCode(db); // full extraction — decoded path doesn't exist yet
      extractClaudeCode(db); // patch attempt fails; memo records cwd:null, toolPaths:[]
      assert.equal(repo3(), null);

      // A repo appears at the decoded path — but the row carries no
      // transcript-derived input, so nothing may probe it.
      mkdirSync(decodedDir, { recursive: true });
      execFileSync("git", ["init", "-q"], { cwd: decodedDir });
      execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/phantom.git"], { cwd: decodedDir });
      advancePastThrottle();
      extractClaudeCode(db);
      assert.equal(repo3(), null, "an inputless row is never probed (static decoded path is not re-checked)");
    } finally {
      rmSync(decodedDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
