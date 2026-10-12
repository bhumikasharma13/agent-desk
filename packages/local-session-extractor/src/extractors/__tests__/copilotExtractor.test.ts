// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../../store/SessionStore";
import { extractCopilot } from "../../internal";
import { setPathOverrides } from "../pathResolver";

// ESM-compatible __dirname
const __dirname = dirname(fileURLToPath(import.meta.url));


const fixtureDir = join(__dirname, "../../../fixtures/extraction", "copilot");
const fixtureDb = join(fixtureDir, "vscode_state.vscdb");
const fixtureWorkspaceStoragePath = join(fixtureDir, "workspaceStorage");
const fixtureCliSessionsPath = join(fixtureDir, "cli-sessions");

// ── VS Code fixture mode ──────────────────────────────────────────────────────

describe("copilotExtractor — vscode fixture", () => {
  let tmpDir: string;
  let db: SessionStore;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-copilot-vscode-smoke-"));
    db = new SessionStore(join(tmpDir, "test.db"));
    // Point user data path to tmpDir so the existsSync guard passes on any machine.
    setPathOverrides({ COPILOT_VSCODE_USER_DATA_PATH: tmpDir });
    setPathOverrides({ COPILOT_VSCODE_DB_PATH: fixtureDb });
    setPathOverrides({ COPILOT_VSCODE_WORKSPACE_STORAGE_PATH: fixtureWorkspaceStoragePath });
    // Point CLI path to a non-existent dir so only VSCode source is exercised.
    setPathOverrides({ COPILOT_CLI_PATH: join(tmpDir, "empty-cli") });
    extractCopilot(db);
  });

  after(() => {
    setPathOverrides({ COPILOT_VSCODE_USER_DATA_PATH: undefined });
    setPathOverrides({ COPILOT_VSCODE_DB_PATH: undefined });
    setPathOverrides({ COPILOT_VSCODE_WORKSPACE_STORAGE_PATH: undefined });
    setPathOverrides({ COPILOT_CLI_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("does not throw and returns a number", () => {
    const count = extractCopilot(new SessionStore(join(tmpDir, "verify.db")));
    assert.ok(typeof count === "number", "count must be a number");
    assert.ok(count >= 0, "count must be non-negative");
  });

  it("happy path: stored conversation has valid schema", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected at least one conversation");
    const messages = JSON.parse(rows[0]!.conversation) as { role?: unknown }[];
    assert.ok(Array.isArray(messages), "parsed conversation must be array");
    for (const msg of messages) {
      assert.ok(typeof msg.role === "string", `message.role must be string, got ${typeof msg.role}`);
    }
  });

  it("signals: session_meta session_title from JSONL customTitle", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { session_title?: string };
    assert.equal(meta.session_title, "Copilot fixture session", "session_title must come from customTitle");
  });

  it("signals: session_meta user_message_count", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { user_message_count?: number };
    assert.equal(meta.user_message_count, 1, "1 non-cancelled user request");
  });

  it("signals: session_meta uses_web_search from toolInvocationSerialized copilot_webSearch", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { uses_web_search?: boolean };
    assert.equal(meta.uses_web_search, true, "copilot_webSearch tool → uses_web_search=true");
  });

  it("signals: session_meta tool_counts from toolInvocationSerialized items", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { tool_counts?: Record<string, number> };
    assert.ok(typeof meta.tool_counts === "object" && meta.tool_counts !== null, "tool_counts must be object");
    assert.equal(meta.tool_counts!["copilot_webSearch"], 1, "copilot_webSearch count must be 1");
  });

  it("signals: session_meta user_message_timestamps from request.timestamp", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { user_message_timestamps?: string[] };
    assert.ok(Array.isArray(meta.user_message_timestamps), "user_message_timestamps must be array");
    assert.equal(meta.user_message_timestamps!.length, 1, "1 user request → 1 timestamp");
    assert.ok(!isNaN(Date.parse(meta.user_message_timestamps![0]!)), "timestamp must be valid ISO 8601");
    assert.ok(
      meta.user_message_timestamps![0]!.startsWith("2026-04-01"),
      "timestamp must match fixture date 2026-04-01"
    );
  });

  it("signals: per-prompt model from request.modelId", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const messages = JSON.parse(rows[0]!.conversation) as { role: string; metadata?: { model?: string } }[];
    const user = messages.find((m) => m.role === "user");
    const asst = messages.find((m) => m.role === "assistant");
    assert.equal(user?.metadata?.model, "gpt-4o", "user prompt model must be gpt-4o");
    assert.equal(asst?.metadata?.model, "gpt-4o", "assistant prompt model must be gpt-4o");
  });

  it("signals: per-prompt inputTokens on user prompt from result.usage.promptTokens", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const messages = JSON.parse(rows[0]!.conversation) as { role: string; metadata?: { inputTokens?: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number } }[];
    const user = messages.find((m) => m.role === "user");
    assert.equal(user?.metadata?.inputTokens, 100, "inputTokens must be 100");
    assert.equal(user?.metadata?.cacheCreationInputTokens, 10, "cacheCreationInputTokens must be 10");
    assert.equal(user?.metadata?.cacheReadInputTokens, 5, "cacheReadInputTokens must be 5");
  });

  it("signals: per-prompt outputTokens on assistant prompt from result.usage.completionTokens", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const messages = JSON.parse(rows[0]!.conversation) as { role: string; metadata?: { outputTokens?: number } }[];
    const asst = messages.find((m) => m.role === "assistant");
    assert.equal(asst?.metadata?.outputTokens, 50, "outputTokens must be 50");
  });

  it("row: conversation_source_created_at_ms is populated (not left null → extraction-day fallback)", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    // A null source time makes the store path fall back to the row insert time (today).
    assert.ok(
      rows[0]!.conversation_source_created_at_ms != null,
      "conversation_source_created_at_ms must be set from the session index entry or the file mtime"
    );
  });
});

// ── CLI fixture mode ──────────────────────────────────────────────────────────

describe("copilotExtractor — cli fixture", () => {
  let tmpDir: string;
  let db: SessionStore;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-copilot-cli-smoke-"));
    db = new SessionStore(join(tmpDir, "test.db"));
    // Point CLI path to the fixture sessions directory.
    setPathOverrides({ COPILOT_CLI_PATH: fixtureCliSessionsPath });
    // Point VS Code to non-existent paths so only CLI source runs.
    setPathOverrides({ COPILOT_VSCODE_USER_DATA_PATH: join(tmpDir, "no-vscode") });
    setPathOverrides({ COPILOT_VSCODE_DB_PATH: join(tmpDir, "no-vscode.db") });
    setPathOverrides({ COPILOT_VSCODE_WORKSPACE_STORAGE_PATH: join(tmpDir, "no-ws-storage") });
    extractCopilot(db);
  });

  after(() => {
    setPathOverrides({ COPILOT_CLI_PATH: undefined });
    setPathOverrides({ COPILOT_VSCODE_USER_DATA_PATH: undefined });
    setPathOverrides({ COPILOT_VSCODE_DB_PATH: undefined });
    setPathOverrides({ COPILOT_VSCODE_WORKSPACE_STORAGE_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("happy path: does not throw and returns positive count", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "fixture CLI session must have been extracted");
  });

  it("signals: session_meta git_branch from session.start context.branch", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { git_branch?: string };
    assert.equal(meta.git_branch, "feat/sort", "git_branch must come from session.start context.branch");
  });

  it("signals: session_meta uses_mcp from mcp__* tool", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { uses_mcp?: boolean };
    assert.equal(meta.uses_mcp, true, "mcp__github__web_search → uses_mcp=true");
  });

  it("signals: session_meta uses_web_search from mcp tool with web_search segment", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { uses_web_search?: boolean };
    assert.equal(meta.uses_web_search, true, "web_search segment → uses_web_search=true");
  });

  it("signals: session_meta tool_counts from tool.execution_complete", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { tool_counts?: Record<string, number> };
    assert.ok(typeof meta.tool_counts === "object" && meta.tool_counts !== null, "tool_counts must be object");
    assert.equal(meta.tool_counts!["mcp__github__web_search"], 1, "mcp__github__web_search count must be 1");
  });

  it("signals: session_meta user_message_timestamps from user.message event", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { user_message_timestamps?: string[] };
    assert.ok(Array.isArray(meta.user_message_timestamps), "user_message_timestamps must be array");
    assert.equal(meta.user_message_timestamps!.length, 1, "1 user message → 1 timestamp");
    assert.ok(!isNaN(Date.parse(meta.user_message_timestamps![0]!)), "timestamp must be valid ISO 8601");
    assert.ok(
      meta.user_message_timestamps![0]!.startsWith("2026-04-01"),
      "timestamp must match fixture date 2026-04-01"
    );
  });

  it("signals: session_meta start_time from session.start data.startTime", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const meta = JSON.parse(rows[0]!.session_meta!) as { start_time?: string };
    assert.equal(meta.start_time, "2026-04-01T10:00:00.000Z", "start_time must match session.start startTime");
  });

  it("row: conversation_source_created_at_ms from session.start startTime (not extraction day)", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    // Without a real source time the store path falls back to the row insert time
    // (today), misdating every CLI session to the extraction day.
    assert.equal(
      rows[0]!.conversation_source_created_at_ms,
      Date.parse("2026-04-01T10:00:00.000Z"),
      "conversation_source_created_at_ms must come from session.start startTime"
    );
  });

  it("signals: session_meta duration_minutes from shutdown and start timestamps", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    // session.shutdown(10:00:30) - startTime(10:00:00) = 30s = 0.5 min
    const meta = JSON.parse(rows[0]!.session_meta!) as { duration_minutes?: number };
    assert.equal(meta.duration_minutes, 0.5, "duration_minutes must be 0.5 (30s session)");
  });

  it("signals: user and assistant prompts in conversation", () => {
    const rows = db.getPendingConversations(100);
    assert.ok(rows.length > 0, "expected rows");
    const messages = JSON.parse(rows[0]!.conversation) as { role: string }[];
    const userCount = messages.filter((m) => m.role === "user").length;
    const asstCount = messages.filter((m) => m.role === "assistant").length;
    assert.equal(userCount, 1, "1 user.message event → 1 user prompt");
    assert.equal(asstCount, 1, "1 assistant.message event → 1 assistant prompt");
  });
});

