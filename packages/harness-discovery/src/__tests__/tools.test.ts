// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { __setNestedClaudeMdCapForTest, collectClaudeCodeAssets, collectClaudeCodeRepoAssets, discoverPluginAgentFiles } from "../claudeCode";
import { collectCodexAssets, collectCodexRepoAssets } from "../codex";
import { collectCursorAssets, collectCursorRepoAssets } from "../cursor";
import { collectKiroAssets, collectKiroRepoAssets } from "../kiro";
import { assetSourcePath, harnessAssetId } from "../identity";
import { log, setLogger, type Logger } from "../log";
import { scan } from "../scan";
import { escapeControls, stripTerminalEscapes } from "../sanitize";
import { createCollectSession } from "../session";
import { __setGitRunnerForTest, resolveRepoWinners, stripRemoteCredentials } from "../scanShared";
import { findGitToplevel } from "../git";
import { Fixture, SKILL, git, sha256, write } from "./fixtures";

let fx: Fixture;
beforeAll(() => {
  fx = new Fixture();
});
afterAll(() => fx.cleanup());
afterEach(() => fx.resetHome());

const summary = (assets: { ideType: string; type: string; scope: string; sourcePath: string }[]) =>
  assets.map((a) => `${a.ideType} ${a.type} ${a.scope} ${a.sourcePath}`).sort();

describe("Claude Code plugins", () => {
  function installPlugin(enabled: boolean) {
    const install = join(fx.home, ".claude", "plugins", "cache", "market", "tools", "1.0.0");
    write(join(install, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "tools", version: "1.0.0" }));
    write(join(install, "skills", "fmt", "SKILL.md"), SKILL("fmt"));
    write(join(install, "commands", "lint.md"), "---\ndescription: Lints the change set before commit.\n---\n");
    write(join(install, "rules", "style.md"), "# Style\n");
    write(join(install, "agents", "reviewer.md"), "---\nname: reviewer\n---\nReviews.\n");
    write(join(install, "hooks", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo bye" }] }] } }));
    write(join(fx.home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "tools@market": [{ installPath: install, version: "1.0.0" }] } }));
    write(join(fx.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "tools@market": enabled } }));
    return install;
  }

  it("reports each asset a plugin contributes, and the plugin with its counts", async () => {
    installPlugin(true);
    const r = await scan({ ides: ["claude-code"] });
    expect(r.assets.map((a) => [a.type, a.name, a.payload.invocation ?? ""]).sort()).toEqual([
      ["agent", "reviewer", "tools:reviewer"],
      ["command", "Lint", "/tools:lint"],
      ["hook", "Stop: echo bye", ""],
      ["plugin", "tools", ""],
      ["rule", "Style", ""],
      ["skill", "fmt", "/fmt"],
    ]);
    const plugin = r.assets.find((a) => a.type === "plugin")!;
    expect(plugin.sourcePath).toBe(".claude/plugins/cache/market/tools/1.0.0/.claude-plugin/plugin.json");
    expect(plugin.payload.plugin_asset_counts).toEqual({ skills: 1, commands: 1, rules: 1, hooks: 1, agents: 1 });
    expect(r.assets.every((a) => a.payload.operational_state === "enabled")).toBe(true);
  });

  it("marks every asset of a disabled plugin disabled", async () => {
    installPlugin(false);
    const r = await scan({ ides: ["claude-code"] });
    expect(new Set(r.assets.map((a) => a.payload.operational_state))).toEqual(new Set(["disabled"]));
  });

  it("uses the registry line as the plugin body when it has no manifest or README", async () => {
    const install = join(fx.home, ".claude", "plugins", "cache", "bare");
    mkdirSync(install, { recursive: true });
    write(join(fx.home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "bare@m": [{ installPath: install, version: "3" }] } }));
    const r = await scan({ ides: ["claude-code"] });
    expect(r.assets[0]!.payload.inline_body).toBe("bare@m@3");
  });

  it("finds plugin agents from the manifest and the agents/ dir, never outside the plugin", async () => {
    const install = join(fx.root, "plugin-agents");
    write(join(install, "agents", "a.md"), "# a\n");
    write(join(install, "extra", "b.md"), "# b\n");
    write(join(fx.root, "outside-agent.md"), "# o\n");
    symlinkSync(join(fx.root, "outside-agent.md"), join(install, "agents", "link.md"));
    const found = await discoverPluginAgentFiles(install, { agents: ["./extra/b.md", "../outside-agent.md", "/etc/hosts"] });
    expect(found).toEqual([join(install, "agents", "a.md"), join(install, "extra", "b.md")]);
  });
});

describe("repo scopes", () => {
  it("does not take a home folder that is a git repo (dotfiles) as the repo of a folder in it", async () => {
    git(fx.home, "init", "-q", "-b", "main");
    const notes = join(fx.home, "notes");
    write(join(notes, "AGENTS.md"), "# Notes\n");
    git(fx.home, "add", "-A");
    git(fx.home, "commit", "-q", "-m", "dotfiles");
    const r = await scan({ repos: [notes], ides: ["codex"] });
    const agents = r.assets.find((a) => a.type === "agents_md");
    expect(agents?.projectPath).toBe(notes);
    expect(agents?.sourcePath).toBe("AGENTS.md");
    expect(agents?.scope).toBe("repo-local");
    expect(r.warnings.map((w) => w.message)).toContain("is inside a git repo whose top level is the home directory; scanned as a plain folder");
  });

  it("looks for a folder's git top level no higher than the home folder", () => {
    // A .git above HOME (here in the fixture root) is never looked at for a folder in HOME.
    git(fx.root, "init", "-q", "-b", "main");
    try {
      const plain = join(fx.home, "plain");
      mkdirSync(plain, { recursive: true });
      expect(findGitToplevel(plain)).toBeUndefined();
      expect(findGitToplevel(fx.home)).toBeUndefined();
      git(fx.home, "init", "-q", "-b", "main");
      expect(findGitToplevel(plain)).toBe(fx.home);
    } finally {
      rmSync(join(fx.root, ".git"), { recursive: true, force: true });
    }
  });

  it("scans every immediate subdirectory that carries its own config, however many there are", async () => {
    const repo = fx.repo("wide");
    for (let i = 0; i < 25; i++) mkdirSync(join(repo, `d${String(i).padStart(2, "0")}`));
    write(join(repo, "d24", "CLAUDE.md"), "# package\n");
    write(join(repo, "node_modules", "dep", "CLAUDE.md"), "# ignored\n");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets.map((a) => a.sourcePath)).toEqual(["d24/CLAUDE.md"]);
  });

  it("reports repo-scope config for all four tools with the right scope", async () => {
    const repo = fx.repo("all-tools");
    write(join(repo, ".codex", "agents", "helper.toml"), 'name = "helper"\n');
    write(join(repo, ".codex", "rules", "safe.rules"), "prefix_rule()\n");
    write(join(repo, ".agents", "skills", "shared", "SKILL.md"), SKILL("shared"));
    write(join(repo, ".cursorrules"), "Be brief.\n");
    write(join(repo, ".cursor", "commands", "ship.md"), "# ship\n");
    write(join(repo, ".kiro", "steering", "tech.md"), "---\ninclusion: fileMatch\nfileMatchPattern: '*.ts'\n---\nUse strict mode.\n");
    write(join(repo, ".kiro", "agents", "checker.json"), JSON.stringify({ name: "checker", description: "Runs the checks." }));
    write(join(repo, ".kiro", "agents", "lock.json"), JSON.stringify({ lockfileVersion: 3 }));
    write(join(repo, ".kiro", "hooks", "on-save.kiro.hook"), JSON.stringify({ when: { type: "fileEdited" } }));
    write(join(repo, ".kiro", "hooks", "h.json"), JSON.stringify({ hooks: [{ trigger: "PostFileSave" }] }));
    write(join(repo, ".kiro", "hooks", "notes.json"), JSON.stringify({ notes: [] }));
    write(join(repo, ".claude", "templates", "pr.md"), "# PR template\n");
    fx.commitAll(repo);
    write(join(repo, ".cursor", "rules", "local.mdc"), "---\ndescription: A rule that is not committed yet.\n---\n");

    const r = await scan({ repos: [repo] });

    expect(summary(r.assets)).toEqual([
      "claude-code prompt_template repo-committed .claude/templates/pr.md",
      "codex agent repo-committed .codex/agents/helper.toml",
      "codex rule repo-committed .codex/rules/safe.rules",
      "codex skill repo-committed .agents/skills/shared/SKILL.md",
      "cursor command repo-committed .cursor/commands/ship.md",
      "cursor rule repo-committed .cursorrules",
      "cursor rule repo-local .cursor/rules/local.mdc",
      "kiro agent repo-committed .kiro/agents/checker.json",
      "kiro hook repo-committed .kiro/hooks/h.json",
      "kiro hook repo-committed .kiro/hooks/on-save.kiro.hook",
      "kiro rule repo-committed .kiro/steering/tech.md",
    ]);
    const steering = r.assets.find((a) => a.ideType === "kiro" && a.type === "rule")!;
    expect(steering.payload).toMatchObject({ inclusion_mode: "fileMatch", inclusion_file_match: "*.ts" });
    expect(r.assets.find((a) => a.type === "agent" && a.ideType === "codex")!.name).toBe("helper");
    for (const a of r.assets) {
      expect(a.payload.baseline_content_hash !== undefined, a.sourcePath).toBe(a.scope === "repo-committed");
    }
  });

  it("reports user-scope config for Codex, Cursor and Kiro", async () => {
    write(join(fx.home, ".agents", "skills", "s", "SKILL.md"), SKILL("s"));
    write(join(fx.home, ".cursor", "rules", "tone.mdc"), "Be brief.\n");
    write(join(fx.home, ".cursor", "skills-cursor", "c", "SKILL.md"), SKILL("c"));
    write(join(fx.home, ".kiro", "steering", "product.md"), "Always.\n");
    const r = await scan({ ides: ["codex", "cursor", "kiro"] });
    expect(summary(r.assets)).toEqual([
      "codex skill user .agents/skills/s/SKILL.md",
      "cursor rule user .cursor/rules/tone.mdc",
      "cursor skill user .cursor/skills-cursor/c/SKILL.md",
      "kiro rule user .kiro/steering/product.md",
    ]);
    expect(r.assets.find((a) => a.ideType === "kiro")!.payload.inclusion_mode).toBe("always");
  });

  it("anchors identity on the credential-stripped remote, so two checkouts of one remote collapse", async () => {
    const a = fx.repo("checkout-a");
    const b = fx.repo("checkout-b");
    for (const r of [a, b]) {
      write(join(r, "AGENTS.md"), "# same\n");
      git(r, "remote", "add", "origin", "https://user:token@example.com/org/repo.git");
    }
    const r = await scan({ repos: [a, b], ides: ["codex"] });
    expect(r.assets).toHaveLength(1);
    expect(r.assets[0]!.payload.repo_remote_url).toBe("https://example.com/org/repo.git");
  });
});

describe("activeInAgents", () => {
  it("names another agent carrying a same-named skill, read from the HOME of this scan", async () => {
    write(join(fx.home, ".claude", "skills", "shared", "SKILL.md"), SKILL("shared"));
    write(join(fx.home, ".cursor", "skills-cursor", "shared", "SKILL.md"), SKILL("shared"));
    const r = await scan({ ides: ["claude-code"] });
    expect(r.assets[0]!.payload.active_in_agents).toEqual(["Claude Code", "Cursor"]);
  });

  it("names Codex, not a folder label, for a same-named skill in ~/.agents/skills, which Codex reads", async () => {
    write(join(fx.home, ".claude", "skills", "shared", "SKILL.md"), SKILL("shared"));
    write(join(fx.home, ".agents", "skills", "shared", "SKILL.md"), SKILL("shared"));
    const r = await scan({ ides: ["claude-code", "codex"] });
    expect(r.assets.find((a) => a.ideType === "claude-code")!.payload.active_in_agents).toEqual(["Claude Code", "Codex"]);
    expect(r.assets.filter((a) => a.ideType === "codex").map((a) => a.sourcePath)).toEqual([".agents/skills/shared/SKILL.md"]);
  });

  it("lists a tool once when two of its folders hold the skill", async () => {
    write(join(fx.home, ".claude", "skills", "shared", "SKILL.md"), SKILL("shared"));
    for (const dir of [[".codex", "skills"], [".agents", "skills"], [".cursor", "skills-cursor"], [".cursor", "rules", "skills"]]) {
      write(join(fx.home, ...dir, "shared", "SKILL.md"), SKILL("shared"));
    }
    expect((await scan({ ides: ["claude-code"] })).assets[0]!.payload.active_in_agents).toEqual(["Claude Code", "Cursor", "Codex"]);
  });

  it("follows HOME when it changes between two scans in one process", async () => {
    const other = join(fx.root, "other-home");
    write(join(fx.home, ".claude", "skills", "shared", "SKILL.md"), SKILL("shared"));
    write(join(other, ".claude", "skills", "shared", "SKILL.md"), SKILL("shared"));
    write(join(other, ".kiro", "skills", "shared", "SKILL.md"), SKILL("shared"));
    expect((await scan({ ides: ["claude-code"] })).assets[0]!.payload.active_in_agents).toEqual(["Claude Code"]);
    process.env.HOME = other;
    try {
      expect((await scan({ ides: ["claude-code"] })).assets[0]!.payload.active_in_agents).toEqual(["Claude Code", "Kiro"]);
    } finally {
      process.env.HOME = fx.home;
    }
  });
});

describe("scope", () => {
  it("lists a gitignored file in a tool folder as repo-local, while the any-depth CLAUDE.md search skips it", async () => {
    const repo = fx.repo("ignored-rule");
    write(join(repo, ".gitignore"), ".claude/rules/\nnotes/\n");
    write(join(repo, "README.md"), "# repo\n");
    fx.commitAll(repo);
    write(join(repo, ".claude", "rules", "x.md"), "# local rule\n");
    write(join(repo, "notes", "deep", "CLAUDE.md"), "# ignored notes\n");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(summary(r.assets)).toEqual(["claude-code rule repo-local .claude/rules/x.md"]);
  });

  it("keeps a tracked file that is not on the default branch repo-local, with no baseline", async () => {
    const repo = fx.repo("feature");
    write(join(repo, "CLAUDE.md"), "# on main\n");
    fx.commitAll(repo);
    git(repo, "checkout", "-q", "-b", "feature");
    write(join(repo, "AGENTS.md"), "# only on feature\n");
    fx.commitAll(repo);
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets.map((a) => [a.sourcePath, a.scope, a.payload.baseline_content_hash !== undefined]).sort()).toEqual([
      ["AGENTS.md", "repo-local", false],
      ["CLAUDE.md", "repo-committed", true],
    ]);
  });
});

describe("loggers", () => {
  const mk = (): Logger & { lines: string[] } => {
    const lines: string[] = [];
    const rec = (msg: string) => void lines.push(msg);
    return { lines, debug: rec, info: rec, warn: rec, error: rec };
  };

  it("sends each scan's diagnostics to its own logger and leaves the process logger in place", async () => {
    const installed = mk();
    setLogger(installed);
    try {
      write(join(fx.home, ".claude", "settings.json"), "{");
      const [la, lb] = [mk(), mk()];
      await Promise.all([scan({ ides: ["claude-code"], logger: la }), scan({ ides: ["kiro"], logger: lb })]);
      expect(log()).toBe(installed);
      expect(la.lines).toContain("scan_problem");
      expect(lb.lines).toEqual([]);
      expect(installed.lines).toEqual([]);
    } finally {
      setLogger(null);
    }
  });
});

describe("default branch, tracked set and git caches", () => {
  const baselineOf = async (repo: string, path: string) =>
    (await scan({ repos: [repo], ides: ["claude-code"] })).assets.find((a) => a.sourcePath === path);

  it("takes the baseline from origin/main before a local main that is ahead", async () => {
    const repo = fx.repo("ahead");
    write(join(repo, "CLAUDE.md"), "v1\n");
    fx.commitAll(repo);
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    write(join(repo, "CLAUDE.md"), "v2\n");
    fx.commitAll(repo);
    const a = await baselineOf(repo, "CLAUDE.md");
    expect([a!.scope, a!.payload.baseline_content_hash]).toEqual(["repo-committed", sha256("v1\n")]);
  });

  it("reads a file removed from the index as repo-local, even though the default branch has it", async () => {
    const repo = fx.repo("untracked-again");
    write(join(repo, "CLAUDE.md"), "# rules\n");
    fx.commitAll(repo);
    git(repo, "rm", "-q", "--cached", "CLAUDE.md");
    expect((await baselineOf(repo, "CLAUDE.md"))!.scope).toBe("repo-local");
  });

  it("sees a commit made between two scans", async () => {
    const repo = fx.repo("between");
    write(join(repo, "CLAUDE.md"), "# rules\n");
    fx.commitAll(repo);
    await scan({ repos: [repo], ides: ["claude-code"] });
    write(join(repo, "AGENTS.md"), "# agents\n");
    fx.commitAll(repo);
    expect((await baselineOf(repo, "AGENTS.md"))!.scope).toBe("repo-committed");
  });

  it("does not keep a git context read while git was unavailable", async () => {
    const repo = fx.repo("no-git");
    write(join(repo, "CLAUDE.md"), "# rules\n");
    fx.commitAll(repo);
    const path = process.env.PATH;
    process.env.PATH = join(fx.root, "empty-bin");
    try {
      expect((await baselineOf(repo, "CLAUDE.md"))!.scope).toBe("repo-local");
    } finally {
      process.env.PATH = path;
    }
    expect((await baselineOf(repo, "CLAUDE.md"))!.scope).toBe("repo-committed");
  });

  it("baselines a committed in-repo symlink against its target's body, not the link text", async () => {
    const repo = fx.repo("link-baseline");
    write(join(repo, "docs", "rules.md"), "# rules\n");
    symlinkSync(join("docs", "rules.md"), join(repo, "CLAUDE.md"));
    fx.commitAll(repo);
    const a = await baselineOf(repo, "CLAUDE.md");
    expect([a!.scope, a!.payload.baseline_content_hash]).toEqual(["repo-committed", a!.contentHash]);
  });

  it("finds a subdirectory's AGENTS.md even when it has no other Claude config", async () => {
    const repo = fx.repo("sub-agents");
    write(join(repo, "pkg", "AGENTS.md"), "# pkg agents\n");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(summary(r.assets)).toEqual(["claude-code agents_md repo-local pkg/AGENTS.md"]);
  });
});

describe("payloads", () => {
  it("lists a skill folder's helper files in payload.files", async () => {
    const repo = fx.repo("skill-files");
    const dir = join(repo, ".claude", "skills", "deploy");
    write(join(dir, "SKILL.md"), SKILL("deploy"));
    write(join(dir, "run.sh"), "#!/bin/sh\n");
    write(join(dir, "notes.md"), "# notes\n");
    write(join(dir, "config.json"), "{}\n");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    const files = r.assets.find((a) => a.type === "skill")!.payload.files!;
    expect(files.map((f) => f.relativePath).sort()).toEqual(["SKILL.md", "config.json", "notes.md", "run.sh"]);
  });

  it("strips terminal escapes from a name taken from frontmatter", async () => {
    const repo = fx.repo("escape-name");
    write(join(repo, ".claude", "skills", "e", "SKILL.md"), SKILL("\u001b[31mred\u001b[0m"));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.name).toBe("red");
  });

  it("strips bidirectional controls from a name taken from frontmatter", async () => {
    const repo = fx.repo("bidi-name");
    write(join(repo, ".claude", "skills", "b", "SKILL.md"), SKILL("safe‮dm.exe⁦x⁩"));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.name).toBe("safedm.exex");
  });

  it("reads an empty Kiro inclusion as Kiro's default, always", async () => {
    const repo = fx.repo("kiro-empty");
    write(join(repo, ".kiro", "steering", "a.md"), '---\ninclusion: ""\n---\nText.\n');
    const r = await scan({ repos: [repo], ides: ["kiro"] });
    expect(r.assets[0]!.payload.inclusion_mode).toBe("always");
  });
});

describe("home as a repo, package scope, helper files", () => {
  it("scans a folder inside a dotfiles HOME repo as a plain folder, not as HOME", async () => {
    write(join(fx.home, ".claude", "rules", "r.md"), "# rule\n");
    write(join(fx.home, ".cursor", "rules", "c.mdc"), "Rule.\n");
    write(join(fx.home, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [{ command: "cat ~/fake-secret" }] } }));
    write(join(fx.home, "fake-secret"), "not for the scan\n");
    git(fx.home, "init", "-q", "-b", "main");
    fx.commitAll(fx.home);
    const proj = join(fx.home, "proj");
    write(join(proj, "notes.txt"), "x\n");
    const control = await scan({});
    const r = await scan({ repos: [proj] });
    expect(summary(r.assets)).toEqual(summary(control.assets));
    expect(r.assets.every((a) => a.scope === "user" && a.filePath !== join(fx.home, "fake-secret"))).toBe(true);
    expect(r.warnings).toEqual([{ root: proj, message: expect.stringMatching(/top level is the home directory/) }]);
  });

  it.each([
    ["with a remote and differing copies", true, "# pkg agents\n"],
    ["without a remote and identical copies", false, "# agents\n"],
  ])("keys a Codex and Kiro package on the repo, %s", async (_label, remote, pkgBody) => {
    const repo = fx.repo(`pkg-scope-${remote}`);
    if (remote) git(repo, "remote", "add", "origin", "https://example.com/o/mono.git");
    write(join(repo, "AGENTS.md"), "# agents\n");
    write(join(repo, "pkg", "AGENTS.md"), pkgBody);
    write(join(repo, ".kiro", "steering", "style.md"), "style\n");
    write(join(repo, "pkg", ".kiro", "steering", "style.md"), remote ? "pkg style\n" : "style\n");
    fx.commitAll(repo);
    const r = await scan({ repos: [join(repo, "pkg")], ides: ["codex", "kiro"] });
    expect(summary(r.assets)).toEqual([
      "codex agents_md repo-committed AGENTS.md",
      "codex agents_md repo-committed pkg/AGENTS.md",
      "kiro rule repo-committed .kiro/steering/style.md",
      "kiro rule repo-committed pkg/.kiro/steering/style.md",
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("lists every file in a skill folder, whatever its extension", async () => {
    const repo = fx.repo("all-helpers");
    const dir = join(repo, ".claude", "skills", "deploy");
    write(join(dir, "SKILL.md"), SKILL("deploy"));
    for (const f of ["scripts/deploy.mjs", "bin/run", "lib/helper.rb", "notes.md"]) write(join(dir, f), "x\n");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.payload.files!.map((f) => f.relativePath)).toEqual(["SKILL.md", "bin/run", "lib/helper.rb", "notes.md", "scripts/deploy.mjs"]);
  });

  it("warns when a skill's primary is over the size cap, so none of its helper files are listed", async () => {
    const repo = fx.repo("big-primary");
    const dir = join(repo, ".claude", "skills", "big");
    write(join(dir, "SKILL.md"), `${SKILL("big")}${"x".repeat(300 * 1024)}`);
    write(join(dir, "run.sh"), "#!/bin/sh\n");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.payload.files).toBeUndefined();
    expect(r.warnings).toEqual([{ ide: "claude-code", path: join(dir, "SKILL.md"), message: expect.stringMatching(/helper files are not listed/) }]);
  });

  it("lists a plugin skill's helper files", async () => {
    const install = join(fx.home, ".claude", "plugins", "cache", "m", "tools", "1");
    write(join(install, "skills", "fmt", "SKILL.md"), SKILL("fmt"));
    write(join(install, "skills", "fmt", "run.sh"), "#!/bin/sh\n");
    write(join(fx.home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "tools@m": [{ installPath: install }] } }));
    const r = await scan({ ides: ["claude-code"] });
    expect(r.assets.find((a) => a.type === "skill")!.payload.files?.map((f) => f.relativePath)).toEqual(["SKILL.md", "run.sh"]);
  });

  it("reads a committed file whose name is NFD on disk as committed", async () => {
    const repo = fx.repo("nfd");
    write(join(repo, ".cursor", "rules", "café.mdc"), "Rule.\n");
    fx.commitAll(repo);
    const r = await scan({ repos: [repo], ides: ["cursor"] });
    expect(r.assets.map((a) => a.scope)).toEqual(["repo-committed"]);
  });

  it("strips C1 control characters from a frontmatter name", async () => {
    const repo = fx.repo("c1-name");
    write(join(repo, ".claude", "skills", "c", "SKILL.md"), SKILL("a\u0085b\u0080c"));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.name).toBe("abc");
  });
});

describe("roots, checkouts and manifests", () => {
  it("reads the git top level for Claude Code when the root is a subdirectory", async () => {
    const repo = fx.repo("top-level");
    write(join(repo, "CLAUDE.md"), "# root rules\n");
    write(join(repo, ".claude", "rules", "root.md"), "# root rule\n");
    write(join(repo, "pkg", "index.js"), "export {};\n");
    fx.commitAll(repo);
    const r = await scan({ repos: [join(repo, "pkg")], ides: ["claude-code"] });
    expect(summary(r.assets)).toEqual([
      "claude-code claude_md repo-committed CLAUDE.md",
      "claude-code rule repo-committed .claude/rules/root.md",
    ]);
  });

  it("warns when a checkout's copy of a shared file differs from the one reported", async () => {
    const src = fx.repo("shared-src");
    write(join(src, "AGENTS.md"), "# shared\n");
    fx.commitAll(src);
    const a = join(fx.root, "clone-a");
    const b = join(fx.root, "clone-b");
    git(fx.root, "clone", "-q", src, a);
    git(fx.root, "clone", "-q", src, b);
    write(join(b, "AGENTS.md"), "# edited in b\n");
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(a, ".git", "index"), later, later);
    const r = await scan({ repos: [a, b], ides: ["codex"] });
    expect(r.assets.map((x) => x.filePath)).toEqual([join(a, "AGENTS.md")]);
    expect(r.warnings).toEqual([{
      ide: "codex",
      path: join(b, "AGENTS.md"),
      message: `differs from ${join(a, "AGENTS.md")}, the copy reported for this asset; not reported`,
    }]);
  });

  it("lists helper files for Codex, Cursor and Kiro skills too", async () => {
    const repo = fx.repo("skill-files-all");
    for (const dir of [".agents/skills/c", ".cursor/skills/c", ".kiro/skills/c"]) {
      write(join(repo, dir, "SKILL.md"), SKILL("c"));
      write(join(repo, dir, "run.sh"), "#!/bin/sh\n");
    }
    const r = await scan({ repos: [repo], ides: ["codex", "cursor", "kiro"] });
    expect(r.assets.map((a) => [a.ideType, a.payload.files?.map((f) => f.relativePath).sort()])).toEqual([
      ["codex", ["SKILL.md", "run.sh"]],
      ["cursor", ["SKILL.md", "run.sh"]],
      ["kiro", ["SKILL.md", "run.sh"]],
    ]);
  });

  it("warns when a skill's helper-file list is cut at a cap", async () => {
    const repo = fx.repo("big-skill");
    const dir = join(repo, ".claude", "skills", "big");
    write(join(dir, "SKILL.md"), SKILL("big"));
    for (let i = 0; i < 51; i++) write(join(dir, `f${String(i).padStart(2, "0")}.md`), `# ${i}\n`);
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.payload.files).toHaveLength(50);
    expect(r.warnings).toEqual([{ ide: "claude-code", path: dir, message: expect.stringMatching(/^helper files listed only up to/) }]);
  });

  it("skips an immediate subdirectory that is a submodule or a linked worktree", async () => {
    const sub = fx.repo("nested-sub-src");
    write(join(sub, "CLAUDE.md"), "# sub\n");
    fx.commitAll(sub);
    const repo = fx.repo("nested-super");
    write(join(repo, "CLAUDE.md"), "# super\n");
    fx.commitAll(repo);
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor");
    git(repo, "worktree", "add", "-q", join(repo, "wt"));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets.map((a) => a.filePath)).toEqual([join(repo, "CLAUDE.md")]);
  });

  it("resolves a relative plugin installPath against the plugins directory", async () => {
    const plugins = join(fx.home, ".claude", "plugins");
    write(join(plugins, "cache", "p", "commands", "go.md"), "# go\n");
    write(join(plugins, "installed_plugins.json"), JSON.stringify({ plugins: { "p@m": [{ installPath: "cache/p" }] } }));
    const r = await scan({ ides: ["claude-code"] });
    expect(r.warnings).toEqual([]);
    expect(r.assets.map((a) => a.type).sort()).toEqual(["command", "plugin"]);
  });

  it("gives a direct collector call the default branch as it is now, after a fetch moved it", async () => {
    const repo = fx.repo("direct-fetch");
    write(join(repo, "CLAUDE.md"), "v1\n");
    fx.commitAll(repo);
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    write(join(repo, "CLAUDE.md"), "v2\n");
    fx.commitAll(repo);
    const baseline = async () => {
      let hash: string | undefined;
      await collectClaudeCodeRepoAssets(createCollectSession((a) => (hash = a.payload.baseline_content_hash)), repo);
      return hash;
    };
    expect(await baseline()).toBe(sha256("v1\n"));
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    expect(await baseline()).toBe(sha256("v2\n"));
  });
});

describe("contracts pinned by pass-2 mutations", () => {
  it("treats a plugin with no enabledPlugins entry as enabled", async () => {
    const install = join(fx.home, ".claude", "plugins", "cache", "m", "p", "1");
    write(join(install, "commands", "go.md"), "# go\n");
    write(join(fx.home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ plugins: { "p@m": [{ installPath: install }] } }));
    write(join(fx.home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: {} }));
    const r = await scan({ ides: ["claude-code"] });
    expect(new Set(r.assets.map((a) => a.payload.operational_state))).toEqual(new Set(["enabled"]));
  });

  it("keeps a hook repo-local when its committed wiring names a script that is not on the default branch", async () => {
    const repo = fx.repo("script-not-committed");
    write(join(repo, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [{ command: ".cursor/hooks/new.sh" }] } }));
    write(join(repo, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bash .codex/hooks/new.sh" }] }] } }));
    fx.commitAll(repo);
    write(join(repo, ".cursor", "hooks", "new.sh"), "#!/bin/sh\n");
    write(join(repo, ".codex", "hooks", "new.sh"), "#!/bin/sh\n");
    const r = await scan({ repos: [repo], ides: ["cursor", "codex"] });
    expect(r.assets.map((a) => [a.ideType, a.sourcePath, a.scope]).sort()).toEqual([
      ["codex", ".codex/hooks/new.sh", "repo-local"],
      ["cursor", ".cursor/hooks/new.sh", "repo-local"],
    ]);
  });

  it("keeps a committed Cursor hook that names a missing script repo-local", async () => {
    const repo = fx.repo("cursor-missing");
    write(join(repo, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [{ command: "bash .cursor/hooks/gone.sh" }] } }));
    fx.commitAll(repo);
    const r = await scan({ repos: [repo], ides: ["cursor"] });
    expect(r.assets.map((a) => [a.payload.inline_body, a.scope])).toEqual([["bash .cursor/hooks/gone.sh", "repo-local"]]);
  });

  it("does not cache a git context read during a transient git failure", async () => {
    const repo = fx.repo("transient");
    write(join(repo, "CLAUDE.md"), "# rules\n");
    fx.commitAll(repo);
    const real = (cwd: string, args: string[]): string | null => {
      try {
        return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        return null;
      }
    };
    // Verifying `main` fails as a spawn failure would (undefined), so no default branch is
    // found.
    __setGitRunnerForTest(async (cwd, args) => (args[0] === "rev-parse" && args.at(-1) === "main" ? undefined : real(cwd, args)));
    try {
      expect((await scan({ repos: [repo], ides: ["claude-code"] })).assets[0]!.scope).toBe("repo-local");
    } finally {
      __setGitRunnerForTest(null);
    }
    expect((await scan({ repos: [repo], ides: ["claude-code"] })).assets[0]!.scope).toBe("repo-committed");
  });

  it("scans a Codex root reached through a symlink once, keyed on the real repo", async () => {
    const repo = fx.repo("codex-link");
    write(join(repo, ".codex", "rules", "r.rules"), "prefix_rule()\n");
    fx.commitAll(repo);
    const link = join(fx.root, "codex-link-alias");
    symlinkSync(repo, link);
    const seen: string[] = [];
    const session = createCollectSession((a) => seen.push(assetSourcePath(a)));
    await collectCodexAssets(session, { roots: [{ path: link, isWorktree: false }] });
    expect([...session.scannedKeys]).toEqual([repo]);
    expect(seen).toEqual([".codex/rules/r.rules"]);
  });

  it("takes the default branch from origin/HEAD first", async () => {
    const repo = fx.repo("origin-head");
    write(join(repo, "CLAUDE.md"), "v1\n");
    fx.commitAll(repo);
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    write(join(repo, "CLAUDE.md"), "v2\n");
    fx.commitAll(repo);
    git(repo, "update-ref", "refs/remotes/origin/dev", "HEAD");
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/dev");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.payload.baseline_content_hash).toBe(sha256("v2\n"));
  });

  it.each([
    ["claude-code", collectClaudeCodeAssets],
    ["codex", collectCodexAssets],
    ["cursor", collectCursorAssets],
    ["kiro", collectKiroAssets],
  ] as const)("adds a worktree root to scannedKeys without reading it (%s)", async (_ide, collect) => {
    const wt = join(fx.root, `wt-root-${_ide}`);
    write(join(wt, "CLAUDE.md"), "# wt\n");
    const session = createCollectSession(() => {});
    await collect(session, { roots: [{ path: wt, isWorktree: true }] });
    expect([...session.scannedKeys]).toEqual([wt]);
    expect([...session.seenIds]).toEqual([]);
  });

  it("lists helper files three folder levels deep, and warns about a fourth", async () => {
    const repo = fx.repo("depth");
    const dir = join(repo, ".claude", "skills", "d");
    write(join(dir, "SKILL.md"), SKILL("d"));
    write(join(dir, "a", "b", "two.md"), "x\n");
    write(join(dir, "a", "b", "c", "three.md"), "x\n");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.payload.files!.map((f) => f.relativePath)).toEqual(["SKILL.md", "a/b/two.md"]);
    expect(r.warnings.map((w) => w.path)).toEqual([dir]);
  });

  it("lists a helper of exactly 256 KiB and leaves out one byte more, with a warning", async () => {
    const repo = fx.repo("helper-size");
    const dir = join(repo, ".claude", "skills", "s");
    write(join(dir, "SKILL.md"), SKILL("s"));
    write(join(dir, "fits.txt"), Buffer.alloc(256 * 1024, "a"));
    write(join(dir, "over.txt"), Buffer.alloc(256 * 1024 + 1, "a"));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.payload.files!.map((f) => f.relativePath)).toEqual(["SKILL.md", "fits.txt"]);
    expect(r.warnings.map((w) => w.path)).toEqual([dir]);
  });

  it("skips a node_modules folder among a repo's subdirectories", async () => {
    const repo = fx.repo("node-modules");
    write(join(repo, "node_modules", "CLAUDE.md"), "# vendored\n");
    write(join(repo, "pkg", "CLAUDE.md"), "# pkg\n");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(summary(r.assets)).toEqual(["claude-code claude_md repo-local pkg/CLAUDE.md"]);
  });

  it("scans a Codex package subdir only when it is below the top level", async () => {
    const repo = fx.repo("codex-sub");
    write(join(repo, ".codex", "rules", "r.rules"), "prefix_rule()\n");
    fx.commitAll(repo);
    const session = createCollectSession(() => {});
    await collectCodexAssets(session, { roots: [{ path: repo, isWorktree: false }] });
    expect([...session.scannedKeys]).toEqual([repo]);
  });
});

describe("helper-file walk, scope keys and root spelling", () => {
  it("falls back to the folder name when a skill's frontmatter name is empty", async () => {
    const repo = fx.repo("empty-name");
    write(join(repo, ".claude", "skills", "tidy-up", "SKILL.md"), "---\nname: ''\n---\nBody.\n");
    expect((await scan({ repos: [repo], ides: ["claude-code"] })).assets[0]!.name).toBe("Tidy Up");
  });

  it("does not re-list a skill folder reached through a link inside it", async () => {
    const dir = join(fx.home, ".claude", "skills", "s");
    write(join(dir, "SKILL.md"), SKILL("s"));
    write(join(dir, "h.md"), "# h\n");
    symlinkSync(dir, join(dir, "loop"));
    const r = await scan({ ides: ["claude-code"] });
    expect(r.assets[0]!.payload.files!.map((f) => f.relativePath)).toEqual(["SKILL.md", "h.md"]);
    expect(r.warnings).toEqual([]);
  });

  const files = (r: { assets: Array<{ payload: { files?: Array<{ relativePath: string }> } }> }) => r.assets.map((a) => a.payload.files?.map((f) => f.relativePath));

  it("walks a folder at its shallowest depth when a deeper link also reaches it", async () => {
    const dir = join(fx.home, ".claude", "skills", "a");
    write(join(dir, "SKILL.md"), SKILL("a"));
    write(join(dir, "z", "sub", "deep.md"), "# deep\n");
    mkdirSync(join(dir, "b"));
    symlinkSync(join(dir, "z"), join(dir, "b", "l"));
    const r = await scan({ ides: ["claude-code"] });
    expect(files(r)).toEqual([["SKILL.md", "z/sub/deep.md"]]);
    expect(r.warnings).toEqual([]);
  });

  it("warns about a SKILL.md link whose target is gone", async () => {
    const dir = join(fx.home, ".claude", "skills", "g");
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(fx.home, "nowhere.md"), join(dir, "SKILL.md"));
    write(join(dir, "sub", "SKILL.md"), SKILL("sub"));
    const r = await scan({ ides: ["claude-code"] });
    expect(r.assets).toEqual([]);
    expect(r.warnings).toEqual([{ ide: "claude-code", path: join(dir, "SKILL.md"), message: "symlink target unreadable (ENOENT); not read" }]);
  });

  it("does not take a directory named SKILL.md for a skill, and still finds the skills under it", async () => {
    const dir = join(fx.home, ".claude", "skills", "g");
    write(join(dir, "SKILL.md", "x.md"), "# x\n");
    write(join(dir, "sub", "SKILL.md"), SKILL("sub"));
    const r = await scan({ ides: ["claude-code"] });
    expect(r.assets.map((a) => a.sourcePath)).toEqual([".claude/skills/g/sub/SKILL.md"]);
    expect(r.warnings).toEqual([]);
  });

  it("reads a SKILL.md that is a link to a file inside HOME", async () => {
    write(join(fx.home, "shared", "real.md"), SKILL("s"));
    mkdirSync(join(fx.home, ".claude", "skills", "s"), { recursive: true });
    symlinkSync(join(fx.home, "shared", "real.md"), join(fx.home, ".claude", "skills", "s", "SKILL.md"));
    const r = await scan({ ides: ["claude-code"] });
    expect(r.assets.map((a) => a.sourcePath)).toEqual([".claude/skills/s/SKILL.md"]);
  });

  it("lists helpers in a folder linked from inside HOME", async () => {
    const dir = join(fx.home, ".claude", "skills", "a");
    write(join(dir, "SKILL.md"), SKILL("a"));
    write(join(fx.home, "shared", "lib", "x.md"), "# x\n");
    symlinkSync(join(fx.home, "shared", "lib"), join(dir, "lib"));
    expect(files(await scan({ ides: ["claude-code"] }))).toEqual([["SKILL.md", "lib/x.md"]]);
  });

  it("does not fold other skills in through a link to the skills folder", async () => {
    const skills = join(fx.home, ".claude", "skills");
    write(join(skills, "a", "SKILL.md"), SKILL("a"));
    write(join(skills, "a", "h.md"), "# h\n");
    write(join(skills, "b", "SKILL.md"), SKILL("b"));
    write(join(skills, "b", "bh.md"), "# bh\n");
    symlinkSync(skills, join(skills, "a", "up"));
    symlinkSync(join(skills, "a"), join(skills, "a", "self"));
    expect(files(await scan({ ides: ["claude-code"] }))).toEqual([["SKILL.md", "h.md"], ["SKILL.md", "bh.md"]]);
  });

  it.each([
    ["only node_modules", (dir: string) => write(join(dir, "node_modules", "x", "i.js"), "x\n")],
    ["only an empty folder", (dir: string) => mkdirSync(join(dir, "empty"))],
    ["only a link to SKILL.md", (dir: string) => symlinkSync(join(dir, "SKILL.md"), join(dir, "alias.md"))],
  ])("says nothing about helpers of an over-cap SKILL.md with %s", async (_label, add) => {
    const dir = join(fx.home, ".claude", "skills", "big");
    write(join(dir, "SKILL.md"), `${SKILL("big")}${"x".repeat(256 * 1024)}`);
    add(dir);
    const r = await scan({ ides: ["claude-code"] });
    expect(r.warnings).toEqual([]);
    expect(files(r)).toEqual([undefined]);
  });

  it("lists a case-variant skill.md once, as SKILL.md (case-insensitive disks)", async () => {
    const dir = join(fx.home, ".claude", "skills", "c");
    write(join(dir, "skill.md"), SKILL("c"));
    write(join(dir, "h.md"), "# h\n");
    if (!existsSync(join(dir, "SKILL.md"))) return; // case-sensitive disk
    expect(files(await scan({ ides: ["claude-code"] }))).toEqual([["SKILL.md", "h.md"]]);
  });

  it("does not follow a link, or a chain of links, out of HOME from inside a skill folder", async () => {
    const dir = join(fx.home, ".claude", "skills", "a");
    write(join(dir, "SKILL.md"), SKILL("a"));
    write(join(dir, "h.md"), "# h\n");
    const secret = join(fx.root, "outside-walk", "secret");
    write(join(secret, "creds.txt"), "token\n");
    symlinkSync(secret, join(dir, "out"));
    symlinkSync(secret, join(fx.home, "hop"));
    symlinkSync(join(fx.home, "hop"), join(dir, "chain"));
    symlinkSync(join(secret, "creds.txt"), join(dir, "chainf.txt"));
    const r = await scan({ ides: ["claude-code"] });
    expect(files(r)).toEqual([["SKILL.md", "h.md"]]);
    expect(JSON.stringify(r.assets)).not.toContain("creds");
    const outside = "resolves outside HOME and the scanned repos; not read";
    expect(r.warnings).toEqual(["chain", "chainf.txt", "out"].map((n) => ({ ide: "claude-code", path: join(dir, n), message: outside })));
  });

  it("does not list the primary again through a link to it inside the folder", async () => {
    const dir = join(fx.home, ".claude", "skills", "a");
    write(join(dir, "SKILL.md"), SKILL("a"));
    write(join(dir, "h.md"), "# h\n");
    symlinkSync(join(dir, "SKILL.md"), join(dir, "alias.md"));
    const r = await scan({ ides: ["claude-code"] });
    expect(r.assets[0]!.payload.files!.map((f) => f.relativePath)).toEqual(["SKILL.md", "h.md"]);
  });

  it("does not treat a folder with an oversized SKILL.md as a group of skills", async () => {
    const repo = fx.repo("huge-skill");
    write(join(repo, ".claude", "skills", "huge", "SKILL.md"), Buffer.alloc(2 * 1024 * 1024, "a"));
    write(join(repo, ".claude", "skills", "huge", "sub", "SKILL.md"), SKILL("sub"));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets).toEqual([]);
    expect(r.warnings.map((w) => w.message)).toEqual([expect.stringMatching(/^larger than 1048576 bytes/)]);
  });

  it("says nothing about helper files when an oversized SKILL.md has none", async () => {
    const repo = fx.repo("big-alone");
    write(join(repo, ".claude", "skills", "big", "SKILL.md"), `${SKILL("big")}${"x".repeat(300 * 1024)}`);
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.payload.files).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it("skips node_modules inside a skill folder", async () => {
    const repo = fx.repo("skill-node-modules");
    const dir = join(repo, ".claude", "skills", "d");
    write(join(dir, "SKILL.md"), SKILL("d"));
    for (let i = 0; i < 60; i++) write(join(dir, "node_modules", `p${i}`, "index.js"), "x\n");
    write(join(dir, "scripts", "deploy.sh"), "#!/bin/sh\n");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.payload.files!.map((f) => f.relativePath)).toEqual(["SKILL.md", "scripts/deploy.sh"]);
    expect(r.warnings).toEqual([]);
  });

  // The collector contract: one session per tool, the same roots every run, and the tool's stored
  // assets for the roots in scannedKeys replaced by the run's result; a root not in scannedKeys
  // was not read, so its stored assets stay.
  const sync = async (collect: typeof collectCodexAssets, roots: string[], store: Map<string, { sourcePath: string; root: string }>) => {
    const seen = new Map<string, { sourcePath: string; root: string }>();
    const session = createCollectSession((a) => seen.set(harnessAssetId(a), { sourcePath: assetSourcePath(a), root: a.projectPath }));
    await collect(session, { roots: roots.map((path) => ({ path, isWorktree: false })) });
    for (const [id, a] of store) if (session.scannedKeys.has(a.root)) store.delete(id);
    for (const [id, a] of seen) store.set(id, a);
    return [...store.values()].map((a) => a.sourcePath).sort();
  };

  it.each([
    ["Codex", collectCodexAssets, "AGENTS.md"],
    ["Kiro", collectKiroAssets, ".kiro/steering/s.md"],
    ["Claude Code", collectClaudeCodeAssets, "CLAUDE.md"],
  ] as const)("keeps a store in step when the same roots are read every run (%s)", async (label, collect, file) => {
    const repo = fx.repo(`sync-${label.replace(/ /g, "")}`);
    write(join(repo, file), "top\n");
    write(join(repo, "pkg", file), "pkg\n");
    const locked = join(fx.root, `sync-locked-${label.replace(/ /g, "")}`);
    write(join(locked, file), "locked\n");
    const store = new Map<string, { sourcePath: string; root: string }>();
    const roots = [join(repo, "pkg"), locked];
    expect(await sync(collect, roots, store)).toEqual([file, file, `pkg/${file}`].sort());
    rmSync(join(repo, "pkg", file));
    chmodSync(locked, 0o000);
    try {
      // The deleted file goes; the unreadable root is not in scannedKeys, so its asset stays.
      expect(await sync(collect, roots, store)).toEqual([file, file].sort());
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  it("skips a subdirectory that is HOME, even through a link, with a warning", async () => {
    write(join(fx.home, ".claude", "rules", "r.md"), "# rule\n");
    write(join(fx.home, "CLAUDE.md"), "# home\n");
    const parent = join(fx.root, "above-home");
    mkdirSync(parent, { recursive: true });
    symlinkSync(fx.home, join(parent, "me"));
    const r = await scan({ repos: [parent], ides: ["claude-code"] });
    expect(r.assets.every((a) => a.scope === "user")).toBe(true);
    expect(r.warnings).toEqual([{ root: join(parent, "me"), message: expect.stringMatching(/is the home directory/) }]);
  });

  it("reads the top level when collectClaudeCodeRepoAssets is called on a package", async () => {
    const repo = fx.repo("repo-assets-top");
    write(join(repo, "CLAUDE.md"), "# top\n");
    write(join(repo, ".claude", "rules", "r.md"), "# rule\n");
    write(join(repo, "pkg", "CLAUDE.md"), "# pkg\n");
    fx.commitAll(repo);
    const seen: string[] = [];
    await collectClaudeCodeRepoAssets(createCollectSession((a) => seen.push(assetSourcePath(a))), join(repo, "pkg"));
    expect(seen.sort()).toEqual([".claude/rules/r.md", "CLAUDE.md", "pkg/CLAUDE.md"]);
  });

  it("skips a subdirectory that is a link to another folder already read", async () => {
    const repo = fx.repo("alias-subdir");
    write(join(repo, "pkg", "CLAUDE.md"), "# pkg\n");
    symlinkSync(join(repo, "pkg"), join(repo, "alias"));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    // Whichever spelling is read first (directory order) is the one reported.
    expect(summary(r.assets)).toHaveLength(1);
  });

  // A folder outside git is keyed by its path, so these show the spelling a root is keyed by.
  it.each([
    ["codex", collectCodexAssets, "AGENTS.md"],
    ["kiro", collectKiroAssets, ".kiro/steering/s.md"],
    ["cursor", collectCursorAssets, ".cursor/rules/r.mdc"],
  ] as const)("keys a root given to the %s collector in another case by its on-disk spelling", async (ide, collect, file) => {
    const dir = join(fx.root, `casedir-${ide}`);
    write(join(dir, file), "x\n");
    const upper = join(fx.root, `CASEDIR-${ide.toUpperCase()}`);
    if (!existsSync(upper) || realpathSync.native(upper) === upper) return; // case-sensitive disk
    const seen: string[] = [];
    const session = createCollectSession((a) => seen.push(`${a.projectPath} ${assetSourcePath(a)}`));
    await collect(session, { roots: [{ path: upper, isWorktree: false }] });
    expect(seen).toEqual([`${dir} ${file}`]);
    expect([...session.scannedKeys]).toEqual([dir]);
  });

  it.each([
    ["claude-code", collectClaudeCodeAssets, "CLAUDE.md"],
    ["kiro", collectKiroAssets, ".kiro/steering/s.md"],
    ["cursor", collectCursorAssets, ".cursor/rules/r.mdc"],
  ] as const)("keys a %s collector root reached through a symlink by its real path", async (ide, collect, file) => {
    const dir = join(fx.root, `linked-dir-${ide}`);
    write(join(dir, file), "x\n");
    const link = join(fx.root, `linked-dir-alias-${ide}`);
    symlinkSync(dir, link);
    const seen: string[] = [];
    const session = createCollectSession((a) => seen.push(`${a.projectPath} ${assetSourcePath(a)}`));
    await collect(session, { roots: [{ path: link, isWorktree: false }] });
    expect(seen).toEqual([`${dir} ${file}`]);
    expect([...session.scannedKeys]).toEqual([dir]);
  });

  it.each([
    ["claude-code", collectClaudeCodeRepoAssets, "CLAUDE.md"],
    ["codex", collectCodexRepoAssets, "AGENTS.md"],
    ["kiro", collectKiroRepoAssets, ".kiro/steering/s.md"],
    ["cursor", collectCursorRepoAssets, ".cursor/rules/r.mdc"],
  ] as const)("keys a folder given to the %s …RepoAssets call through a symlink by its real path", async (ide, collect, file) => {
    const dir = join(fx.root, `repo-assets-dir-${ide}`);
    write(join(dir, file), "x\n");
    const link = join(fx.root, `repo-assets-alias-${ide}`);
    symlinkSync(dir, link);
    const seen: string[] = [];
    const session = createCollectSession((a) => seen.push(`${a.projectPath} ${assetSourcePath(a)}`));
    await collect(session, link);
    expect(seen).toEqual([`${dir} ${file}`]);
    expect([...session.scannedKeys]).toEqual([dir]);
  });

  it("reads the user scope when HOME is spelled in another case and a collector is called directly", async () => {
    write(join(fx.home, ".claude", "rules", "r.md"), "# rule\n");
    const upper = join(dirname(fx.home), basename(fx.home).toUpperCase());
    if (!existsSync(upper) || realpathSync.native(upper) === upper) return; // case-sensitive disk
    process.env.HOME = upper;
    try {
      const seen: string[] = [];
      await collectClaudeCodeAssets(createCollectSession((a) => seen.push(`${a.scope} ${assetSourcePath(a)}`)), { roots: [] });
      expect(seen).toEqual(["user .claude/rules/r.md"]);
    } finally {
      process.env.HOME = fx.home;
    }
  });

  it.each([
    ["claude-code", collectClaudeCodeAssets],
    ["codex", collectCodexAssets],
    ["cursor", collectCursorAssets],
    ["kiro", collectKiroAssets],
  ] as const)("adds the top level of a root deep inside a worktree to scannedKeys without reading it (%s)", async (ide, collect) => {
    const repo = fx.repo(`deep-wt-${ide}`);
    write(join(repo, "CLAUDE.md"), "# main\n");
    fx.commitAll(repo);
    const wt = join(fx.root, `deep-wt-${ide}-linked`);
    git(repo, "worktree", "add", "-q", wt);
    mkdirSync(join(wt, "sub"));
    const session = createCollectSession(() => {});
    await collect(session, { roots: [{ path: join(wt, "sub"), isWorktree: false }] });
    expect([...session.scannedKeys]).toEqual([wt]);
    expect([...session.seenIds]).toEqual([]);
  });

  it("recognises a dotfiles HOME spelled in another case (case-insensitive disks)", async () => {
    const upper = join(fx.root, "HOME");
    if (!existsSync(upper) || realpathSync.native(upper) === upper) return; // case-sensitive disk: nothing to show
    write(join(fx.home, ".claude", "rules", "r.md"), "# rule\n");
    git(fx.home, "init", "-q", "-b", "main");
    fx.commitAll(fx.home);
    process.env.HOME = upper;
    try {
      const proj = join(upper, "proj");
      mkdirSync(proj, { recursive: true });
      const r = await scan({ repos: [proj] });
      expect(r.assets.every((a) => a.scope === "user")).toBe(true);
      expect(r.warnings.map((w) => w.message)).toEqual([expect.stringMatching(/top level is the home directory/)]);
    } finally {
      process.env.HOME = fx.home;
    }
  });

  it("reads a root given to a collector in another case (case-insensitive disks)", async () => {
    const repo = fx.repo("caserepo");
    write(join(repo, "CLAUDE.md"), "# rules\n");
    fx.commitAll(repo);
    const upper = join(fx.root, "CASEREPO");
    if (!existsSync(upper) || realpathSync.native(upper) === upper) return; // case-sensitive disk
    const seen: string[] = [];
    await collectClaudeCodeAssets(createCollectSession((a) => seen.push(`${a.scope} ${assetSourcePath(a)}`)), { roots: [{ path: upper, isWorktree: false }] });
    expect(seen).toEqual(["repo-committed CLAUDE.md"]);
  });

  it.each([
    ["claude-code", collectClaudeCodeAssets],
    ["codex", collectCodexAssets],
    ["cursor", collectCursorAssets],
    ["kiro", collectKiroAssets],
  ] as const)("skips a collector root that is HOME spelled through a link (%s)", async (_ide, collect) => {
    write(join(fx.home, ".claude", "rules", "r.md"), "# rule\n");
    write(join(fx.home, ".cursor", "rules", "c.mdc"), "Rule.\n");
    write(join(fx.home, ".kiro", "steering", "k.md"), "Steer.\n");
    write(join(fx.home, "AGENTS.md"), "# agents\n");
    const link = join(fx.root, `home-link-${_ide}`);
    symlinkSync(fx.home, link);
    process.env.HOME = link;
    try {
      const scopes: string[] = [];
      const session = createCollectSession((a) => scopes.push(a.scope));
      await collect(session, { roots: [{ path: fx.home, isWorktree: false }] });
      expect(scopes.every((x) => x === "user")).toBe(true);
      // Not read, but recorded, so a store replaces what it kept for this root.
      expect([...session.scannedKeys]).toEqual([fx.home]);
    } finally {
      process.env.HOME = fx.home;
      rmSync(link);
    }
  });

  it.each([
    ["claude-code", collectClaudeCodeRepoAssets, "CLAUDE.md"],
    ["cursor", collectCursorRepoAssets, ".cursor/rules/r.mdc"],
  ] as const)("records the folder a …RepoAssets call read in scannedKeys (%s)", async (_ide, collect, file) => {
    const repo = fx.repo(`repo-assets-keys-${_ide}`);
    write(join(repo, file), "x\n");
    const session = createCollectSession(() => {});
    await collect(session, repo);
    expect([...session.scannedKeys]).toEqual([repo]);
  });

  it("warns once for a root in a dotfiles HOME repo, not once per subdirectory", async () => {
    write(join(fx.home, ".claude", "rules", "r.md"), "# rule\n");
    git(fx.home, "init", "-q", "-b", "main");
    fx.commitAll(fx.home);
    const proj = join(fx.home, "proj");
    write(join(proj, "a", "CLAUDE.md"), "# a\n");
    write(join(proj, "b", "CLAUDE.md"), "# b\n");
    const r = await scan({ repos: [proj], ides: ["claude-code"] });
    expect(r.warnings).toEqual([{ root: proj, message: expect.stringMatching(/top level is the home directory/) }]);
  });
});

describe("shapes the re-check pinned", () => {
  it("leaves dot files and folders out of a skill's file list, and never reads their content", async () => {
    const repo = fx.repo("dot-helpers");
    const dir = join(repo, ".claude", "skills", "s");
    write(join(dir, "SKILL.md"), SKILL("s"));
    write(join(dir, ".env"), "API_KEY=do-not-read-me\n");
    write(join(dir, ".git", "config"), "[core]\n");
    write(join(dir, "run.sh"), "#!/bin/sh\n");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.payload.files!.map((f) => f.relativePath)).toEqual(["SKILL.md", "run.sh"]);
    expect(JSON.stringify(r)).not.toContain("do-not-read-me");
  });

  it.each([
    [256 * 1024, ["SKILL.md", "run.sh"], 0],
    [256 * 1024 + 1, undefined, 1],
  ])("lists helpers for a %i-byte SKILL.md only within the cap", async (size, files, warnings) => {
    const repo = fx.repo(`primary-${size}`);
    const dir = join(repo, ".claude", "skills", "p");
    const head = SKILL("p");
    write(join(dir, "SKILL.md"), head + "x".repeat(size - head.length));
    write(join(dir, "run.sh"), "#!/bin/sh\n");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.payload.files?.map((f) => f.relativePath)).toEqual(files);
    expect(r.warnings).toHaveLength(warnings);
  });

  it("gives a flat <name>.md skill and a lone SKILL.md no file list", async () => {
    const repo = fx.repo("no-list");
    write(join(repo, ".claude", "skills", "flat.md"), SKILL("flat"));
    write(join(repo, ".claude", "skills", "flat-helper.sh"), "#!/bin/sh\n");
    write(join(repo, ".claude", "skills", "lone", "SKILL.md"), SKILL("lone"));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets.map((a) => [a.name, a.payload.files])).toEqual([["flat", undefined], ["lone", undefined]]);
  });

  it("lists 49 helpers plus SKILL.md without a warning", async () => {
    const repo = fx.repo("at-cap");
    const dir = join(repo, ".claude", "skills", "c");
    write(join(dir, "SKILL.md"), SKILL("c"));
    for (let i = 0; i < 49; i++) write(join(dir, `h${String(i).padStart(2, "0")}.md`), `# ${i}\n`);
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.payload.files).toHaveLength(50);
    expect(r.warnings).toEqual([]);
  });

  it.each(["codex", "cursor", "kiro"] as const)("warns when a %s skill's file list is cut at the cap", async (ide) => {
    const repo = fx.repo(`cap-${ide}`);
    const dir = join(repo, { codex: ".agents", cursor: ".cursor", kiro: ".kiro" }[ide], "skills", "c");
    write(join(dir, "SKILL.md"), SKILL("c"));
    for (let i = 0; i < 51; i++) write(join(dir, `h${String(i).padStart(2, "0")}.md`), `# ${i}\n`);
    const r = await scan({ repos: [repo], ides: [ide] });
    expect(r.assets[0]!.payload.files).toHaveLength(50);
    expect(r.warnings.map((w) => w.path)).toEqual([dir]);
  });

  it("reads every tool's user files once, as user scope, from a folder in a dotfiles HOME repo", async () => {
    write(join(fx.home, ".claude", "rules", "r.md"), "# rule\n");
    write(join(fx.home, ".agents", "skills", "k", "SKILL.md"), SKILL("k"));
    write(join(fx.home, ".kiro", "steering", "s.md"), "Steer.\n");
    write(join(fx.home, ".cursor", "rules", "c.mdc"), "Rule.\n");
    write(join(fx.home, "AGENTS.md"), "# home agents\n");
    git(fx.home, "init", "-q", "-b", "main");
    fx.commitAll(fx.home);
    const proj = join(fx.home, "proj");
    write(join(proj, "sub", "CLAUDE.md"), "# sub\n");
    const r = await scan({ repos: [proj] });
    expect(r.assets.filter((a) => a.scope !== "user").map((a) => a.filePath)).toEqual([join(proj, "sub", "CLAUDE.md")]);
    for (const collect of [collectClaudeCodeRepoAssets, collectCodexRepoAssets, collectCursorRepoAssets, collectKiroRepoAssets]) {
      const scopes: string[] = [];
      await collect(createCollectSession((a) => scopes.push(`${a.scope} ${assetSourcePath(a)}`)), proj);
      expect(scopes.filter((x) => !x.startsWith("repo-local "))).toEqual([]);
    }
  });

  it("matches NFC and NFD spellings of a tracked name whatever the platform", async () => {
    const nfd = "cafe\u0301.mdc";
    const nfc = nfd.normalize("NFC");
    const real = (cwd: string, args: string[]): string | null => {
      try {
        return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        return null;
      }
    };
    for (const spelling of [nfc, nfd]) {
      // One repo per spelling, so a cached git context cannot answer for the second.
      const repo = fx.repo(`nfc-runner-${spelling === nfc ? "nfc" : "nfd"}`);
      write(join(repo, ".cursor", "rules", nfd), "Rule.\n");
      fx.commitAll(repo);
      // ls-files answers with one spelling; the file on disk has the other or the same.
      __setGitRunnerForTest(async (cwd, args) => (args[0] === "ls-files" ? `.cursor/rules/${spelling}\0` : real(cwd, args)));
      try {
        const r = await scan({ repos: [repo], ides: ["cursor"] });
        expect(r.assets.map((a) => a.scope)).toEqual(["repo-committed"]);
      } finally {
        __setGitRunnerForTest(null);
      }
    }
  });

  it("reads a committed settings hook in an NFD-named subdirectory as committed", async () => {
    const repo = fx.repo("nfd-settings");
    const sub = join(repo, "cafe\u0301");
    write(join(sub, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] } }));
    fx.commitAll(repo);
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets.map((a) => [a.type, a.scope])).toEqual([["hook", "repo-committed"]]);
  });

  it("takes local master as the default branch when nothing else exists", async () => {
    const repo = join(fx.root, "master-only");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "master");
    write(join(repo, "CLAUDE.md"), "# rules\n");
    fx.commitAll(repo);
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect([r.assets[0]!.scope, r.warnings]).toEqual(["repo-committed", []]);
  });

  it("names the repo's top level in the no-default-branch warning, not the folder passed", async () => {
    const repo = join(fx.root, "trunk-sub");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "trunk");
    write(join(repo, "pkg", "CLAUDE.md"), "# pkg\n");
    fx.commitAll(repo);
    const r = await scan({ repos: [join(repo, "pkg")], ides: ["claude-code"] });
    expect(r.warnings.map((w) => w.root)).toEqual([repo]);
  });

  it("records a Codex and Kiro package folder in scannedKeys", async () => {
    const repo = fx.repo("pkg-keys");
    write(join(repo, "pkg", "AGENTS.md"), "# pkg\n");
    write(join(repo, "pkg", ".kiro", "steering", "s.md"), "Steer.\n");
    for (const collect of [collectCodexAssets, collectKiroAssets]) {
      const session = createCollectSession(() => {});
      await collect(session, { roots: [{ path: join(repo, "pkg"), isWorktree: false }] });
      expect([...session.scannedKeys].sort()).toEqual([repo, join(repo, "pkg")]);
    }
  });
});

// Pins the README's "Before you rely on it" items, so a change to any of them is deliberate.
describe("scope through a directory link, and CLAUDE.md at any depth", () => {
  // `.agents/skills -> ../.claude/skills`, as a repo shares one skills folder between tools.
  const linkSkills = (repo: string, linkDir: string) => {
    mkdirSync(join(repo, linkDir), { recursive: true });
    symlinkSync("../.claude/skills", join(repo, linkDir, "skills"));
  };
  const skillOf = (r: Awaited<ReturnType<typeof scan>>) =>
    r.assets.filter((a) => a.type === "skill").map((a) => [a.sourcePath, a.scope, a.payload.baseline_content_hash ?? null]);

  it.each([
    ["codex", ".agents"],
    ["kiro", ".kiro"],
  ] as const)("reads a skill under a committed directory link to a committed folder as repo-committed (%s)", async (ide, linkDir) => {
    const repo = fx.repo(`dirlink-committed-${ide}`);
    write(join(repo, ".claude", "skills", "s", "SKILL.md"), SKILL("s"));
    linkSkills(repo, linkDir);
    fx.commitAll(repo);
    const r = await scan({ repos: [repo], ides: [ide] });
    expect(skillOf(r)).toEqual([[`${linkDir}/skills/s/SKILL.md`, "repo-committed", sha256(SKILL("s"))]]);
  });

  it("reads a skill under an untracked directory link as repo-local", async () => {
    const repo = fx.repo("dirlink-untracked");
    write(join(repo, ".claude", "skills", "s", "SKILL.md"), SKILL("s"));
    fx.commitAll(repo);
    linkSkills(repo, ".agents");
    expect(skillOf(await scan({ repos: [repo], ides: ["codex"] }))).toEqual([[".agents/skills/s/SKILL.md", "repo-local", null]]);
  });

  it("reads an untracked file under a committed directory link as repo-local", async () => {
    const repo = fx.repo("dirlink-target-local");
    write(join(repo, ".claude", "skills", "keep.md"), "# keep\n");
    linkSkills(repo, ".agents");
    fx.commitAll(repo);
    write(join(repo, ".claude", "skills", "s", "SKILL.md"), SKILL("s"));
    expect(skillOf(await scan({ repos: [repo], ides: ["codex"] }))).toEqual([
      [".agents/skills/keep.md", "repo-committed", sha256("# keep\n")],
      [".agents/skills/s/SKILL.md", "repo-local", null],
    ]);
  });

  it("reads a file under a committed directory link as repo-local once it leaves the index", async () => {
    const repo = fx.repo("dirlink-unstaged");
    write(join(repo, ".claude", "skills", "s", "SKILL.md"), SKILL("s"));
    linkSkills(repo, ".agents");
    fx.commitAll(repo);
    git(repo, "rm", "--cached", "-q", ".claude/skills/s/SKILL.md");
    expect(skillOf(await scan({ repos: [repo], ides: ["codex"] }))).toEqual([[".agents/skills/s/SKILL.md", "repo-local", null]]);
  });

  it("reads a skill under a directory link repointed since the commit as repo-local", async () => {
    const repo = fx.repo("dirlink-repointed");
    write(join(repo, ".claude", "skills", "s", "SKILL.md"), SKILL("s"));
    write(join(repo, "other", "s", "SKILL.md"), SKILL("s"));
    linkSkills(repo, ".agents");
    fx.commitAll(repo);
    rmSync(join(repo, ".agents", "skills"));
    symlinkSync("../other", join(repo, ".agents", "skills"));
    expect(skillOf(await scan({ repos: [repo], ides: ["codex"] }))).toEqual([[".agents/skills/s/SKILL.md", "repo-local", null]]);
  });

  it("does not follow a committed directory link out of the repo", async () => {
    const repo = fx.repo("dirlink-out");
    const outside = join(fx.root, "dirlink-outside");
    write(join(outside, "s", "SKILL.md"), SKILL("s"));
    mkdirSync(join(repo, ".agents"));
    symlinkSync(outside, join(repo, ".agents", "skills"));
    fx.commitAll(repo);
    const r = await scan({ repos: [repo], ides: ["codex"] });
    expect(skillOf(r)).toEqual([]);
    expect(r.warnings.map((w) => w.message)).toEqual(["resolves outside HOME and the scanned repos; not read"]);
  });

  const claudeMds = (r: Awaited<ReturnType<typeof scan>>) =>
    r.assets.filter((a) => a.type === "claude_md").map((a) => [a.sourcePath, a.scope]);

  it("reports a committed CLAUDE.md at any depth as repo-committed, and an untracked one as repo-local", async () => {
    const repo = fx.repo("deep-claude-md");
    write(join(repo, "a", "b", "c", "CLAUDE.md"), "# deep\n");
    fx.commitAll(repo);
    write(join(repo, "x", "y", "CLAUDE.md"), "# local\n");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(claudeMds(r)).toEqual([["a/b/c/CLAUDE.md", "repo-committed"], ["x/y/CLAUDE.md", "repo-local"]]);
    expect(r.assets[0]!.payload.baseline_content_hash).toBe(sha256("# deep\n"));
  });

  it("skips a nested CLAUDE.md that is gitignored, under node_modules or a dot folder, or in a nested repo", async () => {
    const repo = fx.repo("deep-claude-md-skips");
    write(join(repo, ".gitignore"), "ignored/\n");
    for (const d of ["ignored/x", "node_modules/p", ".hidden/x", "inner/sub"]) write(join(repo, d, "CLAUDE.md"), `# ${d}\n`);
    // Committed in the outer repo before the inner one was made, so git's list still names it.
    fx.commitAll(repo);
    git(join(repo, "inner"), "init", "-q");
    write(join(repo, "kept", "z", "CLAUDE.md"), "# kept\n");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(claudeMds(r)).toEqual([["kept/z/CLAUDE.md", "repo-local"]]);
  });

  it("keeps the top-level and immediate-subfolder CLAUDE.md as they were, once each, with the same ids", async () => {
    const repo = fx.repo("deep-claude-md-ids");
    for (const d of ["", "pkg", "pkg/deeper"]) write(join(repo, d, "CLAUDE.md"), `# ${d}\n`);
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    const id = (sp: string) => sha256(`claude-code:repo-local:${repo}:${sp}:claude_md:CLAUDE.md`);
    expect(r.assets.filter((a) => a.type === "claude_md").map((a) => [a.sourcePath, a.id])).toEqual([
      ["CLAUDE.md", id("CLAUDE.md")],
      ["pkg/CLAUDE.md", id("pkg/CLAUDE.md")],
      ["pkg/deeper/CLAUDE.md", id("pkg/deeper/CLAUDE.md")],
    ]);
  });

  it("reports a nested CLAUDE.md in a folder outside git, with the same skips", async () => {
    const dir = join(fx.root, "plain-deep");
    for (const d of ["a/b", "node_modules/p", ".hidden/x"]) write(join(dir, d, "CLAUDE.md"), `# ${d}\n`);
    expect(claudeMds(await scan({ repos: [dir], ides: ["claude-code"] }))).toEqual([["a/b/CLAUDE.md", "repo-local"]]);
  });

  it("warns when a repo has more CLAUDE.md files than the cap", async () => {
    const repo = fx.repo("deep-claude-md-cap");
    for (const d of ["a/x", "b/x", "c/x"]) write(join(repo, d, "CLAUDE.md"), `# ${d}\n`);
    __setNestedClaudeMdCapForTest(2);
    try {
      const r = await scan({ repos: [repo], ides: ["claude-code"] });
      expect(claudeMds(r)).toEqual([["a/x/CLAUDE.md", "repo-local"], ["b/x/CLAUDE.md", "repo-local"]]);
      expect(r.warnings).toEqual([{ root: repo, message: "more than 2 CLAUDE.md files; the rest are not reported" }]);
    } finally {
      __setNestedClaudeMdCapForTest(1000);
    }
  });
});

describe("the deep CLAUDE.md pass: order, git failures, cap, depth, case and links", () => {
  const realGit = (cwd: string, args: string[]): string | null => {
    try {
      return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  };
  const claudeMds = (r: Awaited<ReturnType<typeof scan>>) =>
    r.assets.filter((a) => a.type === "claude_md").map((a) => [a.projectPath, a.sourcePath, a.scope]);
  const linkSkills = (repo: string, linkDir: string, target = "../.claude/skills") => {
    mkdirSync(join(repo, linkDir), { recursive: true });
    symlinkSync(target, join(repo, linkDir, "skills"));
  };
  const skillScopes = (r: Awaited<ReturnType<typeof scan>>) => r.assets.filter((a) => a.type === "skill").map((a) => [a.sourcePath, a.scope]);

  // F1
  it("lets the winning copy of a repo claim a shared nested CLAUDE.md before a losing copy's folder pass", async () => {
    const [a, b] = ["order-a", "order-b"].map((n) => {
      const repo = fx.repo(n);
      write(join(repo, "apps", "web", "CLAUDE.md"), "# web\n");
      git(repo, "remote", "add", "origin", "https://example.com/o/r.git");
      fx.commitAll(repo);
      git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      return repo;
    });
    write(join(b!, "apps", "web", "CLAUDE.md"), "# stale edit\n");
    utimesSync(join(b!, ".git", "index"), new Date(2000, 0, 1), new Date(2000, 0, 1));
    const r = await scan({ repos: [a!, join(b!, "apps")], ides: ["claude-code"] });
    expect(claudeMds(r)).toEqual([[a, "apps/web/CLAUDE.md", "repo-committed"]]);
  });

  // F2
  it("walks for nested CLAUDE.md, as repo-local, when git cannot list the repo", async () => {
    const repo = fx.repo("unlisted");
    write(join(repo, "a", "b", "CLAUDE.md"), "# deep\n");
    fx.commitAll(repo);
    __setGitRunnerForTest(async () => undefined);
    try {
      const r = await scan({ repos: [repo], ides: ["claude-code"] });
      expect(claudeMds(r)).toEqual([[repo, "a/b/CLAUDE.md", "repo-local"]]);
      expect(r.warnings.map((w) => w.message)).toContain("git could not read this repository; its files are reported as repo-local");
    } finally {
      __setGitRunnerForTest(null);
    }
  });

  // F3
  it("warns, naming the repo, when git cannot list its untracked files", async () => {
    const repo = fx.repo("others-fail");
    write(join(repo, "CLAUDE.md"), "# top\n");
    fx.commitAll(repo);
    write(join(repo, "a", "b", "CLAUDE.md"), "# untracked\n");
    __setGitRunnerForTest(async (cwd, args) => (args.includes("--others") ? undefined : realGit(cwd, args)));
    try {
      const r = await scan({ repos: [repo], ides: ["claude-code"] });
      expect(r.warnings).toEqual([{ root: repo, message: "git could not list its untracked files; untracked CLAUDE.md files below the top level are not reported" }]);
    } finally {
      __setGitRunnerForTest(null);
    }
  });

  // F4, F8
  const withCap = async <T,>(cap: number, fn: () => Promise<T>): Promise<T> => {
    __setNestedClaudeMdCapForTest(cap);
    try {
      return await fn();
    } finally {
      __setNestedClaudeMdCapForTest(1000);
    }
  };
  it.each([
    ["a git repo", true],
    ["a plain folder", false],
  ])("counts only files the deep pass reports towards the cap, in %s", async (_label, isRepo) => {
    const dir = isRepo ? fx.repo("cap-count-git") : join(fx.root, "cap-count-plain");
    // A and B sort before the top-level CLAUDE.md, so a count that included it would warn here.
    for (const d of ["", "A/x", "B/x"]) write(join(dir, d, "CLAUDE.md"), `# ${d}\n`);
    const r = await withCap(2, () => scan({ repos: [dir], ides: ["claude-code"] }));
    expect(claudeMds(r).map((c) => c[1])).toEqual(["CLAUDE.md", "A/x/CLAUDE.md", "B/x/CLAUDE.md"]);
    expect(r.warnings).toEqual([]);
  });
  it.each([
    ["a git repo", true],
    ["a plain folder", false],
  ])("warns at one file past the cap, in %s", async (_label, isRepo) => {
    const dir = isRepo ? fx.repo("cap-over-git") : join(fx.root, "cap-over-plain");
    for (const d of ["", "A/x", "B/x", "y/z/w"]) write(join(dir, d, "CLAUDE.md"), `# ${d}\n`);
    const r = await withCap(2, () => scan({ repos: [dir], ides: ["claude-code"] }));
    expect(claudeMds(r).map((c) => c[1])).toEqual(["CLAUDE.md", "A/x/CLAUDE.md", "B/x/CLAUDE.md"]);
    expect(r.warnings).toEqual([{ root: dir, message: "more than 2 CLAUDE.md files; the rest are not reported" }]);
  });

  it("does not warn at the cap when the file past it is gone from disk", async () => {
    const repo = fx.repo("cap-gone");
    for (const d of ["A/x", "B/x", "C/x"]) write(join(repo, d, "CLAUDE.md"), `# ${d}\n`);
    fx.commitAll(repo);
    rmSync(join(repo, "C", "x", "CLAUDE.md"));
    const r = await withCap(2, () => scan({ repos: [repo], ides: ["claude-code"] }));
    expect(claudeMds(r).map((c) => c[1])).toEqual(["A/x/CLAUDE.md", "B/x/CLAUDE.md"]);
    expect(r.warnings).toEqual([]);
  });

  // F5, M13, M13b
  it("searches a folder outside git 8 levels deep, and warns past that", async () => {
    const dir = join(fx.root, "plain-depth");
    write(join(dir, "1", "2", "3", "4", "5", "6", "7", "8", "CLAUDE.md"), "# eight\n");
    write(join(dir, "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "x9", "CLAUDE.md"), "# nine\n");
    const r = await scan({ repos: [dir], ides: ["claude-code"] });
    expect(claudeMds(r).map((c) => c[1])).toEqual(["1/2/3/4/5/6/7/8/CLAUDE.md"]);
    expect(r.warnings).toEqual([{ root: dir, message: "folders more than 8 levels down are not searched for CLAUDE.md" }]);
  });

  // F6
  it("reads a skill as repo-local when the default branch holds a regular file, not a link, at the link's path", async () => {
    const repo = fx.repo("link-mode");
    write(join(repo, ".claude", "skills", "s", "SKILL.md"), SKILL("s"));
    write(join(repo, ".agents", "skills"), "../.claude/skills");
    fx.commitAll(repo);
    git(repo, "checkout", "-q", "-b", "feat");
    rmSync(join(repo, ".agents", "skills"));
    symlinkSync("../.claude/skills", join(repo, ".agents", "skills"));
    fx.commitAll(repo);
    expect(skillScopes(await scan({ repos: [repo], ides: ["codex"] }))).toEqual([[".agents/skills/s/SKILL.md", "repo-local"]]);
  });

  // X2: the link's target is read on the default branch, not at HEAD.
  it("reads a skill as repo-local when the link was repointed in a commit off the default branch", async () => {
    const repo = fx.repo("link-head");
    write(join(repo, ".claude", "skills", "s", "SKILL.md"), SKILL("s"));
    write(join(repo, "other", "skills", "s", "SKILL.md"), SKILL("s"));
    linkSkills(repo, ".agents");
    fx.commitAll(repo);
    git(repo, "checkout", "-q", "-b", "feat");
    rmSync(join(repo, ".agents", "skills"));
    symlinkSync("../other/skills", join(repo, ".agents", "skills"));
    fx.commitAll(repo);
    expect(skillScopes(await scan({ repos: [repo], ides: ["codex"] }))).toEqual([[".agents/skills/s/SKILL.md", "repo-local"]]);
  });

  // M4
  it("follows a chain of committed directory links", async () => {
    const repo = fx.repo("link-chain");
    write(join(repo, ".claude", "skills", "s", "SKILL.md"), SKILL("s"));
    linkSkills(repo, ".kiro");
    linkSkills(repo, ".agents", "../.kiro/skills");
    fx.commitAll(repo);
    expect(skillScopes(await scan({ repos: [repo], ides: ["codex"] }))).toEqual([[".agents/skills/s/SKILL.md", "repo-committed"]]);
  });

  // M7
  it("reads a link's committed target afresh on the next scan", async () => {
    const repo = fx.repo("link-rescan");
    write(join(repo, ".claude", "skills", "s", "SKILL.md"), SKILL("s"));
    write(join(repo, "other", "skills", "s", "SKILL.md"), SKILL("s"));
    linkSkills(repo, ".agents");
    fx.commitAll(repo);
    expect(skillScopes(await scan({ repos: [repo], ides: ["codex"] }))).toEqual([[".agents/skills/s/SKILL.md", "repo-committed"]]);
    rmSync(join(repo, ".agents", "skills"));
    symlinkSync("../other/skills", join(repo, ".agents", "skills"));
    fx.commitAll(repo);
    expect(skillScopes(await scan({ repos: [repo], ides: ["codex"] }))).toEqual([[".agents/skills/s/SKILL.md", "repo-committed"]]);
  });

  // M14
  it("does not walk into a nested repo below a folder outside git", async () => {
    const dir = join(fx.root, "plain-nested-repo");
    write(join(dir, "inner", "x", "CLAUDE.md"), "# inner\n");
    write(join(dir, "kept", "k", "CLAUDE.md"), "# kept\n");
    git(join(dir, "inner"), "init", "-q");
    expect(claudeMds(await scan({ repos: [dir], ides: ["claude-code"] })).map((c) => c[1])).toEqual(["kept/k/CLAUDE.md"]);
  });

  // M16
  it("walks a folder outside git reached twice through a link once", async () => {
    const dir = join(fx.root, "plain-alias");
    write(join(dir, "deep", "real", "x", "CLAUDE.md"), "# x\n");
    symlinkSync(join(dir, "deep", "real"), join(dir, "deep", "alias"));
    expect(claudeMds(await scan({ repos: [dir], ides: ["claude-code"] }))).toHaveLength(1);
  });

  // M17
  it("leaves a candidate subfolder of a folder outside git to its own pass", async () => {
    const dir = join(fx.root, "plain-candidate");
    write(join(dir, "pkg", ".claude", "rules", "r.md"), "# r\n");
    write(join(dir, "pkg", "deep", "CLAUDE.md"), "# deep\n");
    expect(claudeMds(await scan({ repos: [dir], ides: ["claude-code"] }))).toEqual([[join(dir, "pkg"), "deep/CLAUDE.md", "repo-local"]]);
  });

  // M18, M19
  it("reads nested CLAUDE.md from the whole repo when collectClaudeCodeRepoAssets is given a package", async () => {
    const repo = fx.repo("repo-assets-deep");
    write(join(repo, "pkg", "x.md"), "x\n");
    write(join(repo, "other", "y", "CLAUDE.md"), "# y\n");
    const seen: string[] = [];
    await collectClaudeCodeRepoAssets(createCollectSession((a) => seen.push(assetSourcePath(a))), join(repo, "pkg"));
    expect(seen).toEqual(["other/y/CLAUDE.md"]);
  });

  // M23
  it("reads nested CLAUDE.md from the whole repo when --repo names a subfolder", async () => {
    const repo = fx.repo("repo-sub-deep");
    write(join(repo, "pkg", "x.md"), "x\n");
    write(join(repo, "other", "y", "CLAUDE.md"), "# y\n");
    expect(claudeMds(await scan({ repos: [join(repo, "pkg")], ides: ["claude-code"] })).map((c) => c[1])).toEqual(["other/y/CLAUDE.md"]);
  });

  // M21
  it("reports a tracked CLAUDE.md inside a gitignored folder", async () => {
    const repo = fx.repo("ignored-tracked");
    write(join(repo, ".gitignore"), "ign/\n");
    write(join(repo, "ign", "x", "CLAUDE.md"), "# forced\n");
    fx.commitAll(repo);
    git(repo, "add", "-f", "ign/x/CLAUDE.md");
    git(repo, "commit", "-q", "-m", "force");
    expect(claudeMds(await scan({ repos: [repo], ides: ["claude-code"] })).map((c) => [c[1], c[2]])).toEqual([["ign/x/CLAUDE.md", "repo-committed"]]);
  });

  // F9
  it("reports a committed lower-case claude.md the way the folder pass opens it (case-insensitive disks)", async () => {
    const repo = fx.repo("case-claude-md");
    write(join(repo, "one", "claude.md"), "# one\n");
    write(join(repo, "two", "x", "claude.md"), "# two\n");
    fx.commitAll(repo);
    write(join(repo, "three", "y", "claude.md"), "# three\n");
    if (!existsSync(join(repo, "one", "CLAUDE.md"))) return; // case-sensitive disk
    expect(claudeMds(await scan({ repos: [repo], ides: ["claude-code"] })).map((c) => [c[1], c[2]])).toEqual([
      ["one/CLAUDE.md", "repo-committed"],
      ["three/y/CLAUDE.md", "repo-local"],
      ["two/x/CLAUDE.md", "repo-committed"],
    ]);
  });
});

describe("final re-check: case spellings, the walk's bounds, links and listing", () => {
  const gitOut = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
  const claudeMds = (r: Awaited<ReturnType<typeof scan>>) =>
    r.assets.filter((a) => a.type === "claude_md").map((a) => [a.projectPath, a.sourcePath, a.scope]);
  const withCap = async <T,>(cap: number, fn: () => Promise<T>): Promise<T> => {
    __setNestedClaudeMdCapForTest(cap);
    try {
      return await fn();
    } finally {
      __setNestedClaudeMdCapForTest(1000);
    }
  };
  const failingGit = async <T,>(fn: () => Promise<T>): Promise<T> => {
    __setGitRunnerForTest(async () => undefined);
    try {
      return await fn();
    } finally {
      __setGitRunnerForTest(null);
    }
  };
  const caseInsensitive = (dir: string) => existsSync(join(dir, "CASE-PROBE")) || (write(join(dir, "case-probe"), ""), existsSync(join(dir, "CASE-PROBE")));

  // Item 1, F1
  it("reads a CLAUDE.md renamed from claude.md on disk only as repo-committed (case-insensitive disks)", async () => {
    const repo = fx.repo("rename-on-disk");
    write(join(repo, "claude.md"), "# top\n");
    write(join(repo, "one", "x", "claude.md"), "# deep\n");
    fx.commitAll(repo);
    if (!caseInsensitive(fx.root)) return;
    for (const d of [repo, join(repo, "one", "x")]) {
      renameSync(join(d, "claude.md"), join(d, "tmp.md"));
      renameSync(join(d, "tmp.md"), join(d, "CLAUDE.md"));
    }
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(claudeMds(r).map((c) => [c[1], c[2]])).toEqual([["CLAUDE.md", "repo-committed"], ["one/x/CLAUDE.md", "repo-committed"]]);
  });

  // Item 1, F7
  it("takes the baseline from the tracked spelling that is on disk when git tracks several (case-insensitive disks)", async () => {
    const repo = fx.repo("three-variants");
    if (!caseInsensitive(fx.root)) return;
    write(join(repo, "f", "claude.md"), "# on disk\n");
    git(repo, "add", "f/claude.md");
    for (const [name, body] of [["CLAUDE.md", "# upper\n"], ["Claude.md", "# title\n"]] as const) {
      write(join(fx.root, "variant-body"), body);
      const sha = gitOut(repo, "hash-object", "-w", join(fx.root, "variant-body"));
      git(repo, "update-index", "--add", "--cacheinfo", `100644,${sha},f/${name}`);
    }
    git(repo, "commit", "-q", "-m", "variants");
    const [asset] = (await scan({ repos: [repo], ides: ["claude-code"] })).assets.filter((a) => a.type === "claude_md");
    expect([asset!.scope, asset!.payload.baseline_content_hash]).toEqual(["repo-committed", sha256("# on disk\n")]);
  });

  it("reads a file as repo-local when git tracks two other case variants of it (case-insensitive disks)", async () => {
    const repo = fx.repo("two-variants");
    if (!caseInsensitive(fx.root)) return;
    mkdirSync(join(repo, "f"));
    for (const [name, body] of [["CLAUDE.md", "# upper\n"], ["Claude.md", "# title\n"]] as const) {
      write(join(fx.root, "variant-body"), body);
      const sha = gitOut(repo, "hash-object", "-w", join(fx.root, "variant-body"));
      git(repo, "update-index", "--add", "--cacheinfo", `100644,${sha},f/${name}`);
    }
    git(repo, "commit", "-q", "-m", "variants");
    write(join(repo, "f", "claude.md"), "# on disk\n");
    const [asset] = (await scan({ repos: [repo], ides: ["claude-code"] })).assets.filter((a) => a.type === "claude_md");
    expect(asset!.scope).toBe("repo-local");
  });

  // Item 2, F2, M8
  it("does not let an unreadable CLAUDE.md stop the walk early", async () => {
    const dir = join(fx.root, "walk-unreadable");
    write(join(dir, "a", "x", "CLAUDE.md"), "x".repeat(1024 * 1024 + 1));
    for (const d of ["b/x", "c/x", "d/e/f"]) write(join(dir, d, "CLAUDE.md"), `# ${d}\n`);
    const r = await withCap(2, () => scan({ repos: [dir], ides: ["claude-code"] }));
    expect(claudeMds(r).map((c) => c[1])).toEqual(["b/x/CLAUDE.md", "c/x/CLAUDE.md"]);
    expect(r.warnings.map((w) => w.message)).toContain("more than 2 CLAUDE.md files; the rest are not reported");
  });

  // Item 3, F3
  it("does not report a candidate folder's files again through a link to it", async () => {
    const dir = join(fx.root, "walk-candidate-link");
    write(join(dir, "pkg", "CLAUDE.md"), "# pkg\n");
    write(join(dir, "pkg", "deep", "CLAUDE.md"), "# deep\n");
    symlinkSync(join(dir, "pkg"), join(dir, "alias"));
    const r = await scan({ repos: [dir], ides: ["claude-code"] });
    expect(claudeMds(r).filter((c) => String(c[1]).endsWith("deep/CLAUDE.md"))).toHaveLength(1);
  });

  // Item 4, F4
  it("does not warn that git could not read a repo whose files it listed", async () => {
    const repo = fx.repo("false-git-warning");
    write(join(repo, "a", "b", "CLAUDE.md"), "# deep\n");
    fx.commitAll(repo);
    write(join(fx.home, "notes", "CLAUDE.md"), "# notes\n");
    symlinkSync(join(fx.home, "notes"), join(repo, "notes"));
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.warnings.map((w) => w.message)).not.toContain("git could not read this repository; its files are reported as repo-local");
    expect(claudeMds(r).find((c) => c[1] === "a/b/CLAUDE.md")?.[2]).toBe("repo-committed");
  });

  // Item 5, F5
  it("reads a file list larger than 8 MiB from git ls-files", async () => {
    const repo = fx.repo("big-list");
    write(join(repo, "a", "b", "CLAUDE.md"), "# deep\n");
    fx.commitAll(repo);
    const realGitPath = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
    const bin = join(fx.root, "big-list-bin");
    // A git that pads `ls-files -z` with 9 MiB of extra names and runs the real git for the rest.
    write(join(bin, "git"), `#!/bin/sh\ncase " $* " in\n  *" ls-files -z "*) "${realGitPath}" "$@" && exec perl -e 'print "pad/", "x" x 190, $_, "\\0" for 1..48000' ;;\nesac\nexec "${realGitPath}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const r = await scan({ repos: [repo], ides: ["claude-code"] });
      expect(claudeMds(r).map((c) => [c[1], c[2]])).toEqual([["a/b/CLAUDE.md", "repo-committed"]]);
      expect(r.warnings).toEqual([]);
    } finally {
      process.env.PATH = path;
    }
  });

  // Item 6, F6
  it("does not count a file past the cap that would not be reported", async () => {
    const repo = fx.repo("cap-link-out");
    for (const d of ["a/x", "b/x"]) write(join(repo, d, "CLAUDE.md"), `# ${d}\n`);
    write(join(fx.root, "cap-outside.md"), "# outside\n");
    mkdirSync(join(repo, "c", "x"), { recursive: true });
    symlinkSync(join(fx.root, "cap-outside.md"), join(repo, "c", "x", "CLAUDE.md"));
    const r = await withCap(2, () => scan({ repos: [repo], ides: ["claude-code"] }));
    expect(claudeMds(r).map((c) => c[1])).toEqual(["a/x/CLAUDE.md", "b/x/CLAUDE.md"]);
    expect(r.warnings.map((w) => w.message)).toEqual(["resolves outside HOME and the scanned repos; not read"]);
  });

  // Item 7, F8
  it("does not follow an untracked link out of the repo when git cannot list it", async () => {
    const repo = fx.repo("unlisted-link-out");
    write(join(repo, "a", "CLAUDE.md"), "# a\n");
    write(join(fx.home, "kb", "x", "CLAUDE.md"), "# kb\n");
    symlinkSync(join(fx.home, "kb"), join(repo, "kb"));
    const r = await failingGit(() => scan({ repos: [repo], ides: ["claude-code"] }));
    expect(claudeMds(r).map((c) => c[1])).toEqual(["a/CLAUDE.md"]);
  });

  // Item 8: root orders across two copies of one remote.
  it.each([
    ["[B/apps, A]", (a: string, b: string) => [join(b, "apps"), a]],
    ["[A/apps, B]", (a: string, b: string) => [join(a, "apps"), b]],
    ["[A/x/y, B]", (a: string, b: string) => [join(a, "x", "y"), b]],
  ])("lets the winning copy claim a shared nested CLAUDE.md with roots %s", async (label, roots) => {
    const tag = label.replace(/[^a-z]/gi, "");
    const [a, b] = ["a", "b"].map((n) => {
      const repo = fx.repo(`orders-${tag}-${n}`);
      write(join(repo, "apps", "web", "CLAUDE.md"), "# web\n");
      write(join(repo, "x", "y", "keep.md"), "k\n");
      git(repo, "remote", "add", "origin", "https://example.com/o/orders.git");
      fx.commitAll(repo);
      git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      return repo;
    });
    write(join(b!, "apps", "web", "CLAUDE.md"), "# stale edit\n");
    utimesSync(join(b!, ".git", "index"), new Date(2000, 0, 1), new Date(2000, 0, 1));
    const r = await scan({ repos: roots(a!, b!), ides: ["claude-code"] });
    expect(claudeMds(r).filter((c) => c[1] === "apps/web/CLAUDE.md")).toEqual([[a, "apps/web/CLAUDE.md", "repo-committed"]]);
  });

  it("reads a repo git could not list as repo-local, then as repo-committed once it can", async () => {
    const repo = fx.repo("unlisted-then-listed");
    write(join(repo, "a", "b", "CLAUDE.md"), "# deep\n");
    fx.commitAll(repo);
    expect(claudeMds(await failingGit(() => scan({ repos: [repo], ides: ["claude-code"] })))).toEqual([[repo, "a/b/CLAUDE.md", "repo-local"]]);
    expect(claudeMds(await scan({ repos: [repo], ides: ["claude-code"] }))).toEqual([[repo, "a/b/CLAUDE.md", "repo-committed"]]);
  });

  // M5
  it("walks into a candidate subfolder of a repo git could not list", async () => {
    const repo = fx.repo("unlisted-candidate");
    write(join(repo, "pkg", ".claude", "rules", "r.md"), "# r\n");
    write(join(repo, "pkg", "deep", "CLAUDE.md"), "# deep\n");
    const r = await failingGit(() => scan({ repos: [repo], ides: ["claude-code"] }));
    expect(claudeMds(r)).toEqual([[repo, "pkg/deep/CLAUDE.md", "repo-local"]]);
  });

  // M26
  it("walks the whole repo git could not list when --repo names a subfolder", async () => {
    const repo = fx.repo("unlisted-subfolder");
    write(join(repo, "pkg", "x.md"), "x\n");
    write(join(repo, "other", "y", "CLAUDE.md"), "# y\n");
    const r = await failingGit(() => scan({ repos: [join(repo, "pkg")], ides: ["claude-code"] }));
    expect(claudeMds(r).map((c) => c[1])).toEqual(["other/y/CLAUDE.md"]);
  });
});

describe("files crafted to make a pattern backtrack", () => {
  // Each scan took 20 seconds or more while a pattern retried a long run from each of its
  // characters, and the app scans every few minutes. Linear, it takes well under a second.
  it("scans a skill whose description holds 200 KB of spaces quickly, to the same asset", async () => {
    const repo = fx.repo("slow-skill");
    const description = `x${" ".repeat(200_000)}y`;
    const body = `---\nname: slow\ndescription: ${description}\n---\nBody.\n`;
    write(join(repo, ".claude", "skills", "slow", "SKILL.md"), body);
    fx.commitAll(repo);
    const start = performance.now();
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    const ms = performance.now() - start;
    expect(r.assets.map((a) => [a.type, a.name, a.scope, a.sourcePath])).toEqual([["skill", "slow", "repo-committed", ".claude/skills/slow/SKILL.md"]]);
    expect(r.assets[0]!.contentHash).toBe(sha256(body));
    expect(r.assets[0]!.payload).toMatchObject({ description, invocation: "/slow", baseline_content_hash: sha256(body) });
    expect(r.warnings).toEqual([]);
    expect(ms).toBeLessThan(10_000);
  });

  it("reads a TOML agent's first name line after any blank lines, quickly however many there are", async () => {
    const repo = fx.repo("toml-names");
    const agents = join(repo, ".codex", "agents");
    write(join(agents, "indented.toml"), '\n  \n\t\n  name = "indented"\n');
    write(join(agents, "second.toml"), 'title = "t"\nkey name = "no"\nname = "second"\n');
    write(join(agents, "split.toml"), 'name\n=\n"split"\n');
    write(join(agents, "commented.toml"), '# name = "c"\n');
    write(join(agents, "deep.toml"), `${"\n".repeat(200_000)}title = "t"\nname = "deep"\n`);
    const start = performance.now();
    const r = await scan({ repos: [repo], ides: ["codex"] });
    const ms = performance.now() - start;
    expect(r.assets.map((a) => [a.sourcePath, a.name]).sort()).toEqual([
      [".codex/agents/commented.toml", "Commented"],
      [".codex/agents/deep.toml", "deep"],
      [".codex/agents/indented.toml", "indented"],
      [".codex/agents/second.toml", "second"],
      [".codex/agents/split.toml", "split"],
    ]);
    expect(ms).toBeLessThan(10_000);
  });
});

describe("git's environment", () => {
  // A committed CLAUDE.md, and an untracked one two folders down, which only git's list of
  // files that are not ignored finds.
  const repoWithTwo = (name: string): string => {
    const repo = fx.repo(name);
    write(join(repo, "CLAUDE.md"), "# rules\n");
    fx.commitAll(repo);
    write(join(repo, "notes", "deep", "CLAUDE.md"), "# notes\n");
    return repo;
  };
  // An excludes file that ignores everything, so git no longer lists notes/deep/CLAUDE.md.
  const ignoreAll = () => {
    const file = join(fx.root, "ignore-all");
    write(file, "*\n");
    return file;
  };
  const scanWith = async (repo: string, vars: Record<string, string>) => {
    const saved = Object.keys(vars).map((k) => [k, process.env[k]] as const);
    try {
      Object.assign(process.env, vars);
      return await scan({ repos: [repo], ides: ["claude-code"] });
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  // A scan started from a git hook inherits GIT_DIR, GIT_INDEX_FILE and the -c config of the
  // git that ran the hook. None of them may change what the scan reads.
  it.each([
    ["GIT_DIR", (other: string) => ({ GIT_DIR: join(other, ".git") })],
    ["GIT_WORK_TREE", (other: string) => ({ GIT_WORK_TREE: other })],
    ["GIT_INDEX_FILE", (other: string) => ({ GIT_INDEX_FILE: join(other, ".git", "index") })],
    ["GIT_OBJECT_DIRECTORY", (other: string) => ({ GIT_OBJECT_DIRECTORY: join(other, ".git", "objects") })],
    ["GIT_CONFIG_PARAMETERS", () => ({ GIT_CONFIG_PARAMETERS: `'core.excludesfile'='${ignoreAll()}'` })],
    ["GIT_CONFIG_COUNT", () => ({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.excludesFile", GIT_CONFIG_VALUE_0: ignoreAll() })],
  ])("reads the scanned repo whatever %s says", async (name, vars) => {
    const repo = repoWithTwo(`env-${name}`);
    const other = fx.repo(`env-${name}-other`);
    write(join(other, "README.md"), "# other\n");
    fx.commitAll(other);
    const r = await scanWith(repo, vars(other));
    expect(r.assets.map((a) => [a.sourcePath, a.scope]).sort()).toEqual([
      ["CLAUDE.md", "repo-committed"],
      ["notes/deep/CLAUDE.md", "repo-local"],
    ]);
    expect(r.warnings).toEqual([]);
  });

  // The variables that only choose which config files git reads stay, as HOME does: the tests,
  // the examples and a user set them to keep git to the config they mean.
  it("keeps the variables that choose git's config files", async () => {
    const repo = repoWithTwo("env-global");
    const config = join(fx.root, "ignore-all.gitconfig");
    write(config, `[core]\n\texcludesFile = ${ignoreAll()}\n`);
    const r = await scanWith(repo, { GIT_CONFIG_GLOBAL: config });
    expect(r.assets.map((a) => [a.sourcePath, a.scope])).toEqual([["CLAUDE.md", "repo-committed"]]);
  });
});

describe("known limits", () => {
  it("does not scan namespaced command folders or nested Cursor rule folders", async () => {
    const repo = fx.repo("nested");
    write(join(repo, ".claude", "commands", "top.md"), "# top\n");
    write(join(repo, ".claude", "commands", "group", "deep.md"), "# deep\n");
    write(join(repo, ".cursor", "rules", "top.mdc"), "Top rule.\n");
    write(join(repo, ".cursor", "rules", "group", "deep.mdc"), "Deep rule.\n");
    const r = await scan({ repos: [repo], ides: ["claude-code", "cursor"] });
    expect(summary(r.assets)).toEqual([
      "claude-code command repo-local .claude/commands/top.md",
      "cursor rule repo-local .cursor/rules/top.mdc",
    ]);
    expect(r.warnings).toEqual([]);
  });

  // Declined by the author: files agents load that are new scope for this tool.
  it.each([
    ["~/.claude/commands/", () => join(fx.home, ".claude", "commands", "go.md")],
    ["~/.codex/AGENTS.md", () => join(fx.home, ".codex", "AGENTS.md")],
    ["~/.codex/prompts/", () => join(fx.home, ".codex", "prompts", "review.md")],
    ["a repo's .claude/CLAUDE.md", (repo: string) => join(repo, ".claude", "CLAUDE.md")],
    ["a repo's CLAUDE.local.md", (repo: string) => join(repo, "CLAUDE.local.md")],
    ["CLAUDE.md in a folder above the repo", (repo: string) => join(repo, "..", "CLAUDE.md")],
  ])("does not scan %s", async (_label, where) => {
    const repo = fx.repo(`unscanned-${_label.replace(/[^a-z]/gi, "")}`);
    const outer = join(fx.root, "CLAUDE.md");
    const file = where(repo);
    write(file, "# instructions\n");
    // Positive control: a file the scan does read, beside the one it does not.
    write(join(repo, ".cursor", "rules", "control.mdc"), "Rule.\n");
    try {
      const r = await scan({ repos: [repo] });
      expect(summary(r.assets)).toEqual(["cursor rule repo-local .cursor/rules/control.mdc"]);
    } finally {
      if (file === outer) rmSync(outer);
    }
  });

  it("reports no asset for MCP config or agent permissions", async () => {
    const repo = fx.repo("mcp");
    write(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "docs-mcp" } } }));
    write(join(repo, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
    write(join(fx.home, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Read(./.env)"] } }));
    write(join(repo, ".cursor", "rules", "control.mdc"), "Rule.\n");
    const r = await scan({ repos: [repo] });
    expect(summary(r.assets)).toEqual(["cursor rule repo-local .cursor/rules/control.mdc"]);
    expect(r.warnings).toEqual([]);
  });

  it("skips a submodule passed as a repo, with a warning, and reports none of its config", async () => {
    const sub = fx.repo("sub-src");
    write(join(sub, "CLAUDE.md"), "# Submodule rules\n");
    write(join(sub, "AGENTS.md"), "# Submodule agents\n");
    write(join(sub, ".cursor", "rules", "r.mdc"), "Rule.\n");
    write(join(sub, ".kiro", "steering", "s.md"), "Steer.\n");
    fx.commitAll(sub);
    const sup = fx.repo("super");
    git(sup, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
    // Every tool, and a folder inside the submodule too: both go through each reader's skip.
    const r = await scan({ repos: [join(sup, "sub"), join(sup, "sub", ".cursor")] });
    expect(r.warnings.map((w) => [w.root, w.message])).toEqual([
      [join(sup, "sub"), expect.stringMatching(/linked worktree or a submodule/)],
      [join(sup, "sub", ".cursor"), expect.stringMatching(/linked worktree or a submodule/)],
    ]);
    expect(r.assets).toEqual([]);
  });

  it("lists AGENTS.md once for each tool that reads it", async () => {
    const repo = fx.repo("agents-md");
    write(join(repo, "AGENTS.md"), "# Agents\n");
    const r = await scan({ repos: [repo] });
    expect(summary(r.assets)).toEqual([
      "claude-code agents_md repo-local AGENTS.md",
      "codex agents_md repo-local AGENTS.md",
      "cursor agents_md repo-local AGENTS.md",
    ]);
  });
});

describe("helpers", () => {
  it("strips credentials from https remotes and leaves scp-style ones alone", () => {
    expect(stripRemoteCredentials("https://x:y@example.com/o/r.git")).toBe("https://example.com/o/r.git");
    expect(stripRemoteCredentials("git@example.com:o/r.git")).toBe("git@example.com:o/r.git");
  });

  it("strips a password from an scp-style remote and credential query parameters from a URL", () => {
    expect(stripRemoteCredentials("user:secret@example.com:o/r.git")).toBe("example.com:o/r.git");
    expect(stripRemoteCredentials("https://example.com/o/r.git?token=abc")).toBe("https://example.com/o/r.git");
  });

  it("strips credentials from a remote the URL parser refuses, and drops a fragment", () => {
    expect(stripRemoteCredentials("https://user:s3cret@example.com:99999/o/r.git")).toBe("https://example.com:99999/o/r.git");
    expect(stripRemoteCredentials("https://example.com/o/r.git#frag")).toBe("https://example.com/o/r.git");
    expect(stripRemoteCredentials("user:p@ss@example.com:o/r.git")).toBe("example.com:o/r.git");
  });

  it("drops a query or fragment and the userinfo up to the last @ from a remote the URL parser refuses", () => {
    expect(stripRemoteCredentials("https://u:p@host.com:99999/o/r.git?token=SECRET")).toBe("https://host.com:99999/o/r.git");
    expect(stripRemoteCredentials("https://host.com:99999/o/r.git?token=SECRET")).toBe("https://host.com:99999/o/r.git");
    expect(stripRemoteCredentials("https://u:ab+c/d=@git-codecommit.example.com/v1/repos/r")).toBe("https://git-codecommit.example.com/v1/repos/r");
    expect(stripRemoteCredentials("https://u:p@host.com:99999?q=a@c")).toBe("https://host.com:99999");
    expect(stripRemoteCredentials("https://u:p@ss@host.com:99999/o/r.git")).toBe("https://host.com:99999/o/r.git");
    expect(stripRemoteCredentials("HTTPS://u:p@host.com/r.git")).toBe("https://host.com/r.git");
  });

  it("keeps a # or ? in an ssh:// or file:// path, and drops userinfo that holds one", () => {
    expect(stripRemoteCredentials("ssh://h.example/r#1.git")).toBe("ssh://h.example/r#1.git");
    expect(stripRemoteCredentials("ssh://git@h.example/r?2.git")).toBe("ssh://h.example/r?2.git");
    expect(stripRemoteCredentials("file:///srv/re#po.git")).toBe("file:///srv/re#po.git");
    expect(stripRemoteCredentials("https://user:my#pass@h.example/r.git")).toBe("https://h.example/r.git");
    expect(stripRemoteCredentials("https://user:12#34@h.example/r.git")).toBe("https://h.example/r.git");
    expect(stripRemoteCredentials("https://tok#en@h.example/r.git")).toBe("https://h.example/r.git");
    expect(stripRemoteCredentials("https://user:my?pass@h.example/r.git")).toBe("https://h.example/r.git");
  });

  it("strips 8-bit string controls whole, an OSC ended by 8-bit ST, and three more bidi marks", () => {
    expect(stripTerminalEscapes("\u0090q#payload\u009cX")).toBe("X");
    expect(stripTerminalEscapes("\u0098sos\u009cX \u009epm\u009cY \u009fapc\u009cZ")).toBe("X Y Z");
    expect(stripTerminalEscapes("\u009d0;title\u009cX")).toBe("X");
    expect(stripTerminalEscapes("\u001b]0;t\u009cX rest")).toBe("X rest");
    expect(stripTerminalEscapes("\u009d0;t\u001b\\X")).toBe("X");
    expect(stripTerminalEscapes("\u001b]0;t\u009cX\u0007 rest")).toBe("X rest");
    expect(stripTerminalEscapes("a\u061cb\u200ec\u200fd")).toBe("abcd");
    expect(escapeControls("a\u061cb\u200ec\u200fd")).toBe("a\\u061cb\\u200ec\\u200fd");
  });

  it("strips CSI intermediate bytes and 7-bit SOS, PM and APC strings", () => {
    expect(stripTerminalEscapes("\u001b[1 qX")).toBe("X");
    expect(stripTerminalEscapes("\u001bXsos\u001b\\A \u001b^pm\u001b\\B \u001b_apc\u001b\\C")).toBe("A B C");
  });

  it("strips VT and FF, whole CSI sequences with private or intermediate bytes, DCS strings, and U+009B CSI", () => {
    expect(stripTerminalEscapes("a\u000bb\u000cc")).toBe("abc");
    expect(stripTerminalEscapes("a\u007fb")).toBe("ab");
    expect(stripTerminalEscapes("\u001b[?1049hX")).toBe("X");
    expect(stripTerminalEscapes("\u001bPq#0\u001b\\X")).toBe("X");
    expect(stripTerminalEscapes("\u009b31mX")).toBe("X");
  });

  it("strips an OSC string to the first BEL or ST on its line, and an open one to the next BEL, ESC or 8-bit ST", () => {
    expect(stripTerminalEscapes("\u001b]0;t\u0007X")).toBe("X");
    expect(stripTerminalEscapes("\u009d1\u009d2\u0007X")).toBe("X");
    expect(stripTerminalEscapes("\u001b]a\u001bb\u0007X")).toBe("X");
    expect(stripTerminalEscapes("\u001b]1\u009d2\u009cX")).toBe("X");
    expect(stripTerminalEscapes("\u001b]t\u001b\\X\u009dopen")).toBe("X");
    expect(stripTerminalEscapes("a\u001b]0;t\nb\u0007c")).toBe("ac");
    expect(stripTerminalEscapes("a\u009dt\u2028\u0007c")).toBe("ac");
    expect(stripTerminalEscapes("a\u001b]open\u009dtwo")).toBe("a");
  });

  // Each of these two tests took about 20 seconds while a pattern retried the rest of the line
  // from each intro, or the rest of the run from each `?`. Linear, they take a few milliseconds.
  it("strips 200 KB of unclosed OSC intros in linear time", () => {
    for (const s of ["\u009d".repeat(200_000), "\u001b]".repeat(100_000)]) {
      const start = performance.now();
      expect(stripTerminalEscapes(`${s}\n\u0007X`)).toBe("X");
      expect(performance.now() - start).toBeLessThan(1000);
    }
  });

  it("strips credentials after the first ? or # of a URL's userinfo as before, and in linear time", () => {
    expect(stripRemoteCredentials("https://a?b@c?d@h.example/r")).toBe("https://h.example/r");
    expect(stripRemoteCredentials("https://a#b?c@h.example/r")).toBe("https://h.example/r");
    expect(stripRemoteCredentials("ssh://u?x/@h.example/r")).toBe("ssh://u?x/@h.example/r");
    for (const [remote, expected] of [
      [`https://${"?".repeat(200_000)}`, "https://"],
      [`ssh://${"#".repeat(200_000)}`, `ssh://${"#".repeat(200_000)}`],
    ]) {
      const start = performance.now();
      expect(stripRemoteCredentials(remote!)).toBe(expected);
      expect(performance.now() - start).toBeLessThan(1000);
    }
  });

  // git fetches from the first url, so the scan reads that one, and never follows an include.
  const remoteOf = (repo: string) => execFileSync("git", ["remote", "get-url", "origin"], { cwd: repo, encoding: "utf8" }).trim();

  it("reads the first of two origin urls, as git remote get-url does", async () => {
    const repo = fx.repo("two-urls");
    git(repo, "remote", "add", "origin", "https://first.example/r.git");
    git(repo, "config", "--add", "remote.origin.url", "https://second.example/r.git");
    write(join(repo, "CLAUDE.md"), "# rules\n");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.payload.repo_remote_url).toBe(remoteOf(repo));
    expect(remoteOf(repo)).toBe("https://first.example/r.git");
  });

  it("reads the origin url from the repo's own config, not an included file", async () => {
    const repo = fx.repo("include-url");
    git(repo, "remote", "add", "origin", "https://main.example/r.git");
    write(join(repo, "extra.cfg"), '[remote "origin"]\n\turl = https://included.example/r.git\n');
    git(repo, "config", "include.path", join(repo, "extra.cfg"));
    write(join(repo, "CLAUDE.md"), "# rules\n");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.payload.repo_remote_url).toBe(remoteOf(repo));
    expect(remoteOf(repo)).toBe("https://main.example/r.git");
  });

  it("ignores an included url even when the include comes before the repo's own", async () => {
    const repo = fx.repo("include-first");
    write(join(repo, "extra.cfg"), '[remote "origin"]\n\turl = https://included.example/r.git\n');
    git(repo, "config", "include.path", join(repo, "extra.cfg"));
    git(repo, "config", "remote.origin.url", "https://main.example/r.git");
    write(join(repo, "CLAUDE.md"), "# rules\n");
    const r = await scan({ repos: [repo], ides: ["claude-code"] });
    expect(r.assets[0]!.payload.repo_remote_url).toBe("https://main.example/r.git");
  });

  it("gives a repo no remote when git is missing", async () => {
    const repo = fx.repo("no-git-remote");
    git(repo, "remote", "add", "origin", "https://h.example/r.git");
    write(join(repo, "CLAUDE.md"), "# rules\n");
    const path = process.env.PATH;
    process.env.PATH = join(fx.root, "no-bin");
    try {
      const r = await scan({ repos: [repo], ides: ["claude-code"] });
      expect(r.assets.map((a) => [a.scope, a.payload.repo_remote_url ?? ""])).toEqual([["repo-local", ""]]);
    } finally {
      process.env.PATH = path;
    }
  });

  it("picks the in-scope checkout, then the most recent, then the first key", async () => {
    const recency: Record<string, number> = { "/a": 1, "/b": 2, "/c": 3 };
    const cands = ["/a", "/b", "/c"].map((projectKey) => ({ remoteUrl: "r", projectKey }));
    expect(await resolveRepoWinners(cands, () => true, async (k) => recency[k]!)).toEqual(new Set(["/c"]));
    expect(await resolveRepoWinners(cands, (k) => k === "/a", async (k) => recency[k]!)).toEqual(new Set(["/a"]));
    expect(await resolveRepoWinners([{ remoteUrl: "", projectKey: "/x" }], () => true)).toEqual(new Set(["/x"]));
  });

  it("breaks a recency tie in favour of the first key", async () => {
    const cands = ["/a", "/b"].map((projectKey) => ({ remoteUrl: "r", projectKey }));
    expect(await resolveRepoWinners(cands, () => true, async () => 5)).toEqual(new Set(["/a"]));
  });

  it("strips C0 control characters other than tab, newline and carriage return", () => {
    expect(stripTerminalEscapes("a\u000eb\u001fc\u0001d\te\nf\rg")).toBe("abcd\te\nf\rg");
  });
});
