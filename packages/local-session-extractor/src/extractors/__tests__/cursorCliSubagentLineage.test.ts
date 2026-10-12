// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Cursor CLI Task-spawned children live as sibling store.db dirs with
 * subagentInfo in the hex meta row and NO meta.json. Field names (typeName,
 * parentAgentId, toolCallId) are Cursor's, grounded against live ~/.cursor/chats
 * stores — not invented to match the reader.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../store/SessionStore";
import { conversationId } from "../../internal";
import { extractCursorCli, parentAgentIdFromCliSubagentInfo } from "../../internal";
import { DatabaseSync } from "node:sqlite";
import { setPathOverrides } from "../pathResolver";


const PARENT_ID = "ad4a4379-parent-aaaa-bbbb-cccccccccccc";
const CHILD_ID = "c73ab60d-child-bbbb-cccc-dddddddddddd";
const CHILD_2 = "ffa52d83-child-cccc-dddd-eeeeeeeeeeee";

function hexMeta(obj: object): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("hex");
}

function seedStore(
  dir: string,
  opts: {
    agentId: string;
    query: string;
    subagentInfo?: {
      parentAgentId: string;
      rootParentAgentId?: string;
      toolCallId?: string;
      typeName?: string;
    };
    sidecar?: { cwd: string; title?: string; hasConversation?: boolean };
  },
): void {
  mkdirSync(dir, { recursive: true });
  if (opts.sidecar) {
    writeFileSync(
      join(dir, "meta.json"),
      JSON.stringify({
        hasConversation: opts.sidecar.hasConversation !== false,
        createdAtMs: Date.now() - 120_000,
        updatedAtMs: Date.now() - 60_000,
        cwd: opts.sidecar.cwd,
        title: opts.sidecar.title,
      }),
    );
  }
  const raw = new DatabaseSync(join(dir, "store.db"));
  raw.exec("CREATE TABLE IF NOT EXISTS blobs (id INTEGER PRIMARY KEY, data TEXT)");
  raw.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)");
  raw
    .prepare("INSERT INTO blobs (data) VALUES (?)")
    .run(
      JSON.stringify({
        role: "user",
        content: [{ type: "text", text: `<user_query>${opts.query}</user_query>` }],
      }),
    );
  const meta: Record<string, unknown> = {
    agentId: opts.agentId,
    name: opts.subagentInfo ? "New Agent" : "Parent",
    mode: "default",
    createdAt: Date.now() - 120_000,
  };
  if (opts.subagentInfo) meta.subagentInfo = opts.subagentInfo;
  raw.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(hexMeta(meta));
  raw.close();
}

function lineageOf(db: SessionStore, sessionId: string) {
  const row = db
    .raw()
    .prepare(
      "SELECT session_meta, relation_type FROM conversations WHERE ide_type = 'cursor' AND session_id = ?",
    )
    .get(sessionId) as { session_meta: string | null; relation_type: string } | undefined;
  if (!row) return undefined;
  const meta = row.session_meta
    ? (JSON.parse(row.session_meta) as {
        lineage?: {
          relation_type?: string;
          parent_record_key?: string;
          linkage_confidence?: string;
          tokens?: number;
          origin_agent_type?: string;
          tool_use_id?: string;
        };
      })
    : {};
  return { relation_type: row.relation_type, lineage: meta.lineage };
}

describe("cursorCliExtractor — CLI subagent lineage", () => {
  let tmpDir: string;

  afterEach(() => {
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: undefined });
    setPathOverrides({ CURSOR_CLI_CONFIG_PATH: undefined });
    setPathOverrides({ CURSOR_STATSIG_CACHE_PATH: undefined });
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  function setupChats(): { chats: string; cwd: string } {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-cli-subagent-"));
    const chats = join(tmpDir, "chats");
    const cwd = join(tmpDir, "repo");
    mkdirSync(cwd, { recursive: true });
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: chats });
    setPathOverrides({ CURSOR_CLI_CONFIG_PATH: join(tmpDir, "no-cli-config.json") });
    setPathOverrides({ CURSOR_STATSIG_CACHE_PATH: join(tmpDir, "no-statsig-cache.json") });
    return { chats, cwd };
  }

  it("returns the parent agent id from a child's subagentInfo", () => {
    assert.equal(
      parentAgentIdFromCliSubagentInfo({
        agentId: CHILD_ID,
        subagentInfo: { parentAgentId: PARENT_ID },
      }),
      PARENT_ID,
    );
    assert.equal(
      parentAgentIdFromCliSubagentInfo({ agentId: CHILD_ID }),
      undefined,
    );
    assert.equal(
      parentAgentIdFromCliSubagentInfo({
        agentId: CHILD_ID,
        subagentInfo: { parentAgentId: "" },
      }),
      undefined,
    );
    assert.equal(
      parentAgentIdFromCliSubagentInfo({
        agentId: CHILD_ID,
        subagentInfo: { parentAgentId: CHILD_ID },
      }),
      undefined,
    );
    assert.equal(
      parentAgentIdFromCliSubagentInfo({
        agentId: CHILD_ID,
        subagentInfo: { parentAgentId: "../etc" },
      }),
      undefined,
    );
    assert.equal(
      parentAgentIdFromCliSubagentInfo({
        agentId: CHILD_ID,
        subagentInfo: { parentAgentId: "/tmp/x" },
      }),
      undefined,
    );
  });

  it("skips a child store when captureLineage is off (Claude Code CLI policy)", () => {
    const { chats, cwd } = setupChats();
    seedStore(join(chats, "ws", PARENT_ID), {
      agentId: PARENT_ID,
      query: "review this PR",
      sidecar: { cwd, title: "GitHub PR Review" },
    });
    seedStore(join(chats, "ws", CHILD_ID), {
      agentId: CHILD_ID,
      query: "run bugbot",
      subagentInfo: {
        parentAgentId: PARENT_ID,
        rootParentAgentId: PARENT_ID,
        toolCallId: "tool_abc",
        typeName: "bugbot",
      },
    });

    const db = new SessionStore(join(tmpDir, "local.db"));
    assert.equal(extractCursorCli(db), 1, "only the parent is ingested with the flag off");
    assert.ok(lineageOf(db, PARENT_ID));
    assert.equal(lineageOf(db, CHILD_ID), undefined);
  });

  it("extracts the child as SUBAGENT folded onto the parent when captureLineage is on", () => {
    const { chats, cwd } = setupChats();
    seedStore(join(chats, "ws", PARENT_ID), {
      agentId: PARENT_ID,
      query: "review this PR",
      sidecar: { cwd, title: "GitHub PR Review" },
    });
    seedStore(join(chats, "ws", CHILD_ID), {
      agentId: CHILD_ID,
      query: "run bugbot",
      subagentInfo: {
        parentAgentId: PARENT_ID,
        rootParentAgentId: PARENT_ID,
        toolCallId: "tool_abc",
        typeName: "bugbot",
      },
    });

    const db = new SessionStore(join(tmpDir, "local.db"));
    assert.equal(extractCursorCli(db, new Set(), { captureLineage: true }), 2);

    const parent = lineageOf(db, PARENT_ID);
    assert.equal(parent?.relation_type, "PRIMARY");
    assert.equal(parent?.lineage, undefined);

    const child = lineageOf(db, CHILD_ID);
    assert.equal(child?.relation_type, "SUBAGENT");
    assert.equal(child?.lineage?.relation_type, "SUBAGENT");
    assert.equal(child?.lineage?.parent_record_key, conversationId("cursor", PARENT_ID));
    assert.equal(child?.lineage?.linkage_confidence, "STRONG");
    assert.equal(child?.lineage?.origin_agent_type, "bugbot");
    assert.equal(child?.lineage?.tool_use_id, "tool_abc");
    // CLI store has no output tokens and this fixture has no field-5 input
    // totals, so the fold weight is omitted (0 is not written). Consumer
    // A consumer recomputes the child's cost from the stored transcript.
    assert.equal(child?.lineage?.tokens, undefined);
  });

  it("tags every child of one parent, not as extra primaries", () => {
    const { chats, cwd } = setupChats();
    seedStore(join(chats, "ws", PARENT_ID), {
      agentId: PARENT_ID,
      query: "review this PR",
      sidecar: { cwd, title: "GitHub PR Review" },
    });
    seedStore(join(chats, "ws", CHILD_ID), {
      agentId: CHILD_ID,
      query: "run bugbot",
      subagentInfo: {
        parentAgentId: PARENT_ID,
        toolCallId: "tool_1",
        typeName: "bugbot",
      },
    });
    seedStore(join(chats, "ws", CHILD_2), {
      agentId: CHILD_2,
      query: "run security-review",
      subagentInfo: {
        parentAgentId: PARENT_ID,
        toolCallId: "tool_2",
        typeName: "security-review",
      },
    });

    const db = new SessionStore(join(tmpDir, "local.db"));
    assert.equal(extractCursorCli(db, new Set(), { captureLineage: true }), 3);

    const parentKey = conversationId("cursor", PARENT_ID);
    for (const id of [CHILD_ID, CHILD_2]) {
      const child = lineageOf(db, id);
      assert.equal(child?.relation_type, "SUBAGENT");
      assert.equal(child?.lineage?.parent_record_key, parentKey);
    }
    assert.equal(lineageOf(db, CHILD_ID)?.lineage?.origin_agent_type, "bugbot");
    assert.equal(lineageOf(db, CHILD_2)?.lineage?.origin_agent_type, "security-review");
  });

  it("still skips a store.db with no sidecar and no subagentInfo when captureLineage is on", () => {
    const { chats, cwd } = setupChats();
    seedStore(join(chats, "ws", PARENT_ID), {
      agentId: PARENT_ID,
      query: "hello",
      sidecar: { cwd },
    });
    // Abandoned/incomplete dir: store.db exists, no sidecar, no subagentInfo.
    seedStore(join(chats, "ws", "orphan-dir"), {
      agentId: "orphan-dir",
      query: "should not ingest",
    });

    const db = new SessionStore(join(tmpDir, "local.db"));
    assert.equal(extractCursorCli(db, new Set(), { captureLineage: true }), 1);
    assert.equal(lineageOf(db, "orphan-dir"), undefined);
  });

  it("stamps a child that sorted before its parent in the same cycle", () => {
    const { chats, cwd } = setupChats();
    // readdir typically hits "00…" before "zz…"; sidecar-first sort processes
    // the parent before the child so the upsert is already SUBAGENT.
    const parentId = "zzparent-aaaa-bbbb-cccccccccccc";
    const childId = "00child-bbbb-cccc-dddddddddddd";
    seedStore(join(chats, "ws", parentId), {
      agentId: parentId,
      query: "review this PR",
      sidecar: { cwd, title: "GitHub PR Review" },
    });
    seedStore(join(chats, "ws", childId), {
      agentId: childId,
      query: "run bugbot",
      subagentInfo: {
        parentAgentId: parentId,
        toolCallId: "tool_early",
        typeName: "bugbot",
      },
    });

    const db = new SessionStore(join(tmpDir, "local.db"));
    assert.equal(extractCursorCli(db, new Set(), { captureLineage: true }), 2);
    const child = lineageOf(db, childId);
    assert.equal(child?.relation_type, "SUBAGENT");
    assert.equal(child?.lineage?.parent_record_key, conversationId("cursor", parentId));
    assert.equal(child?.lineage?.origin_agent_type, "bugbot");
  });

  it("does not ingest the child when the parent was not persisted", () => {
    const { chats, cwd } = setupChats();
    seedStore(join(chats, "ws", PARENT_ID), {
      agentId: PARENT_ID,
      query: "should skip",
      sidecar: { cwd, hasConversation: false },
    });
    seedStore(join(chats, "ws", CHILD_ID), {
      agentId: CHILD_ID,
      query: "run bugbot",
      subagentInfo: { parentAgentId: PARENT_ID, typeName: "bugbot" },
    });

    const db = new SessionStore(join(tmpDir, "local.db"));
    assert.equal(extractCursorCli(db, new Set(), { captureLineage: true }), 0);
    assert.equal(lineageOf(db, CHILD_ID), undefined);
  });

  it("extracts a child with a stub sidecar as SUBAGENT when captureLineage is on", () => {
    const { chats, cwd } = setupChats();
    seedStore(join(chats, "ws", PARENT_ID), {
      agentId: PARENT_ID,
      query: "review this PR",
      sidecar: { cwd, title: "GitHub PR Review" },
    });
    seedStore(join(chats, "ws", CHILD_ID), {
      agentId: CHILD_ID,
      query: "run bugbot",
      sidecar: { cwd, hasConversation: false },
      subagentInfo: {
        parentAgentId: PARENT_ID,
        toolCallId: "tool_stub",
        typeName: "bugbot",
      },
    });

    const db = new SessionStore(join(tmpDir, "local.db"));
    assert.equal(extractCursorCli(db, new Set(), { captureLineage: true }), 2);
    const child = lineageOf(db, CHILD_ID);
    assert.equal(child?.relation_type, "SUBAGENT");
    assert.equal(child?.lineage?.parent_record_key, conversationId("cursor", PARENT_ID));
  });

  it("retries a child on a later cycle once the parent row exists", () => {
    const { chats, cwd } = setupChats();
    seedStore(join(chats, "ws", CHILD_ID), {
      agentId: CHILD_ID,
      query: "run bugbot",
      subagentInfo: { parentAgentId: PARENT_ID, typeName: "bugbot" },
    });
    const db = new SessionStore(join(tmpDir, "local.db"));
    assert.equal(extractCursorCli(db, new Set(), { captureLineage: true }), 0);
    seedStore(join(chats, "ws", PARENT_ID), {
      agentId: PARENT_ID,
      query: "review this PR",
      sidecar: { cwd, title: "GitHub PR Review" },
    });
    assert.equal(extractCursorCli(db, new Set(), { captureLineage: true }), 2);
    const child = lineageOf(db, CHILD_ID);
    assert.equal(child?.relation_type, "SUBAGENT");
    assert.equal(child?.lineage?.parent_record_key, conversationId("cursor", PARENT_ID));
  });

  it("ingests a parent after meta.json flips hasConversation without a store.db write", () => {
    const { chats, cwd } = setupChats();
    const parentDir = join(chats, "ws", PARENT_ID);
    seedStore(parentDir, {
      agentId: PARENT_ID,
      query: "review this PR",
      sidecar: { cwd, hasConversation: false },
    });
    const db = new SessionStore(join(tmpDir, "local.db"));
    assert.equal(extractCursorCli(db, new Set(), { captureLineage: true }), 0);
    writeFileSync(
      join(parentDir, "meta.json"),
      JSON.stringify({
        hasConversation: true,
        createdAtMs: Date.now() - 120_000,
        updatedAtMs: Date.now(),
        cwd,
        title: "GitHub PR Review",
      }),
    );
    assert.equal(extractCursorCli(db, new Set(), { captureLineage: true }), 1);
    assert.ok(lineageOf(db, PARENT_ID));
  });
});
