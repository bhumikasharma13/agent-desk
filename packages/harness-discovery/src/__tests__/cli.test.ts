// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../cli";

let root: string;

function capture(): { io: { out: (s: string) => void; err: (s: string) => void }; out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return { io: { out: (s) => (out += s), err: (s) => (err += s) }, out: () => out, err: () => err };
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "harness-discovery-cli-")));
  mkdirSync(join(root, ".cursor", "rules"), { recursive: true });
  writeFileSync(join(root, ".cursor", "rules", "tone.md"), "Be brief.\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("harness-discovery CLI", () => {
  it("prints the scan as JSON with --json", async () => {
    const c = capture();
    const code = await main(["scan", "--home", root, "--ide", "cursor", "--json"], c.io);
    expect(code).toBe(0);
    const parsed = JSON.parse(c.out());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.assets.map((a: { sourcePath: string }) => a.sourcePath)).toEqual([".cursor/rules/tone.md"]);
  });

  it("prints one tab-separated line per asset without --json", async () => {
    const c = capture();
    expect(await main(["scan", "--home", root, "--ide", "cursor"], c.io)).toBe(0);
    expect(c.out()).toMatch(/^user\tcursor\trule\t\.cursor\/rules\/tone\.md\t[0-9a-f]{12}\n1 asset\n$/);
  });

  it("escapes bidirectional controls in file names", async () => {
    const bidiHome = realpathSync(mkdtempSync(join(tmpdir(), "harness-discovery-cli-bidi-")));
    try {
      mkdirSync(join(bidiHome, ".cursor", "rules"), { recursive: true });
      writeFileSync(join(bidiHome, ".cursor", "rules", "a‮cod.md"), "hi\n");
      const c = capture();
      expect(await main(["scan", "--home", bidiHome, "--ide", "cursor"], c.io)).toBe(0);
      expect(c.out()).not.toMatch(/[‪-‮⁦-⁩]/);
      expect(c.out()).toContain("a\\u202ecod.md");
    } finally {
      rmSync(bidiHome, { recursive: true, force: true });
    }
  });

  it("escapes control characters in file names, one line per asset", async () => {
    const evilHome = realpathSync(mkdtempSync(join(tmpdir(), "harness-discovery-cli-evil-")));
    try {
      mkdirSync(join(evilHome, ".cursor", "rules"), { recursive: true });
      writeFileSync(join(evilHome, ".cursor", "rules", "x\u001b]52;c;aGk=\u0007\nuser\tcursor\trule\tFAKE\u009b.md"), "hi\n");
      const c = capture();
      expect(await main(["scan", "--home", evilHome, "--ide", "cursor"], c.io)).toBe(0);
      expect(c.out()).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
      const lines = c.out().trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("\\x1b]52;c;aGk=\\x07\\x0auser\\x09cursor");
      expect(lines[0]).toContain("FAKE\\x9b.md");
    } finally {
      rmSync(evilHome, { recursive: true, force: true });
    }
  });

  it("exits 1 when a repo cannot be scanned", async () => {
    const c = capture();
    expect(await main(["scan", "--home", root, "--ide", "cursor", "--repo", join(root, "nope")], c.io)).toBe(1);
    expect(c.err()).toContain("not a directory");
  });

  it("exits 2 on an unknown command or tool", async () => {
    expect(await main(["list"], capture().io)).toBe(2);
    expect(await main(["scan", "--ide", "vim"], capture().io)).toBe(2);
  });

  it("exits 2 on an unknown flag, printing the usage", async () => {
    const c = capture();
    expect(await main(["scan", "--verbose"], c.io)).toBe(2);
    expect(c.err()).toContain("Usage: harness-discovery scan");
  });

  it("names an unknown option plainly before the usage", async () => {
    const c = capture();
    expect(await main(["scan", "--bogus"], c.io)).toBe(2);
    expect(c.err()).toMatch(/^unknown option: --bogus\n\nUsage: harness-discovery scan/);
  });

  it("escapes C1 and bidi characters from file paths in --json output, as valid JSON", async () => {
    const h = realpathSync(mkdtempSync(join(tmpdir(), "harness-discovery-cli-json-")));
    try {
      mkdirSync(join(h, ".cursor", "rules"), { recursive: true });
      writeFileSync(join(h, ".cursor", "rules", "F\u009b2J\u202e\u007f\u200f.md"), "hi\n");
      const c = capture();
      expect(await main(["scan", "--home", h, "--ide", "cursor", "--json"], c.io)).toBe(0);
      expect(c.out()).not.toMatch(/[\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
      expect(c.out()).toContain("\\u007f\\u200f");
      expect(JSON.parse(c.out()).assets[0].sourcePath).toBe(".cursor/rules/F\u009b2J\u202e\u007f\u200f.md");
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  it("names an unknown option that contains a quote in full", async () => {
    const c = capture();
    expect(await main(["scan", "--a'b"], c.io)).toBe(2);
    expect(c.err()).toMatch(/^unknown option: --a'b\n/);
  });

  it("escapes a control character in an unknown option's name", async () => {
    const c = capture();
    expect(await main(["scan", "--a\u001bb"], c.io)).toBe(2);
    expect(c.err()).toMatch(/^unknown option: --a\\x1bb\n/);
  });

  it("reads a tool named twice with --ide once", async () => {
    const c = capture();
    expect(await main(["scan", "--home", root, "--ide", "cursor", "--ide", "cursor"], c.io)).toBe(0);
    expect(c.out().trimEnd().split("\n")).toHaveLength(2);
  });

  it("exits 2 on an empty --repo", async () => {
    const c = capture();
    expect(await main(["scan", "--home", root, "--repo", ""], c.io)).toBe(2);
    expect(c.err()).toBe("--repo: empty path\n");
  });

  it("exits 2 on an empty --home instead of reading the working directory", async () => {
    const c = capture();
    expect(await main(["scan", "--home", ""], c.io)).toBe(2);
    expect(c.err()).toBe("--home: empty path\n");
  });

  it("exits 2 when --home is not a directory", async () => {
    const c = capture();
    expect(await main(["scan", "--home", join(root, ".cursor", "rules", "tone.md")], c.io)).toBe(2);
    expect(c.err()).toMatch(/--home .*: not a directory\n$/);
  });

  it("prints warnings with the path they are about and still exits 0", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "harness-discovery-cli-warn-")));
    try {
      mkdirSync(join(home, ".cursor"), { recursive: true });
      writeFileSync(join(home, ".cursor", "hooks.json"), "{");
      const c = capture();
      expect(await main(["scan", "--home", home, "--ide", "cursor"], c.io)).toBe(0);
      expect(c.err()).toBe(`warning: ${join(home, ".cursor", "hooks.json")}: not valid JSON; skipped\n`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("prints this help for --help, and exits 0", async () => {
    const c = capture();
    expect(await main(["--help"], c.io)).toBe(0);
    expect(c.out()).toBe(`Usage: harness-discovery scan [--home <dir>] [--repo <dir>]... [--ide <ide>]... [--json]

Lists the skills, rules, agents, hooks, commands, plugins and instruction files that
Claude Code, Codex, Cursor and Kiro load. It reads files and never writes.

  --home <dir>   Home directory to read user-scope config from (default: $HOME)
  --repo <dir>   Repository to scan for repo-scope config (repeatable)
  --ide <ide>    Limit to claude-code, codex, cursor or kiro (repeatable)
  --json         Print the full result as JSON

Exit status: 0 on success, 1 when a repo or tool could not be scanned, 2 on bad usage.
`);
  });

  it("restores HOME after a scan with --home", async () => {
    const before = process.env.HOME;
    await main(["scan", "--home", root, "--ide", "kiro"], capture().io);
    expect(process.env.HOME).toBe(before);
  });
});
