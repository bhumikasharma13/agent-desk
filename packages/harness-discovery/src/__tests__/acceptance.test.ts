// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// The acceptance test: `harness-discovery scan` against a fixture HOME with one repo holding a
// Claude skill, a Codex AGENTS.md, a Cursor rule and a settings.json hook prints all four with
// the right scope and hash, and the scanner's own reads stay inside HOME and the repo — every file and
// directory read the scanner makes is recorded and checked, with bait planted outside.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Fixture, SKILL, sha256, write } from "./fixtures";

const reads = vi.hoisted(() => [] as string[]);

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const track = <A extends unknown[], R>(fn: (p: never, ...a: A) => R) =>
    ((p: string, ...a: A) => {
      reads.push(String(p));
      return fn(p as never, ...a);
    }) as unknown as typeof fn;
  return { ...real, default: real, readFile: track(real.readFile), readdir: track(real.readdir), opendir: track(real.opendir) };
});
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const track = <A extends unknown[], R>(fn: (p: never, ...a: A) => R) =>
    ((p: string, ...a: A) => {
      reads.push(String(p));
      return fn(p as never, ...a);
    }) as unknown as typeof fn;
  return { ...real, default: real, readFileSync: track(real.readFileSync), readdirSync: track(real.readdirSync) };
});

const SKILL_MD = SKILL("review", "Reviews a change against the house rules before it merges.");
const AGENTS_MD = "# Agents\n\nRun the tests before you commit.\n";
const CURSOR_RULE = "---\ndescription: House style\n---\nPrefer small functions.\n";
const HOOK = "echo checked";

let fx: Fixture;
let outside: string;
let repo: string;
let out = "";
let err = "";
let code: number;

beforeAll(async () => {
  fx = new Fixture();
  outside = realpathSync(mkdtempSync(join(tmpdir(), "hd-bait-")));
  write(join(outside, "bait", "SKILL.md"), SKILL("bait"));
  write(join(outside, "bait.sh"), "#!/bin/sh\n");
  write(join(outside, "bait.md"), "# bait\n");

  write(join(fx.home, ".claude", "settings.json"), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: HOOK }] }],
      Stop: [{ hooks: [{ type: "command", command: `bash ${join(outside, "bait.sh")}` }] }],
    },
  }));
  repo = fx.repo("demo");
  write(join(repo, ".claude", "skills", "review", "SKILL.md"), SKILL_MD);
  write(join(repo, "AGENTS.md"), AGENTS_MD);
  fx.commitAll(repo);
  write(join(repo, ".cursor", "rules", "style.mdc"), CURSOR_RULE);
  // Bait: links out of the repo that a scanner following them would read.
  symlinkSync(join(outside, "bait"), join(repo, ".claude", "skills", "bait"));
  symlinkSync(join(outside, "bait.md"), join(repo, "CLAUDE.md"));
  mkdirSync(join(repo, ".kiro"));
  symlinkSync(outside, join(repo, ".kiro", "steering"));

  const { main } = await import("../cli");
  reads.length = 0;
  code = await main(["scan", "--home", fx.home, "--repo", repo], { out: (s) => (out += s), err: (s) => (err += s) });
});
afterAll(() => {
  fx.cleanup();
  rmSync(outside, { recursive: true, force: true });
});

describe("acceptance: harness-discovery scan", () => {
  it("prints the skill, AGENTS.md, Cursor rule and hook with scope and hash", () => {
    const lines = out.trimEnd().split("\n");
    expect(lines).toEqual(expect.arrayContaining([
      `repo-committed\tclaude-code\tskill\t.claude/skills/review/SKILL.md\t${sha256(SKILL_MD).slice(0, 12)}`,
      `repo-committed\tcodex\tagents_md\tAGENTS.md\t${sha256(AGENTS_MD).slice(0, 12)}`,
      `repo-local\tcursor\trule\t.cursor/rules/style.mdc\t${sha256(CURSOR_RULE).slice(0, 12)}`,
    ]));
    expect(lines.some((l) => new RegExp(`^user\tclaude-code\thook\t\\.claude/settings\\.json#PreToolUse:[0-9a-f]{12}\t${sha256(HOOK).slice(0, 12)}$`).test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/^\d+ assets$/);
    expect(code).toBe(0);
  });

  it("keeps the scanner's own reads inside HOME and the repo, and says which links it did not follow", () => {
    expect(reads.length).toBeGreaterThan(10);
    const inside = (p: string) => {
      let real: string;
      try {
        real = realpathSync(p);
      } catch {
        return true; // never opened: nothing there to read
      }
      return [fx.home, repo].some((r) => real === r || real.startsWith(r + sep));
    };
    expect(reads.filter((p) => !inside(p))).toEqual([]);
    expect(out).not.toContain("bait");
    expect(err).toContain(`warning: ${join(repo, "CLAUDE.md")}: resolves outside HOME and the scanned repos; not read`);
    expect(err).toContain(`warning: ${join(repo, ".claude", "skills", "bait")}: resolves outside HOME and the scanned repos; not read`);
    expect(err).toContain(`warning: ${join(repo, ".kiro", "steering")}: resolves outside HOME and the scanned repos; not read`);
  });
});
