// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// The session reads against a real session store: what crosses IPC, what is refused, and
// that a failure comes back as an error value.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "local-session-extractor";
import { MAX_MESSAGE_CHARS, getTranscript, listSessions } from "../sessions";
import { cutText } from "../../shared/sessionTypes";

const dir = mkdtempSync(join(tmpdir(), "sessions-ipc-"));
const store = openStore(join(dir, "sessions.db"));
after(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const LOGIN = "jane.doe@example.com";
const ACCOUNT = "acct-5f2a9c";
const LONG = "x".repeat(MAX_MESSAGE_CHARS + 10);
store.upsert({
  ideType: "claude-code",
  // A Claude Code session id holds the session's folder, the user name included.
  sessionId: "-Users-janedoe-src-shop::s1",
  projectPath: "/w/shop",
  conversation: [
    { role: "user", content: "Why is the total off?" },
    { role: "assistant", content: LONG, metadata: { model: "m-1", messageId: "msg-9" } },
    { role: "assistant", content: "y".repeat(MAX_MESSAGE_CHARS) },
    { role: "assistant", content: "z".repeat(MAX_MESSAGE_CHARS + 1) },
  ],
  sessionMeta: JSON.stringify({ session_title: "Cart total", git_branch: "main" }),
  installationMetadata: JSON.stringify({ login_email: LOGIN, account_uuid: ACCOUNT, device_id: "dev-1" }),
  lastMtimeMs: 1,
  lastSize: 1,
  lastOffset: 0,
});
const key = (): string => listSessions(store, { ideType: "claude-code" }).rows[0]!.key;

test("a list and a transcript carry only the page's fields: no tool session id, login email or account id", () => {
  const list = listSessions(store, { limit: 50 });
  assert.equal(list.error, null);
  assert.equal(list.total, 1);
  assert.deepEqual(Object.keys(list.rows[0]!).sort(), [
    "assistantMessages", "branch", "durationMinutes", "ideType", "key", "lastActivityMs", "models", "projectPath", "startedAt", "title", "userMessages",
  ]);
  assert.match(list.rows[0]!.key, /^[0-9a-f]{64}$/);
  const t = getTranscript(store, key(), 0);
  assert.equal(t.error, null);
  assert.deepEqual(Object.keys(t.messages[1]!).sort(), ["content", "inputTokens", "isSubAgent", "model", "outputTokens", "role", "timestamp", "truncated"]);
  const out = JSON.stringify([list, t]);
  for (const kept of ["janedoe", "s1", LOGIN, ACCOUNT, "dev-1", "msg-9", "git_branch"]) assert.ok(!out.includes(kept), kept);
});

test("a message longer than the cap is cut and marked, and one exactly at the cap is not", () => {
  const [short, long, exact, over] = getTranscript(store, key(), 0).messages;
  assert.deepEqual([short!.truncated, long!.truncated, long!.content.length], [false, true, MAX_MESSAGE_CHARS]);
  assert.deepEqual([exact!.truncated, exact!.content.length], [false, MAX_MESSAGE_CHARS]);
  assert.deepEqual([over!.truncated, over!.content.length], [true, MAX_MESSAGE_CHARS]);
});

test("the cut never splits a surrogate pair", () => {
  const cut = cutText(`${"x".repeat(MAX_MESSAGE_CHARS - 1)}😀`, MAX_MESSAGE_CHARS);
  assert.equal(cut, "x".repeat(MAX_MESSAGE_CHARS - 1));
  assert.equal(cutText("ab😀", 4), "ab😀", "a text within the cap is whole");
});

test("a page position from the list continues the list after its last row", () => {
  for (const id of ["p1", "p2", "p3"]) store.upsert({ ideType: "codex", sessionId: id, conversation: [], lastMtimeMs: 5, lastSize: 1, lastOffset: 0 });
  const first = listSessions(store, { limit: 2 });
  const last = first.rows.at(-1)!;
  const next = listSessions(store, { limit: 2, after: { lastActivityMs: last.lastActivityMs, key: last.key } });
  assert.equal(next.total, first.total, "a later page has the first page's total");
  assert.equal(next.error, null);
  const keys = [...first.rows, ...next.rows].map((r) => r.key);
  assert.equal(new Set(keys).size, 4);
  assert.equal(listSessions(store, { after: { lastActivityMs: 5, key: "not-a-key" } }).error, "The page position is not valid.");
});

test("a Projects row's filter, its No folder row included, lists that row's sessions", () => {
  store.upsert({ ideType: "kiro", sessionId: "loose", conversation: [{ role: "user", content: "x" }], lastMtimeMs: 1, lastSize: 1, lastOffset: 0 });
  const loose = listSessions(store, { ideType: "kiro", projectPath: null });
  assert.deepEqual([loose.error, loose.total], [null, 1]);
  assert.deepEqual([listSessions(store, { ideType: "claude-code", projectPath: "/w/shop" }).total, listSessions(store, { ideType: "kiro", projectPath: "/w/shop" }).total], [1, 0]);
});

test("bad input is refused as an error value", () => {
  for (const filter of [null, [], "x", { ideType: "vim" }, { projectPath: 7 }, { query: "q".repeat(201) }, { limit: 0 }, { limit: 201 }, { after: null }, { after: { lastActivityMs: "1", key: "a".repeat(64) } }]) {
    const r = listSessions(store, filter);
    assert.ok(r.error, JSON.stringify(filter));
    assert.deepEqual(r.rows, []);
  }
  for (const [k, offset] of [["s", 0], ["", 0], [7, 0], ["A".repeat(64), 0], ["a".repeat(64), -1], ["a".repeat(64), "0"]] as const) {
    assert.ok(getTranscript(store, k, offset).error, `${String(k).slice(0, 10)} ${offset}`);
  }
  assert.equal(getTranscript(store, key().toUpperCase(), 0).error, "The session key is not valid.", "an uppercase key is refused");
  assert.match(getTranscript(store, "a".repeat(64), 0).error ?? "", /no longer in the store/);
});

test("a store that did not open is an error, not an empty list", () => {
  assert.match(listSessions(null, {}).error ?? "", /not open/);
  assert.match(getTranscript(null, "a".repeat(64), 0).error ?? "", /not open/);
});

test("a store that fails a read is an error value, not a throw", () => {
  const broken = { listSessionSummaries: () => { throw new Error("database is not open"); }, getConversationPage: () => { throw new Error("disk I/O error"); } };
  assert.match(listSessions(broken as never, {}).error ?? "", /could not be read: database is not open/);
  assert.match(getTranscript(broken as never, "a".repeat(64), 0).error ?? "", /could not be read: disk I\/O error/);
});

test("a message whose content is not text shows as empty, not as a failure", () => {
  const odd = { listSessionSummaries: () => ({ rows: [], total: 0 }), getConversationPage: () => ({ total: 1, messages: [{ role: "user", content: { text: "x" }, timestamp: null, model: null, inputTokens: null, outputTokens: null, isSubAgent: false }] }) };
  const t = getTranscript(odd as never, "a".repeat(64), 0);
  assert.equal(t.error, null);
  assert.equal(t.messages[0]!.content, "");
});
