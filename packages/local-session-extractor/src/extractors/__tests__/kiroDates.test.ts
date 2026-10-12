// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A Kiro session whose created or updated time is missing or not a date has no
 * duration and no source-created time: never a 1970 epoch, never NaN.
 */
import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../../store/SessionStore";
import { extractKiro } from "../../internal";
import { setPathOverrides } from "../pathResolver";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIRO_CASE = join(HERE, "../../../fixtures/turn-telemetry/kiro/turn-brackets");
const tmp = mkdtempSync(join(tmpdir(), "lse-kiro-dates-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const EMPTY = ["KIRO_SESSIONS_PATH", "KIRO_IDE_SESSIONS_PATH", "KIRO_CLI_SESSIONS_PATH", "KIRO_DB_PATH", "KIRO_CLI_DB_PATH", "KIRO_CREW_PATH", "KIRO_USER_MCP_PATH"] as const;

function scan(name: string, paths: Partial<Record<(typeof EMPTY)[number], string>>) {
  const base = join(tmp, name);
  setPathOverrides(Object.fromEntries(EMPTY.map((k) => [k, paths[k] ?? join(base, `none-${k.toLowerCase()}`)])));
  const store = new SessionStore(join(base, "sessions.db"));
  try {
    extractKiro(store);
    return store.listConversations({ ideType: "kiro" }).map((r) => ({
      created: r.conversation_source_created_at_ms,
      meta: JSON.parse(r.session_meta!) as { session_duration_seconds?: number | null; duration_minutes?: number | null },
    }));
  } finally {
    store.close();
  }
}

function cliSession(dir: string, dates: { created_at?: string; updated_at?: string }): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "s1.json"),
    JSON.stringify({ session_id: "s1", cwd: "/tmp/project", title: "t", ...dates, session_state: { agent_name: "main" } }),
  );
  writeFileSync(
    join(dir, "s1.jsonl"),
    [
      { kind: "Prompt", data: { message_id: "m1", meta: { timestamp: 1775037605 }, content: [{ kind: "text", data: "Do the thing" }] } },
      { kind: "AssistantMessage", data: { message_id: "m2", content: [{ kind: "text", data: "Done." }] } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

describe("Kiro session times that are missing or not dates", () => {
  afterEach(() => setPathOverrides(Object.fromEntries(EMPTY.map((k) => [k, undefined]))));

  const cliCases: Array<[string, { created_at?: string; updated_at?: string }]> = [
    ["no created_at", { updated_at: "2026-04-01T10:10:00.000Z" }],
    ["a created_at that is not a date", { created_at: "yesterday", updated_at: "2026-04-01T10:10:00.000Z" }],
  ];
  for (const [label, dates] of cliCases) {
    it(`cli: ${label} gives no duration and no created time`, () => {
      const dir = join(tmp, `cli-${label.replace(/\W+/g, "-")}`, "sessions");
      cliSession(dir, dates);
      const rows = scan(`cli-${label.replace(/\W+/g, "-")}`, { KIRO_CLI_SESSIONS_PATH: dir });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.created, null);
      assert.equal(rows[0]!.meta.session_duration_seconds, undefined);
      assert.equal(rows[0]!.meta.duration_minutes, undefined);
    });
  }

  it("ide: a createdAt that is not a date gives no duration and no created time", () => {
    const root = join(tmp, "ide", "sessions");
    const sess = readdirSync(KIRO_CASE).find((n) => n.startsWith("sess_"))!;
    const target = join(root, "ws1", sess);
    cpSync(join(KIRO_CASE, sess), target, { recursive: true });
    const sessionJson = JSON.parse(readFileSync(join(target, "session.json"), "utf8")) as Record<string, unknown>;
    sessionJson["createdAt"] = "not a date";
    writeFileSync(join(target, "session.json"), JSON.stringify(sessionJson));
    const rows = scan("ide", { KIRO_IDE_SESSIONS_PATH: root });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.created, null);
    assert.equal(rows[0]!.meta.session_duration_seconds, undefined);
  });
});
