// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// Symlinks, confinement to HOME and the given repos, and problems that must be reported
// rather than dropped.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { collectClaudeCodeAssets } from "../claudeCode";
import { scan } from "../scan";
import { createCollectSession } from "../session";
import { Fixture, SKILL, git, sha256, write } from "./fixtures";

let fx: Fixture;
let outside: string;

beforeAll(() => {
  fx = new Fixture();
  outside = realpathSync(mkdtempSync(join(tmpdir(), "hd-outside-")));
});
afterAll(() => {
  fx.cleanup();
  rmSync(outside, { recursive: true, force: true });
});
afterEach(() => fx.resetHome());

const messages = (r: { warnings: { path?: string; message: string }[] }) => r.warnings.map((w) => `${w.path}: ${w.message}`);

describe("symlinked entries", () => {
  it("reads a symlinked skill folder and rule file that stay inside HOME", async () => {
    write(join(fx.home, "shared", "linked", "SKILL.md"), SKILL("linked"));
    write(join(fx.home, "shared", "style.md"), "# Style\n");
    mkdirSync(join(fx.home, ".claude", "skills"), { recursive: true });
    mkdirSync(join(fx.home, ".claude", "rules"), { recursive: true });
    symlinkSync(join(fx.home, "shared", "linked"), join(fx.home, ".claude", "skills", "linked"));
    symlinkSync(join(fx.home, "shared", "style.md"), join(fx.home, ".claude", "rules", "style.md"));

    const r = await scan({ ides: ["claude-code"] });

    expect(r.assets.map((a) => `${a.type}:${a.sourcePath}`).sort()).toEqual([
      "rule:.claude/rules/style.md",
      "skill:.claude/skills/linked/SKILL.md",
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("reads a repo skill linked to another folder in the same repo", async () => {
    const repo = fx.repo("linked-in-repo");
    write(join(repo, "skills", "deploy", "SKILL.md"), SKILL("deploy"));
    mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
    symlinkSync(join(repo, "skills", "deploy"), join(repo, ".claude", "skills", "deploy"));

    const r = await scan({ repos: [repo], ides: ["claude-code"] });

    expect(r.assets.map((a) => a.sourcePath)).toEqual([".claude/skills/deploy/SKILL.md"]);
  });

  it("does not read a symlinked skill whose target leaves HOME and the repos, and says so", async () => {
    write(join(outside, "evil", "SKILL.md"), SKILL("evil"));
    mkdirSync(join(fx.home, ".claude", "skills"), { recursive: true });
    const link = join(fx.home, ".claude", "skills", "evil");
    symlinkSync(join(outside, "evil"), link);

    const r = await scan({ ides: ["claude-code"] });

    expect(r.assets).toEqual([]);
    expect(messages(r)).toEqual([`${link}: resolves outside HOME and the scanned repos; not read`]);
  });

  it("treats a sibling directory that shares HOME's name as a prefix as outside HOME", async () => {
    const sibling = `${fx.home}-other`;
    write(join(sibling, "s", "SKILL.md"), SKILL("s"));
    mkdirSync(join(fx.home, ".claude", "skills"), { recursive: true });
    symlinkSync(join(sibling, "s"), join(fx.home, ".claude", "skills", "s"));
    try {
      const r = await scan({ ides: ["claude-code"] });
      expect(r.assets).toEqual([]);
      expect(r.warnings.map((w) => w.message)).toEqual(["resolves outside HOME and the scanned repos; not read"]);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("reports a dangling symlink instead of skipping it silently", async () => {
    mkdirSync(join(fx.home, ".claude", "rules"), { recursive: true });
    const link = join(fx.home, ".claude", "rules", "gone.md");
    symlinkSync(join(fx.home, "nowhere.md"), link);

    const r = await scan({ ides: ["claude-code"] });

    expect(messages(r)).toEqual([`${link}: symlink target unreadable (ENOENT); not read`]);
  });

  it("does not read a fixed-name file (CLAUDE.md) symlinked outside the roots", async () => {
    write(join(outside, "secret.md"), "outside the roots\n");
    const repo = fx.repo("linkout");
    symlinkSync(join(outside, "secret.md"), join(repo, "CLAUDE.md"));

    const r = await scan({ repos: [repo], ides: ["claude-code", "cursor"] });

    expect(r.assets.filter((a) => a.type === "claude_md")).toEqual([]);
    expect(messages(r)).toEqual([`${join(repo, "CLAUDE.md")}: resolves outside HOME and the scanned repos; not read`]);
  });

  it("does not list a config directory (.claude) that is itself a symlink out of the roots", async () => {
    write(join(outside, "claude", "rules", "r.md"), "# r\n");
    const repo = fx.repo("dirlink");
    symlinkSync(join(outside, "claude"), join(repo, ".claude"));

    const r = await scan({ repos: [repo], ides: ["claude-code"] });

    expect(r.assets).toEqual([]);
    expect(r.warnings.map((w) => w.message)).toContain("resolves outside HOME and the scanned repos; not read");
  });

  it("counts a ~/.claude/skills link into an installed plugin once, as the plugin's skill", async () => {
    const install = join(fx.home, ".claude", "plugins", "cache", "tools");
    write(join(install, "skills", "fmt", "SKILL.md"), SKILL("fmt"));
    write(join(fx.home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "tools@market": [{ installPath: install }] } }));
    mkdirSync(join(fx.home, ".claude", "skills"), { recursive: true });
    symlinkSync(join(install, "skills", "fmt"), join(fx.home, ".claude", "skills", "fmt"));

    const r = await scan({ ides: ["claude-code"] });

    const skills = r.assets.filter((a) => a.type === "skill");
    expect(skills).toHaveLength(1);
    expect(skills[0]!.payload.plugin_name).toBe("tools");
  });
});

describe("problems are reported, not dropped", () => {
  it("warns about a settings.json that is not valid JSON", async () => {
    const path = join(fx.home, ".claude", "settings.json");
    write(path, "{ not json");
    const r = await scan({ ides: ["claude-code"] });
    expect(messages(r)).toEqual([`${path}: not valid JSON; skipped`]);
    expect(r.errors).toEqual([]);
  });

  it("warns about a config file whose JSON root is not an object", async () => {
    const path = join(fx.home, ".claude", "settings.json");
    write(path, "[1, 2]");
    const r = await scan({ ides: ["claude-code"] });
    expect(messages(r)).toEqual([`${path}: not a JSON object; skipped`]);
  });

  it("warns about Cursor and Codex hooks.json files that cannot be used", async () => {
    const repo = fx.repo("badhooks");
    write(join(repo, ".cursor", "hooks.json"), "{");
    write(join(repo, ".codex", "hooks.json"), JSON.stringify({ version: 1 }));
    const r = await scan({ repos: [repo], ides: ["cursor", "codex"] });
    expect(messages(r).sort()).toEqual([
      `${join(repo, ".codex", "hooks.json")}: has no \`hooks\` object; skipped`,
      `${join(repo, ".cursor", "hooks.json")}: not valid JSON; skipped`,
    ]);
    expect(r.warnings.map((w) => w.ide).sort()).toEqual(["codex", "cursor"]);
  });

  it("warns about a Kiro agent or hook JSON file that is not valid JSON", async () => {
    const repo = fx.repo("badkiro");
    write(join(repo, ".kiro", "agents", "a.json"), "{");
    write(join(repo, ".kiro", "hooks", "h.json"), "{");
    const r = await scan({ repos: [repo], ides: ["kiro"] });
    expect(r.assets).toEqual([]);
    expect(r.warnings).toHaveLength(2);
  });

  it("reads a file of exactly 1 MiB and refuses one byte more", async () => {
    const repo = fx.repo("cap");
    write(join(repo, "CLAUDE.md"), Buffer.alloc(1024 * 1024, "a"));
    write(join(repo, "AGENTS.md"), Buffer.alloc(1024 * 1024 + 1, "a"));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets.map((a) => a.type)).toEqual(["claude_md"]);
    expect(r.warnings.map((w) => w.path)).toEqual([join(repo, "AGENTS.md")]);
  });

  it("warns about a file over the size cap, and still reports the rest", async () => {
    const repo = fx.repo("big");
    write(join(repo, "CLAUDE.md"), Buffer.alloc(2 * 1024 * 1024, "a"));
    write(join(repo, "AGENTS.md"), "# agents\n");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets.map((a) => a.type)).toEqual(["agents_md"]);
    expect(messages(r)).toEqual([`${join(repo, "CLAUDE.md")}: larger than 1048576 bytes; not read`]);
  });

  it("reports an unreadable repo root as an error", async () => {
    const locked = join(fx.root, "locked");
    write(join(locked, "CLAUDE.md"), "# hi\n");
    chmodSync(locked, 0o000);
    try {
      const r = await scan({ repos: [locked], ides: ["claude-code", "cursor"] });
      expect(r.errors).toEqual([{ root: locked, message: "cannot read directory (EACCES)" }]);
      expect(r.assets).toEqual([]);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("keeps an unreadable root out of scannedKeys when a collector is called directly", async () => {
    const locked = join(fx.root, "locked-direct");
    const open = fx.repo("open-direct");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const session = createCollectSession(() => {});
      await collectClaudeCodeAssets(session, { roots: [{ path: locked, isWorktree: false }, { path: open, isWorktree: false }] });
      // Positive control: the readable root beside it does land in scannedKeys.
      expect([...session.scannedKeys]).toEqual([open]);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("reports a plugin installed outside ~/.claude/plugins through the result, not the console", async () => {
    write(join(fx.home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "p@m": [{ installPath: join(fx.root, "elsewhere") }] } }));
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const r = await scan({ ides: ["claude-code"] });
      expect(spy).not.toHaveBeenCalled();
      expect(r.warnings.map((w) => w.message)).toEqual([
        `plugin "p@m" is installed outside ${join(fx.home, ".claude", "plugins")}; not read`,
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("reports nothing for the ordinary absence of config files", async () => {
    const repo = fx.repo("empty");
    const r = await scan({ repos: [repo] });
    expect(r).toEqual({ schemaVersion: 1, assets: [], warnings: [], errors: [] });
    // Positive control: one present file in the same repo is found by every tool that reads it.
    write(join(repo, "AGENTS.md"), "# Agents\n");
    const again = await scan({ repos: [repo] });
    expect(again.assets.map((a) => a.ideType).sort()).toEqual(["claude-code", "codex", "cursor"]);
    expect(again.warnings).toEqual([]);
  });

  it("hashes the raw bytes of a file even when its frontmatter is CRLF", async () => {
    const repo = fx.repo("crlf-hash");
    const body = "---\r\nname: crlf\r\ndescription: Windows line endings in a skill file.\r\n---\r\nBody.\r\n";
    write(join(repo, ".claude", "skills", "crlf", "SKILL.md"), body);
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    const skill = r.assets.find((a) => a.type === "skill")!;
    expect(skill.name).toBe("crlf");
    expect(skill.contentHash).toBe(sha256(body));
  });
});

describe("git that cannot read a repo, malformed plugin records, raw-byte hashes", () => {
  it("warns when git cannot read a repo it found, instead of reporting everything repo-local silently", async () => {
    const repo = fx.repo("corrupt-index");
    write(join(repo, "CLAUDE.md"), "# rules\n");
    fx.commitAll(repo);
    write(join(repo, ".git", "index"), "garbage");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets.map((a) => a.scope)).toEqual(["repo-local"]);
    expect(r.warnings).toEqual([{ root: repo, message: expect.stringMatching(/^git could not read this repository/) }]);
  });

  it("warns when a repo with commits has no default branch, naming the refs it tried", async () => {
    const repo = join(fx.root, "trunk");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "trunk");
    write(join(repo, "CLAUDE.md"), "# rules\n");
    fx.commitAll(repo);
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets.map((a) => a.scope)).toEqual(["repo-local"]);
    expect(r.warnings).toEqual([{ root: repo, message: expect.stringMatching(/^no default branch \(tried origin\/HEAD, origin\/main, origin\/master, main, master\)/) }]);
  });

  it("reads a tool listed twice in ides once", async () => {
    const repo = fx.repo("ides-twice");
    write(join(repo, ".cursor", "rules", "r.mdc"), "Rule.\n");
    const r = await scan({ repos: [repo], ides: ["cursor", "cursor"] });
    expect(r.assets).toHaveLength(1);
  });

  it("reports an empty repo path as an error instead of scanning the working directory", async () => {
    const r = await scan({ repos: ["", ""], ides: ["claude-code"] });
    expect(r.errors).toEqual([{ root: "", message: "empty path" }]);
  });

  it("reports a repo given twice that is not a directory, or is HOME, once", async () => {
    const missing = join(fx.root, "nope");
    const r = await scan({ repos: [missing, missing, fx.home, fx.home], ides: ["claude-code"] });
    expect(r.errors).toEqual([{ root: missing, message: "not a directory" }]);
    expect(r.warnings).toEqual([{ root: fx.home, message: expect.stringMatching(/is the home directory/) }]);
  });

  it("warns once per repo when git is not on PATH", async () => {
    const repo = fx.repo("git-off-path");
    write(join(repo, "CLAUDE.md"), "# rules\n");
    fx.commitAll(repo);
    const path = process.env.PATH;
    process.env.PATH = join(fx.root, "no-bin");
    try {
      const r = await scan({ repos: [repo] });
      expect(r.warnings).toEqual([{ root: repo, message: expect.stringMatching(/^git could not read this repository/) }]);
    } finally {
      process.env.PATH = path;
    }
  });

  it("skips a plugin entry that is not an object, with a warning, and keeps reading", async () => {
    const pluginsFile = join(fx.home, ".claude", "plugins", "installed_plugins.json");
    write(pluginsFile, JSON.stringify({ plugins: { "x@m": [null] } }));
    write(join(fx.home, ".claude", "CLAUDE.md"), "# mine\n");
    const r = await scan({ ides: ["claude-code"] });
    expect(r.errors).toEqual([]);
    expect(r.assets.map((a) => a.type)).toEqual(["claude_md"]);
    expect(r.warnings).toEqual([{ ide: "claude-code", path: pluginsFile, message: 'plugin "x@m" has an entry that is not an object; skipped' }]);
  });

  it("hashes a file's raw bytes, so two files that differ only in invalid UTF-8 differ", async () => {
    const repo = fx.repo("bytes");
    const a = Buffer.from([0x41, 0xff, 0x0a]);
    const b = Buffer.from([0x41, 0xfe, 0x0a]);
    write(join(repo, ".cursor", "rules", "a.md"), a);
    write(join(repo, ".cursor", "rules", "b.md"), b);
    fx.commitAll(repo);
    const r = await scan({ repos: [repo], ides: ["cursor"] });
    const byPath = Object.fromEntries(r.assets.map((x) => [x.sourcePath, x]));
    expect(byPath[".cursor/rules/a.md"]!.contentHash).toBe(sha256(a));
    expect(byPath[".cursor/rules/b.md"]!.contentHash).toBe(sha256(b));
    expect(byPath[".cursor/rules/a.md"]!.payload.baseline_content_hash).toBe(sha256(a));
  });

  it("keeps the hash of a valid UTF-8 file unchanged", async () => {
    const repo = fx.repo("utf8");
    const body = "---\ndescription: Grüße, valid UTF-8.\n---\nText.\n";
    write(join(repo, ".cursor", "rules", "u.md"), body);
    const r = await scan({ repos: [repo], ides: ["cursor"] });
    expect(r.assets[0]!.contentHash).toBe(sha256(body));
  });
});
