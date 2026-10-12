// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A scan reads Codex's `auth.json` for the plan tier and login email, and Claude Code's
 * `~/.claude.json` for its `oauthAccount` fields. It keeps those and never a token from
 * either file, in the store or an export.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSessions, openStore, readAll } from "../index";

const tmp = mkdtempSync(join(tmpdir(), "lse-credentials-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const ID_TOKEN = `${b64({ alg: "none" })}.${b64({ email: "dev@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "plus" } })}.sig-id`;
const ACCESS_TOKEN = `${b64({ alg: "none" })}.${b64({ scope: "all" })}.sig-access`;
const REFRESH_TOKEN = "refresh-token-value-for-this-test-only";

describe("Claude Code ~/.claude.json", () => {
  it("contributes the oauthAccount fields, and no token in the file reaches the store or an export", async () => {
    const home = join(tmp, "home-claude");
    const project = join(home, ".claude", "projects", "-w-app");
    mkdirSync(project, { recursive: true });
    const tokens = ["claude-access-token-for-this-test-only", "claude-refresh-token-for-this-test-only", "claude-api-key-for-this-test-only"];
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({
        primaryApiKey: tokens[2],
        claudeAiOauth: { accessToken: tokens[0], refreshToken: tokens[1] },
        oauthAccount: { emailAddress: "dev@example.com", accountUuid: "acct-1", organizationUuid: "org-1", seatTier: "team", billingType: "stripe" },
      }),
    );
    const line = { type: "user", uuid: "u1", timestamp: "2026-04-01T10:00:00.000Z", sessionId: "c1", cwd: "/w/app", message: { role: "user", content: "hello" } };
    writeFileSync(join(project, "c1.jsonl"), JSON.stringify(line) + "\n");

    const dbPath = join(tmp, "sessions-claude.db");
    const store = openStore(dbPath);
    try {
      const result = await readAll(store, { home, sources: ["claude-code"] });
      assert.equal(result.counts["claude-code"], 1);
      const row = store.listConversations({ ideType: "claude-code" })[0]!;
      const meta = JSON.parse(row.installation_metadata!) as Record<string, unknown>;
      assert.deepEqual([meta["login_email"], meta["account_uuid"], meta["organization_uuid"], meta["seat_tier"]], ["dev@example.com", "acct-1", "org-1", "team"]);

      const file = join(tmp, "export-claude.jsonl");
      await exportSessions(store, { format: "jsonl", shape: "row", out: file, includeSyncState: true });
      const stored = JSON.stringify(store.raw().prepare("SELECT * FROM conversations").all()) + JSON.stringify(store.raw().prepare("SELECT * FROM meta").all());
      const pages = [dbPath, `${dbPath}-wal`].filter(existsSync).map((p) => readFileSync(p).toString("latin1"));
      for (const text of [stored, readFileSync(file, "utf8"), ...pages]) {
        for (const secret of tokens) assert.ok(!text.includes(secret), `${secret} must not be kept`);
      }
    } finally {
      store.close();
    }
  });
});

describe("Codex auth.json", () => {
  it("contributes the plan tier and email, and no token reaches the store or an export", async () => {
    const home = join(tmp, "home");
    const codex = join(home, ".codex");
    const day = join(codex, "sessions", "2026", "04", "01");
    mkdirSync(day, { recursive: true });
    writeFileSync(
      join(codex, "auth.json"),
      JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: ID_TOKEN, access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN } }),
    );
    const id = "0d6c2f4e-1b2a-4c3d-8e9f-0a1b2c3d4e5f";
    const lines = [
      { timestamp: "2026-04-01T11:00:00.000Z", type: "session_meta", payload: { id, timestamp: "2026-04-01T11:00:00.000Z", cwd: "/Users/you/app", source: "cli" } },
      { timestamp: "2026-04-01T11:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "hello" } },
    ];
    writeFileSync(join(day, `rollout-2026-04-01T11-00-00-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const dbPath = join(tmp, "sessions.db");
    const store = openStore(dbPath);
    try {
      const result = await readAll(store, { home, sources: ["codex"] });
      assert.equal(result.counts.codex, 1);
      const meta = JSON.parse(store.getConversation("codex", id)!.installation_metadata!) as Record<string, unknown>;
      assert.equal(meta["plan_tier"], "pro");
      assert.equal(meta["login_email"], "dev@example.com");

      const file = join(tmp, "export.jsonl");
      await exportSessions(store, { format: "jsonl", shape: "row", out: file, includeSyncState: true });
      const stored = JSON.stringify(store.raw().prepare("SELECT * FROM conversations").all()) + JSON.stringify(store.raw().prepare("SELECT * FROM meta").all());
      // The raw database pages too, the write-ahead log included.
      const pages = [dbPath, `${dbPath}-wal`].filter(existsSync).map((p) => readFileSync(p).toString("latin1"));
      for (const text of [stored, readFileSync(file, "utf8"), ...pages]) {
        for (const secret of [ID_TOKEN, ACCESS_TOKEN, REFRESH_TOKEN, "sig-id", "sig-access"]) {
          assert.ok(!text.includes(secret), `${secret.slice(0, 12)}… must not be kept`);
        }
      }
    } finally {
      store.close();
    }
  });
});
