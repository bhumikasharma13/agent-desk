// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// The README shows three examples' commands and output. CI runs the examples and compares their
// output with each example's own README (scripts/run-examples.sh); this pins the root README to
// those same blocks, so the two cannot drift.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

/** Every fenced block as {lang, body}, in order. */
function blocks(md) {
  return [...md.matchAll(/^```(\w+)\n([\s\S]*?)^```$/gm)].map((m) => ({ lang: m[1], body: m[2] }));
}

test("each example the README runs shows the same command and output as the example's own README", () => {
  const readme = blocks(read("README.md"));
  const runs = readme.flatMap((b, i) =>
    b.lang === "sh" ? [...b.body.matchAll(/^(examples\/([a-z0-9-]+)\/run\.sh)$/gm)].map((m) => ({ cmd: m[1], name: m[2], out: readme[i + 1] })) : [],
  );
  assert.deepEqual(runs.map((r) => r.name).sort(), ["count-sessions-per-tool", "list-agent-files-in-a-repo", "tell-committed-from-local-files"]);
  for (const r of runs) {
    const own = blocks(read(`examples/${r.name}/README.md`));
    assert.equal(own[0].body.trim(), r.cmd, `${r.name}: the command`);
    assert.equal(r.out?.lang, "text", `${r.name}: the README shows its output`);
    assert.equal(r.out.body, own.at(-1).body, `${r.name}: the output`);
  }
});

test("the README and docs/reference.md say what the session store keeps, login email included", () => {
  const row = read("docs/reference.md").split("\n").find((l) => l.startsWith("| Session files of the six tools"));
  assert.ok(row, "the What the app reads table has the sessions row");
  assert.match(row, /every session/);
  assert.match(row, /login email/);
  const summary = read("README.md").split("\n").find((l) => l.startsWith("- It keeps a masked copy of every session's conversation"));
  assert.ok(summary, "the README's privacy summary has the session store line");
  assert.match(summary, /login email/);
});
