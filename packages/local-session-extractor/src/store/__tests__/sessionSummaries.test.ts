// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The two list-view reads: `listSessionSummaries` and `getConversationPage`.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type SessionStore } from "../SessionStore";
import { conversationId } from "../ids";
import { MIGRATIONS } from "../migrations";
import type { ConversationPrompt, IdeType } from "../../types/session";
import type { SessionSummaryFilter, UpsertParams } from "../../types/store";

const tmp = mkdtempSync(join(tmpdir(), "lse-summaries-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const LOGIN = "jane.doe@example.com";
const ACCOUNT = "acct-5f2a9c";

function row(over: Partial<UpsertParams>): UpsertParams {
  return {
    ideType: "claude-code",
    sessionId: "s",
    conversation: [],
    lastMtimeMs: 1,
    lastSize: 1,
    lastOffset: 0,
    installationMetadata: JSON.stringify({ login_email: LOGIN, account_uuid: ACCOUNT }),
    ...over,
  };
}

const fresh = (): SessionStore => openStore(join(tmp, `${Math.random()}.db`));

function fill(): SessionStore {
  const store = fresh();
  store.upsert(row({
    sessionId: "a",
    lastMtimeMs: 3_000,
    projectPath: "/src/shop",
    sessionMeta: JSON.stringify({ session_title: "Fix the cart total", first_prompt: "ignored", duration_minutes: 7, git_branch: "main", git_branches: ["main", "fix/cart"] }),
    conversation: [
      { role: "user", content: "Why is the total off?", timestamp: "2026-04-03T10:00:00.000Z" },
      { role: "assistant", content: "Floats.", timestamp: "2026-04-03T10:00:06.000Z", metadata: { model: "m-1", inputTokens: 12, outputTokens: 4 } },
      { role: "assistant", content: "Done.", timestamp: "2026-04-03T10:03:00.000Z", metadata: { model: "m-2", isSubAgent: true } },
      { role: "assistant", content: "Again.", timestamp: "2026-04-03T10:02:00.000Z", metadata: { model: "m-1" } },
    ],
  }));
  store.upsert(row({
    ideType: "codex",
    sessionId: "b",
    lastMtimeMs: 2_000,
    projectPath: "/src/api",
    sessionMeta: JSON.stringify({ first_prompt: "Add 100% coverage" }),
    conversation: [
      { role: "user", content: "Add 100% coverage", timestamp: "2026-04-02T09:00:00.000Z" },
      { role: "assistant", content: "Added.", timestamp: "2026-04-02T09:30:00.000Z" },
    ],
  }));
  // No title in session_meta: the first message stands in.
  store.upsert(row({ sessionId: "c", conversation: [{ role: "user", content: "Rename the module" }] }));
  // A delegated child is not a session of its own.
  store.upsert(row({
    sessionId: "child",
    sessionMeta: JSON.stringify({ lineage: { relation_type: "SUBAGENT", parent_record_key: "x" } }),
    conversation: [{ role: "user", content: "sub" }],
  }));
  // The row written last is the least recently active: the order is the sessions' own.
  store.raw().prepare("UPDATE conversations SET updated_at = datetime('now', '+1 hour') WHERE session_id = 'c'").run();
  return store;
}

/** Every row, page by page through the cursor. */
function all(store: SessionStore, filter: SessionSummaryFilter, between?: () => void): string[] {
  const out: string[] = [];
  let after: SessionSummaryFilter["after"];
  for (let pages = 0; ; pages++) {
    const { rows } = store.listSessionSummaries({ ...filter, ...(after ? { after } : {}) });
    if (rows.length === 0) return out;
    if (pages > 100) throw new Error(`paging never ends: ${out.slice(0, 8).join(",")}`);
    out.push(...rows.map((r) => r.sessionId));
    after = rows.at(-1)!;
    between?.();
    between = undefined;
  }
}

describe("listSessionSummaries", () => {
  it("lists primary sessions, most recently active first, with titles, counts, models and times", () => {
    const store = fill();
    try {
      const { rows, total } = store.listSessionSummaries();
      assert.equal(total, 3);
      assert.deepEqual(rows.map((r) => r.sessionId), ["a", "b", "c"]);
      assert.deepEqual(rows[0], {
        id: conversationId("claude-code", "a"),
        ideType: "claude-code",
        sessionId: "a",
        lastActivityMs: Date.parse("2026-04-03T10:03:00.000Z"),
        lastActivityAt: "2026-04-03T10:03:00.000Z",
        projectPath: "/src/shop",
        repoName: null,
        branch: "fix/cart",
        title: "Fix the cart total",
        startedAt: "2026-04-03T10:00:00.000Z",
        durationMinutes: 7,
        userMessages: 1,
        assistantMessages: 3,
        models: ["m-1", "m-2"],
      }, "a model on two messages is listed once");
      assert.equal(rows[1]!.title, "Add 100% coverage");
      assert.equal(rows[1]!.durationMinutes, 30, "the span between timestamps when session_meta has none");
      assert.equal(rows[2]!.title, "Rename the module");
      assert.deepEqual([rows[2]!.startedAt, rows[2]!.durationMinutes, rows[2]!.models, rows[2]!.branch], [null, null, [], null]);
      assert.deepEqual([rows[2]!.lastActivityMs, rows[2]!.lastActivityAt], [1, "1970-01-01T00:00:00.001Z"], "no timestamps: the source's own last change");
    } finally {
      store.close();
    }
  });

  it("filters by tool, project and text, with the total of every match", () => {
    const store = fill();
    try {
      const ids = (f: SessionSummaryFilter) => store.listSessionSummaries(f).rows.map((r) => r.sessionId);
      assert.deepEqual(ids({ ideType: "codex" }), ["b"]);
      assert.deepEqual(ids({ projectPath: "/src/shop" }), ["a"]);
      assert.deepEqual(ids({ query: "CART" }), ["a"]);
      assert.deepEqual(ids({ query: "% c" }), ["b"], "% matches itself, not any text");
      assert.deepEqual(ids({ query: "_" }), [], "_ matches itself, not any character");
      assert.deepEqual(ids({ query: "rename" }), ["c"], "the first message, shown as the title, is searched too");
      assert.equal(store.listSessionSummaries({ limit: 1 }).total, 3);
      for (const bad of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }]) {
        assert.throws(() => store.listSessionSummaries(bad), /limit must be an integer from 1 to 200/);
      }
      assert.throws(() => store.listSessionSummaries({ query: "a".repeat(201) }), /query must be at most 200 characters/);
      assert.deepEqual(ids({ query: "a".repeat(200) }), []);
    } finally {
      store.close();
    }
  });

  it("lists one tool's sessions with no folder, and each folder's total is the count countByIdeAndProject gives it", () => {
    const store = fill();
    try {
      store.upsert(row({ ideType: "codex", sessionId: "loose", conversation: [{ role: "user", content: "x" }] }));
      store.upsert(row({ ideType: "codex", sessionId: "loose-child", sessionMeta: JSON.stringify({ lineage: { relation_type: "SUBAGENT" } }) }));
      const ids = (f: SessionSummaryFilter) => store.listSessionSummaries(f).rows.map((r) => r.sessionId).sort();
      assert.deepEqual(ids({ projectPath: null }), ["c", "loose"]);
      assert.deepEqual(ids({ ideType: "codex", projectPath: null }), ["loose"], "a child run is not a session of its own");
      const rows = store.countByIdeAndProject();
      assert.ok(rows.some((r) => r.project_path === null), "the fixture has a no-folder row");
      for (const r of rows) {
        const total = store.listSessionSummaries({ ideType: r.ide_type as IdeType, projectPath: r.project_path }).total;
        assert.equal(total, r.count, `${r.ide_type} ${r.project_path}`);
      }
    } finally {
      store.close();
    }
  });

  it("matches text without regard to ASCII case only", () => {
    const store = fresh();
    try {
      store.upsert(row({ sessionId: "fr", sessionMeta: JSON.stringify({ session_title: "Résumé de l'école" }) }));
      assert.equal(store.listSessionSummaries({ query: "DE L'" }).total, 1);
      assert.equal(store.listSessionSummaries({ query: "ÉCOLE" }).total, 0);
    } finally {
      store.close();
    }
  });

  it("cuts a title at 200 characters", () => {
    const store = fresh();
    try {
      store.upsert(row({ sessionMeta: JSON.stringify({ session_title: "t".repeat(201) }) }));
      assert.equal(store.listSessionSummaries().rows[0]!.title, "t".repeat(200));
    } finally {
      store.close();
    }
  });

  it("orders sessions changed at the same time by id", () => {
    const store = fresh();
    try {
      for (const id of ["p", "q", "r", "s"]) store.upsert(row({ sessionId: id, lastMtimeMs: 50 }));
      const byId = ["p", "q", "r", "s"].sort((x, y) => (conversationId("claude-code", x) < conversationId("claude-code", y) ? -1 : 1));
      assert.deepEqual(store.listSessionSummaries().rows.map((r) => r.sessionId), byId);
      assert.deepEqual(all(store, { limit: 2 }), byId, "across a page boundary too");
    } finally {
      store.close();
    }
  });

  it("pages after the last row: a row added or moved between pages is not shown twice, and no other row is skipped", () => {
    const store = fresh();
    try {
      for (const id of ["e1", "e2", "e3", "e4"]) store.upsert(row({ ideType: "codex", sessionId: id, lastMtimeMs: 50 }));
      const before = all(store, { limit: 2 });
      const added = all(store, { limit: 2 }, () => store.upsert(row({ ideType: "codex", sessionId: "new", lastMtimeMs: 60 })));
      assert.deepEqual(added, before, "a newer row lands above the pages already read");
      const now = all(store, { limit: 2 });
      const target = now[4]!;
      const moved = all(store, { limit: 2 }, () => store.upsert(row({ ideType: "codex", sessionId: target, lastMtimeMs: 70 })));
      assert.deepEqual(moved, now.slice(0, 4), "a moved row goes above, and the rows below it all still come");
      assert.equal(new Set(moved).size, moved.length);
      assert.throws(() => store.listSessionSummaries({ after: { lastActivityMs: Number.NaN, id: "x" } }), /after must hold/);
    } finally {
      store.close();
    }
  });

  it("reads the total and the page in one transaction", () => {
    const store = fill();
    try {
      const handle = store.raw();
      const seen: boolean[] = [];
      const prepare = handle.prepare.bind(handle);
      handle.prepare = ((sql: string) => {
        seen.push(handle.isTransaction);
        return prepare(sql);
      }) as typeof handle.prepare;
      store.listSessionSummaries();
      handle.prepare = prepare;
      assert.deepEqual(seen, [true, true]);
      assert.equal(handle.isTransaction, false, "and ends it");
    } finally {
      store.close();
    }
  });

  it("orders by each session's last message, not by when its file last changed", () => {
    const store = fresh();
    try {
      const msg = (at: string): ConversationPrompt[] => [{ role: "user", content: "x", timestamp: at }];
      // A file copied or touched today: its mtime is new, its messages are not.
      store.upsert(row({ sessionId: "touched", lastMtimeMs: Date.parse("2026-10-07T00:00:00Z"), conversation: msg("2026-01-01T00:00:00Z") }));
      store.upsert(row({ sessionId: "recent", lastMtimeMs: Date.parse("2026-03-01T00:00:00Z"), conversation: msg("2026-03-01T00:00:00Z") }));
      store.upsert(row({ sessionId: "undated", lastMtimeMs: Date.parse("2026-02-01T00:00:00Z"), conversation: [{ role: "user", content: "x" }] }));
      assert.deepEqual(store.listSessionSummaries().rows.map((r) => r.sessionId), ["recent", "undated", "touched"]);
      assert.deepEqual(all(store, { limit: 1 }), ["recent", "undated", "touched"], "one row a page: each page picks by last activity too");
      assert.equal(store.listSessionSummaries().rows[2]!.lastActivityAt, "2026-01-01T00:00:00.000Z");
    } finally {
      store.close();
    }
  });

  it("pages in the order of an index, with no sort of its own", () => {
    const store = fill();
    try {
      const plan = (store.raw().prepare(
        "EXPLAIN QUERY PLAN SELECT id, last_message_ms FROM conversations WHERE relation_type NOT IN ('SUBAGENT', 'PLUGIN', 'HOOK') ORDER BY last_message_ms DESC, id ASC LIMIT 50",
      ).all() as { detail: string }[]).map((r) => r.detail).join("\n");
      assert.match(plan, /idx_conversations_last_message/);
      assert.doesNotMatch(plan, /TEMP B-TREE/);
    } finally {
      store.close();
    }
  });

  it("fills the last-activity time of rows stored before the column existed", () => {
    const store = fresh();
    try {
      store.upsert(row({ sessionId: "old", lastMtimeMs: 5, conversation: [{ role: "user", content: "x", timestamp: "2026-04-01T10:00:00.250Z" }] }));
      store.upsert(row({ sessionId: "bare", lastMtimeMs: 7 }));
      store.upsert(row({ sessionId: "broken", lastMtimeMs: 9 }));
      store.raw().prepare("UPDATE conversations SET conversation = 'not json' WHERE session_id = 'broken'").run();
      store.raw().exec("DROP INDEX idx_conversations_last_message; ALTER TABLE conversations DROP COLUMN last_message_ms;");
      store.raw().exec(MIGRATIONS.at(-1)!);
      const at = (id: string) => (store.raw().prepare("SELECT last_message_ms AS v FROM conversations WHERE session_id = ?").get(id) as { v: number }).v;
      assert.deepEqual([at("old"), at("bare"), at("broken")], [Date.parse("2026-04-01T10:00:00.250Z"), 7, 9]);
    } finally {
      store.close();
    }
  });

  it("gives every page the total of the whole list", () => {
    const store = fill();
    try {
      const first = store.listSessionSummaries({ limit: 1 });
      const second = store.listSessionSummaries({ limit: 1, after: first.rows[0]! });
      assert.deepEqual([first.total, second.total, second.rows.length], [3, 3, 1]);
    } finally {
      store.close();
    }
  });

  it("lists a row whose conversation does not parse, or holds no text, without failing the page", () => {
    const store = fill();
    try {
      store.upsert(row({ sessionId: "bad", lastMtimeMs: 9_000, conversation: [{ role: "user", content: { text: "an object" } } as unknown as ConversationPrompt] }));
      store.upsert(row({ sessionId: "obj", lastMtimeMs: 8_000 }));
      store.upsert(row({ sessionId: "junk", lastMtimeMs: 7_000 }));
      store.raw().prepare("UPDATE conversations SET conversation = '{\"role\":\"user\"}' WHERE session_id = 'obj'").run();
      store.raw().prepare("UPDATE conversations SET conversation = 'not json', session_meta = 'not json' WHERE session_id = 'junk'").run();
      const { rows, total } = store.listSessionSummaries();
      assert.equal(total, 6);
      const by = new Map(rows.map((r) => [r.sessionId, r]));
      assert.equal(by.get("bad")!.title, null, "a non-text first message is no title");
      assert.equal(by.get("bad")!.userMessages, 1);
      for (const id of ["obj", "junk"]) assert.deepEqual([by.get(id)!.userMessages, by.get(id)!.assistantMessages], [0, 0], id);
      assert.equal(store.getConversationPage(by.get("bad")!.id)!.messages[0]!.content, "");
      for (const id of ["obj", "junk"]) assert.throws(() => store.getConversationPage(by.get(id)!.id), /not a JSON array/, id);
      assert.deepEqual(store.listSessionSummaries({ query: "Fix" }).rows.map((r) => r.sessionId), ["a"], "a search skips session_meta that does not parse");
    } finally {
      store.close();
    }
  });
});

describe("getConversationPage", () => {
  it("pages a 5,000-message conversation in order", () => {
    const store = fresh();
    try {
      const conversation: ConversationPrompt[] = Array.from({ length: 5000 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `m-${i}`,
      }));
      store.upsert(row({ sessionId: "long", conversation }));
      const id = conversationId("claude-code", "long");
      const last = store.getConversationPage(id, { offset: 4950 })!;
      assert.equal(last.total, 5000);
      assert.equal(last.messages.length, 50);
      assert.deepEqual([last.messages[0]!.content, last.messages.at(-1)!.content], ["m-4950", "m-4999"]);
      assert.deepEqual(store.getConversationPage(id, { limit: 2 })!.messages.map((m) => m.content), ["m-0", "m-1"]);
      assert.equal(store.getConversationPage(id, { offset: 5000 })!.messages.length, 0);
      assert.equal(store.getConversationPage("absent"), null);
      assert.throws(() => store.getConversationPage(id, { limit: 1001 }), /limit must be an integer from 1 to 1000/);
    } finally {
      store.close();
    }
  });

  it("reads one tool's session, not another tool's with the same session id", () => {
    const store = fresh();
    try {
      store.upsert(row({ ideType: "codex", sessionId: "same", conversation: [{ role: "user", content: "codex text" }] }));
      store.upsert(row({ ideType: "kiro", sessionId: "same", conversation: [{ role: "user", content: "kiro text" }, { role: "assistant", content: "ok" }] }));
      const page = (ide: "codex" | "kiro") => store.getConversationPage(conversationId(ide, "same"))!;
      assert.deepEqual([page("codex").total, page("codex").messages.map((m) => m.content)], [1, ["codex text"]]);
      assert.deepEqual([page("kiro").total, page("kiro").messages.map((m) => m.content)], [2, ["kiro text", "ok"]]);
    } finally {
      store.close();
    }
  });

  it("leaves out a message whose role is neither user nor assistant, in the page and in the counts", () => {
    const store = fresh();
    try {
      store.upsert(row({ sessionId: "roles", conversation: [
        { role: "user", content: "one" },
        { role: "system", content: "hidden" } as unknown as ConversationPrompt,
        { role: "assistant", content: "two" },
      ] }));
      const summary = store.listSessionSummaries().rows[0]!;
      const page = store.getConversationPage(summary.id)!;
      assert.deepEqual(page.messages.map((m) => m.content), ["one", "two"]);
      assert.equal(page.total, summary.userMessages + summary.assistantMessages);
      assert.equal(page.total, 2);
    } finally {
      store.close();
    }
  });

  it("returns each message's role, text, time, model, tokens and sub-agent mark", () => {
    const store = fill();
    try {
      const page = store.getConversationPage(conversationId("claude-code", "a"))!;
      assert.deepEqual(page.messages[1], {
        role: "assistant", content: "Floats.", timestamp: "2026-04-03T10:00:06.000Z", model: "m-1", inputTokens: 12, outputTokens: 4, isSubAgent: false,
      });
      assert.equal(page.messages[2]!.isSubAgent, true);
      assert.equal(page.messages[0]!.model, null);
    } finally {
      store.close();
    }
  });
});

it("neither read returns installation metadata", () => {
  const store = fill();
  try {
    const out = JSON.stringify([store.listSessionSummaries(), store.getConversationPage(conversationId("claude-code", "a"))]);
    for (const secret of [LOGIN, ACCOUNT, "login_email", "installation"]) assert.ok(!out.includes(secret), secret);
  } finally {
    store.close();
  }
});
