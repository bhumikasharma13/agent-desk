// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { detectCopilotVSCodeMetadata } from "../planTierDetector";

function stateDb(dir: string, name: string, items: Record<string, string>): string {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  const insert = db.prepare("INSERT INTO ItemTable VALUES (?, ?)");
  for (const [key, value] of Object.entries(items)) insert.run(key, value);
  db.close();
  return path;
}

describe("detectCopilotVSCodeMetadata", () => {
  let dir = "";
  before(() => (dir = mkdtempSync(join(tmpdir(), "copilot-vscdb-"))));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("reads each value in its known shape", () => {
    const meta = detectCopilotVSCodeMetadata(
      stateDb(dir, "ok.vscdb", {
        "extensionsAssignmentFilterProvider.copilotSku": "free_limited_copilot",
        "GitHub.copilot": JSON.stringify({ installedVersion: "1.388.0" }),
        "extensionsAssignmentFilterProvider.copilotTrackingId": "0123456789abcdef0123456789abcdef",
        "github.copilot-github": "example-user",
        "chat.currentLanguageModel.panel": "copilot/gpt-4.1",
        "chat.lastChatMode": "agent",
      }),
    );
    assert.ok(meta);
    assert.equal(meta.entrypoint, "copilot-vscode");
    assert.equal(meta.cc_version, "1.388.0");
    assert.equal(meta.device_id, "0123456789abcdef0123456789abcdef");
    assert.equal(meta.login_email, undefined, "a GitHub username is never sent as a login email");
    assert.equal(meta.default_model, "copilot/gpt-4.1");
    assert.equal(meta.last_chat_mode, "agent");
  });

  it("never sends a credential stored under a value key", () => {
    for (const token of [
      "gho_16C7e42F292c6912E7710c838347Ae178B4a", // fake credential, test fixture. gitleaks:allow
      "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP",
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      "/Users/example-user/src/secret-project/notes.txt",
    ]) {
      const meta = detectCopilotVSCodeMetadata(
        stateDb(dir, `tok-${token.length}.vscdb`, {
          "extensionsAssignmentFilterProvider.copilotSku": "free_limited_copilot",
          "GitHub.copilot": JSON.stringify({ installedVersion: token }),
          "chat.currentLanguageModel.panel": token,
          "chat.lastChatMode": token,
        }),
      );
      assert.ok(meta);
      assert.ok(!JSON.stringify(meta).includes(token.slice(0, 10)), `${token.slice(0, 10)}… must not appear`);
    }
  });

  it("drops a value in any other shape rather than storing it", () => {
    const meta = detectCopilotVSCodeMetadata(
      stateDb(dir, "odd.vscdb", {
        "extensionsAssignmentFilterProvider.copilotSku": "free_limited_copilot",
        "extensionsAssignmentFilterProvider.copilotTrackingId": "not-a-tracking-id",
        "github.copilot-github": JSON.stringify({ id: "12345", label: "example-user", accessToken: "gho_example" }),
        "chat.currentLanguageModel.panel": "x".repeat(400),
        "chat.lastChatMode": "two words",
      }),
    );
    assert.ok(meta, "the recognised fields still form a record");
    assert.ok(meta.plan_tier);
    for (const key of ["device_id", "login_email", "default_model", "last_chat_mode"] as const) {
      assert.equal(meta[key], undefined, `${key} must be absent`);
    }
  });
});
