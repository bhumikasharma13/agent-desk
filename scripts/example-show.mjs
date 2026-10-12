// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// Launches the built app (run `pnpm build` first) for the current HOME with a throwaway profile,
// waits for its first read of sessions and agent files, and prints what one page shows, read
// through the same calls the page makes. The examples use it in place of looking at the window.
// Usage: node scripts/example-show.mjs <sessions|conversation|agent-files>

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
// The Harness page's own Source label (Node strips the types of this .ts file).
import { sourceLabel } from "../src/renderer/components/harnessModel.ts";

const what = process.argv[2];
if (!["sessions", "conversation", "agent-files"].includes(what)) {
  console.error("usage: node scripts/example-show.mjs <sessions|conversation|agent-files>");
  process.exit(2);
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(path.join(ROOT, ".vite", "build", "index.js"))) {
  console.error("the app is not built: run pnpm build first");
  process.exit(1);
}

// The Projects page's tools, in its order.
const TOOLS = [
  ["claudeCode", "Claude Code"],
  ["cursor", "Cursor"],
  ["copilot", "GitHub Copilot"],
  ["antigravity", "Antigravity"],
  ["codex", "Codex"],
  ["kiro", "Kiro"],
];

const table = (rows) => {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => "  " + r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
};

async function sessions(api) {
  const stats = await api.evaluate(() => window.electronAPI.extraction.getStats());
  // Stack tags come from a folder scan that follows the read; wait until every project has its entry.
  const paths = TOOLS.flatMap(([key]) => stats.folders[key].map((f) => f.path)).filter(Boolean);
  let stacks = [];
  for (let i = 0; i < 60; i++) {
    stacks = await api.evaluate(() => window.electronAPI.stack.getProjects());
    if (paths.every((p) => stacks.some((s) => s.path === p))) break;
    await api.waitForTimeout(500);
  }
  const tags = new Map(stacks.map((s) => [s.path, s.stackTags.join(", ")]));
  console.log("Sessions per tool:");
  console.log(table(TOOLS.map(([key, label]) => [label, String(stats.counts[key])])));
  console.log("Projects:");
  const rows = TOOLS.flatMap(([key, label]) =>
    [...stats.folders[key]]
      .sort((a, b) => b.count - a.count || String(a.path).localeCompare(String(b.path)))
      .map((f) => [label, String(f.count), tags.get(f.path) || "-", f.path ?? "No folder"]),
  );
  console.log(table([["TOOL", "SESSIONS", "STACK", "PROJECT"], ...rows]));
}

// The sessions the Projects page lists for the project with the newest session, and the first
// one's conversation as the page shows it, masked.
async function conversation(api) {
  const newest = await api.evaluate(() => window.electronAPI.sessions.list({ limit: 1 }));
  if (newest.error) throw new Error(newest.error);
  const project = newest.rows[0] ? { ideType: newest.rows[0].ideType, projectPath: newest.rows[0].projectPath } : {};
  const list = await api.evaluate((p) => window.electronAPI.sessions.list({ ...p, limit: 200 }), project);
  if (list.error) throw new Error(list.error);
  const title = (r) => r.title?.replace(/\s+/g, " ").trim() || "Untitled session";
  console.log(`${list.total} ${list.total === 1 ? "session" : "sessions"}:`);
  const rows = list.rows.map((r) => [r.ideType, String(r.userMessages + r.assistantMessages), path.basename(r.projectPath ?? "No folder"), title(r)]);
  console.log(table([["TOOL", "MESSAGES", "PROJECT", "TITLE"], ...rows]));
  const first = list.rows[0];
  if (!first) return;
  const t = await api.evaluate((key) => window.electronAPI.sessions.getTranscript(key, 0), first.key);
  if (t.error) throw new Error(t.error);
  console.log(`Conversation: ${title(first)}`);
  for (const m of t.messages) {
    const lines = m.content.split("\n");
    lines.forEach((l, i) => console.log(`  ${(i === 0 ? m.role : "").padEnd(9)}  ${l}`.trimEnd()));
  }
}

async function agentFiles(api) {
  const inv = await api.evaluate(() => window.electronAPI.harness.getInventory());
  const n = inv.summary.totalAssets;
  console.log(`${n} ${n === 1 ? "entry" : "entries"}:`);
  console.log(table([["TYPE", "NAME", "SOURCE", "AGENTS"], ...inv.assets.map((a) => [a.type, a.name, sourceLabel(a), a.activeInAgents.join(", ")])]));
  for (const line of [...inv.warnings, ...inv.errors]) console.log(`! ${line}`);
}

const userData = mkdtempSync(path.join(tmpdir(), "agent-desk-example-"));
const app = await _electron.launch({
  executablePath: createRequire(import.meta.url)("electron"),
  args: [ROOT, `--user-data-dir=${userData}`, "--use-mock-keychain"],
  env: { ...process.env },
});
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.electronAPI !== undefined);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const stats = await page.evaluate(() => window.electronAPI.extraction.getStats());
    if (stats.status !== "running" && (stats.lastRunAt !== null || stats.lastError !== null)) {
      if (stats.lastError) throw new Error(`the read failed: ${stats.lastError}`);
      for (const p of stats.problems) console.log(`! ${p}`);
      break;
    }
    if (Date.now() > deadline) throw new Error(`the first read did not finish: ${JSON.stringify(stats)}`);
    await page.waitForTimeout(500);
  }
  await (what === "sessions" ? sessions(page) : what === "conversation" ? conversation(page) : agentFiles(page));
} finally {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}
