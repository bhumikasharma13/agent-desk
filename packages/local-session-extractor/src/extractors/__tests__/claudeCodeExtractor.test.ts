// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../../store/SessionStore";
import { conversationId } from "../../internal";
import { extractClaudeCode } from "../../internal";
import { SessionEventBuilder } from "../../internal";
import { redactText } from "../../internal";
import type { SessionLineagePayload } from "../../index";
import { setPathOverrides } from "../pathResolver";
import { userInfo } from "node:os";

// ESM-compatible __dirname
const __dirname = dirname(fileURLToPath(import.meta.url));

const fixturesDir = join(__dirname, "../../../fixtures/extraction", "claude-code");

// ── Fixture mode ─────────────────────────────────────────────────────────────

describe("claudeCodeExtractor — fixture", () => {
  let tmpDir: string;
  let db: SessionStore;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-cc-smoke-"));
    db = new SessionStore(join(tmpDir, "test.db"));
    // Point to the parent dir — the extractor treats subdirectories as project dirs.
    // fixturesDir/ contains project_happy/ (valid JSONL) and project_corrupted/ (bad JSONL).
    setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: fixturesDir });
  });

  after(() => {
    setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("happy path: returns non-negative count", () => {
    const count = extractClaudeCode(db);
    assert.ok(typeof count === "number", "count must be a number");
    assert.ok(count > 0, "fixture has valid JSONL data, count must be > 0");
  });

  it("extracts subagent transcripts with parent lineage", () => {
    extractClaudeCode(db, true); // captureLineage on
    const rows = db.getPendingConversations(200);
    const child = rows.find(
      (r) => r.session_id === "project_happy::abc123def456::agent-testsub01"
    );
    assert.ok(child?.session_meta, "subagent row must exist with session_meta");
    const lin = (JSON.parse(child.session_meta) as { lineage?: SessionLineagePayload }).lineage;
    assert.ok(lin, "subagent must carry lineage");
    assert.equal(lin.relation_type, "SUBAGENT");
    assert.equal(lin.linkage_confidence, "STRONG");
    assert.equal(lin.origin_agent_type, "Explore");
    assert.equal(lin.tool_use_id, "toolu_testsub01");
    // parent_record_key must equal the parent's conversationId (worktree-safe resolve).
    assert.equal(
      lin.parent_record_key,
      conversationId("claude-code", "project_happy::abc123def456")
    );
    assert.equal(lin.tokens, 100, "child tokens = 30 input + 70 output");
  });

  it("signals: a subagent (isSidechain) turn is stamped delegated, not human", () => {
    // The subagent transcript agent-testsub01.jsonl carries isSidechain:true on every
    // record — those turns are the delegated agent's work, not the person's. The autonomy
    // bar reads the event author, so stamping them HUMAN would hide the delegation and let
    // a delegated turn disqualify the parent run's autonomy.
    extractClaudeCode(db, true); // captureLineage on
    const rows = db.getPendingConversations(200);
    const child = rows.find(
      (r) => r.session_id === "project_happy::abc123def456::agent-testsub01"
    );
    assert.ok(child?.session_events, "subagent row must carry session_events");
    const events = JSON.parse(child.session_events) as Array<{
      kind: string;
      prompt_ordinal?: number;
      author?: string;
    }>;
    const userRef = events.find(
      (e) => e.kind === "SESSION_EVENT_KIND_PROMPT_REFERENCE" && e.prompt_ordinal === 1
    );
    assert.equal(
      userRef?.author,
      "SESSION_EVENT_AUTHOR_DELEGATED_AGENT",
      "a subagent's user turn must read as delegated, not human"
    );
  });

  it("authorship end to end: typed HUMAN, isMeta caveat INJECTED, command-with-args HUMAN, assistant unset", () => {
    extractClaudeCode(db);
    const rows = db.getPendingConversations(200);
    type Msg = { role: string; content?: string; metadata?: { authorship?: string } };

    const happy = rows.find((r) => r.session_id === "project_happy::abc123def456");
    assert.ok(happy, "project_happy conversation must exist");
    const happyMsgs = JSON.parse(happy.conversation) as Msg[];
    assert.equal(
      happyMsgs.find((m) => m.role === "user")?.metadata?.authorship,
      "PROMPT_AUTHORSHIP_HUMAN",
      "a typed user prompt must read HUMAN"
    );
    assert.equal(
      happyMsgs.find((m) => m.role === "assistant")?.metadata?.authorship,
      undefined,
      "assistant turns leave authorship unset (UNSPECIFIED)"
    );

    // An isMeta-flagged injected turn (a local-command caveat) reads INJECTED end to end.
    const reminder = rows.find((r) => r.session_id === "project_renamed::reminder888");
    assert.ok(reminder, "reminder conversation must exist");
    const reminderMsgs = JSON.parse(reminder.conversation) as Msg[];
    assert.equal(
      reminderMsgs.find((m) => m.role === "user" && m.content?.includes("<local-command-caveat>"))
        ?.metadata?.authorship,
      "PROMPT_AUTHORSHIP_INJECTED",
      "an isMeta caveat turn must read INJECTED"
    );

    // A slash-command turn whose <command-args> carry user input (a URL) is NOT wholly injected —
    // the args are the person's own prompt, so the turn reads HUMAN, preserving the directive.
    const slash = rows.find((r) => r.session_id === "project_renamed::slashcmd999");
    assert.ok(slash, "slashcmd conversation must exist");
    const slashMsgs = JSON.parse(slash.conversation) as Msg[];
    assert.equal(
      slashMsgs.find((m) => m.role === "user")?.metadata?.authorship,
      "PROMPT_AUTHORSHIP_HUMAN",
      "a command turn carrying user args must read HUMAN, not INJECTED"
    );
  });

  it("happy path: stored conversations have valid schema", () => {
    // Re-run extraction so this test is self-contained and not order-dependent.
    // Extraction is idempotent — already-tracked files are skipped, rows remain in DB.
    extractClaudeCode(db);
    const rows = db.getConversationsSince(0, 1000);
    assert.ok(rows.length > 0, "expected conversations after extraction");
    for (const row of rows) {
      assert.ok(typeof row.ide_type === "string", "ide_type must be string");
      assert.ok(typeof row.conversation === "string", "conversation must be JSON string");
      const messages = JSON.parse(row.conversation) as unknown[];
      assert.ok(Array.isArray(messages), "parsed conversation must be array");
      for (const msg of messages as { role?: unknown; content?: unknown }[]) {
        assert.ok(
          typeof msg.role === "string",
          `message.role must be string, got ${typeof msg.role}`
        );
      }
    }
  });

  it("corrupted JSONL: does not throw", () => {
    // fixturesDir contains project_corrupted/ with malformed JSONL — extractor must not throw.
    // Re-uses the same projects root set in before() which covers both happy and corrupted dirs.
    const corruptedDb = new SessionStore(join(tmpDir, "corrupted.db"));
    assert.doesNotThrow(() => extractClaudeCode(corruptedDb));
  });

  it("signals: per-prompt model is populated on assistant messages", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const row = rows[0]!;
    const messages = JSON.parse(row.conversation) as { role: string; metadata?: { model?: string } }[];
    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    assert.ok(assistantMsgs.length > 0, "expected assistant messages");
    assert.equal(assistantMsgs[0]!.metadata?.model, "claude-sonnet-4-6", "model must be claude-sonnet-4-6");
  });

  it("signals: messageId is populated from message.id on assistant prompts", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const messages = JSON.parse(rows[0]!.conversation) as {
      role: string;
      metadata?: { messageId?: string };
    }[];
    const assistantMsgs = messages.filter((m) => m.role === "assistant");
    assert.ok(assistantMsgs.length > 0, "expected assistant messages");
    // One prompt per JSONL line with message.id stamped faithfully — no desktop
    // dedup here; a consumer that sums tokens dedups by message id.
    const ids = assistantMsgs.map((m) => m.metadata?.messageId);
    assert.ok(
      ids.every((id) => typeof id === "string" && id.length > 0),
      `every assistant prompt must carry messageId, got ${JSON.stringify(ids)}`
    );
    assert.ok(
      ids.includes("msg_resp001") && ids.includes("msg_resp002"),
      `messageId must match fixture message.id values, got ${JSON.stringify(ids)}`
    );
  });

  it("signals: messageId is unset when the line has no message.id", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const messages = JSON.parse(rows[0]!.conversation) as {
      role: string;
      metadata?: { messageId?: string };
    }[];
    // User lines never carry message.id, so their messageId stays undefined
    // (only model is back-filled from neighbours, never messageId).
    const userMsgs = messages.filter((m) => m.role === "user");
    assert.ok(userMsgs.length > 0, "expected user messages");
    assert.ok(
      userMsgs.every((m) => m.metadata?.messageId === undefined),
      "user prompts must not have messageId"
    );
  });

  it("signals: per-prompt input and output tokens are populated", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const messages = JSON.parse(rows[0]!.conversation) as { role: string; metadata?: { inputTokens?: number; outputTokens?: number } }[];
    const asst = messages.find((m) => m.role === "assistant");
    assert.ok(typeof asst?.metadata?.inputTokens === "number" && asst.metadata.inputTokens > 0, "inputTokens must be > 0");
    assert.ok(typeof asst?.metadata?.outputTokens === "number" && asst.metadata.outputTokens > 0, "outputTokens must be > 0");
  });

  it("signals: cache tokens (creation and read) are populated on cache-hit message", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const messages = JSON.parse(rows[0]!.conversation) as {
      role: string;
      metadata?: {
        cacheCreationInputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreation5mInputTokens?: number;
        cacheCreation1hInputTokens?: number;
      };
    }[];
    const asst = messages.filter((m) => m.role === "assistant");
    const cacheMsg = asst.find((m) => (m.metadata?.cacheCreationInputTokens ?? 0) > 0 || (m.metadata?.cacheReadInputTokens ?? 0) > 0);
    assert.ok(cacheMsg !== undefined, "expected a message with cache token metadata");
    assert.equal(cacheMsg!.metadata?.cacheCreationInputTokens, 5, "cacheCreationInputTokens must be 5");
    assert.equal(cacheMsg!.metadata?.cacheReadInputTokens, 3, "cacheReadInputTokens must be 3");
    assert.equal(cacheMsg!.metadata?.cacheCreation5mInputTokens, 2, "cacheCreation5mInputTokens must be 2");
    assert.equal(cacheMsg!.metadata?.cacheCreation1hInputTokens, 3, "cacheCreation1hInputTokens must be 3");
  });

  it("presence: a vendor-reported 0 cache split is emitted, an absent split is omitted", () => {
    // The unset-vs-zero contract behind the `optional` proto fields: a split
    // Anthropic reports as 0 is a measured zero and must survive as 0, distinct
    // from a split it never reported (field omitted). Each row below FAILS if
    // applyUsage reverts to the old `if (cacheCreation5m)` truthiness guard,
    // which collapsed a real 0 back into "absent".
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const messages = JSON.parse(rows[0]!.conversation) as {
      role: string;
      metadata?: {
        messageId?: string;
        cacheCreation5mInputTokens?: number;
        cacheCreation1hInputTokens?: number;
      };
    }[];
    const byId = (id: string) => messages.find((m) => m.metadata?.messageId === id);

    const cases: Array<{ id: string; expected5m: number | undefined; expected1h: number | undefined }> = [
      // msg_resp003's usage.cache_creation is { ephemeral_5m: 0, ephemeral_1h: 4 }:
      // the 5m split was measured and happened to be zero.
      { id: "msg_resp003", expected5m: 0, expected1h: 4 },
      // msg_resp001's usage carries no cache_creation block at all — both splits
      // are genuinely absent and must stay undefined, never fabricated as 0.
      { id: "msg_resp001", expected5m: undefined, expected1h: undefined },
    ];
    for (const c of cases) {
      const msg = byId(c.id);
      assert.ok(msg, `expected assistant message ${c.id}`);
      assert.equal(msg!.metadata?.cacheCreation5mInputTokens, c.expected5m, `${c.id} 5m split`);
      assert.equal(msg!.metadata?.cacheCreation1hInputTokens, c.expected1h, `${c.id} 1h split`);
    }
  });

  it("signals: isImageAdded is true on the image-containing user message", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const messages = JSON.parse(rows[0]!.conversation) as { role: string; metadata?: { isImageAdded?: boolean } }[];
    const imageMsg = messages.filter((m) => m.role === "user").find((m) => m.metadata?.isImageAdded === true);
    assert.ok(imageMsg !== undefined, "expected a user message with isImageAdded=true");
  });

  it("signals: relevantFiles are extracted from tool_use file_path inputs", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const messages = JSON.parse(rows[0]!.conversation) as { role: string; metadata?: { relevantFiles?: string[] } }[];
    const withFiles = messages.find((m) => (m.metadata?.relevantFiles?.length ?? 0) > 0);
    assert.ok(withFiles !== undefined, "expected a message with relevantFiles");
    assert.ok(
      withFiles!.metadata!.relevantFiles!.some((f) => f.includes("src/auth.ts")),
      "relevantFiles must include a path containing src/auth.ts"
    );
  });

  it("signals: session_meta PR fields are extracted from pr-link event", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { pr_url?: string; pr_number?: number; pr_repository?: string };
    // Scalar fields carry the FIRST pr-link for backward compat.
    assert.equal(meta.pr_url, "https://github.com/org/repo/pull/42", "pr_url must match first pr-link");
    assert.equal(meta.pr_number, 42, "pr_number must be 42 (first pr-link)");
    assert.equal(meta.pr_repository, "org/repo", "pr_repository must match");
  });

  it("signals: session_meta pr_references captures every distinct pr-link event", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as {
      pr_references?: Array<{ pr_url: string; pr_number: number; pr_repository: string }>;
    };
    assert.ok(Array.isArray(meta.pr_references), "pr_references must be populated");
    assert.equal(meta.pr_references!.length, 2, "both pr-link events must appear");
    assert.equal(meta.pr_references![0]!.pr_number, 42, "first reference is PR 42");
    assert.equal(meta.pr_references![1]!.pr_number, 43, "second reference is PR 43");
    assert.equal(meta.pr_references![0]!.pr_repository, "org/repo");
    assert.equal(meta.pr_references![1]!.pr_repository, "org/repo");
  });

  it("signals: session_meta source is stamped from the per-session launch entrypoint", () => {
    const rows = db.getPendingConversations(200);
    const happy = rows.find((r) => r.session_id === "project_happy::abc123def456");
    assert.ok(happy?.session_meta, "happy session row must exist with session_meta");
    const meta = JSON.parse(happy.session_meta) as { source?: string };
    // The happy fixture's first line carries entrypoint "cli" — a per-session fact — so the
    // session surface is stamped accurately from it, not from an install-level value.
    assert.equal(meta.source, "cli", "source is the transcript's launch entrypoint");
  });

  it("signals: session_meta approval_mode captures the last permissionMode seen", () => {
    const rows = db.getPendingConversations(200);
    const happy = rows.find((r) => r.session_id === "project_happy::abc123def456");
    assert.ok(happy?.session_meta, "happy session row must exist with session_meta");
    const meta = JSON.parse(happy.session_meta) as { approval_mode?: string };
    // The happy fixture ends with two permission-mode switch events ("default" then "plan").
    // The extractor keeps the LAST non-empty permissionMode, so the session's ending posture
    // ("plan") is what reaches approval_mode — captured verbatim for the engine to normalize.
    assert.equal(meta.approval_mode, "plan", "approval_mode is the last permissionMode seen");
  });

  it("signals: per-turn permission_mode — inline on turn 1, event-line switch reaches turn 2", () => {
    const rows = db.getPendingConversations(200);
    const happy = rows.find((r) => r.session_id === "project_happy::abc123def456");
    assert.ok(happy?.conversation, "happy conversation row must exist");
    const msgs = JSON.parse(happy.conversation) as { role: string; content: string; metadata?: { permission_mode?: string } }[];
    // Turn 1's user line carries permissionMode "default" inline. BETWEEN the turns a standalone
    // `permission-mode` event switches to "bypassPermissions" — turn 2's own user line carries NO
    // permissionMode (the inline value is sparse in real transcripts), so it must pick up the
    // switched value via the extractor's forward-fill. Both shapes are what real Claude Code
    // transcripts use. Assistant turns carry none.
    const first = msgs.find((m) => m.role === "user" && m.content.includes("sort an array"));
    assert.ok(first, "first user turn must exist");
    assert.equal(first.metadata?.permission_mode, "default", "turn 1 carries its inline gate");
    const second = msgs.find((m) => m.role === "user" && m.content.includes("Fix the auth bug"));
    assert.ok(second, "second user turn must exist");
    assert.equal(
      second.metadata?.permission_mode,
      "bypassPermissions",
      "an event-line switch between turns reaches the next user turn (its own line has no mode)",
    );
    assert.ok(
      msgs.every((m) => m.role !== "assistant" || m.metadata?.permission_mode === undefined),
      "assistant turns never carry a permission_mode",
    );
  });

  it("signals: an unrecognized permission-mode switch clears the gate, never forward-fills a stale one", () => {
    // Regression: project_permmode's turn 1 carries permissionMode "plan" inline; BETWEEN the turns a
    // standalone `permission-mode` event switches to an unrecognized value ("chaos-mode", e.g. a
    // vendor-added mode). Turn 2's own line has no mode, so the forward-fill must NOT stamp it with
    // turn 1's "plan" — the mode changed to a value we can't vet, so turn 2 (and the session-ending
    // approval_mode) are left unset.
    const rows = db.getPendingConversations(200);
    const sess = rows.find((r) => r.session_id === "project_permmode::permmode789abc");
    assert.ok(sess?.conversation, "permmode session row must exist");
    const msgs = JSON.parse(sess.conversation) as { role: string; content: string; metadata?: { permission_mode?: string } }[];
    const first = msgs.find((m) => m.role === "user" && m.content.includes("Plan the refactor"));
    assert.ok(first, "first user turn must exist");
    assert.equal(first.metadata?.permission_mode, "plan", "turn 1 carries its inline gate");
    const second = msgs.find((m) => m.role === "user" && m.content.includes("Now apply it"));
    assert.ok(second, "second user turn must exist");
    assert.equal(second.metadata?.permission_mode, undefined, "an unrecognized mode-switch clears the gate, not forward-fill turn 1's");
    const meta = JSON.parse(sess.session_meta!) as { approval_mode?: string };
    assert.equal(meta.approval_mode, undefined, "session-ending approval_mode is unset when the last mode is unrecognized");
  });

  it("signals: session_meta session_title is extracted from ai-title event", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { session_title?: string };
    assert.equal(meta.session_title, "Fix auth bug", "session_title must match");
  });

  it("signals: a user's custom-title rename takes priority over the ai-title", () => {
    const rows = db.getPendingConversations(100);
    const renamed = rows.find((r) => r.session_id === "project_renamed::renamed789");
    assert.ok(renamed?.session_meta, "renamed session row must exist with session_meta");
    const meta = JSON.parse(renamed.session_meta) as { session_title?: string };
    assert.equal(
      meta.session_title,
      "rename-test-title",
      "custom-title (rename) must win over ai-title"
    );
  });

  it("signals: session_meta first_prompt captures the first real user prompt", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { first_prompt?: string };
    assert.equal(
      meta.first_prompt,
      "Write a function to sort an array",
      "first_prompt must be the session's opening user message"
    );
  });

  it("signals: first_prompt renders a slash-command turn as a readable label", () => {
    const rows = db.getPendingConversations(100);
    const slash = rows.find((r) => r.session_id === "project_renamed::slashcmd999");
    assert.ok(slash?.session_meta, "slash-command session row must exist with session_meta");
    const meta = JSON.parse(slash.session_meta) as { first_prompt?: string };
    assert.equal(
      meta.first_prompt,
      "/deploy-app https://github.com/example-org/example-repo/issues/1",
      "a slash-command first prompt must surface '<command> <args>', not the raw markup"
    );
  });

  it("signals: a prompt that only QUOTES the markup is prose, not an invocation", () => {
    // The markup is quoted far more often than it is typed — it rides in tool results,
    // pasted transcripts, and prose about commands like this one. Reading a mention as an
    // invocation would name the session after a command nobody ran and discard the real
    // opening message, and on the usage path it would invent a declaration outright.
    const rows = db.getPendingConversations(100);
    const quoted = rows.find((r) => r.session_id === "project_renamed::cmdquote888");
    assert.ok(quoted?.session_meta, "quoted-markup session row must exist with session_meta");
    const meta = JSON.parse(quoted.session_meta) as { first_prompt?: string };
    assert.match(
      meta.first_prompt ?? "",
      /^The extractor is blind to slash commands\./,
      "a mention must leave the real prompt standing, not collapse it to the quoted name"
    );
    const events = JSON.parse(quoted.session_events ?? "[]") as { operation_name?: string }[];
    assert.ok(
      !events.some((e) => e.operation_name === "loop"),
      `a quoted command name must not become a declaration: ${quoted.session_events}`
    );
  });

  // End-to-end companion to the unit coverage in sessionEvents.test.ts: a command turn
  // reaches the timeline as a typed declaration, not just as prompt text. The fixture
  // stores `message.content` as a plain string because that is what Claude Code writes
  // for a command turn — every such turn on a real machine does.
  it("signals: a slash-command turn becomes a typed declaration event", () => {
    const rows = db.getPendingConversations(100);
    const slash = rows.find((r) => r.session_id === "project_renamed::slashcmd999");
    assert.ok(slash?.session_events, "slash-command session row must carry session_events");
    const events = JSON.parse(slash.session_events) as { kind: string; operation_name?: string }[];
    const declared = events.find((e) => e.operation_name === "deploy-app");
    assert.ok(declared, `no declaration for the command turn: ${slash.session_events}`);
    assert.equal(declared.kind, "SESSION_EVENT_KIND_SKILL_CALL");
  });

  it("signals: first_prompt skips an isMeta injected turn for the real prompt", () => {
    const rows = db.getPendingConversations(100);
    const rem = rows.find((r) => r.session_id === "project_renamed::reminder888");
    assert.ok(rem?.session_meta, "reminder session row must exist with session_meta");
    const meta = JSON.parse(rem.session_meta) as { first_prompt?: string };
    assert.equal(
      meta.first_prompt,
      "Fix the login validation bug",
      "an isMeta:true turn (e.g. a local-command-caveat) must be skipped for the real prompt"
    );
  });

  it("signals: an injected isMeta turn is not stamped as a person", () => {
    // reminder888 opens with a `type:user, isMeta:true` local-command caveat carrying real text,
    // so it lands in prompts[] wearing the user role. The autonomy bar reads the event's author
    // and nothing else, and the stamp is final, so stamping this HUMAN would let
    // a line the person never typed disqualify a run's autonomy with no way to correct it.
    const rows = db.getPendingConversations(100);
    const rem = rows.find((r) => r.session_id === "project_renamed::reminder888");
    assert.ok(rem?.session_events, "reminder session row must carry session_events");
    const events = JSON.parse(rem.session_events) as Array<{
      kind: string;
      prompt_ordinal?: number;
      author?: string;
    }>;
    const refs = events.filter((e) => e.kind === "SESSION_EVENT_KIND_PROMPT_REFERENCE");
    assert.ok(refs.length >= 2, `expected the caveat and the real prompt, got ${refs.length}`);

    const caveat = refs.find((e) => e.prompt_ordinal === 1);
    assert.equal(
      caveat?.author,
      "SESSION_EVENT_AUTHOR_AGENT",
      "the injected local-command caveat must not read as a person"
    );
    // The real prompt right after it IS a person — without this the assertion above would pass
    // against an extractor that stamped every turn AGENT.
    const real = refs.find((e) => e.prompt_ordinal === 2);
    assert.equal(
      real?.author,
      "SESSION_EVENT_AUTHOR_HUMAN",
      "the person's own turn must still read as human"
    );
  });

  it("signals: first_prompt is redacted — a secret never reaches session_meta", () => {
    const rows = db.getPendingConversations(100);
    const sec = rows.find((r) => r.session_id === "project_renamed::secret777");
    assert.ok(sec?.session_meta, "secret session row must exist with session_meta");
    const meta = JSON.parse(sec.session_meta) as { first_prompt?: string };
    assert.ok(meta.first_prompt, "first_prompt must be present");
    assert.ok(
      !meta.first_prompt!.includes("sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"),
      "the raw API key must not appear in first_prompt"
    );
    assert.match(meta.first_prompt!, /████████/, "the secret must be redacted");
  });

  it("signals: session_title and last_prompt are redacted — a secret never reaches session_meta", () => {
    const rows = db.getPendingConversations(100);
    const s = rows.find((r) => r.session_id === "project_renamed::secrets999");
    assert.ok(s?.session_meta, "secrets session row must exist with session_meta");
    const meta = JSON.parse(s.session_meta) as { session_title?: string; last_prompt?: string };
    const KEY = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123";
    assert.ok(meta.session_title && !meta.session_title.includes(KEY), "raw key must not be in session_title");
    assert.match(meta.session_title!, /████████/, "session_title secret must be redacted");
    assert.ok(meta.last_prompt && !meta.last_prompt.includes(KEY), "raw key must not be in last_prompt");
    assert.match(meta.last_prompt!, /████████/, "last_prompt secret must be redacted");
  });

  it("signals: an empty ai-title falls through to no session_title", () => {
    const rows = db.getPendingConversations(100);
    const e = rows.find((r) => r.session_id === "project_renamed::emptyai555");
    assert.ok(e?.session_meta, "empty-ai-title session row must exist with session_meta");
    const meta = JSON.parse(e.session_meta) as { session_title?: string };
    assert.equal(meta.session_title, undefined, "an empty ai-title must not become session_title");
  });

  it("signals: an empty custom-title does not suppress a valid ai-title", () => {
    const rows = db.getPendingConversations(100);
    const blanked = rows.find((r) => r.session_id === "project_renamed::blanked456");
    assert.ok(blanked?.session_meta, "blanked session row must exist with session_meta");
    const meta = JSON.parse(blanked.session_meta) as { session_title?: string };
    // Expected through redactText, not the raw fixture string: session_title is a
    // text-class field, so a developer whose OS username happens to appear in the
    // title ("test") has it pseudonymized and a hardcoded literal fails on their
    // machine only. The claim under test is the fall-through, not redaction.
    assert.equal(
      meta.session_title,
      redactText("Investigate the flaky test"),
      "an empty custom-title must fall through to the ai-title, not blank it out"
    );
  });

  it("signals: session_meta git_branch is extracted from gitBranch field on user message", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { git_branch?: string };
    assert.equal(meta.git_branch, "feat/auth", "git_branch must match");
  });

  it("signals: compaction signals are populated from compact_boundary events", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as {
      compaction_count?: number;
      manual_compaction_count?: number;
      avg_pre_compaction_tokens?: number;
    };
    assert.equal(meta.compaction_count, 1, "compaction_count must be 1");
    assert.equal(meta.manual_compaction_count, 1, "manual_compaction_count must be 1");
    assert.equal(meta.avg_pre_compaction_tokens, 15000, "avg_pre_compaction_tokens must be 15000");
  });

  it("signals: tracked_file_paths are extracted from file-history-snapshot events", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { tracked_file_paths?: string[] };
    assert.ok(Array.isArray(meta.tracked_file_paths), "tracked_file_paths must be array");
    assert.ok(meta.tracked_file_paths!.includes("src/auth.ts"), "must include src/auth.ts");
  });

  it("signals: languages are derived from tracked/relevant files (CC self-reports none)", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { languages?: Record<string, number> };
    assert.ok(meta.languages !== undefined, "languages must be derived");
    assert.ok((meta.languages!["TypeScript"] ?? 0) > 0, "src/auth.ts must map to TypeScript");
  });

  it("signals: last_prompt is extracted from last-prompt event", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { last_prompt?: string };
    assert.equal(meta.last_prompt, "Fix the auth bug", "last_prompt must match");
  });

  it("signals: bridge_session_url is extracted from bridge_status event, its session token masked", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { bridge_session_url?: string };
    assert.equal(meta.bridge_session_url, "https://bridge.example.com/s/████████", "bridge_session_url must match");
  });

  it("signals: user_message_timestamps are derived from JSONL message timestamps", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { user_message_timestamps?: string[] };
    assert.ok(Array.isArray(meta.user_message_timestamps), "user_message_timestamps must be array");
    assert.ok(meta.user_message_timestamps!.length >= 2, "must have at least 2 user timestamps");
    for (const ts of meta.user_message_timestamps!) {
      assert.ok(!isNaN(Date.parse(ts)), `timestamp "${ts}" must be valid ISO 8601`);
    }
    assert.ok(
      meta.user_message_timestamps!.some((ts) => ts.startsWith("2026-04-01")),
      "timestamps must include fixture date 2026-04-01"
    );
  });
});

// ── oauthAccount merge (~/.claude.json) ──────────────────────────────────────

describe("claudeCodeExtractor — oauthAccount merge", () => {
  let tmpDir: string;
  let db: SessionStore;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-cc-oauth-"));
    db = new SessionStore(join(tmpDir, "test.db"));
    const configPath = join(tmpDir, "claude.json");
    writeFileSync(configPath, JSON.stringify({
      accessToken: "secret-must-be-ignored",
      oauthAccount: {
        seatTier: "team_tier_1",
        organizationType: "claude_team",
        userRateLimitTier: "default_claude_max_5x",
        emailAddress: "oauth-authoritative@example.com",
      },
    }));
    setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: fixturesDir });
    setPathOverrides({ CLAUDE_CODE_CONFIG_PATH: configPath });
  });

  after(() => {
    setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: undefined });
    setPathOverrides({ CLAUDE_CODE_CONFIG_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("merges oauth raw fields AND never blanks plan_tier", () => {
    extractClaudeCode(db);
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected extracted rows");
    const withMeta = rows.find((r) => r.installation_metadata);
    assert.ok(withMeta?.installation_metadata, "expected installation_metadata to be set");
    const meta = JSON.parse(withMeta.installation_metadata) as Record<string, unknown>;
    // oauth raw fields are merged onto the session
    assert.equal(meta["seat_tier"], "team_tier_1");
    assert.equal(meta["organization_type"], "claude_team");
    // the authoritative oauthAccount.emailAddress lands in login_email and is
    // special-cased to win over any telemetry-derived email in the merge — the
    // fallback seat key hashes login_email, so the authoritative one must survive.
    assert.equal(meta["login_email"], "oauth-authoritative@example.com");
    // regression guard (review finding): the merge runs AFTER the inferred
    // cascade, so plan_tier stays set (telemetry or model fallback) and is
    // never left empty by adding oauth fields. The token is never surfaced.
    assert.ok(
      typeof meta["plan_tier"] === "string" && (meta["plan_tier"] as string).length > 0,
      `plan_tier must remain non-empty, got ${JSON.stringify(meta["plan_tier"])}`,
    );
    assert.ok(!("accessToken" in meta), "top-level token must never surface");
  });

  it("no ~/.claude.json → existing path unchanged (no oauth fields)", () => {
    setPathOverrides({ CLAUDE_CODE_CONFIG_PATH: join(tmpDir, "missing.json") });
    const db2 = new SessionStore(join(tmpDir, "test2.db"));
    extractClaudeCode(db2);
    const rows = db2.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected extracted rows (else the assertion below is vacuous)");
    // No row may carry oauth fields when ~/.claude.json is absent.
    for (const row of rows) {
      if (!row.installation_metadata) continue;
      const meta = JSON.parse(row.installation_metadata) as Record<string, unknown>;
      assert.ok(!("seat_tier" in meta), "seat_tier must not appear without ~/.claude.json");
    }
  });
});

describe("claudeCodeExtractor — non-interactive (sdk) sessions", () => {
  let tmpDir: string;
  let projectsDir: string;
  let db: SessionStore;

  const writeSession = (sessionId: string, entrypoint: string) => {
    const projDir = join(projectsDir, "-repo-app");
    mkdirSync(projDir, { recursive: true });
    const lines = [
      { type: "user", entrypoint, cwd: "/repo/app", sessionId, uuid: `${sessionId}-u1`, timestamp: "2026-07-13T10:00:00.000Z", message: { role: "user", content: "add an idle-time KPI card" } },
      { type: "assistant", cwd: "/repo/app", sessionId, uuid: `${sessionId}-a1`, timestamp: "2026-07-13T10:00:05.000Z", message: { role: "assistant", content: "on it", usage: { input_tokens: 20, output_tokens: 40 } } },
    ];
    writeFileSync(join(projDir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
  };

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-cc-sdk-"));
    projectsDir = join(tmpDir, "projects");
    mkdirSync(projectsDir, { recursive: true });
    setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: projectsDir });
    db = new SessionStore(join(tmpDir, "test.db"));
    writeSession("sess-sdk-0001", "sdk-cli");
    writeSession("sess-cli-0001", "cli");
    // Started headless (claude -p) then resumed interactively (claude --resume):
    // the transcript carries an sdk-cli turn AND a later cli turn.
    const sid = "sess-resume-0001";
    writeFileSync(join(projectsDir, "-repo-app", `${sid}.jsonl`), [
      { type: "user", entrypoint: "sdk-cli", cwd: "/repo/app", sessionId: sid, uuid: `${sid}-u1`, timestamp: "2026-07-13T10:00:00.000Z", message: { role: "user", content: "kick off the task" } },
      { type: "assistant", cwd: "/repo/app", sessionId: sid, uuid: `${sid}-a1`, timestamp: "2026-07-13T10:00:05.000Z", message: { role: "assistant", content: "done", usage: { input_tokens: 20, output_tokens: 40 } } },
      { type: "user", entrypoint: "cli", cwd: "/repo/app", sessionId: sid, uuid: `${sid}-u2`, timestamp: "2026-07-13T10:05:00.000Z", message: { role: "user", content: "actually let's refine this together" } },
    ].map((l) => JSON.stringify(l)).join("\n"));
    // A hook in the PARENT (cli) session ran `claude -p … --output-format json`;
    // Claude captured the child's json (with its session_id) into the parent's
    // hook_success attachment stdout. The CHILD (sdk-cli) must resolve to this
    // parent via that stdout link — STRONG, not NONE. Uses UUID-shaped ids so the
    // extractor's session_id regex matches.
    const parentUuid = "11111111-1111-1111-1111-111111111111";
    const childUuid = "22222222-2222-2222-2222-222222222222";
    writeFileSync(join(projectsDir, "-repo-app", `${parentUuid}.jsonl`), [
      { type: "user", entrypoint: "cli", cwd: "/repo/app", sessionId: parentUuid, uuid: `${parentUuid}-u1`, timestamp: "2026-07-13T09:00:00.000Z", message: { role: "user", content: "build the thing" } },
      { type: "attachment", sessionId: parentUuid, attachment: { type: "hook_success", hookEvent: "Stop", command: "claude -p 'review' --output-format json", stdout: JSON.stringify({ type: "result", session_id: childUuid, result: "ok" }), stderr: "", exitCode: 0, durationMs: 900 } },
      { type: "assistant", cwd: "/repo/app", sessionId: parentUuid, uuid: `${parentUuid}-a1`, timestamp: "2026-07-13T09:00:05.000Z", message: { role: "assistant", content: "done", usage: { input_tokens: 10, output_tokens: 20 } } },
    ].map((l) => JSON.stringify(l)).join("\n"));
    writeFileSync(join(projectsDir, "-repo-app", `${childUuid}.jsonl`), [
      { type: "user", entrypoint: "sdk-cli", cwd: "/repo/app", sessionId: childUuid, uuid: `${childUuid}-u1`, timestamp: "2026-07-13T09:00:02.000Z", message: { role: "user", content: "review" } },
      { type: "assistant", cwd: "/repo/app", sessionId: childUuid, uuid: `${childUuid}-a1`, timestamp: "2026-07-13T09:00:03.000Z", message: { role: "assistant", content: "ok", usage: { input_tokens: 5, output_tokens: 5 } } },
    ].map((l) => JSON.stringify(l)).join("\n"));
    // A NON-`claude -p` hook whose output merely contains a session_id must NOT
    // create a parent edge (only `claude -p … --output-format json` stdout is the
    // spawned child's result). Here a notify hook echoes a UUID; the "child" it
    // names must stay unlinked (HOOK/NONE), not be mis-attributed to this parent.
    const notifyParentUuid = "33333333-3333-3333-3333-333333333333";
    const notLinkedUuid = "44444444-4444-4444-4444-444444444444";
    writeFileSync(join(projectsDir, "-repo-app", `${notifyParentUuid}.jsonl`), [
      { type: "user", entrypoint: "cli", cwd: "/repo/app", sessionId: notifyParentUuid, uuid: `${notifyParentUuid}-u1`, timestamp: "2026-07-13T08:00:00.000Z", message: { role: "user", content: "do work" } },
      { type: "attachment", sessionId: notifyParentUuid, attachment: { type: "hook_success", hookEvent: "Stop", command: "./notify.sh", stdout: JSON.stringify({ session_id: notLinkedUuid, note: "done" }), stderr: "", exitCode: 0, durationMs: 30 } },
      { type: "assistant", cwd: "/repo/app", sessionId: notifyParentUuid, uuid: `${notifyParentUuid}-a1`, timestamp: "2026-07-13T08:00:05.000Z", message: { role: "assistant", content: "ok", usage: { input_tokens: 10, output_tokens: 20 } } },
    ].map((l) => JSON.stringify(l)).join("\n"));
    writeFileSync(join(projectsDir, "-repo-app", `${notLinkedUuid}.jsonl`), [
      { type: "user", entrypoint: "sdk-cli", cwd: "/repo/app", sessionId: notLinkedUuid, uuid: `${notLinkedUuid}-u1`, timestamp: "2026-07-13T08:00:02.000Z", message: { role: "user", content: "x" } },
      { type: "assistant", cwd: "/repo/app", sessionId: notLinkedUuid, uuid: `${notLinkedUuid}-a1`, timestamp: "2026-07-13T08:00:03.000Z", message: { role: "assistant", content: "y", usage: { input_tokens: 5, output_tokens: 5 } } },
    ].map((l) => JSON.stringify(l)).join("\n"));
    extractClaudeCode(db, true); // captureLineage on
  });

  after(() => {
    setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const lineageOf = (sessionId: string): SessionLineagePayload | undefined => {
    const row = db.getPendingConversations(1000).find((r) => r.session_id.endsWith(sessionId));
    assert.ok(row, `row ${sessionId} must exist`);
    if (!row.session_meta) return undefined;
    return (JSON.parse(row.session_meta) as { lineage?: SessionLineagePayload }).lineage;
  };

  it("tags a headless sdk-cli session as HOOK", () => {
    const lin = lineageOf("sess-sdk-0001");
    assert.ok(lin, "sdk session must carry lineage");
    assert.equal(lin.relation_type, "HOOK");
    assert.equal(lin.linkage_confidence, "NONE");
    assert.equal(lin.tokens, 60, "child tokens = 20 input + 40 output");
  });

  it("leaves an interactive cli session as primary (no lineage)", () => {
    assert.equal(lineageOf("sess-cli-0001"), undefined);
  });

  it("leaves a headless-then-resumed-interactively session as primary (a real human turn is never hidden)", () => {
    assert.equal(lineageOf("sess-resume-0001"), undefined);
  });

  it("links a hook-spawned sdk child to the parent that fired it (HOOK/STRONG via hook stdout session_id)", () => {
    const lin = lineageOf("22222222-2222-2222-2222-222222222222");
    assert.ok(lin, "child must carry lineage");
    assert.equal(lin.relation_type, "HOOK");
    assert.equal(lin.linkage_confidence, "STRONG");
    assert.equal(
      lin.parent_record_key,
      conversationId("claude-code", "-repo-app::11111111-1111-1111-1111-111111111111")
    );
  });

  it("does NOT link a child named in a non-`claude -p` hook's output (stays HOOK/NONE)", () => {
    const lin = lineageOf("44444444-4444-4444-4444-444444444444");
    assert.ok(lin, "child must carry lineage");
    assert.equal(lin.relation_type, "HOOK");
    assert.equal(lin.linkage_confidence, "NONE", "a notify-hook session_id must not become a STRONG parent edge");
    assert.equal(lin.parent_record_key, undefined);
  });

  // A session that starts and exits between polls has its ~/.claude/sessions file
  // pruned before the run scan, so it is absent from the live map. Its kind must
  // still be derivable from the DURABLE per-turn transcript entrypoint (these
  // fixture ids are not real live sessions, so the live map misses for them).
  const sessionKindOf = (sessionId: string): string | undefined => {
    const row = db.getPendingConversations(1000).find((r) => r.session_id.endsWith(sessionId));
    assert.ok(row, `row ${sessionId} must exist`);
    return row.session_meta ? (JSON.parse(row.session_meta) as { session_kind?: string }).session_kind : undefined;
  };

  it("derives session_kind from the durable transcript entrypoint when no live sessions file exists", () => {
    assert.equal(sessionKindOf("sess-sdk-0001"), "background");
    assert.equal(sessionKindOf("sess-cli-0001"), "interactive");
    // Headless then resumed interactively: any human turn makes it interactive.
    assert.equal(sessionKindOf("sess-resume-0001"), "interactive");
  });
});


// A tool_result arrives as a user message whose content is ONLY tool_result blocks, and
// extractContent deliberately keeps those out of contentText. So such a line is "empty"
// as a prompt — and a prompt-empty skip that fires before the timeline sees it silently
// caps every session's coverage at PARTIAL and leaves no pass/fail to ground a check on. This pins the ordering: events are
// captured BEFORE the prompt skips.
describe("session-event capture vs the prompt-empty skip", () => {
  it("records a tool-result-only line, so coverage can reach COMPLETE", () => {
    const b = new SessionEventBuilder();
    // An assistant tool_use that DOES become a prompt.
    b.addMessageEvents(
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Bash", id: "call-1", input: { command: "go test ./..." } }] },
      },
      "2026-05-10T12:00:00.000Z",
    );
    b.addPromptReference(1, "2026-05-10T12:00:00.000Z", "SESSION_EVENT_AUTHOR_AGENT");
    // The paired result: a user line with NO text content at all.
    b.addMessageEvents(
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "call-1", is_error: false, content: "ok" }] },
      },
      "2026-05-10T12:00:01.000Z",
    );

    const kinds = b.build().map((e) => e.kind);
    assert.ok(
      kinds.includes("SESSION_EVENT_KIND_TOOL_RESULT"),
      `a tool-result-only line must still produce a TOOL_RESULT event, got ${JSON.stringify(kinds)}`,
    );
    assert.equal(
      b.coverage(),
      "EVENT_COVERAGE_COMPLETE",
      "with an action and an observable outcome the session is fully observed",
    );
  });
});

// Leak regression: an absolute file path from a file-history-snapshot
// must not reach session_meta.tracked_file_paths with the real home/username segment.
// The committed fixtures use a relative path (src/auth.ts), which redactPath leaves
// untouched — so this plants the *running* user's home dir (the only segment redactPath
// swaps) in a fresh temp transcript and asserts the swap end-to-end.
describe("claudeCodeExtractor — tracked_file_paths redaction", () => {
  let tmpDir: string;
  let db: SessionStore;
  const username = userInfo().username as string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-cc-redact-"));
    const projectsDir = join(tmpDir, "projects");
    const projectDir = join(projectsDir, "project_leak");
    mkdirSync(projectDir, { recursive: true });
    const home = `/Users/${username}`;
    const lines = [
      { type: "user", message: { role: "user", content: "edit the file" }, cwd: `${home}/dev/app`, timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "file-history-snapshot", snapshot: { trackedFileBackups: { [`${home}/dev/app/src/leak.ts`]: {} } } },
    ];
    writeFileSync(join(projectDir, "leak123.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    db = new SessionStore(join(tmpDir, "test.db"));
    setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: projectsDir });
  });

  after(() => {
    setPathOverrides({ CLAUDE_CODE_PROJECTS_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("swaps the home/username segment and preserves the rest of the path", () => {
    assert.ok(username, "need an OS username to exercise redactPath");
    extractClaudeCode(db);
    const rows = db.getPendingConversations(100);
    const row = rows.find((r) => r.session_id === "project_leak::leak123");
    assert.ok(row?.session_meta, "leak session row must exist with session_meta");
    const meta = JSON.parse(row.session_meta) as { tracked_file_paths?: string[] };
    assert.ok(meta.tracked_file_paths?.length, "tracked_file_paths must be populated");
    const path = meta.tracked_file_paths![0]!;
    assert.ok(!path.includes(`/${username}/`), `raw username leaked in ${path}`);
    assert.ok(path.endsWith("/dev/app/src/leak.ts"), "path past the home segment must be preserved");
  });
});



