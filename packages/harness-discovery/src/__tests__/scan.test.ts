// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { log, setLogger, type Logger } from "../log";
import type { ScanResult, ScannedAsset } from "../scan";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const SKILL = "---\nname: review\ndescription: Reviews a change against the house rules before it merges.\n---\nRead the diff.\n";
const AGENTS_MD = "# Agents\n\nRun the tests before you commit.\n";
const CURSOR_RULE = "---\ndescription: House style\n---\nPrefer small functions.\n";
const HOOK_COMMAND = "echo checked";

let root: string;
let home: string;
let repo: string;
let fsmonitorMarker: string;
let scan: typeof import("../scan").scan;
let result: ScanResult;

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

// The test's own git calls keep the fsmonitor off too, so only the scanner could trip the marker.
function run(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.fsmonitor=false", ...args], {
    cwd,
    env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: "ignore",
  });
}

function only(ide: string, type: string): ScannedAsset {
  const matches = result.assets.filter((a) => a.ideType === ide && a.type === type);
  expect(matches, `${ide} ${type}`).toHaveLength(1);
  return matches[0]!;
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "harness-discovery-")));
  home = join(root, "home");
  repo = join(home, "code", "demo");

  write(join(home, ".claude", "settings.json"), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: HOOK_COMMAND }] }] },
  }));
  write(join(repo, ".claude", "skills", "review", "SKILL.md"), SKILL);
  write(join(repo, "AGENTS.md"), AGENTS_MD);
  write(join(repo, ".kiro", "steering", "style.md"), "Keep it short.\n");
  run(repo, "init", "-q", "-b", "main");
  run(repo, "add", ".");
  run(repo, "commit", "-q", "-m", "init");
  // Written after the commit, so it is untracked: repo-local.
  write(join(repo, ".cursor", "rules", "style.mdc"), CURSOR_RULE);

  // A repo-configured command git would run on every index read. Scanning must never run it.
  fsmonitorMarker = join(root, "fsmonitor-ran");
  const fsmonitor = join(root, "fsmonitor.sh");
  writeFileSync(fsmonitor, `#!/bin/sh\ntouch '${fsmonitorMarker}'\n`);
  chmodSync(fsmonitor, 0o755);
  run(repo, "config", "core.fsmonitor", fsmonitor);

  // The scanners resolve some paths from HOME when first loaded.
  process.env.HOME = home;
  ({ scan } = await import("../scan"));
  result = await scan({ repos: [repo, join(root, "missing")] });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("scan — a fixture home with one repo", () => {
  it("reports a committed Claude skill as repo-committed, hashed and baselined", () => {
    const skill = only("claude-code", "skill");
    expect(skill.scope).toBe("repo-committed");
    expect(skill.projectPath).toBe(repo);
    expect(skill.sourcePath).toBe(".claude/skills/review/SKILL.md");
    expect(skill.contentHash).toBe(sha256(SKILL));
    expect(skill.payload.baseline_content_hash).toBe(sha256(SKILL));
  });

  it("reports a committed AGENTS.md for Codex as repo-committed", () => {
    const agentsMd = only("codex", "agents_md");
    expect(agentsMd.scope).toBe("repo-committed");
    expect(agentsMd.sourcePath).toBe("AGENTS.md");
    expect(agentsMd.contentHash).toBe(sha256(AGENTS_MD));
  });

  it("reports an untracked Cursor rule as repo-local, with no baseline", () => {
    const rule = only("cursor", "rule");
    expect(rule.scope).toBe("repo-local");
    expect(rule.sourcePath).toBe(".cursor/rules/style.mdc");
    expect(rule.contentHash).toBe(sha256(CURSOR_RULE));
    expect(rule.payload.baseline_content_hash).toBeUndefined();
  });

  it("reports an inline settings.json hook at user scope, its command as the body", () => {
    const hook = only("claude-code", "hook");
    expect(hook.scope).toBe("user");
    expect(hook.projectPath).toBe("");
    expect(hook.sourcePath).toMatch(/^\.claude\/settings\.json#PreToolUse:[0-9a-f]{12}$/);
    expect(hook.contentHash).toBe(sha256(HOOK_COMMAND));
    expect(hook.payload.inline_body).toBe(HOOK_COMMAND);
    expect(hook.payload.hook_config).toEqual({ event: "PreToolUse", matcher: "Bash", timeoutSeconds: 0 });
  });

  it("derives each id from ide, scope, repo anchor, source path, type and name", () => {
    for (const a of result.assets) {
      const anchor = a.payload.repo_remote_url ?? a.projectPath;
      expect(a.id).toBe(sha256(`${a.ideType}:${a.scope}:${anchor}:${a.sourcePath}:${a.type}:${a.name}`));
    }
  });

  it("finds nothing outside the given home and repos", () => {
    for (const a of result.assets) {
      expect(a.filePath.startsWith(`${root}/`), a.filePath).toBe(true);
    }
  });

  it("reports a missing repo as an error and still scans the rest", () => {
    expect(result.errors).toEqual([{ root: join(root, "missing"), message: "not a directory" }]);
    expect(result.assets.length).toBeGreaterThan(0);
  });

  it("never runs a command the scanned repo's git config names", () => {
    expect(existsSync(fsmonitorMarker)).toBe(false);
    // Positive controls: the scan did run git (the tracked skill has a baseline), and the bait
    // is live (a plain `git ls-files` in the repo runs it).
    expect(only("claude-code", "skill").payload.baseline_content_hash).toBeDefined();
    execFileSync("git", ["ls-files"], { cwd: repo, env: { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1" }, stdio: "ignore" });
    expect(existsSync(fsmonitorMarker)).toBe(true);
    rmSync(fsmonitorMarker);
  });
});

describe("scan — roots", () => {
  it("scans a repo reached through a symlink exactly as its real path", async () => {
    const link = join(root, "link-to-demo");
    symlinkSync(repo, link);
    const viaLink = await scan({ repos: [link], ides: ["claude-code"] });
    const skill = viaLink.assets.find((a) => a.type === "skill")!;
    expect(skill.scope).toBe("repo-committed");
    expect(skill.sourcePath).toBe(".claude/skills/review/SKILL.md");
    expect(skill.id).toBe(only("claude-code", "skill").id);
  });

  it("warns for a linked worktree and a directory inside one, and collects neither", async () => {
    const worktree = join(root, "demo-wt");
    run(repo, "worktree", "add", "-q", worktree);
    const inside = join(worktree, ".claude");
    const scanned = await scan({ repos: [worktree, inside] });
    expect(scanned.warnings.map((w) => w.root)).toEqual([worktree, inside]);
    expect(scanned.warnings[0]!.message).toMatch(/linked worktree or a submodule/);
    expect(scanned.assets.filter((a) => a.scope !== "user")).toEqual([]);
  });

  it("never scans the home directory as a repo, even when HOME is a symlinked path", async () => {
    const homeLink = join(root, "home-link");
    symlinkSync(home, homeLink);
    const previousHome = process.env.HOME;
    process.env.HOME = homeLink;
    try {
      const scanned = await scan({ repos: [home], ides: ["claude-code"] });
      expect(scanned.warnings.map((w) => w.message)).toEqual([expect.stringMatching(/is the home directory/)]);
      expect(scanned.assets.filter((a) => a.scope !== "user")).toEqual([]);
    } finally {
      process.env.HOME = previousHome;
    }
  });

  it("puts back the caller's logger after a scan with its own", async () => {
    const noop = (): void => {};
    const installed: Logger = { debug: noop, info: noop, warn: noop, error: noop };
    const perScan: Logger = { debug: noop, info: noop, warn: noop, error: noop };
    setLogger(installed);
    try {
      await scan({ ides: ["kiro"], logger: perScan });
      expect(log()).toBe(installed);
    } finally {
      setLogger(null);
    }
  });
});
