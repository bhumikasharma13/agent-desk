#!/usr/bin/env node
// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
// Runs every fenced block of README.md and docs/reference.md, or names it as skipped with a reason.
//
// - Each `## ` section gets a fresh HOME: a copy of the package's demo home
//   (examples/scan-from-the-command-line/testdata/home), so a plain `scan` reads only that.
//   PATH starts with a fake `ps` that prints nothing (no Antigravity probe can reach a real
//   server) and an `npx` that runs the built command for its release URL: that release may not
//   exist yet, and scripts/smoke-install.sh runs the packed .tgz through npx.
// - A shell variable a block sets (`LSE=<release URL>`) is set again before each later block of
//   the same file, as the reader's shell keeps it.
// - A ```ts block is saved under the file name its following ```sh block runs (`node … x.mts`).
// - A ```sh block runs as one script in a temp app that links the built package. Its stdout,
//   normalized like scripts/run-examples.sh plus HOME → /Users/you, must equal the next
//   ```text block when there is one. A block with no output block must still exit 0.
// - ```mermaid blocks are diagrams and are skipped here.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync("pnpm", ["-s", "build"], { cwd: repo, stdio: "ignore" });
const work = realpathSync(mkdtempSync(join(tmpdir(), "lse-readme-")));
const app = join(work, "app");
mkdirSync(join(app, "node_modules"), { recursive: true });
symlinkSync(repo, join(app, "node_modules", "local-session-extractor"));
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "app", private: true, type: "commonjs" }));
const bin = join(work, "bin");
mkdirSync(bin);
const { name, version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const releaseUrl = `https://github.com/tetriz-ai/agent-desk/releases/download/${name}-v${version}/${name}-${version}.tgz`;
writeFileSync(join(bin, "npx"), `#!/bin/sh\n[ "$1" = "${releaseUrl}" ] || { echo "npx $1 is not stubbed" >&2; exit 1; }\nshift\nexec node "${repo}/dist/cli.js" "$@"\n`, { mode: 0o755 });
writeFileSync(join(bin, "ps"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

const skips = {
  'pnpm add "$LSE"': "adds a release that may not exist yet; scripts/smoke-install.sh adds the packed .tgz",
};
let failed = 0;
const report = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${what}`);
  if (!ok) failed++;
};

for (const doc of ["README.md", "docs/reference.md"]) {
  const md = readFileSync(join(repo, doc), "utf8");
  // A fence may be indented inside a list item; its body loses that indent.
  const fence = /^( *)```(\w*)\n([\s\S]*?)^\1```$/gm;
  const list = [...md.matchAll(fence)].map((m) => ({
    lang: m[2],
    at: m.index,
    body: m[3].split("\n").map((l) => (l.startsWith(m[1]) ? l.slice(m[1].length) : l)).join("\n"),
  }));
  const sectionOf = (at) => md.slice(0, at).lastIndexOf("\n## ");
  let home = null;
  let homeSection = null;
  let pending = null;
  const shellVars = [];
  for (let i = 0; i < list.length; i++) {
    const { lang, body, at } = list[i];
    const tag = `${doc} block ${i}`;
    if (sectionOf(at) !== homeSection) {
      homeSection = sectionOf(at);
      home = join(mkdtempSync(join(work, "home-")), "home");
      cpSync(join(repo, "examples/scan-from-the-command-line/testdata/home"), home, { recursive: true });
    }
    const normalize = (s) =>
      s
        .split(home).join("/Users/you")
        .replace(/[^ \n]*\/tmp\.[A-Za-z0-9]{10}/g, "/tmp/example")
        .replace(/ in [0-9]+\.[0-9]s$/gm, " in 0.0s")
        .replace(/[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}/g, "2026-01-01 00:00:00");
    if (lang === "mermaid") {
      console.log(`skip  ${tag} (mermaid): a diagram`);
    } else if (lang === "ts") {
      const next = list[i + 1];
      const name = next?.lang === "sh" ? /([\w.-]+\.mts)\b/.exec(next.body)?.[1] : undefined;
      if (!name) report(false, `${tag} (ts): no following sh block names the file to run`);
      else {
        writeFileSync(join(app, name), body);
        console.log(`ok    ${tag} (ts): saved as ${name}`);
      }
    } else if (lang === "sh") {
      const lines = body.trim().split("\n");
      for (const line of lines) if (skips[line]) console.log(`skip  ${tag}: ${line} (${skips[line]})`);
      const script = [...shellVars, ...lines.filter((l) => !skips[l])].join("\n");
      shellVars.push(...lines.filter((l) => /^[A-Z]+=\S+$/.test(l)));
      const r = spawnSync("bash", ["-c", script], { cwd: app, encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
      if (r.status !== 0) report(false, `${tag} (sh) exited ${r.status}: ${r.stderr.trim()}`);
      if (list[i + 1]?.lang === "text") pending = { i, out: normalize(r.stdout) };
      else if (r.status === 0) report(true, `${tag} (sh) ran, no output shown`);
    } else if (lang === "text") {
      if (!pending) report(false, `${tag} (text) follows no command`);
      else {
        report(pending.out === body, `${tag} (text) matches the output of block ${pending.i}`);
        if (pending.out !== body) console.log(`--- want\n${body}--- got\n${pending.out}`);
      }
      pending = null;
    } else {
      report(false, `${tag}: unknown language '${lang}'`);
    }
  }
}
rmSync(work, { recursive: true, force: true });
console.log(`${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
