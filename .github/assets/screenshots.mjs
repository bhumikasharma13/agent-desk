// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// Opens the built app for the current HOME with a throwaway profile, waits for its first read,
// and saves Projects, sessions, a conversation and Harness as PNGs in the given folder. Run through screenshots.sh.

import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron } from "playwright-core";

const outDir = process.argv[2];
const userData = mkdtempSync(path.join(tmpdir(), "agent-desk-shots-"));
const app = await _electron.launch({
  executablePath: createRequire(import.meta.url)("electron"),
  args: [process.cwd(), `--user-data-dir=${userData}`, "--use-mock-keychain"],
  env: { ...process.env },
});
try {
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.electronAPI !== undefined);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const stats = await page.evaluate(() => window.electronAPI.extraction.getStats());
    if (stats.status !== "running" && (stats.lastRunAt !== null || stats.lastError !== null)) {
      if (stats.lastError) throw new Error(`the first read failed: ${stats.lastError}`);
      if (stats.problems.length) throw new Error(`sample sources failed: ${stats.problems.join(", ")}`);
      break;
    }
    if (Date.now() > deadline) throw new Error(`the first read did not finish: ${JSON.stringify(stats)}`);
    await page.waitForTimeout(500);
  }
  // Escape defers the first-launch folder-access primer, so no macOS prompt opens. The banner it
  // leaves asks for the same access; it is hidden here because this profile never answers it.
  const primer = page.getByRole("dialog", { name: /See your AI coding sessions/ });
  if (await primer.isVisible()) {
    await page.keyboard.press("Escape");
    await primer.waitFor({ state: "detached" });
  }
  await page.addStyleTag({ content: "main > div:has(> div:first-child:is(.text-warning)) { display: none !important; }" });
  await page.evaluate(() => document.fonts.ready);
  await page.setViewportSize({ width: 1120, height: 700 });
  // The page's clock stands just after the sample's newest session, so its relative times and
  // date headings read as recent whenever the images are rendered again.
  await page.clock.setFixedTime(new Date("2026-04-02T12:00:00Z"));
  // The page pane only: the 212 px sidebar left out, and the empty space below the rows cut.
  const clip = { x: 212, y: 0, width: 908, height: 420 };
  // Stack tags come from a folder scan that follows the read; wait until every project has its
  // entry, as scripts/example-show.mjs does.
  const stats = await page.evaluate(() => window.electronAPI.extraction.getStats());
  const paths = Object.values(stats.folders).flat().map((f) => f.path).filter(Boolean);
  for (let i = 0; i < 60; i++) {
    const stacks = await page.evaluate(() => window.electronAPI.stack.getProjects());
    if (paths.every((p) => stacks.some((s) => s.path === p))) break;
    await page.waitForTimeout(500);
  }
  await page.getByRole("button", { name: "Projects" }).first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, "projects.png"), clip });
  await page.locator('[data-project-row]').filter({ hasText: "shop" }).first().click();
  await page.getByRole("region", { name: "Sessions of shop" }).waitFor();
  await page.locator("[data-session-row]").first().waitFor();
  await page.screenshot({ path: path.join(outDir, "sessions.png"), clip: { ...clip, height: 260 } });
  await page.getByRole("button", { name: /The cart total is off by one cent/ }).click();
  await page.getByText("Done. Totals are now exact.", { exact: true }).waitFor();
  // Keep the entire sample conversation and its masking note in view.
  await page.screenshot({ path: path.join(outDir, "conversation.png"), clip: { ...clip, height: 480 } });
  await page.getByRole("button", { name: "Harness" }).first().click();
  await page.getByText(/^\d+ entr(y|ies) ·/).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, "harness.png"), clip });
} finally {
  await app.close();
  rmSync(userData, { recursive: true, force: true });
}
