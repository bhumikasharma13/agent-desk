// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// Acceptance: the built app, launched through Playwright for Electron against a throwaway HOME
// (test/acceptance/fixture.mjs) with its own userData, matches what the two libraries' own CLIs
// report for that HOME, makes no outbound connection, reads and writes only where it should, and
// shows the same data after a relaunch. Its Harness Refresh runs a read, and quitting waits for a
// read in progress. Run `pnpm build` first.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import { FIXTURE_LOGIN, FIXTURE_SECRET, addClaudeSessions, gitEnv, makeFixture } from "./fixture.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ELECTRON = require("electron"); // the path of the Electron binary
const TRACE_PRELOAD = path.join(ROOT, "test", "acceptance", "trace.cjs");
const LSE_CLI = path.join(ROOT, "node_modules", "local-session-extractor", "dist", "cli.js");
const HD_CLI = path.join(ROOT, "node_modules", "harness-discovery", "dist", "cli.mjs");

let fixture;
let userData;
let scratch;
let tracePath;
let first; // what the first launch showed
let drill; // the drill-down tests' HOME (drillHome)

before(() => {
  assert.ok(existsSync(path.join(ROOT, ".vite", "build", "index.js")), "run `pnpm build` before the acceptance test");
  fixture = makeFixture();
  scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-desk-acceptance-")));
  userData = path.join(scratch, "userData");
  tracePath = path.join(scratch, "trace.jsonl");
});

after(() => {
  rmSync(fixture.home, { recursive: true, force: true });
  if (drill) rmSync(drill.home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

function env(home = fixture) {
  return {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    HOME: home.home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    AGENT_DESK_TRACE: tracePath,
    AGENT_DESK_PROTECTED_ROOT: home.protectedRoot,
  };
}

async function launch(profile = userData, home = fixture) {
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: ["-r", TRACE_PRELOAD, ROOT, `--user-data-dir=${profile}`, "--use-mock-keychain"],
    env: env(home),
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.electronAPI !== undefined);
  const focused = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.isFocused()));
  if (focused) {
    await app.close();
    assert.fail("the window cannot take the keyboard focus (trace.cjs)");
  }
  return { app, page };
}

/** Waits for a finished cycle (one with lastRunAt at or after `since`) and returns its stats. */
async function waitForCycle(page, since) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const stats = await page.evaluate(() => window.electronAPI.extraction.getStats());
    if (stats.status !== "running" && stats.lastRunAt && Date.parse(stats.lastRunAt) >= since) return stats;
    if (Date.now() > deadline) throw new Error(`no finished cycle: ${JSON.stringify(stats)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function storedScan() {
  return JSON.parse(readFileSync(path.join(userData, "harness-inventory.json"), "utf8")).result;
}

const assetKeys = (assets) => assets.map((a) => `${a.id} ${a.scope} ${a.contentHash}`).sort();

/** What the session library's CLI stores for the same HOME, read back with its own store API. */
async function sessionCliCounts() {
  const db = path.join(scratch, "cli-sessions.db");
  rmSync(db, { force: true });
  execFileSync(process.execPath, [LSE_CLI, "scan", "--db", db], { env: gitEnv(fixture.home), stdio: "ignore" });
  const { openStore } = await import("local-session-extractor");
  const store = openStore(db, { mustExist: true });
  try {
    return { counts: store.countByIde(), rows: store.countByIdeAndProject(), conversations: store.listConversations() };
  } finally {
    store.close();
  }
}

function harnessCli() {
  const out = execFileSync(process.execPath, [HD_CLI, "scan", "--home", fixture.home, "--repo", fixture.repo, "--json"], {
    env: gitEnv(fixture.home),
  });
  return JSON.parse(out.toString());
}

const FOLDER_KEY = { "claude-code": "claudeCode", cursor: "cursor", copilot: "copilot", antigravity: "antigravity", codex: "codex", kiro: "kiro" };

test("first launch: counts, projects and the harness inventory match the libraries' CLIs", async () => {
  const started = Date.now();
  const { app, page } = await launch();
  try {
    const stats = await waitForCycle(page, started);
    assert.equal(stats.lastError, null);
    assert.deepEqual(stats.problems, []);
    assert.ok(
      !existsSync(path.join(userData, "permission-grants.json")),
      `no folder was asked for: nothing pressed Continue. Requests: ${JSON.stringify(traceEntries().filter((e) => e.kind === "ipc"))}`,
    );

    const cli = await sessionCliCounts();
    assert.deepEqual(stats.counts, cli.counts, "session counts per tool");
    assert.ok(stats.counts.claudeCode === 2 && stats.counts.codex === 1, `fixture sessions read: ${JSON.stringify(stats.counts)}`);
    // The session store holds every conversation and each tool's login email: readable by the user only.
    for (const f of ["sessions.db", "harness-inventory.json"]) {
      assert.equal(statSync(path.join(userData, f)).mode & 0o777, 0o600, `${f} is mode 0600`);
    }
    for (const row of cli.rows) {
      const folders = stats.folders[FOLDER_KEY[row.ide_type]];
      assert.ok(
        folders.some((f) => f.path === row.project_path && f.count === row.count),
        `Projects row ${row.ide_type} ${row.project_path} ${row.count}`,
      );
    }

    const scan = harnessCli();
    const stored = storedScan();
    assert.deepEqual(assetKeys(stored.assets), assetKeys(scan.assets), "harness ids, scope and hashes");
    const types = new Set(stored.assets.map((a) => a.type));
    for (const t of ["skill", "agents_md", "rule", "hook"]) assert.ok(types.has(t), `fixture ${t} found`);

    const inventory = await page.evaluate(() => window.electronAPI.harness.getInventory());
    assert.equal(inventory.lastError, null);
    assert.deepEqual(inventory.errors, []);
    assert.ok(inventory.summary.totalAssets > 0 && inventory.summary.totalAssets <= stored.assets.length);

    // Stack tags follow the first read at once, not at the next read five minutes later.
    const tagsBy = Date.now() + 20_000;
    let stacks = [];
    while (Date.now() < tagsBy) {
      stacks = await page.evaluate(() => window.electronAPI.stack.getProjects());
      if (stacks.some((p) => p.path === fixture.repo && p.stackTags.length > 0)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(stacks.find((p) => p.path === fixture.repo)?.stackTags.includes("typescript"), `stack tags: ${JSON.stringify(stacks)}`);
    first = { counts: stats.counts, folders: stats.folders, assets: assetKeys(stored.assets) };
  } finally {
    await app.close();
  }
});

/** Defers the first-launch folder-access primer, as Escape does, so no macOS prompt opens. */
/** A back control by where it goes back to: "Back to <label>" by name, shown as "← <label>". */
const backButton = (page, label) => page.getByRole("button", { name: new RegExp(`^(← |Back to )${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) });

async function dismissPrimer(page) {
  const primer = page.getByRole("dialog", { name: /See your AI coding sessions/ });
  if (await primer.isVisible()) {
    await page.keyboard.press("Escape");
    await primer.waitFor({ state: "detached" });
  }
}

// Runs before "containment", so that test's trace covers the sessions views' reads too.
test("Projects: a project row shows that tool's sessions there, and a conversation shows masked text and no login", async () => {
  const started = Date.now();
  const { app, page } = await launch();
  try {
    const stats = await waitForCycle(page, started);
    const cli = await sessionCliCounts();
    const primary = cli.conversations.filter((r) => r.relation_type === "PRIMARY");
    const ipc = await page.evaluate(() => window.electronAPI.sessions.list({ limit: 200 }));
    assert.equal(ipc.error, null);
    assert.equal(ipc.total, 3);
    assert.deepEqual(
      ipc.rows.map((r) => `${r.ideType} ${r.key} ${r.projectPath} ${r.userMessages + r.assistantMessages}`).sort(),
      primary.map((r) => `${r.ide_type} ${r.id} ${r.project_path} ${JSON.parse(r.conversation).length}`).sort(),
      "tool, session, project and message count per session",
    );
    // The test means something: the store does keep the login beside the sessions.
    assert.ok(primary.some((r) => (r.installation_metadata ?? "").includes(FIXTURE_LOGIN.email)), "the login is stored");

    // Every Projects row, through the page: its sessions view counts what the row counts.
    await dismissPrimer(page);
    const rows = Object.entries(FOLDER_KEY).flatMap(([ide, key]) => stats.folders[key].map((f) => ({ ide, ...f })));
    assert.equal(rows.length, 3);
    for (const r of rows) {
      const name = r.path === null ? "No folder" : path.basename(r.path);
      const tool = { "claude-code": "Claude Code", codex: "Codex" }[r.ide];
      const counted = `${r.count} ${r.count === 1 ? "session" : "sessions"}`;
      await page.getByRole("button", { name: `${name}, ${tool}, ${counted}`, exact: true }).click();
      await page.getByRole("heading", { name: `${name} · ${tool} · ${counted}`, exact: true }).waitFor({ timeout: 15_000 });
      const view = page.getByRole("region", { name: `Sessions of ${name}` });
      for (const until = Date.now() + 10_000; (await view.locator("[data-session-row]").count()) !== r.count && Date.now() < until; ) await new Promise((res) => setTimeout(res, 100));
      assert.equal(await view.locator("[data-session-row]").count(), r.count, `${name} ${tool}: the view lists the row's count`);
      await backButton(page, "Projects").click();
    }

    // Claude Code in shop: grouped by last activity, as Claude Code's pickers do.
    await page.getByRole("button", { name: "shop, Claude Code, 1 session", exact: true }).click();
    const april = page.getByRole("group", { name: "April 2026" });
    await april.getByRole("button", { name: /The cart total is off by one cent.*main/ }).click();
    await page.getByText("Prices are summed as floats.", { exact: false }).waitFor({ timeout: 15_000 });
    const text = await page.evaluate(() => document.body.innerText);
    assert.match(text, /The staging database is ████████ for now\./, "the secret shows masked");
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    // A Claude Code session id holds its folder path; the page gets an opaque key instead.
    const claudeIds = primary.filter((r) => r.ide_type === "claude-code").map((r) => r.session_id);
    assert.ok(claudeIds.length === 2 && claudeIds.every((id) => id.includes("::")), `the ids hold a folder: ${claudeIds}`);
    const sent = JSON.stringify(ipc);
    for (const kept of [FIXTURE_SECRET, "penny-jar", FIXTURE_LOGIN.email, FIXTURE_LOGIN.account, ...claudeIds]) {
      assert.ok(!html.includes(kept), `${kept} is not on the page`);
      assert.ok(!sent.includes(kept), `${kept} does not cross IPC`);
    }

    // Back returns to the list with the session still chosen; so does Escape.
    await backButton(page, "shop sessions").click();
    await backButton(page, "shop sessions").waitFor({ state: "detached" });
    assert.equal(await page.locator('[data-session-row][aria-current="true"]').count(), 1, "the session stays chosen");

    // A search looks at this project's sessions only: the Codex session in shop is not here.
    const search = page.getByRole("textbox", { name: "Search this project's sessions" });
    await search.fill("rounding");
    await page.getByText("No session here matches the search.").waitFor();
    await search.fill("cart");
    await page.getByText("1 session matches the search", { exact: true }).waitFor();
    // The Codex session has no title or first prompt of its own: its first message is its title, and is searched.
    const rounding = await page.evaluate(() => window.electronAPI.sessions.list({ ideType: "codex", query: "rounding" }));
    assert.equal(rounding.total, 1);

    // The Documents session's text is in the session store, so opening it reads nothing in Documents.
    await backButton(page, "Projects").click();
    await page.getByRole("button", { name: "notes, Claude Code, 1 session", exact: true }).click();
    const before = traceEntries().length;
    await page.getByRole("button", { name: /Tidy these notes/ }).click();
    await page.getByText("Done.", { exact: true }).waitFor({ timeout: 15_000 });
    const inDocuments = traceEntries().slice(before).filter((e) => e.kind === "read" && e.path.startsWith(fixture.documents + path.sep));
    assert.deepEqual(inDocuments, []);
    await page.keyboard.press("Escape");
    await backButton(page, "notes sessions").waitFor({ state: "detached" });
    await page.getByRole("button", { name: /Tidy these notes/ }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "notes, Claude Code, 1 session", exact: true }).waitFor();
  } finally {
    await app.close();
  }
});

test("offline: the app opens no outbound connection beyond loopback", () => {
  const net = traceEntries().filter((e) => e.kind === "net");
  const outside = net.filter((e) => !/^(127\.0\.0\.1|localhost|::1|\[::1\])(:|\/|$)|^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(e.host));
  assert.deepEqual(outside, []);
});

test("containment: Node reads stay in HOME, the app and its runtime; writes stay in userData", () => {
  const entries = traceEntries();
  assert.ok(entries.some((e) => e.kind === "start" && e.type === "utility"), "the worker process was traced too");
  const electronDir = path.dirname(path.dirname(path.dirname(path.dirname(ELECTRON)))); // .../electron/dist
  const inside = (p, roots) => roots.some((r) => p === r || p.startsWith(r + path.sep));
  const readRoots = [fixture.home, userData, ROOT, electronDir, realpathSync(electronDir)];
  // Resolving a project path looks at each folder on the way to it (lstat, which follows no
  // link and lists nothing): the fixture HOME's own ancestors.
  const ancestorOfHome = (e) => e.op.startsWith("lstat") && fixture.home.startsWith(e.path === "/" ? "/" : e.path + path.sep);
  const reads = entries.filter((e) => e.kind === "read" && !inside(e.path, readRoots) && !ancestorOfHome(e));
  assert.deepEqual([...new Set(reads.map((e) => e.path))], []);
  const writes = entries.filter((e) => e.kind === "write" && !inside(e.path, [userData]));
  assert.deepEqual([...new Set(writes.map((e) => `${e.op} ${e.path}`))], []);
  // Nothing inside the Documents folder the user has not granted is read, with one known
  // exception: reading sessions looks for the repository (its .git entry and .git/config) of
  // every folder a session ran in, protected or not.
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const knownException = new RegExp(`^${escapeRe(fixture.documents)}/[^/]+/\\.git(/config)?$`);
  const protectedReads = entries.filter((e) => e.kind === "read" && inside(e.path, [fixture.documents]));
  assert.deepEqual([...new Set(protectedReads.filter((e) => !knownException.test(e.path)).map((e) => `${e.op} ${e.path}`))], []);
  assert.ok(protectedReads.some((e) => knownException.test(e.path)), "the known exception is still there (docs/before-you-rely-on-it.md)");
  assert.ok(entries.some((e) => e.op === "existsSync" || e.op === "statSync" || e.op === "stat"), "existence checks are traced");
  const commands = entries.filter((e) => e.kind === "exec").map((e) => path.basename(e.command.split(" ")[0]));
  assert.deepEqual([...new Set(commands)].filter((c) => !["git", "ps"].includes(c)), [], "only git and ps are started");
});

// After "containment": this launch reads its own HOME and profile, which that test would flag.
test("Projects: one-line rows, Load more, a long conversation, back twice to the same place, a read, and the No folder row", async () => {
  const own = makeFixture();
  addClaudeSessions(own, 52, 130);
  // More stack tags than one line holds: the row shows what fits, then "+N".
  for (const f of ["go.mod", "Cargo.toml", "pyproject.toml", "pom.xml", "Gemfile", "Package.swift", "composer.json", "Chart.yaml", "Dockerfile", "Jenkinsfile", "ansible.cfg"]) {
    writeFileSync(path.join(own.repo, f), "\n");
  }
  // A Codex session that names no folder: the Projects page lists it under "No folder".
  const day = path.join(own.home, ".codex", "sessions", "2026", "04", "02");
  mkdirSync(day, { recursive: true });
  const loose = [
    { timestamp: "2026-04-02T08:00:00.000Z", type: "session_meta", payload: { id: "1e2f3a4b-0000-4000-8000-00000000f01d", timestamp: "2026-04-02T08:00:00.000Z", originator: "codex_cli_rs", source: "cli" } },
    { timestamp: "2026-04-02T08:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Sketch a release checklist." }] } },
    { timestamp: "2026-04-02T08:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "Sketch a release checklist.", images: [] } },
  ];
  writeFileSync(path.join(day, "rollout-2026-04-02T08-00-00-1e2f3a4b-0000-4000-8000-00000000f01d.jsonl"), loose.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const started = Date.now();
  const { app, page } = await launch(path.join(scratch, "userData-sessions-paging"), own);
  try {
    await waitForCycle(page, started);
    await dismissPrimer(page);
    // At the window's smallest size every row stays on one line.
    await page.setViewportSize({ width: 1000, height: 680 });
    const oneLine = async (rowSel, textSel) =>
      page.evaluate(([r, t]) => [...document.querySelectorAll(r)].map((row) => row.getBoundingClientRect().height < 2 * row.querySelector(t).getBoundingClientRect().height), [rowSel, textSel]);
    const shopRow = page.getByRole("button", { name: "shop, Claude Code, 53 sessions", exact: true });
    for (const until = Date.now() + 20_000; !(await shopRow.getByText(/^\+\d+$/).count()) && Date.now() < until; ) await new Promise((r) => setTimeout(r, 200));
    assert.equal(await shopRow.getByText(/^\+\d+$/).count(), 1, "the stack chips that do not fit show as +N");
    assert.ok((await oneLine("[data-project-row]", "span")).every(Boolean), "every project row is one line");
    // Up and Down move between the project rows, and Enter chooses one.
    const first = page.locator("[data-project-row]").first();
    await first.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "shop · Claude Code · 53 sessions", exact: true }).waitFor({ timeout: 15_000 });
    const rows = page.locator("[data-session-row]");
    assert.equal(await rows.count(), 50);
    assert.ok((await oneLine("[data-session-row]", "span")).every(Boolean), "every session row is one line");
    await page.getByRole("button", { name: "Load more (3 left)" }).click();
    for (const until = Date.now() + 15_000; (await rows.count()) < 53 && Date.now() < until; ) await new Promise((r) => setTimeout(r, 100));
    assert.equal(await rows.count(), 53);
    assert.equal(await page.getByRole("button", { name: /^Load more/ }).count(), 0, "nothing left to load");

    // The newest session, at the top, holds 130 messages: shown 100 at a time.
    await page.getByRole("button", { name: /Step 0 of extra-000/ }).click();
    await page.getByText("100 of 130 messages", { exact: true }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Show the next 30" }).click();
    await page.getByText("130 of 130 messages", { exact: true }).waitFor();
    await page.getByText("Step 128 of extra-000.", { exact: true }).waitFor();

    // A read that finds a new message shows it in the open conversation, header included.
    const file = path.join(own.home, ".claude", "projects", own.repo.replace(/[^A-Za-z0-9]/g, "-"), "extra-000.jsonl");
    const line = { type: "user", uuid: "extra-000-late", timestamp: "2026-04-05T09:00:00.000Z", sessionId: "extra-000", cwd: own.repo, message: { role: "user", content: "A late question." } };
    appendFileSync(file, JSON.stringify(line) + "\n");
    const read = Date.now();
    await page.evaluate(() => window.electronAPI.extraction.triggerNow());
    await waitForCycle(page, read);
    await page.getByText("131 of 131 messages", { exact: true }).waitFor({ timeout: 15_000 });
    await page.getByText("A late question.", { exact: true }).waitFor();
    await page.getByText("1 h 0 min", { exact: true }).waitFor({ timeout: 15_000 });

    await page.keyboard.press("Escape");
    await backButton(page, "shop sessions").waitFor({ state: "detached" });
    // The read kept the page loaded with Load more.
    assert.equal(await rows.count(), 53, "a read keeps the rows loaded");
    assert.equal(await page.getByRole("button", { name: /^Load more/ }).count(), 0);

    // Open session 51, past the first page; a read while it is open; Back returns to it, the
    // list as long as it was and scrolled where it was.
    const target = rows.nth(50);
    const title = (await target.locator("span").first().textContent()) ?? "";
    const deepId = /Step 0 of (extra-\d+)\./.exec(title)?.[1];
    assert.ok(deepId, `session 51 is an added one: ${title}`);
    await target.scrollIntoViewIfNeeded();
    const list = page.getByRole("region", { name: "Sessions of shop" }).locator(".overflow-y-auto").first();
    const scrolled = await list.evaluate((el) => el.scrollTop);
    assert.ok(scrolled > 0, "the list is scrolled");
    await target.click();
    await page.getByText("2 of 2 messages", { exact: true }).waitFor({ timeout: 15_000 });
    // A third message, as late as the session's last: the read changes its count, not its place.
    const deepLine = { type: "user", uuid: `${deepId}-late`, timestamp: "2026-04-05T08:00:01.000Z", sessionId: deepId, cwd: own.repo, message: { role: "user", content: "A deep question." } };
    appendFileSync(path.join(path.dirname(file), `${deepId}.jsonl`), JSON.stringify(deepLine) + "\n");
    const deepRead = Date.now();
    await page.evaluate(() => window.electronAPI.extraction.triggerNow());
    await waitForCycle(page, deepRead);
    await page.getByText("3 of 3 messages", { exact: true }).waitFor({ timeout: 15_000 });
    await backButton(page, "shop sessions").click();
    await backButton(page, "shop sessions").waitFor({ state: "detached" });
    // The list's own read after the cycle has landed once the row shows the third message.
    await page.waitForFunction(() => document.querySelector('[data-session-row][aria-current="true"]')?.textContent?.includes("3 messages"), null, { timeout: 15_000 });
    assert.equal(await rows.count(), 53, "the rows loaded with Load more are still there");
    assert.equal(await page.getByRole("button", { name: /^Load more/ }).count(), 0, "no Load more again");
    assert.equal(await page.locator('[data-session-row][aria-current="true"]').count(), 1);
    await page.waitForFunction((t) => (document.activeElement?.textContent ?? "").startsWith(t), title, { timeout: 5_000 });
    assert.equal(await list.evaluate((el) => el.scrollTop), scrolled, "the list keeps its scroll");

    // Escape, then back on Projects: the same row has the focus.
    await page.keyboard.press("Escape");
    await shopRow.waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "shop, Claude Code, 53 sessions", null, { timeout: 5_000 });

    // The No folder row: the Codex session with no folder, and only it.
    await page.getByRole("button", { name: "No folder, Codex, 1 session", exact: true }).click();
    await page.getByRole("heading", { name: "No folder · Codex · 1 session", exact: true }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: /Sketch a release checklist/ }).waitFor();
    assert.equal(await page.locator("[data-session-row]").count(), 1);
  } finally {
    await app.close();
    rmSync(own.home, { recursive: true, force: true });
  }
});

// The drill-down tests share one HOME: shop's stack in nine tags (more than one line holds at
// the window's smallest width), twenty one-session projects (a Projects list taller than the
// window), "big" with 260 sessions (more than one read returns), "mix" with ten, and "grow",
// which a test adds to.
const NINE_TAGS = ["Go", "TypeScript", "Python", "PHP", "Helm", "Webpack", "NumPy", "gRPC", "GORM"];
function drillHome() {
  if (drill) return drill;
  drill = makeFixture();
  writeFileSync(path.join(drill.repo, "go.mod"), "module shop\n\ngo 1.22\n\nrequire (\n\tgorm.io/gorm v1.25.0\n\tgoogle.golang.org/grpc v1.60.0\n)\n");
  writeFileSync(path.join(drill.repo, "package.json"), JSON.stringify({ name: "shop", private: true, devDependencies: { webpack: "^5.0.0" } }) + "\n");
  writeFileSync(path.join(drill.repo, "requirements.txt"), "numpy==1.26.0\n");
  writeFileSync(path.join(drill.repo, "composer.json"), "{}\n");
  writeFileSync(path.join(drill.repo, "Chart.yaml"), "\n");
  for (let i = 0; i < 20; i++) {
    const name = `p${String(i).padStart(2, "0")}`;
    addClaudeSessions(drill, 1, 2, { repo: path.join(drill.home, "src", name), prefix: name });
  }
  addClaudeSessions(drill, 260, 2, { repo: path.join(drill.home, "src", "big"), prefix: "big" });
  addClaudeSessions(drill, 10, 2, { repo: path.join(drill.home, "src", "mix"), prefix: "mix" });
  addClaudeSessions(drill, 1, 2, { repo: path.join(drill.home, "src", "grow"), prefix: "grow" });
  return drill;
}

/** Launches on the drill-down HOME with its own profile, at the window's smallest size, after the first read. */
async function launchDrill(name) {
  const home = drillHome();
  const started = Date.now();
  const { app, page } = await launch(path.join(scratch, `userData-drill-${name}`), home);
  try {
    await waitForCycle(page, started);
    await dismissPrimer(page);
    await page.setViewportSize({ width: 1000, height: 680 });
  } catch (e) {
    await app.close();
    throw e;
  }
  return { app, page, home };
}

/** Waits until shop's Claude Code row shows its stack, cut to "+N". */
async function shopStack(page) {
  const shop = page.getByRole("button", { name: "shop, Claude Code, 1 session", exact: true });
  await shop.getByText(/^\+\d+$/).waitFor({ timeout: 30_000 });
  return shop;
}

/** Each stack chip or "+N" drawn past the right edge of its row's Stack column, and how many were checked. */
function stackOverflow(page) {
  return page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const out = { clipped: [], checked: 0 };
    for (const row of document.querySelectorAll("[data-project-row]")) {
      const column = row.children[1]; // name, Stack column, count
      const right = column.getBoundingClientRect().right;
      for (const el of column.children) {
        if (getComputedStyle(el).visibility === "hidden") continue;
        out.checked++;
        if (el.getBoundingClientRect().right > right + 0.5) out.clipped.push(`${row.getAttribute("aria-label")}: ${el.textContent}`);
      }
    }
    return out;
  });
}

/** Appends a user message to a Claude Code session of the drill-down HOME, by default as late as its last. */
function addMessage(home, folder, id, text, timestamp = "2026-04-05T08:00:01.000Z") {
  const repo = path.join(home.home, "src", folder);
  const file = path.join(home.home, ".claude", "projects", repo.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
  const line = { type: "user", uuid: `${id}-${Date.now()}`, timestamp, sessionId: id, cwd: repo, message: { role: "user", content: text } };
  appendFileSync(file, JSON.stringify(line) + "\n");
}

/** Writes Codex session `id`, run in `cwd` (made if missing) at `at`; written again, it moves the session. */
function codexSession(home, id, cwd, prompt, at) {
  mkdirSync(cwd, { recursive: true });
  const day = path.join(home.home, ".codex", "sessions", "2026", "04", "06");
  mkdirSync(day, { recursive: true });
  const lines = [
    { timestamp: at, type: "session_meta", payload: { id, timestamp: at, cwd, originator: "codex_cli_rs", cli_version: "0.144.5", source: "cli", model_provider: "openai" } },
    { timestamp: at, type: "turn_context", payload: { cwd, model: "gpt-5-codex" } },
    { timestamp: at, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } },
    { timestamp: at, type: "event_msg", payload: { type: "user_message", message: prompt, images: [] } },
  ];
  const file = path.join(day, `rollout-2026-04-06T09-00-00-${id}.jsonl`);
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

/** Clicks Load more until `n` sessions are listed. */
async function loadAll(page, n) {
  const rows = page.locator("[data-session-row]");
  await rows.first().waitFor({ timeout: 15_000 });
  for (const until = Date.now() + 30_000; (await rows.count()) < n && Date.now() < until; ) {
    const more = page.getByRole("button", { name: /^Load more/ });
    if ((await more.count()) > 0 && (await more.isEnabled())) await more.click();
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(await rows.count(), n);
  return rows;
}

async function runRead(page) {
  const read = Date.now();
  await page.evaluate(() => window.electronAPI.extraction.triggerNow());
  await waitForCycle(page, read);
}

const sessionIndex = (page) => page.evaluate(() => [...document.querySelectorAll("[data-session-row]")].indexOf(document.activeElement));

test("Projects: a row's stack chips are never cut off by the Stack column, at any width", async () => {
  const { app, page } = await launchDrill("chips");
  try {
    const shop = await shopStack(page);
    const inside = async (what) => {
      const seen = await stackOverflow(page);
      assert.ok(seen.checked >= 2, `${what}: chips were checked`);
      assert.deepEqual(seen.clipped, [], `${what}: every chip and the +N inside the Stack column`);
    };
    // Each Stack column also checked as its own resize is delivered, after the app's observer and
    // before the frame is painted.
    await page.evaluate(() => {
      window.__clippedAtResize = [];
      for (const row of document.querySelectorAll("[data-project-row]")) {
        const column = row.children[1];
        new ResizeObserver(() => {
          const right = column.getBoundingClientRect().right;
          for (const el of column.children) {
            if (getComputedStyle(el).visibility !== "hidden" && el.getBoundingClientRect().right > right + 0.5) {
              window.__clippedAtResize.push(`${innerWidth} px, ${row.getAttribute("aria-label")}: ${el.textContent}`);
            }
          }
        }).observe(column);
      }
    });
    // Every width from 900 to 1400 px and back, a pixel at a time, each checked once: every chip
    // boundary of the nine tags is crossed growing and shrinking.
    for (const width of [...Array.from({ length: 501 }, (_, i) => 900 + i), ...Array.from({ length: 501 }, (_, i) => 1400 - i), 1000]) {
      await page.setViewportSize({ width, height: 680 });
      await inside(`${width} px`);
    }
    assert.equal(await shop.getByText(/^\+\d+$/).count(), 1, "at 1000 px the nine tags need a +N");
    assert.deepEqual(await page.evaluate(() => window.__clippedAtResize.slice(0, 5)), [], "no frame painted with a chip cut off");

    // A read that finds a new, wide tag early in the stack: the row is measured afresh.
    const workflow = path.join(drill.repo, ".github", "workflows", "ci.yml");
    mkdirSync(path.dirname(workflow), { recursive: true });
    writeFileSync(workflow, "on: push\n");
    try {
      const read = Date.now();
      await page.evaluate(() => window.electronAPI.extraction.triggerNow());
      await waitForCycle(page, read);
      await page.waitForFunction(() => document.querySelector('[data-project-row][aria-label="shop, Claude Code, 1 session"]')?.textContent?.includes("GitHub Actions"), null, { timeout: 30_000 });
      await inside("after a new tag");
    } finally {
      rmSync(path.join(drill.repo, ".github"), { recursive: true, force: true });
    }
  } finally {
    await app.close();
  }
});

test("Projects: a row's stack is never drawn as a +N alone while it lays out", async () => {
  const { app, page } = await launchDrill("first-paint");
  try {
    await shopStack(page);
    // Away to the Harness page and back: every Projects row lays out its stack anew.
    await page.getByRole("button", { name: /^Harness/ }).first().click();
    await page.getByRole("button", { name: "shop, Claude Code, 1 session", exact: true }).waitFor({ state: "detached" });
    await page.evaluate(() => {
      window.__plusOnly = [];
      new MutationObserver(() => {
        for (const row of document.querySelectorAll("[data-project-row]")) {
          const column = row.children[1];
          const drawn = [...column.children].filter((el) => getComputedStyle(el).visibility !== "hidden");
          if (drawn.length > 0 && drawn.every((el) => /^\+\d+$/.test(el.textContent ?? ""))) window.__plusOnly.push(row.getAttribute("aria-label"));
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    await page.getByRole("button", { name: /^Projects/ }).first().click();
    await shopStack(page);
    await new Promise((r) => setTimeout(r, 500));
    assert.deepEqual(await page.evaluate(() => window.__plusOnly), [], "no row showed only +N");
  } finally {
    await app.close();
  }
});

test("Projects: a row's accessible description names its whole stack, the tags behind +N included", async () => {
  const { app, page } = await launchDrill("describe");
  try {
    const shop = await shopStack(page);
    const hidden = (await shop.getByText(/^\+\d+$/).getAttribute("title")).split(", ");
    assert.ok(hidden.length > 0);
    // What the accessibility tree computes, not the attribute.
    const cdp = await page.context().newCDPSession(page);
    try {
      const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
      const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: '[data-project-row][aria-label="shop, Claude Code, 1 session"]' });
      const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
      assert.equal(nodes[0].name?.value, "shop, Claude Code, 1 session");
      const description = nodes[0].description?.value ?? "";
      assert.ok(description.startsWith("Stack: "), `description: ${description}`);
      assert.deepEqual(description.slice("Stack: ".length).split(", ").sort(), [...NINE_TAGS].sort());
      for (const t of hidden) assert.ok(description.includes(t), `${t}, behind +N, is described`);
    } finally {
      await cdp.detach();
    }
  } finally {
    await app.close();
  }
});

test("Projects: Back from a project far down the list returns to it, scrolled where it was", async () => {
  const { app, page } = await launchDrill("projects-scroll");
  try {
    const list = page.locator("[data-project-row]").first().locator("xpath=ancestor::div[contains(@class, 'overflow-y-auto')][1]");
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const scrolled = await list.evaluate((el) => el.scrollTop);
    assert.ok(scrolled > 0, "the Projects list is taller than the window and scrolled");
    const last = page.locator("[data-project-row]").last();
    const key = await last.getAttribute("data-project-row");
    await last.click();
    await backButton(page, "Projects").waitFor();
    await page.locator("[data-session-row]").first().waitFor();
    await page.keyboard.press("Escape");
    await backButton(page, "Projects").waitFor({ state: "detached" });
    await page.waitForFunction((k) => document.activeElement?.getAttribute("data-project-row") === k, key, { timeout: 5_000 });
    assert.equal(await list.evaluate((el) => el.scrollTop), scrolled, "the Projects list keeps its scroll");
  } finally {
    await app.close();
  }
});

test("sessions: Enter on a project puts the focus in its sessions; a session's view takes it too", async () => {
  const { app, page } = await launchDrill("focus");
  try {
    await page.getByRole("button", { name: "big, Claude Code, 260 sessions", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "big · Claude Code · 260 sessions", exact: true }).waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-session-row"), null, { timeout: 5_000 });
    assert.equal(await sessionIndex(page), 0, "the first session has the focus");
    await page.keyboard.press("ArrowDown");
    assert.equal(await sessionIndex(page), 1, "Down moves within the sessions");
    await page.keyboard.press("Enter");
    const back = backButton(page, "big sessions");
    await back.waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.activeElement?.textContent === "← big sessions", null, { timeout: 5_000 });
    await page.keyboard.press("Escape");
    await back.waitFor({ state: "detached" });
    assert.equal(await sessionIndex(page), 1, "back on the session left");
  } finally {
    await app.close();
  }
});

test("sessions: when a read takes the session left out of the list, Back focuses the first one", async () => {
  const home = drillHome();
  const ids = ["6a000000-0000-4000-8000-0000000000a1", "6a000000-0000-4000-8000-0000000000a2"];
  const at = ["2026-04-06T09:00:00.000Z", "2026-04-06T10:00:00.000Z"];
  const files = ids.map((id, i) => codexSession(home, id, path.join(home.home, "src", "moving"), `Moving session ${i + 1}.`, at[i]));
  const { app, page } = await launchDrill("gone");
  try {
    await page.getByRole("button", { name: "moving, Codex, 2 sessions", exact: true }).click();
    await page.getByRole("button", { name: /Moving session 1\./ }).click();
    const back = backButton(page, "moving sessions");
    await back.waitFor({ timeout: 15_000 });
    // The session's folder changes, so a read moves it out of this project.
    codexSession(home, ids[0], path.join(home.home, "src", "moved"), "Moving session 1.", at[0]);
    await runRead(page);
    await new Promise((r) => setTimeout(r, 1_500)); // the list's own read after the cycle
    await back.click();
    await back.waitFor({ state: "detached" });
    await page.getByRole("button", { name: /Moving session 2\./ }).waitFor({ timeout: 15_000 });
    assert.equal(await page.locator("[data-session-row]").count(), 1, "the moved session is gone");
    assert.equal(await page.locator('[data-session-row][aria-current="true"]').count(), 0);
    await page.waitForFunction(() => document.activeElement === document.querySelector("[data-session-row]"), null, { timeout: 5_000 });
  } finally {
    await app.close();
    for (const f of files) rmSync(f, { force: true });
  }
});

test("Projects: when a read takes the project left off the list, Back focuses the first row", async () => {
  const home = drillHome();
  const id = "6a000000-0000-4000-8000-0000000000b1";
  const at = "2026-04-06T11:00:00.000Z";
  const file = codexSession(home, id, path.join(home.home, "src", "solo"), "A solo session.", at);
  const { app, page } = await launchDrill("project-gone");
  try {
    await page.getByRole("button", { name: "solo, Codex, 1 session", exact: true }).click();
    await page.getByRole("heading", { name: "solo · Codex · 1 session", exact: true }).waitFor({ timeout: 15_000 });
    codexSession(home, id, path.join(home.home, "src", "solo-renamed"), "A solo session.", at);
    await runRead(page);
    await page.getByRole("heading", { name: "solo · Codex · 0 sessions", exact: true }).waitFor({ timeout: 15_000 });
    await backButton(page, "Projects").click();
    await page.getByRole("button", { name: "solo-renamed, Codex, 1 session", exact: true }).waitFor({ timeout: 15_000 });
    assert.equal(await page.getByRole("button", { name: "solo, Codex, 1 session", exact: true }).count(), 0, "the project left is gone");
    await page.waitForFunction(() => document.activeElement === document.querySelector("[data-project-row]"), null, { timeout: 5_000 });
  } finally {
    await app.close();
    rmSync(file, { force: true });
  }
});

test("sessions: after Load more to 260 and a read, Back returns to session 250, scrolled where it was", async () => {
  const { app, page, home } = await launchDrill("deep-read");
  try {
    await page.getByRole("button", { name: "big, Claude Code, 260 sessions", exact: true }).click();
    const rows = await loadAll(page, 260);
    const target = rows.nth(249);
    const title = (await target.locator("span").first().textContent()) ?? "";
    const id = /Step 0 of (big-\d+)\./.exec(title)?.[1];
    assert.ok(id, title);
    await target.scrollIntoViewIfNeeded();
    const list = page.getByRole("region", { name: "Sessions of big" }).locator(".overflow-y-auto").first();
    const scrolled = await list.evaluate((el) => el.scrollTop);
    assert.ok(scrolled > 0, "the list is scrolled");
    await target.click();
    await page.getByText("2 of 2 messages", { exact: true }).waitFor({ timeout: 15_000 });
    addMessage(home, "big", id, "A question deep down.");
    await runRead(page);
    await page.getByText("3 of 3 messages", { exact: true }).waitFor({ timeout: 15_000 });
    await backButton(page, "big sessions").click();
    await backButton(page, "big sessions").waitFor({ state: "detached" });
    // The list's own read after the cycle has landed once the row shows the third message.
    await page.waitForFunction(() => document.querySelector('[data-session-row][aria-current="true"]')?.textContent?.includes("3 messages"), null, { timeout: 15_000 });
    assert.equal(await rows.count(), 260, "every row loaded is still there");
    assert.equal(await page.getByRole("button", { name: /^Load more/ }).count(), 0, "no Load more again");
    assert.equal(await page.locator('[data-session-row][aria-current="true"]').count(), 1);
    await page.waitForFunction((t) => (document.activeElement?.textContent ?? "").startsWith(t), title, { timeout: 5_000 });
    assert.equal(await list.evaluate((el) => el.scrollTop), scrolled, "the list keeps its scroll");
  } finally {
    await app.close();
  }
});

test("sessions: the focused session keeps the focus through a read, 240 rows down", async () => {
  const { app, page, home } = await launchDrill("focus-deep");
  try {
    await page.getByRole("button", { name: "big, Claude Code, 260 sessions", exact: true }).click();
    const rows = await loadAll(page, 260);
    const target = rows.nth(239);
    const title = (await target.locator("span").first().textContent()) ?? "";
    const id = /Step 0 of (big-\d+)\./.exec(title)?.[1];
    assert.ok(id, title);
    await target.focus();
    addMessage(home, "big", id, "Another question deep down.");
    await runRead(page);
    await page.waitForFunction((t) => [...document.querySelectorAll("[data-session-row]")].find((el) => el.textContent.startsWith(t))?.textContent.includes("3 messages"), title, { timeout: 15_000 });
    await page.waitForFunction((t) => (document.activeElement?.textContent ?? "").startsWith(t), title, { timeout: 5_000 });
    await page.keyboard.press("ArrowDown");
    assert.equal(await sessionIndex(page), 240, "Down moves on from it");
  } finally {
    await app.close();
  }
});

test("sessions: a read that moves the focused session under another heading keeps the focus on it", async () => {
  const { app, page, home } = await launchDrill("focus-today");
  try {
    await page.getByRole("button", { name: "mix, Claude Code, 10 sessions", exact: true }).click();
    const rows = await loadAll(page, 10);
    const target = rows.nth(5);
    const title = (await target.locator("span").first().textContent()) ?? "";
    const id = /Step 0 of (mix-\d+)\./.exec(title)?.[1];
    assert.ok(id, title);
    const other = (await rows.nth(1).locator("span").first().textContent()) ?? "";
    const otherId = /Step 0 of (mix-\d+)\./.exec(other)?.[1];
    assert.ok(otherId, other);
    await target.focus();
    // The focused session moves under Yesterday, below another moved under Today.
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(12, 0, 0, 0);
    addMessage(home, "mix", id, "A question yesterday.", yesterday.toISOString());
    addMessage(home, "mix", otherId, "A question today.", new Date().toISOString());
    await runRead(page);
    const moved = page.getByRole("group", { name: "Yesterday" }).locator("[data-session-row]");
    await moved.first().waitFor({ timeout: 15_000 });
    assert.ok(((await moved.first().textContent()) ?? "").startsWith(title), "the session moved under Yesterday");
    assert.ok(((await page.locator("[data-session-row]").first().textContent()) ?? "").startsWith(other), "another session is first, under Today");
    await page.waitForFunction((t) => document.activeElement?.hasAttribute("data-session-row") && document.activeElement.textContent.startsWith(t), title, { timeout: 5_000 });
  } finally {
    await app.close();
  }
});

test("Projects: a font that loads after the chips were measured does not cut one off", async () => {
  const { app, page } = await launchDrill("fonts");
  try {
    await shopStack(page);
    assert.deepEqual((await stackOverflow(page)).clipped, []);
    // A much wider face for the chips (size-adjust), loaded after they were measured.
    await page.addStyleTag({ content: '@font-face { font-family: "Desk Wide"; src: local("Courier New"), local("Menlo"); size-adjust: 140%; } [data-project-row] > div > span { font-family: "Desk Wide", monospace !important; }' });
    assert.ok(await page.evaluate(async () => (await document.fonts.load('10.5px "Desk Wide"')).length > 0), "the face loaded");
    const seen = await stackOverflow(page);
    assert.ok(seen.checked >= 2);
    assert.deepEqual(seen.clipped, [], "every chip and the +N inside the Stack column");
  } finally {
    await app.close();
  }
});

test("sessions: the back controls are named for where they go back to", async () => {
  const { app, page } = await launchDrill("back-names");
  try {
    await page.getByRole("button", { name: "big, Claude Code, 260 sessions", exact: true }).click();
    for (const [name, shown] of [["Back to Projects", "← Projects"], ["Back to big sessions", "← big sessions"]]) {
      if (name !== "Back to Projects") await page.locator("[data-session-row]").first().click();
      const back = page.getByRole("button", { name, exact: true });
      await back.waitFor({ timeout: 15_000 });
      assert.equal(await back.textContent(), shown);
      assert.equal(await back.locator('[aria-hidden="true"]').textContent(), "←", "the arrow is not read out");
    }
  } finally {
    await app.close();
  }
});

test("sessions: the match count is always the current search's", async () => {
  const { app, page } = await launchDrill("match-count");
  try {
    await page.getByRole("button", { name: "big, Claude Code, 260 sessions", exact: true }).click();
    await page.locator("[data-session-row]").first().waitFor({ timeout: 15_000 });
    await page.evaluate(() => {
      window.__matchLines = [];
      new MutationObserver(() => {
        const t = document.querySelector(".rd-meta-line")?.textContent;
        if (t) window.__matchLines.push(t);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.getByRole("textbox", { name: "Search this project's sessions" }).fill("big-007");
    await page.getByText("1 session matches the search", { exact: true }).waitFor({ timeout: 15_000 });
    assert.deepEqual([...new Set(await page.evaluate(() => window.__matchLines))], ["1 session matches the search"]);
  } finally {
    await app.close();
  }
});

test("sessions: Escape in the search box clears the search, then goes back to Projects", async () => {
  const { app, page } = await launchDrill("search-escape");
  try {
    await page.getByRole("button", { name: "big, Claude Code, 260 sessions", exact: true }).click();
    const search = page.getByRole("textbox", { name: "Search this project's sessions" });
    await search.fill("big-007");
    await page.getByText("1 session matches the search", { exact: true }).waitFor({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector('input[aria-label="Search this project\'s sessions"]')?.value === "", null, { timeout: 5_000 });
    await page.getByText("1 session matches the search", { exact: true }).waitFor({ state: "detached" });
    assert.equal(await page.getByRole("heading", { name: "big · Claude Code · 260 sessions", exact: true }).count(), 1, "still in big's sessions");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "big, Claude Code, 260 sessions", exact: true }).waitFor({ timeout: 5_000 });
  } finally {
    await app.close();
  }
});

test("sessions: during a search the header counts the whole project, and follows a read", async () => {
  const { app, page, home } = await launchDrill("search-count");
  try {
    await page.getByRole("button", { name: "grow, Claude Code, 1 session", exact: true }).click();
    await page.getByRole("heading", { name: "grow · Claude Code · 1 session", exact: true }).waitFor({ timeout: 15_000 });
    await page.getByRole("textbox", { name: "Search this project's sessions" }).fill("nothing like this");
    await page.getByText("No session here matches the search.").waitFor({ timeout: 15_000 });
    assert.equal(await page.getByRole("heading", { name: "grow · Claude Code · 1 session", exact: true }).count(), 1, "the header counts the project, not the matches");
    addClaudeSessions(home, 2, 2, { repo: path.join(home.home, "src", "grow"), prefix: "grown" });
    const read = Date.now();
    await page.evaluate(() => window.electronAPI.extraction.triggerNow());
    await waitForCycle(page, read);
    await page.getByRole("heading", { name: "grow · Claude Code · 3 sessions", exact: true }).waitFor({ timeout: 15_000 });
    await backButton(page, "Projects").click();
    await page.getByRole("button", { name: "grow, Claude Code, 3 sessions", exact: true }).waitFor({ timeout: 15_000 });
  } finally {
    await app.close();
  }
});

test("repeatable: a relaunch shows the same data, and a deleted skill disappears after a rescan", async () => {
  assert.ok(first, "the first launch ran");
  const { app, page } = await launch();
  try {
    const stats = await page.evaluate(() => window.electronAPI.extraction.getStats());
    assert.deepEqual(stats.counts, first.counts, "counts before any new cycle");
    assert.deepEqual(stats.folders, first.folders);
    assert.deepEqual(assetKeys(storedScan().assets), first.assets);

    const before = storedScan().assets.filter((a) => a.type === "skill" && a.name === "review");
    assert.equal(before.length, 1);
    rmSync(path.dirname(fixture.skill), { recursive: true });
    execFileSync("git", ["-C", fixture.repo, "add", "-A"], { env: gitEnv(fixture.home) });
    execFileSync("git", ["-C", fixture.repo, "-c", "user.name=Jane Doe", "-c", "user.email=jane@example.com", "commit", "-q", "-m", "Drop the skill"], { env: gitEnv(fixture.home) });
    const started = Date.now();
    await page.evaluate(() => window.electronAPI.extraction.triggerNow());
    await waitForCycle(page, started);
    const ids = storedScan().assets.map((a) => a.id);
    assert.ok(!ids.includes(before[0].id), "the deleted skill is gone");
    const inventory = await page.evaluate(() => window.electronAPI.harness.getInventory());
    assert.ok(!inventory.assets.some((a) => a.type === "skill" && a.name === "review"));
  } finally {
    await app.close();
  }
});

test("Refresh on the Harness page runs a read and shows a skill added since the last one", async () => {
  const started = Date.now();
  const { app, page } = await launch();
  try {
    await waitForCycle(page, started);
    const skill = path.join(fixture.repo, ".claude", "skills", "ship", "SKILL.md");
    mkdirSync(path.dirname(skill), { recursive: true });
    writeFileSync(skill, "---\nname: ship\ndescription: Ship a release.\n---\nTag and push.\n");
    await dismissPrimer(page);
    await page.getByRole("button", { name: "Harness" }).first().click();
    const clicked = Date.now();
    await page.getByRole("button", { name: "Refresh" }).click();
    await waitForCycle(page, clicked);
    await page.getByRole("button", { name: "Refresh" }).waitFor();
    const inventory = await page.evaluate(() => window.electronAPI.harness.getInventory());
    assert.ok(inventory.assets.some((a) => a.type === "skill" && a.name === "ship"), "the new skill is in the inventory");
    await page.getByRole("tab", { name: /^Skills/ }).click();
    await page.getByRole("main").getByText(/\bship\b/).first().waitFor({ timeout: 10_000 });
  } finally {
    await app.close();
  }
});

test("quitting during a read waits for it, then closes the session store cleanly", async () => {
  const started = Date.now();
  const { app, page } = await launch();
  let stderr = "";
  app.process().stderr?.on("data", (d) => (stderr += d));
  try {
    await waitForCycle(page, started);
    void page.evaluate(() => window.electronAPI.extraction.triggerNow()).catch(() => {});
    const by = Date.now() + 10_000;
    while ((await page.evaluate(() => window.electronAPI.extraction.getStats())).status !== "running") {
      if (Date.now() > by) throw new Error("the read did not start");
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    await app.close();
  }
  assert.doesNotMatch(stderr, /database is not open/);
});

test("a session store that cannot be read shows as an error, not as no sessions", async () => {
  // A second profile: one launch fills its store, then every page after the first is overwritten,
  // so the store opens (its header is intact) but no count can be read.
  const corruptData = path.join(scratch, "userData-corrupt");
  const started = Date.now();
  let { app, page } = await launch(corruptData);
  try {
    await waitForCycle(page, started);
  } finally {
    await app.close();
  }
  const db = path.join(corruptData, "sessions.db");
  for (const suffix of ["-wal", "-shm"]) rmSync(db + suffix, { force: true });
  const bytes = readFileSync(db);
  bytes.fill(0xff, 4096);
  writeFileSync(db, bytes);
  ({ app, page } = await launch(corruptData));
  try {
    await dismissPrimer(page);
    await page.getByRole("button", { name: "Projects" }).first().click();
    await page.getByText("Sessions could not be read.").waitFor({ timeout: 30_000 });
    assert.equal(await page.getByText("No sessions detected yet.").count(), 0);
  } finally {
    await app.close();
  }
});

test("a first read whose worker dies ends the Harness page's first-read state and shows the error", async () => {
  const { app, page } = await launch(path.join(scratch, "userData-killed"));
  try {
    // The page is open on "Reading…" before the read starts (three seconds after launch), so
    // only the end of the read can move it on.
    const primer = page.getByRole("dialog", { name: /See your AI coding sessions/ });
    await primer.waitFor({ timeout: 15_000 });
    await page.keyboard.press("Escape");
    await primer.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Harness" }).first().click();
    await page.getByRole("main").getByText("Reading…").first().waitFor({ timeout: 15_000 });
    const by = Date.now() + 30_000;
    while ((await page.evaluate(() => window.electronAPI.extraction.getStats())).status !== "running") {
      if (Date.now() > by) throw new Error("the first read did not start");
      await new Promise((r) => setTimeout(r, 20));
    }
    // Kill the extraction worker mid-read, as a crash would.
    const killed = await app.evaluate(({ app: electronApp }) => {
      const worker = electronApp.getAppMetrics().find((m) => m.name === "agent-desk-extraction-worker");
      if (worker) process.kill(worker.pid, "SIGKILL");
      return worker !== undefined;
    });
    assert.ok(killed, "the worker process was found");
    let stats;
    for (const until = Date.now() + 30_000; ; ) {
      stats = await page.evaluate(() => window.electronAPI.extraction.getStats());
      if (stats.status !== "running" || Date.now() > until) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.match(stats.lastError ?? "", /worker exited/);
    await page.getByText(/The read failed: .*worker exited/).waitFor({ timeout: 15_000 });
    assert.equal(await page.getByRole("main").getByText("Reading…").count(), 0, "no endless first-read pane");
  } finally {
    await app.close();
  }
});

test("a later read whose worker dies shows its error above the last scan's list, beside an older scan failure", async () => {
  const started = Date.now();
  const profile = path.join(scratch, "userData-later-killed");
  const { app, page } = await launch(profile);
  try {
    await waitForCycle(page, started);
    await dismissPrimer(page);
    await page.getByRole("button", { name: "Harness" }).first().click();
    await page.getByText(/^[1-9]\d* entr(y|ies) ·/).waitFor({ timeout: 15_000 });
    // A scan failure on record first: a read's own error still shows beside it.
    mkdirSync(path.join(profile, "harness-inventory.json.tmp"));
    await page.evaluate(() => window.electronAPI.extraction.triggerNow());
    await page.getByText(/The last scan failed/).waitFor({ timeout: 30_000 });
    // Kill the extraction worker during a later read. A read can end before the kill lands, so
    // this tries a few reads; a kill between reads is a crash the next read recovers from.
    let stats;
    let attempts = 0;
    while (!/worker exited/.test(stats?.lastError ?? "") && attempts < 5) {
      attempts++;
      void page.evaluate(() => window.electronAPI.extraction.triggerNow()).catch(() => {});
      for (const until = Date.now() + 10_000; Date.now() < until; ) {
        if ((await page.evaluate(() => window.electronAPI.extraction.getStats())).status === "running") break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await app.evaluate(({ app: electronApp }) => {
        const worker = electronApp.getAppMetrics().find((m) => m.name === "agent-desk-extraction-worker");
        if (worker) process.kill(worker.pid, "SIGKILL");
      });
      for (const until = Date.now() + 30_000; ; ) {
        stats = await page.evaluate(() => window.electronAPI.extraction.getStats());
        if (stats.status !== "running" || Date.now() > until) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.match(stats.lastError ?? "", /worker exited/, `no read was killed in ${attempts} tries`);
    await page.getByText(/The read failed: .*worker exited/).waitFor({ timeout: 15_000 });
    await page.getByText(/The list below is from the last scan/).waitFor({ timeout: 15_000 });
    assert.ok(await page.getByText(/^[1-9]\d* entr(y|ies) ·/).isVisible(), "the last scan's list stays");
    assert.ok(await page.getByText(/The last scan failed/).isVisible(), "the older scan failure shows too");
  } finally {
    await app.close();
  }
});

test("an open Harness page follows each later read: files gone show as gone, a failed scan shows its failure", async () => {
  const own = makeFixture();
  const profile = path.join(scratch, "userData-open-page");
  const started = Date.now();
  const { app, page } = await launch(profile, own);
  try {
    await waitForCycle(page, started);
    await dismissPrimer(page);
    await page.getByRole("button", { name: "Harness" }).first().click();
    await page.getByText(/^[1-9]\d* entr(y|ies) ·/).waitFor({ timeout: 15_000 });
    // Every agent file goes; the next read is the scheduler's, not the page's Refresh.
    for (const rel of [".claude", ".cursor", "AGENTS.md"]) rmSync(path.join(own.repo, rel), { recursive: true, force: true });
    await page.evaluate(() => window.electronAPI.extraction.triggerNow());
    await page.getByText(/^0 entries ·/).waitFor({ timeout: 30_000 });
    // A scan whose result cannot be stored fails; the open page says so.
    mkdirSync(path.join(profile, "harness-inventory.json.tmp"));
    await page.evaluate(() => window.electronAPI.extraction.triggerNow());
    await page.getByText(/The last scan failed/).waitFor({ timeout: 30_000 });
  } finally {
    await app.close();
    rmSync(own.home, { recursive: true, force: true });
  }
});

test("the packaged app carries the licence and notice texts", () => {
  const resources = path.join(ROOT, "out", `Agent Desk-darwin-${process.arch}`, "Agent Desk.app", "Contents", "Resources");
  for (const f of [
    "LICENSE",
    "NOTICE",
    "LICENSES.chromium.html",
    "third_party/licenses/INDEX.txt",
    "third_party/dataclaw/LICENSE",
    "third_party/licenses/react/LICENSE",
    "third_party/licenses/@fontsource-variable/geist/LICENSE",
    "third_party/licenses/@fontsource/geist-mono/LICENSE",
    "third_party/shadcn-ui/LICENSE",
    "third_party/lucide/LICENSE",
    "third_party/electron-forge/LICENSE",
  ]) {
    assert.ok(existsSync(path.join(resources, f)), `${f} is in the app's Resources`);
  }
});

// Every fuse of the packaged app, by index, as the build should leave it. Index 8 is
// WasmTrapHandlers (Electron 41), which plugin-fuses 7 cannot set: Electron's default, on.
const EXPECTED_FUSES = {
  0: "off", // RunAsNode
  1: "off", // EnableCookieEncryption
  2: "off", // EnableNodeOptionsEnvironmentVariable
  3: "off", // EnableNodeCliInspectArguments
  4: "on", // EnableEmbeddedAsarIntegrityValidation
  5: "on", // OnlyLoadAppFromAsar
  6: "off", // LoadBrowserProcessSpecificV8Snapshot
  7: "on", // GrantFileProtocolExtraPrivileges
  8: "on", // WasmTrapHandlers
};

test("the packaged app's signature is valid and names the app", () => {
  const { verifyBundle, signatureDetails } = require(path.join(ROOT, "scripts", "adHocSign.cjs"));
  const app = path.join(ROOT, "out", `Agent Desk-darwin-${process.arch}`, "Agent Desk.app");
  verifyBundle(app, "dev.agentdesk.app");
  assert.match(signatureDetails(app), /^Identifier=dev\.agentdesk\.app$/m);
  assert.match(signatureDetails(app), /^CodeDirectory .*flags=0x\w+\(adhoc,runtime\)/m, "signed ad hoc with the hardened runtime");
});

test("a Return or Space on the folder-access primer asks for nothing", async () => {
  const profile = path.join(scratch, "userData-primer-keys");
  const { app, page } = await launch(profile);
  try {
    const primer = page.getByRole("dialog", { name: /See your AI coding sessions/ });
    await primer.waitFor({ timeout: 15_000 });
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.getAttribute("role") === "dialog" ? "dialog" : el?.tagName === "BUTTON" ? (el.textContent ?? "").trim() : el?.tagName ?? "";
    });
    assert.equal(focused, "dialog", "the dialog itself holds focus, not Continue");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Space");
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(await primer.isVisible(), "the primer is still open");
    assert.ok(!existsSync(path.join(profile, "permission-grants.json")), "no folder was asked for");
  } finally {
    await app.close();
  }
});

test("Quit in the application menu quits the app, through the quit sequence", async () => {
  const profile = path.join(scratch, "userData-menu-quit");
  const { app, page } = await launch(profile);
  await page.waitForFunction(() => document.querySelector("button") !== null);
  const closed = app.waitForEvent("close", { timeout: 30_000 });
  // The Quit item's role is macOS's terminate: action, which AppKit runs natively (Cmd+Q),
  // so the case sends that action rather than clicking the item from script.
  const found = await app.evaluate(({ Menu }) => {
    const all = (items) => items.flatMap((i) => [i, ...all(i.submenu?.items ?? [])]);
    const quit = all(Menu.getApplicationMenu()?.items ?? []).find((i) => i.role === "quit");
    if (quit) setTimeout(() => Menu.sendActionToFirstResponder("terminate:"), 100);
    return quit !== undefined;
  });
  assert.ok(found, "the application menu has Quit");
  await closed.catch(async (e) => {
    await app.close();
    throw e;
  });
  const log = readFileSync(path.join(profile, "logs", "main.log"), "utf8");
  assert.match(log, /app_quit/, "the quit sequence ran");
});

test("the packaged app's fuses are the nine the build sets", async () => {
  const { getCurrentFuseWire } = require("@electron/fuses");
  const app = path.join(ROOT, "out", `Agent Desk-darwin-${process.arch}`, "Agent Desk.app");
  const wire = await getCurrentFuseWire(app);
  const read = Object.fromEntries(
    Object.entries(wire)
      .filter(([k]) => k !== "version")
      .map(([k, v]) => [k, v === 49 ? "on" : v === 48 ? "off" : `unknown ${v}`]),
  );
  assert.deepEqual(read, Object.fromEntries(Object.entries(EXPECTED_FUSES).map(([k, v]) => [k, v])));
});

test("the window opens no other window and never leaves the app's page", async () => {
  const { app, page } = await launch(path.join(scratch, "userData-window-guards"));
  try {
    const own = page.url();
    assert.match(own, /^file:.*\/index\.html/);
    assert.equal(await page.evaluate(() => window.open("https://example.invalid/") === null), true, "window.open is refused");
    for (const away of ["https://example.invalid/", "file:///etc/hosts"]) {
      await page.evaluate((url) => {
        window.location.href = url;
      }, away);
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(page.url(), own, `navigating to ${away} is refused`);
    }
    assert.equal(app.windows().length, 1, "still one window");
    // Nor can it read a file itself: the page's policy lets it fetch nothing.
    const fetched = await page.evaluate(() => fetch("file:///etc/hosts").then(() => "read", () => "refused"));
    assert.equal(fetched, "refused", "fetching file:///etc/hosts is refused");
    // And it is granted no permission.
    assert.equal(await page.evaluate(() => Notification.requestPermission()), "denied", "a permission request is denied");
    // The page itself still runs. (A refused navigation leaves Playwright waiting on it, so
    // the check reads the DOM directly.)
    const harness = await page.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent?.includes("Harness")));
    assert.equal(harness, true, "the app's own page is still there");
  } finally {
    await app.close();
  }
});

test("after Continue the folder-access banner follows the answers, with no focus change", async () => {
  // The fixture's protected folders are plain folders, so every probe reads as granted at once.
  // The test windows never take focus, so only the app's own push can clear the banner.
  const own = makeFixture();
  for (const name of ["Desktop", "Downloads"]) mkdirSync(path.join(own.home, name)); // a missing folder is never asked
  const profile = path.join(scratch, "userData-primer-continue");
  const { app, page } = await launch(profile, own);
  try {
    const primer = page.getByRole("dialog", { name: /See your AI coding sessions/ });
    await primer.waitFor({ timeout: 15_000 });
    await page.getByText("Grant folder access").first().waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Continue" }).click();
    await primer.waitFor({ state: "detached", timeout: 15_000 });
    await page.getByText("Grant folder access").first().waitFor({ state: "detached", timeout: 15_000 });
    assert.ok(existsSync(path.join(profile, "permission-grants.json")), "the folders were asked for");
  } finally {
    await app.close();
    rmSync(own.home, { recursive: true, force: true });
  }
});

test("the primer is a modal: the app behind it is inert, Tab stays inside it, and Tab to Continue then Return asks", async () => {
  const own = makeFixture();
  for (const name of ["Desktop", "Downloads"]) mkdirSync(path.join(own.home, name));
  const profile = path.join(scratch, "userData-primer-modal");
  const { app, page } = await launch(profile, own);
  try {
    const primer = page.getByRole("dialog", { name: /See your AI coding sessions/ });
    await primer.waitFor({ timeout: 15_000 });
    await page.getByText("Grant folder access").first().waitFor({ timeout: 15_000 });
    assert.equal(await page.evaluate(() => document.querySelector("[inert]")?.textContent?.includes("Grant access") ?? false), true, "the banner is inside the inert app");
    for (let i = 1; i <= 3; i++) {
      await page.keyboard.press("Tab");
      const where = await page.evaluate(() => {
        const el = document.activeElement;
        return { inside: !!el?.closest('[role="dialog"]'), text: (el?.textContent ?? "").trim() };
      });
      assert.ok(where.inside, `Tab ${i} stays in the primer (focus on "${where.text}")`);
    }
    assert.ok(!existsSync(path.join(profile, "permission-grants.json")), "nothing asked yet");
    assert.equal(await page.evaluate(() => (document.activeElement?.textContent ?? "").trim()), "Continue");
    await page.keyboard.press("Enter");
    await primer.waitFor({ state: "detached", timeout: 15_000 });
    assert.ok(existsSync(path.join(profile, "permission-grants.json")), "Continue asked");
  } finally {
    await app.close();
    rmSync(own.home, { recursive: true, force: true });
  }
});

function traceEntries() {
  return readFileSync(tracePath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}
