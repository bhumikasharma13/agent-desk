// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The README's Quick start and Use it as a library sections against the code: the quick-start
 * commands, the release URL they use and the capabilities output, and the library program,
 * which is the read-sessions-into-a-store example byte for byte, with that example's output.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { main } from "../cli/main";

const root = new URL("../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const pkg = JSON.parse(read("package.json")) as { name: string; version: string; bin: Record<string, string> };
/** The .tgz the release workflow attaches for this version: `pnpm pack` names it <name>-<version>.tgz. */
const RELEASE_URL = `https://github.com/tetriz-ai/agent-desk/releases/download/${pkg.name}-v${pkg.version}/${pkg.name}-${pkg.version}.tgz`;

/** Fenced blocks of one language, with a list item's indentation removed. */
function blocks(markdown: string, lang: string): string[] {
  const out: string[] = [];
  const re = new RegExp("^( *)```" + lang + "\\n([\\s\\S]*?)^\\1```$", "gm");
  for (const m of markdown.matchAll(re)) {
    const indent = m[1]!;
    out.push(m[2]!.split("\n").map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line)).join("\n"));
  }
  return out;
}

function section(heading: string): string {
  const readme = read("README.md");
  const start = readme.indexOf(`\n## ${heading}\n`);
  assert.ok(start >= 0, `README has a "${heading}" section`);
  const end = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, end === -1 ? undefined : end);
}

describe("the README's Quick start section", () => {
  const quickStart = section("Quick start");
  const commands = blocks(quickStart, "sh").flatMap((b) => b.trim().split("\n"));

  it("runs exactly these commands, each checked by scripts/readme-blocks.mjs", () => {
    assert.deepEqual(commands, [
      `LSE=${RELEASE_URL}`,
      'npx "$LSE" capabilities',
      'npx "$LSE" scan',
      'npx "$LSE" list',
      'npx "$LSE" show codex 0d6c2f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f > session.json',
      'npx "$LSE" export --out sessions.jsonl',
    ]);
  });

  it("starts with what the demo tape types, the release URL included", () => {
    const tape = read("assets/demo.tape");
    const typed = [...tape.slice(tape.indexOf("\nShow\n")).matchAll(/^Type(?:@\S+)? `(.*)`/gm)].map((m) => m[1]);
    assert.deepEqual(typed, commands.slice(0, typed.length));
  });

  it("names the release of this package.json's version, and the command its bin names", () => {
    assert.deepEqual(Object.keys(pkg.bin), ["local-session-extractor"]);
    assert.ok(quickStart.includes(`(https://github.com/tetriz-ai/agent-desk/releases?q=${pkg.name}-v&expanded=true)`));
  });

  it("shows the capabilities command's output", async () => {
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (c: Buffer) => (out += c.toString()));
    const code = await main(["capabilities"], { stdout, stderr: new PassThrough(), stdin: new PassThrough() });
    assert.equal(code, 0);
    assert.equal(blocks(quickStart, "text")[0], out);
  });
});

describe("the README's Use it as a library section", () => {
  const library = section("Use it as a library");

  it("shows the read-sessions-into-a-store example byte for byte, and no other program", () => {
    assert.deepEqual(blocks(library, "ts"), [read("examples/read-sessions-into-a-store/index.mts")]);
  });

  it("adds the package from the release URL, then runs the program with the one command shown", () => {
    assert.deepEqual(blocks(library, "sh"), [
      // Skipped by scripts/readme-blocks.mjs: the release for this version may not exist yet.
      // scripts/smoke-install.sh adds the .tgz.
      'mkdir lse-try && cd lse-try\npnpm add "$LSE"\n',
      "node --no-warnings=ExperimentalWarning scan.mts\n",
    ]);
  });

  it("shows the output the example's README pins", () => {
    const exampleOutput = blocks(read("examples/read-sessions-into-a-store/README.md"), "text").at(-1);
    assert.deepEqual(blocks(library, "text"), [exampleOutput]);
  });

  it("links the examples index", () => {
    assert.ok(library.includes("](https://github.com/tetriz-ai/agent-desk/blob/main/packages/local-session-extractor/examples/README.md)"));
  });
});

describe("the repository's docs and demo tapes", () => {
  const repo = fileURLToPath(new URL("../../", root));
  const files = (dir: string, ext: RegExp): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.name.startsWith(".") || ["node_modules", "out", "dist", "coverage"].includes(e.name) ? []
      : e.isDirectory() ? files(join(dir, e.name), ext)
      : ext.test(e.name) ? [join(dir, e.name)] : []);
  const hits = (paths: string[], re: RegExp) =>
    paths.flatMap((f) => readFileSync(f, "utf8").split("\n").flatMap((line, i) => (re.test(line) ? [`${relative(repo, f)}:${i + 1}: ${line.trim()}`] : [])));

  it("run these packages only from a release URL, never by a name npx would look up in a registry", () => {
    assert.deepEqual(hits(files(repo, /\.(md|tape)$/), /\bnpx(?:\s+-\S+)*\s+(?:local-session-extractor|harness-discovery)(?![\w./-])/), []);
  });

  it("leave npm out of the package READMEs: no mention of npm, and no npx --no", () => {
    const readmes = ["local-session-extractor", "harness-discovery"].map((p) => join(repo, "packages", p, "README.md"));
    assert.deepEqual(hits(readmes, /\bnpm\b|\bnpx\s+--no\b/), []);
  });
});

describe("the README's links", () => {
  it("are absolute or in-page, because the README ships in the .tgz without the repository's other files", () => {
    const prose = read("README.md").replace(/^( *)```[\s\S]*?^\1```$/gm, "");
    const targets = [...prose.matchAll(/\]\(([^)\s]+)\)|\b(?:src|srcset)="([^"]+)"/g)].map((m) => m[1] ?? m[2]!);
    assert.ok(targets.length > 0);
    assert.deepEqual(targets.filter((t) => !/^(https:\/\/|#)/.test(t)), []);
  });
});
