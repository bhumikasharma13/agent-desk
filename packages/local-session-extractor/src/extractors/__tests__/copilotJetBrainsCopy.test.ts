// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A small JetBrains chat database is copied before it is read. The copy goes to
 * a fresh private temp directory (mode 0700, a random name), never a shared,
 * predictable path, and the directory is removed after the read.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

const copies: Array<{ dest: string; dirMode: number }> = [];
const realCopy = fs.copyFileSync;
fs.copyFileSync = ((src: fs.PathLike, dest: fs.PathLike, mode?: number) => {
  realCopy(src, dest, mode);
  copies.push({ dest: String(dest), dirMode: statSync(dirname(String(dest))).mode & 0o777 });
}) as typeof fs.copyFileSync;
syncBuiltinESMExports();

const { SessionStore } = await import("../../store/SessionStore");
const { extractCopilot } = await import("../../internal");
const { setPathOverrides } = await import("../pathResolver");

const work = join(tmpdir(), `lse-jb-copy-${process.pid}`);
after(() => {
  setPathOverrides({ COPILOT_CLI_PATH: undefined, COPILOT_VSCODE_USER_DATA_PATH: undefined });
  rmSync(work, { recursive: true, force: true });
});

describe("Copilot JetBrains — the temp copy of a chat database", () => {
  it("copies into a private, freshly made directory and removes it", () => {
    const sessionDir = join(homedir(), ".config", "github-copilot", "iu", "chat-sessions", "s1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "copilot-chat-nitrite.db"), Buffer.alloc(1024, 0));
    mkdirSync(work, { recursive: true });
    setPathOverrides({ COPILOT_CLI_PATH: join(work, "no-cli"), COPILOT_VSCODE_USER_DATA_PATH: join(work, "no-vscode") });
    const store = new SessionStore(join(work, "sessions.db"));
    try {
      extractCopilot(store);
    } finally {
      store.close();
    }
    assert.equal(copies.length, 1, "the small database is copied once");
    const { dest, dirMode } = copies[0]!;
    assert.notEqual(dirname(dest), join(tmpdir(), "local-session-extractor-jb"), "not a shared, predictable directory");
    assert.equal(dirMode, 0o700);
    assert.equal(existsSync(dirname(dest)), false, "the temp directory is removed");
  });
});
