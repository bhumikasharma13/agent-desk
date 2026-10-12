// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// Builds a throwaway HOME for a launch: one Claude Code session and one Codex session, both in a
// git repo at <home>/src/shop that holds a Claude skill, an AGENTS.md, a Cursor rule, a
// settings.json hook and a package.json (for a stack tag), committed on main. A second Claude Code
// session ran in <home>/Documents/notes, a committed repo with its own skill and package.json:
// the test makes <home>/Documents the app's Documents folder, which the user has not granted, so
// none of that repo's files may be read. The first session's second prompt holds a secret, and
// ~/.claude.json holds a Claude Code login. Nothing outside the temp dir is read or written.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function write(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/** A secret in the Claude Code session's second prompt, which the session store masks. */
export const FIXTURE_SECRET = "DB_PASSWORD=penny-jar";
/** The Claude Code login in `~/.claude.json`. */
export const FIXTURE_LOGIN = { email: "jane.doe@example.com", account: "8c1f0a52-4d3e-4b6a-9f21-acct00demo01" };

/** A git environment that reads no user or system git config. */
export function gitEnv(home) {
  return { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
}

export function makeFixture() {
  // realpath: macOS reaches the temp dir through /var -> /private/var, and both libraries
  // report canonical paths.
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "agent-desk-home-")));
  const repo = path.join(home, "src", "shop");
  const skill = path.join(repo, ".claude", "skills", "review", "SKILL.md");

  write(skill, "---\nname: review\ndescription: Review a change before it lands.\n---\nRead the diff and list what could break.\n");
  write(path.join(repo, "AGENTS.md"), "# Agents\n\nRun the tests before you commit.\n");
  write(path.join(repo, "package.json"), JSON.stringify({ name: "shop", private: true }, null, 2) + "\n");
  write(path.join(repo, ".cursor", "rules", "style.mdc"), "---\ndescription: House style\n---\nPrefer small functions.\n");
  write(
    path.join(repo, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo checked" }] }] } }, null, 2) + "\n",
  );
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { env: gitEnv(home), stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.name=Jane Doe", "-c", "user.email=jane@example.com", "commit", "-q", "-m", "Add the harness");

  const encoded = repo.replace(/[^A-Za-z0-9]/g, "-");
  const claude = [
    { type: "user", uuid: "u-001", timestamp: "2026-04-01T10:00:00.000Z", sessionId: "7d3c9a10-demo-claude", cwd: repo, gitBranch: "main", message: { role: "user", content: "The cart total is off by one cent. Find out why." } },
    { type: "assistant", uuid: "a-001", timestamp: "2026-04-01T10:00:06.000Z", sessionId: "7d3c9a10-demo-claude", message: { id: "msg-001", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "Prices are summed as floats. I will switch to integer cents." }], usage: { input_tokens: 120, output_tokens: 40 } } },
    { type: "user", uuid: "u-002", timestamp: "2026-04-01T10:01:00.000Z", sessionId: "7d3c9a10-demo-claude", cwd: repo, gitBranch: "main", message: { role: "user", content: `The staging database is ${FIXTURE_SECRET} for now.` } },
  ];
  write(path.join(home, ".claude", "projects", encoded, "7d3c9a10-demo-claude.jsonl"), claude.map((l) => JSON.stringify(l)).join("\n") + "\n");
  // The Claude Code login, which the session store keeps unmasked beside each session.
  write(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: FIXTURE_LOGIN.email, accountUuid: FIXTURE_LOGIN.account } }) + "\n");

  const codex = [
    { timestamp: "2026-04-01T11:00:00.000Z", type: "session_meta", payload: { id: "0d6c2f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f", timestamp: "2026-04-01T11:00:00.000Z", cwd: repo, originator: "codex_cli_rs", cli_version: "0.144.5", source: "cli", model_provider: "openai" } },
    { timestamp: "2026-04-01T11:00:01.000Z", type: "turn_context", payload: { cwd: repo, model: "gpt-5-codex" } },
    { timestamp: "2026-04-01T11:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add a test for the cart total rounding." }] } },
    { timestamp: "2026-04-01T11:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "Add a test for the cart total rounding.", images: [] } },
    { timestamp: "2026-04-01T11:00:20.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Added cart.test.ts with three rounding cases." }] } },
  ];
  write(
    path.join(home, ".codex", "sessions", "2026", "04", "01", "rollout-2026-04-01T11-00-00-0d6c2f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f.jsonl"),
    codex.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  // A repo inside a protected folder (Documents) that a session names.
  const notes = path.join(home, "Documents", "notes");
  write(path.join(notes, ".claude", "skills", "secret", "SKILL.md"), "---\nname: secret\ndescription: Not to be read.\n---\nPrivate.\n");
  write(path.join(notes, "package.json"), "{}\n");
  const gitNotes = (...args) => execFileSync("git", ["-C", notes, ...args], { env: gitEnv(home), stdio: "ignore" });
  gitNotes("init", "-q", "-b", "main");
  gitNotes("add", "-A");
  gitNotes("-c", "user.name=Jane Doe", "-c", "user.email=jane@example.com", "commit", "-q", "-m", "Notes");
  const notesSession = [
    { type: "user", uuid: "u-201", timestamp: "2026-04-03T09:00:00.000Z", sessionId: "5a1b2c3d-demo-notes", cwd: notes, gitBranch: "main", message: { role: "user", content: "Tidy these notes." } },
    { type: "assistant", uuid: "a-201", timestamp: "2026-04-03T09:00:04.000Z", sessionId: "5a1b2c3d-demo-notes", message: { id: "msg-201", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "Done." }], usage: { input_tokens: 20, output_tokens: 5 } } },
  ];
  write(path.join(home, ".claude", "projects", notes.replace(/[^A-Za-z0-9]/g, "-"), "5a1b2c3d-demo-notes.jsonl"), notesSession.map((l) => JSON.stringify(l)).join("\n") + "\n");

  return { home, repo, skill, protectedRoot: home, documents: path.join(home, "Documents"), notes };
}

/**
 * Adds `count` more Claude Code sessions in `repo` (made if missing; the fixture's repo by
 * default), with ids `<prefix>-000` on; the first has `firstMessages` messages, the rest two.
 */
export function addClaudeSessions(fixture, count, firstMessages, { repo = fixture.repo, prefix = "extra" } = {}) {
  mkdirSync(repo, { recursive: true });
  const dir = path.join(fixture.home, ".claude", "projects", repo.replace(/[^A-Za-z0-9]/g, "-"));
  for (let s = 0; s < count; s++) {
    const id = `${prefix}-${String(s).padStart(3, "0")}`;
    const lines = Array.from({ length: s === 0 ? firstMessages : 2 }, (_, i) => {
      const timestamp = new Date(Date.UTC(2026, 3, 5, 8, 0, i)).toISOString();
      return i % 2 === 0
        ? { type: "user", uuid: `${id}-u${i}`, timestamp, sessionId: id, cwd: repo, message: { role: "user", content: `Step ${i} of ${id}.` } }
        : { type: "assistant", uuid: `${id}-a${i}`, timestamp, sessionId: id, message: { id: `${id}-m${i}`, role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: `Did step ${i - 1}.` }], usage: { input_tokens: 1, output_tokens: 1 } } };
    });
    write(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
}
