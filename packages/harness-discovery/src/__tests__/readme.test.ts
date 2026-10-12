// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// The README's quick start and its collector program are the examples that CI runs, so the
// README cannot drift from code that works.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf-8");

/** Every fenced block of `lang` in a Markdown file, in order. */
function blocks(md: string, lang: string): string[] {
  return [...md.matchAll(new RegExp("^```" + lang + "\\n([\\s\\S]*?)^```$", "gm"))].map((m) => m[1]!);
}

const readme = read("README.md");
const quickStart = readme.slice(readme.indexOf("## Quick start"), readme.indexOf("## Choosing an entry point"));

const pkg = JSON.parse(read("package.json")) as { name: string; version: string; bin: Record<string, string> };
/** The .tgz the release workflow attaches for this version: `pnpm pack` names it <name>-<version>.tgz. */
const RELEASE_URL = `https://github.com/tetriz-ai/agent-desk/releases/download/${pkg.name}-v${pkg.version}/${pkg.name}-${pkg.version}.tgz`;

// The quick start sets the release URL, which may not have a release yet, and runs the CLI from it;
// the example runs this checkout's build by its bin name instead.
const SET_URL = `HD=${RELEASE_URL}`;
const asExample = (line: string): string => line.replace(/^npx "\$HD" /, "harness-discovery ");

describe("README", () => {
  it("quick start commands are examples/scan-a-repo/run.sh, with npx \"$HD\" as the built command", () => {
    const readmeLines = blocks(quickStart, "sh")[0]!.trimEnd().split("\n");
    expect(readmeLines[0]).toBe(SET_URL);
    const script = read("examples/scan-a-repo/run.sh").trimEnd().split("\n");
    const body = script.slice(script.findIndex((l) => l.includes("example-setup.sh")) + 1);
    expect(body).toEqual(readmeLines.slice(1).map(asExample));
  });

  it("the demo tape types the quick start commands, the release URL included", () => {
    const readmeLines = blocks(quickStart, "sh")[0]!.trimEnd().split("\n");
    const tape = read("assets/demo.tape");
    const typed = [...tape.slice(tape.indexOf("\nShow\n")).matchAll(/^Type(?:@\S+)? `(.*)`/gm)].map((m) => m[1]);
    expect(typed).toEqual(readmeLines);
  });

  it("runs the release of this package.json's version, set once and then only through npx \"$HD\"", () => {
    expect(Object.keys(pkg.bin)).toEqual(["harness-discovery"]);
    expect(blocks(readme, "sh").filter((b) => b.includes("/releases/download/"))).toEqual([expect.stringContaining(`${SET_URL}\n`)]);
    const commands = blocks(readme, "sh").flatMap((b) => b.split("\n"));
    expect(commands.filter((l) => /\bharness-discovery\b/.test(l) && !l.startsWith("HD="))).toEqual([]);
    expect(commands.filter((l) => l.includes("$HD"))).toEqual([
      'npx "$HD" scan --home "$(mktemp -d)" --repo .',
      'npx "$HD" scan --home "$(mktemp -d)" --repo . --ide cursor',
      'pnpm add "$HD"',
    ]);
    expect(quickStart).toContain(`(https://github.com/tetriz-ai/agent-desk/releases?q=${pkg.name}-v&expanded=true)`);
  });

  it("never mentions npm, and runs nothing with npx --no", () => {
    expect(readme.split("\n").filter((l) => /\bnpm\b|\bnpx\s+--no\b/.test(l))).toEqual([]);
  });

  it("quick start output is the example's output", () => {
    expect(blocks(quickStart, "text")[0]).toBe(blocks(read("examples/scan-a-repo/README.md"), "text").at(-1));
  });

  it("the collector program is examples/collect-into-your-own-store/mirror.mjs without its opening comment", () => {
    const program = blocks(readme, "js").find((b) => b.includes("createCollectSession"))!;
    const example = read("examples/collect-into-your-own-store/mirror.mjs");
    expect(program).toBe(example.slice(example.indexOf("import ")));
  });

  it("links only absolute or in-page targets, because the README ships in the .tgz without the repository's other files", () => {
    const prose = readme.replace(/^( *)```[\s\S]*?^\1```$/gm, "");
    const targets = [...prose.matchAll(/\]\(([^)\s]+)\)|\b(?:src|srcset)="([^"]+)"/g)].map((m) => m[1] ?? m[2]!);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((t) => !/^(https:\/\/|#)/.test(t))).toEqual([]);
  });
});
