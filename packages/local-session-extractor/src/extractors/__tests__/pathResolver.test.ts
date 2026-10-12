// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getCursorCliChatsPath,
  getCursorCliChatsRoots,
  getCursorAgentLogsPath,
  getCursorCliConfigPath,
  getCursorProjectsPath,
  getCodexHomePath,
  getCodexSqlitePath,
  getPathOverride,
  hasPathOverride,
  setHomeOverride,
  setPathOverrides,
  UnknownPathKeyError,
} from "../pathResolver";

describe("pathResolver — Cursor CLI/Agent getters", () => {
  afterEach(() => {
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: undefined, CURSOR_PROJECTS_PATH: undefined, CURSOR_CLI_CONFIG_PATH: undefined });
    delete process.env["LSE_TEST_CURSOR_CLI_CHATS_PATH"];
  });

  it("default to ~/.cursor locations when no override is set", () => {
    assert.equal(getCursorCliChatsPath(), join(homedir(), ".cursor", "chats"));
    assert.equal(getCursorProjectsPath(), join(homedir(), ".cursor", "projects"));
    assert.equal(getCursorCliConfigPath(), join(homedir(), ".cursor", "cli-config.json"));
  });

  it("return an explicit override, and the default again once it is cleared", () => {
    setPathOverrides({
      CURSOR_CLI_CHATS_PATH: "/tmp/fixture/chats",
      CURSOR_PROJECTS_PATH: "/tmp/fixture/projects",
      CURSOR_CLI_CONFIG_PATH: "/tmp/fixture/cli-config.json",
    });
    assert.equal(getCursorCliChatsPath(), "/tmp/fixture/chats");
    assert.equal(getCursorProjectsPath(), "/tmp/fixture/projects");
    assert.equal(getCursorCliConfigPath(), "/tmp/fixture/cli-config.json");
    assert.equal(getPathOverride("CURSOR_PROJECTS_PATH"), "/tmp/fixture/projects");

    setPathOverrides({ CURSOR_PROJECTS_PATH: undefined });
    assert.equal(hasPathOverride("CURSOR_PROJECTS_PATH"), false);
    assert.equal(getCursorProjectsPath(), join(homedir(), ".cursor", "projects"));
  });

  it("treat an empty override as unset", () => {
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: "" });
    assert.equal(getCursorCliChatsPath(), join(homedir(), ".cursor", "chats"));
  });

  it("read no environment variable", () => {
    process.env["LSE_TEST_CURSOR_CLI_CHATS_PATH"] = "/tmp/fixture/from-env";
    assert.equal(getCursorCliChatsPath(), join(homedir(), ".cursor", "chats"));
  });

  it("resolve both the current `chats` and legacy `cli-chats` CLI store roots", () => {
    assert.deepEqual(getCursorCliChatsRoots(), [
      join(homedir(), ".cursor", "chats"),
      join(homedir(), ".cursor", "cli-chats"),
    ]);
  });
});

describe("pathResolver — the home root and Codex's two roots", () => {
  const saved = { CODEX_HOME: process.env["CODEX_HOME"], CODEX_SQLITE_HOME: process.env["CODEX_SQLITE_HOME"] };
  afterEach(() => {
    setPathOverrides({ CODEX_HOME: undefined, CODEX_SQLITE_HOME: undefined });
    setHomeOverride(undefined);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("resolve every default under the home root override", () => {
    delete process.env["CODEX_HOME"];
    delete process.env["CODEX_SQLITE_HOME"];
    setHomeOverride("/tmp/fixture/home");
    assert.equal(getCursorCliChatsPath(), "/tmp/fixture/home/.cursor/chats");
    assert.equal(getCodexHomePath(), "/tmp/fixture/home/.codex");
    assert.equal(getCodexSqlitePath(), "/tmp/fixture/home/.codex/state_5.sqlite");
  });

  it("resolve the cursor-agent temp logs under the home root, not this machine's temp dir", () => {
    setHomeOverride("/tmp/fixture/home");
    assert.match(getCursorAgentLogsPath(), /^\/tmp\/fixture\/home\/cursor-agent-logs-/);
  });

  it("reject an unknown key", () => {
    assert.throws(() => setPathOverrides({ HOME: "/tmp/x" } as never), UnknownPathKeyError);
    // KIRO_LOGS_PATH named a location no reader uses, so it is not a key.
    assert.throws(() => setPathOverrides({ KIRO_LOGS_PATH: "/tmp/x" } as never), UnknownPathKeyError);
  });

  it("honour Codex's own variables when nothing is overridden", () => {
    process.env["CODEX_HOME"] = "/tmp/fixture/env-codex";
    process.env["CODEX_SQLITE_HOME"] = "/tmp/fixture/env-sqlite";
    assert.equal(getCodexHomePath(), "/tmp/fixture/env-codex");
    assert.equal(getCodexSqlitePath(), "/tmp/fixture/env-sqlite/state_5.sqlite");
  });

  it("put each Codex key, and the home root, ahead of Codex's variables", () => {
    process.env["CODEX_HOME"] = "/tmp/fixture/env-codex";
    process.env["CODEX_SQLITE_HOME"] = "/tmp/fixture/env-sqlite";
    setPathOverrides({ CODEX_HOME: "/tmp/fixture/key-codex", CODEX_SQLITE_HOME: "/tmp/fixture/key-sqlite" });
    assert.equal(getCodexHomePath(), "/tmp/fixture/key-codex");
    assert.equal(getCodexSqlitePath(), "/tmp/fixture/key-sqlite/state_5.sqlite");
    setPathOverrides({ CODEX_HOME: undefined, CODEX_SQLITE_HOME: undefined });
    setHomeOverride("/tmp/fixture/home");
    assert.equal(getCodexHomePath(), "/tmp/fixture/home/.codex");
    assert.equal(getCodexSqlitePath(), "/tmp/fixture/home/.codex/state_5.sqlite");
  });
});
