// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Kiro IDE interleaves a session's own prompts with its sub-executions' prompts
 * by time. A prompt with no timestamp stays right after the prompt before it in
 * its own transcript, and every timestamped prompt still lands in time order.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../../store/SessionStore";
import { extractKiro } from "../../internal";
import { setPathOverrides } from "../pathResolver";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASE = join(HERE, "../../../fixtures/turn-telemetry/kiro/inline-subagents");
const tmp = mkdtempSync(join(tmpdir(), "lse-kiro-interleave-"));
const KEYS = ["KIRO_SESSIONS_PATH", "KIRO_IDE_SESSIONS_PATH", "KIRO_CLI_SESSIONS_PATH", "KIRO_DB_PATH", "KIRO_CLI_DB_PATH", "KIRO_CREW_PATH", "KIRO_USER_MCP_PATH"] as const;
after(() => {
  setPathOverrides(Object.fromEntries(KEYS.map((k) => [k, undefined])));
  rmSync(tmp, { recursive: true, force: true });
});

describe("kiro IDE — interleaving prompts that lack a timestamp", () => {
  it("keeps timestamped prompts in time order around an unstamped one", () => {
    const sess = readdirSync(CASE).find((n) => n.startsWith("sess_"))!;
    const root = join(tmp, "ide");
    const target = join(root, "ws1", sess);
    cpSync(join(CASE, sess), target, { recursive: true });
    // Drop the timestamp from a parent assistant message that follows the
    // sub-executions (record 25 of the case's messages.jsonl).
    const path = join(target, "messages.jsonl");
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l, i) => {
      const rec = JSON.parse(l) as { timestamp?: string; payload: { type: string } };
      if (i === 25) {
        assert.equal(rec.payload.type, "assistant");
        delete rec.timestamp;
      }
      return JSON.stringify(rec);
    });
    writeFileSync(path, lines.join("\n") + "\n");

    setPathOverrides(Object.fromEntries(KEYS.map((k) => [k, k === "KIRO_IDE_SESSIONS_PATH" ? root : join(tmp, `none-${k}`)])));
    const store = new SessionStore(join(tmp, "sessions.db"));
    try {
      extractKiro(store);
      const prompts = JSON.parse(store.listConversations({ ideType: "kiro" })[0]!.conversation) as Array<{ role: string; timestamp?: string }>;
      const stamped = prompts.filter((p) => p.timestamp).map((p) => Date.parse(p.timestamp!));
      for (let i = 1; i < stamped.length; i++) assert.ok(stamped[i]! >= stamped[i - 1]!, `out of order at ${i}`);
      assert.equal(prompts.filter((p) => !p.timestamp).length, 1, "the unstamped prompt is kept");
    } finally {
      store.close();
    }
  });
});
