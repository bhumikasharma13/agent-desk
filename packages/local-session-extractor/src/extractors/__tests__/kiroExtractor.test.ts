// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionStore } from "../../store/SessionStore";
import { extractKiro, countWorkspaceArtifacts, buildSharedSessionFields } from "../../internal";
import { parseCliJsonl } from "../../internal";
import { parseIdeMessages } from "../../internal";
import { setPathOverrides, getPathOverride } from "../pathResolver";


// ── Fixture helpers ──────────────────────────────────────────────────────────

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

function writeJsonl(path: string, lines: unknown[]): void {
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"), "utf-8");
}

// ── Fixture mode ─────────────────────────────────────────────────────────────

describe("kiroExtractor — fixture", () => {
  let tmpDir: string;
  let db: SessionStore;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-kiro-smoke-"));
    db = new SessionStore(join(tmpDir, "test.db"));

    // ── Legacy desktop fixture ───────────────────────────────────────────────
    // Dir name contains "-" → not a valid 16–64 char hex string → legacy branch
    const legacyRoot = join(tmpDir, "legacy-sessions");
    const legacyWsDir = join(legacyRoot, "legacy-ws-001");
    mkdirSync(legacyWsDir, { recursive: true });

    writeJson(join(legacyWsDir, "sessions.json"), [
      {
        sessionId: "kiro-legacy-001",
        title: "Legacy fixture session",
        dateCreated: "1743494400000",
        workspaceDirectory: "/tmp/project",
      },
    ]);

    writeJson(join(legacyWsDir, "kiro-legacy-001.json"), {
      sessionId: "kiro-legacy-001",
      title: "Legacy fixture session",
      workspacePath: "/tmp/project",
      autonomyMode: "supervised",
      sessionType: "agent",
      selectedModel: "claude-sonnet-4-5",
      // Real captured legacy-format values. These are PERCENTAGES on a 0-100
      // scale, like the IDE and CLI formats — a value like 0.45 would read as a
      // fraction and invite the wrong conclusion about this field's scale.
      contextUsagePercentage: 4.354499816894531,
      initialContextEstimate: {
        usagePercentage: 1.9395,
        mcpToolsPercentage: 0,
        steeringPercentage: 0.0645,
      },
      history: [
        { message: { role: "user", content: "Write a fibonacci function", id: "u1" } },
        { message: { role: "assistant", content: "Here is the fibonacci function:", id: "a1" } },
      ],
    });

    // ── CLI fixture ──────────────────────────────────────────────────────────
    const cliRoot = join(tmpDir, "cli-sessions");
    mkdirSync(cliRoot, { recursive: true });

    writeJson(join(cliRoot, "session-cli-001.json"), {
      session_id: "session-cli-001",
      cwd: "/tmp/project",
      created_at: "2026-04-01T10:00:00.000Z",
      updated_at: "2026-04-01T10:10:00.000Z",
      title: "CLI fixture session",
      session_state: {
        conversation_metadata: {
          user_turn_metadatas: [
            {
              loop_id: { agent_id: { name: "main", parent_id: null }, rand: 1 },
              total_request_count: 3,
              number_of_cycles: 2,
              input_token_count: 1000,
              output_token_count: 500,
              context_usage_percentage: 7.435,
              metering_usage: [{ value: 5.5, unit: "credits" }],
              // The assistant finished here; the next prompt's gap from this is
              // the user's response time.
              end_reason: "UserTurnEnd",
              end_timestamp: "2026-04-01T10:00:35.000Z",
              turn_duration: { secs: 30, nanos: 0 },
              model: "claude-sonnet-4-5",
              request_attempts: 3,
              builtin_tool_uses: 2,
              user_prompt_length: 100,
              assistant_response_length: 2000,
            },
            {
              loop_id: { agent_id: { name: "main", parent_id: null }, rand: 2 },
              total_request_count: 1,
              number_of_cycles: 0,
              // Kiro meters in credits; real captured sessions report 0 tokens.
              input_token_count: 0,
              output_token_count: 0,
              cache_read_input_token_count: 0,
              cache_write_input_token_count: 0,
              context_usage_percentage: 7.9424,
              metering_usage: [{ value: 1.5, unit: "credits" }],
              // The user denied a tool the agent asked for.
              end_reason: "ToolUseRejected",
              end_timestamp: "2026-04-01T10:02:00.000Z",
              turn_duration: { secs: 5, nanos: 0 },
              model: "claude-sonnet-4-5",
              request_attempts: 1,
              builtin_tool_uses: 1,
              user_prompt_length: 20,
              assistant_response_length: 400,
            },
          ],
        },
        rts_model_state: {
          model_info: { model_id: "claude-sonnet-4-5", context_window_tokens: 200000 },
          context_usage_percentage: 0.3,
        },
        permissions: {
          filesystem: {
            allowed_read_paths: ["/tmp/project"],
            allowed_write_paths: ["/tmp/project/src"],
            denied_read_paths: [],
            denied_write_paths: [],
          },
        },
        agent_name: "main",
      },
    });

    // Prompt.meta.timestamp is epoch SECONDS in real Kiro CLI output.
    const epochSecs = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    writeJsonl(join(cliRoot, "session-cli-001.jsonl"), [
      { kind: "Prompt", data: { message_id: "msg-001", meta: { timestamp: epochSecs("2026-04-01T10:00:05.000Z") }, content: [{ kind: "text", data: "Implement a CLI tool" }] } },
      {
        kind: "AssistantMessage",
        data: {
          message_id: "msg-002",
          content: [
            { kind: "thinking", data: { text: "The user wants a CLI entrypoint.", modelId: "claude-sonnet-4-5" } },
            { kind: "text", data: "Here is a CLI tool:" },
            { kind: "toolUse", data: { name: "write", input: { path: "src/cli.ts", content: "#!/usr/bin/env node\nconsole.log('hello');\n" } } },
            // A plugin-served call: Kiro namespaces it by the MCP server.
            { kind: "toolUse", data: { name: "@kirocrew-cron/cron_list", toolUseId: "tu-cron-1", input: {} } },
          ],
        },
      },
      { kind: "ToolResults", data: { message_id: "msg-003", content: [{ kind: "toolResult", data: { status: "success" } }] } },
      // The CLI names its shell tool `shell` and its read tool `read`; `read`
      // carries operations: [{ mode, path }].
      {
        kind: "AssistantMessage",
        data: {
          message_id: "msg-003b",
          content: [
            { kind: "toolUse", data: { name: "read", toolUseId: "tu-read-1", input: { __tool_use_purpose: "inspect", operations: [{ mode: "Line", path: "/tmp/project/docs/README.md" }] } } },
            { kind: "toolUse", data: { name: "shell", toolUseId: "tu-push-1", input: { command: "cd /tmp/project && git push origin HEAD" } } },
            { kind: "toolUse", data: { name: "shell", toolUseId: "tu-push-2", input: { command: "git push origin main" } } },
          ],
        },
      },
      {
        kind: "ToolResults",
        data: {
          message_id: "msg-003c",
          content: [
            { kind: "toolResult", data: { toolUseId: "tu-read-1", status: "success" } },
            { kind: "toolResult", data: { toolUseId: "tu-push-1", status: "success" } },
            // A rejected push must not be counted.
            { kind: "toolResult", data: { toolUseId: "tu-push-2", status: "error" } },
          ],
        },
      },
      // 60s after turn 1 ended at 10:00:35 → one 60s response time.
      { kind: "Prompt", data: { message_id: "msg-004", meta: { timestamp: epochSecs("2026-04-01T10:01:35.000Z") }, content: [{ kind: "text", data: "Now add a --help flag" }] } },
    ]);

    // Override all path env vars so extractKiro reads only our fixture dirs
    setPathOverrides({ KIRO_SESSIONS_PATH: legacyRoot });
    setPathOverrides({ KIRO_CLI_SESSIONS_PATH: cliRoot });
    // Point global storage to a nonexistent dir so detectKiroPlanTier and
    // readKiroMachineId both return null/undefined without errors.
    setPathOverrides({ KIRO_DB_PATH: join(tmpDir, "no-global-storage") });
    setPathOverrides({ KIRO_CLI_DB_PATH: join(tmpDir, "no-cli-db.sqlite3") });

    // ── New IDE format fixture ───────────────────────────────────────────────
    const ideRoot = join(tmpDir, "ide-sessions");
    const ideWsDir = join(ideRoot, "abcdef0123456789"); // workspace hash dir
    const ideSessionDir = join(ideWsDir, "sess_test-ide-001");
    mkdirSync(ideSessionDir, { recursive: true });

    writeJson(join(ideSessionDir, "session.json"), {
      schemaVersion: "1.0.0",
      dataModelVersion: 1,
      id: "sess_test-ide-001",
      title: "IDE fixture session",
      agentMode: "vibe",
      workspacePaths: ["/tmp/project"],
      createdAt: "2026-08-06T18:00:00.000Z",
      lastModifiedAt: "2026-08-06T18:15:00.000Z",
      modelId: "auto",
      autopilot: true,
      semanticReviewEnabled: true,
      ftaEnabled: false,
      specPlanEnabled: false,
      specWorkflow: "quick",
      specSkipClarificationEnabled: true,
      description: "Test IDE session",
      status: "completed",
    });

    writeJsonl(join(ideSessionDir, "messages.jsonl"), [
      { id: "msg-u1", timestamp: "2026-08-06T18:00:10.000Z", payload: { type: "user", content: "Create a hello world app", images: [], documents: [] } },
      { id: "turn-1-start", timestamp: "2026-08-06T18:00:10.010Z", payload: { type: "turn_start", executionId: "exec-001" } },
      { id: "tool-1-call", timestamp: "2026-08-06T18:00:12.000Z", payload: { type: "tool_call", toolCallId: "tc-1", toolName: "fs_write", args: { path: "/tmp/project/hello.ts", text: "console.log('hello');\nconsole.log('world');\n" }, status: "completed", kind: "other", executionId: "exec-001", _meta: { kiro: { agentMode: "vibe", toolOrigin: "default" } } } },
      { id: "tool-1-result", timestamp: "2026-08-06T18:00:12.100Z", payload: { type: "tool_result", toolCallId: "tc-1", content: "{}", success: true, executionId: "exec-001" } },
      { id: "tool-2-call", timestamp: "2026-08-06T18:00:13.000Z", payload: { type: "tool_call", toolCallId: "tc-2", toolName: "execute_bash", args: { command: "npm test" }, status: "completed", kind: "other", executionId: "exec-001", _meta: { kiro: { agentMode: "vibe", toolOrigin: "default" } } } },
      { id: "tool-2-result", timestamp: "2026-08-06T18:00:14.000Z", payload: { type: "tool_result", toolCallId: "tc-2", content: "Tests passed", success: true, executionId: "exec-001" } },
      { id: "msg-a1", timestamp: "2026-08-06T18:00:15.000Z", payload: { type: "assistant", content: "I created hello.ts with a hello world app and ran the tests.", executionId: "exec-001" } },
      { id: "ctx-1", timestamp: "2026-08-06T18:00:15.001Z", payload: { type: "session_metadata", key: "contextUsage", value: { usagePercentage: 12.5 }, executionId: "exec-001" } },
      { id: "usage-1", timestamp: "2026-08-06T18:00:15.010Z", payload: { type: "usage_summary", promptTurnSummaries: [{ unit: "credit", unitPlural: "credits", usage: 0.25, usedTools: ["fs_write", "execute_bash"] }], elapsedTime: 5000, status: "success", executionId: "exec-001" } },
      { id: "turn-1-end", timestamp: "2026-08-06T18:00:15.020Z", payload: { type: "turn_end", stopReason: "end_turn", executionId: "exec-001" } },
      // Second user message (to test user_response_times)
      { id: "msg-u2", timestamp: "2026-08-06T18:01:00.000Z", payload: { type: "user", content: "Now add error handling", images: [], documents: [] } },
      { id: "turn-2-start", timestamp: "2026-08-06T18:01:00.010Z", payload: { type: "turn_start", executionId: "exec-002" } },
      { id: "msg-a2", timestamp: "2026-08-06T18:01:05.000Z", payload: { type: "assistant", content: "Added try/catch error handling.", executionId: "exec-002" } },
      { id: "usage-2", timestamp: "2026-08-06T18:01:05.010Z", payload: { type: "usage_summary", promptTurnSummaries: [{ unit: "credit", unitPlural: "credits", usage: 0.15, usedTools: [] }], elapsedTime: 4990, status: "success", executionId: "exec-002" } },
      { id: "turn-2-end", timestamp: "2026-08-06T18:01:05.020Z", payload: { type: "turn_end", stopReason: "end_turn", executionId: "exec-002" } },
      // Third user message — interrupted
      { id: "msg-u3", timestamp: "2026-08-06T18:02:00.000Z", payload: { type: "user", content: "Actually wait, stop", images: [], documents: [] } },
      { id: "turn-3-start", timestamp: "2026-08-06T18:02:00.010Z", payload: { type: "turn_start", executionId: "exec-003" } },
      // Sub-agent delegation. subSessionId matches the sub-executions/ filename;
      // subAgentName is the only record of the agent's real name.
      { id: "sub-start-1", timestamp: "2026-08-06T18:02:00.100Z", payload: { type: "sub_agent_start", subAgentName: "context-gatherer", subSessionId: "a632ca2d-8615-4edf-910d-bd24a77d8ab8", parentExecutionId: "exec-003", prompt: "Find the RFC that documents signal extraction", explanation: "The user is asking about an RFC in their repo" } },
      { id: "sub-done-1", timestamp: "2026-08-06T18:02:00.900Z", payload: { type: "sub_agent_complete", subSessionId: "a632ca2d-8615-4edf-910d-bd24a77d8ab8", parentExecutionId: "exec-003", status: "success", response: "=== Context Gathering Summary ===" } },
      // Read tools feed tracked_file_paths. read_file carries `path`; read_code carries `files: [{path}]`.
      { id: "tool-3-call", timestamp: "2026-08-06T18:02:00.200Z", payload: { type: "tool_call", toolCallId: "tc-3", toolName: "read_file", args: { path: "/tmp/project/README.md", limit: 100, offset: 0 }, actionType: "read_files", kind: "read", status: "approved", executionId: "exec-003", _meta: { kiro: { agentMode: "vibe", toolOrigin: "acp" } } } },
      { id: "tool-3-result", timestamp: "2026-08-06T18:02:00.250Z", payload: { type: "tool_result", toolCallId: "tc-3", content: "{}", success: true, executionId: "exec-003" } },
      { id: "tool-4-call", timestamp: "2026-08-06T18:02:00.300Z", payload: { type: "tool_call", toolCallId: "tc-4", toolName: "read_code", args: { files: [{ path: "/tmp/project/src/index.ts" }] }, actionType: "readCode", kind: "read", status: "approved", executionId: "exec-003" } },
      { id: "tool-4-result", timestamp: "2026-08-06T18:02:00.350Z", payload: { type: "tool_result", toolCallId: "tc-4", content: "{}", success: true, executionId: "exec-003" } },
      // A denied tool approval — the user withholding a tool the agent asked for.
      { id: "pend-1", timestamp: "2026-08-06T18:02:00.400Z", payload: { type: "pending_interaction", interactionType: "tool_approval", toolCallId: "tc-5", question: "rm -rf /tmp/project/dist", options: [{ optionId: "accept", name: "Allow", kind: "allow_once" }, { optionId: "reject", name: "Deny", kind: "reject_once" }], executionId: "tc-5" } },
      { id: "res-1", timestamp: "2026-08-06T18:02:00.500Z", payload: { type: "interaction_resolved", toolCallId: "tc-5", outcome: "selected", selectedOption: "reject", executionId: "tc-5" } },
      // A successful `git push` — invisible to git history, so the shell transcript is the only source.
      { id: "tool-6-call", timestamp: "2026-08-06T18:02:00.600Z", payload: { type: "tool_call", toolCallId: "tc-6", toolName: "execute_bash", args: { command: "cd /tmp/project && git push origin HEAD", cwd: "/tmp/project", run_in_background: false }, actionType: "run_command", kind: "execute", status: "approved", executionId: "exec-003" } },
      { id: "tool-6-result", timestamp: "2026-08-06T18:02:00.700Z", payload: { type: "tool_result", toolCallId: "tc-6", content: "Everything up-to-date", success: true, executionId: "exec-003" } },
      // A `git push` that FAILED — must not be counted.
      { id: "tool-7-call", timestamp: "2026-08-06T18:02:00.750Z", payload: { type: "tool_call", toolCallId: "tc-7", toolName: "execute_bash", args: { command: "git push origin main", cwd: "/tmp/project", run_in_background: false }, actionType: "run_command", kind: "execute", status: "approved", executionId: "exec-003" } },
      { id: "tool-7-result", timestamp: "2026-08-06T18:02:00.800Z", payload: { type: "tool_result", toolCallId: "tc-7", content: "rejected", success: false, executionId: "exec-003" } },
      // Closing prose for the turn. Kiro names heads remote-qualified.
      { id: "msg-a3", timestamp: "2026-08-06T18:02:00.850Z", payload: { type: "assistant", content: "Done — pushed to `origin/feat/kiro-ide-session-extraction` and raised the PR.", executionId: "exec-003" } },
      { id: "turn-3-end", timestamp: "2026-08-06T18:02:01.000Z", payload: { type: "turn_end", stopReason: "cancelled", executionId: "exec-003" } },
    ]);

    // Sub-execution directory. The filename is the opaque subSessionId — the
    // sub-agent's name lives only in the parent's sub_agent_start event.
    const subExecDir = join(ideSessionDir, "sub-executions");
    mkdirSync(subExecDir, { recursive: true });
    writeJsonl(join(subExecDir, "a632ca2d-8615-4edf-910d-bd24a77d8ab8.jsonl"), [
      { id: "sub-u1", timestamp: "2026-08-06T18:00:11.000Z", payload: { type: "user", content: "sub-task: format code", images: [], documents: [] } },
      // A FAILED sub-execution edit: its result reports success:false, so utils.ts
      // must NOT count as edited and its lines must not be attributed.
      { id: "sub-tc1", timestamp: "2026-08-06T18:00:11.500Z", payload: { type: "tool_call", toolCallId: "sub-tc-1", toolName: "str_replace", args: { path: "/tmp/project/utils.ts", oldStr: "x=1", newStr: "x = 1;\ny = 2;" }, status: "completed" } },
      { id: "sub-tr1", timestamp: "2026-08-06T18:00:11.600Z", payload: { type: "tool_result", toolCallId: "sub-tc-1", content: "{}", success: false } },
      // A SUCCESSFUL sub-execution edit: its file (greeting.ts) must merge into the
      // parent's files_edited and its one written line into composer_suggested_lines.
      { id: "sub-tc2", timestamp: "2026-08-06T18:00:11.650Z", payload: { type: "tool_call", toolCallId: "sub-tc-2", toolName: "fs_append", args: { path: "/tmp/project/greeting.ts", text: "export const hi = 1;\n" }, status: "completed" } },
      { id: "sub-tr2", timestamp: "2026-08-06T18:00:11.680Z", payload: { type: "tool_result", toolCallId: "sub-tc-2", content: "{}", success: true } },
      // Higher than anything the parent reached — the delegated work is what
      // filled the window, which is the case the session peak must not miss.
      { id: "sub-ctx", timestamp: "2026-08-06T18:00:11.700Z", payload: { type: "session_metadata", key: "contextUsage", value: { usagePercentage: 61.25 }, executionId: "sub-exec-1" } },
    ]);

    // Second IDE session WITHOUT the autopilot key. Kiro omits it on sessions
    // that never touched autopilot, which is the majority of real sessions.
    const ideSessionDir2 = join(ideWsDir, "sess_test-ide-002");
    mkdirSync(ideSessionDir2, { recursive: true });
    writeJson(join(ideSessionDir2, "session.json"), {
      schemaVersion: "1.0.0",
      dataModelVersion: 1,
      id: "sess_test-ide-002",
      title: "IDE session without autopilot",
      agentMode: "vibe",
      workspacePaths: ["/tmp/project"],
      createdAt: "2026-08-06T19:00:00.000Z",
      lastModifiedAt: "2026-08-06T19:05:00.000Z",
      modelId: "claude-opus-4.8",
      specWorkflow: "quick",
      status: "idle",
    });
    writeJsonl(join(ideSessionDir2, "messages.jsonl"), [
      { id: "m-u1", timestamp: "2026-08-06T19:00:10.000Z", payload: { type: "user", content: "What does this repo do?", images: [], documents: [] } },
      { id: "m-a1", timestamp: "2026-08-06T19:00:20.000Z", payload: { type: "assistant", content: "It is a monorepo.", executionId: "exec-101" } },
    ]);

    // User-level MCP applies to every session regardless of workspace. Pointed at
    // a fixture so the run never reads the developer's real ~/.kiro.
    const userMcpPath = join(tmpDir, "user-mcp.json");
    writeJson(userMcpPath, { mcpServers: { "user-level-server": { command: "uvx" } } });
    setPathOverrides({ KIRO_USER_MCP_PATH: userMcpPath });

    // Crew is a real directory on a developer machine; point it at an empty
    // fixture so the suite never reads it (and never varies by machine).
    setPathOverrides({ KIRO_CREW_PATH: join(tmpDir, "no-crew") });

    setPathOverrides({ KIRO_IDE_SESSIONS_PATH: ideRoot });
  });

  after(() => {
    setPathOverrides({ KIRO_SESSIONS_PATH: undefined });
    setPathOverrides({ KIRO_CLI_SESSIONS_PATH: undefined });
    setPathOverrides({ KIRO_DB_PATH: undefined });
    setPathOverrides({ KIRO_CLI_DB_PATH: undefined });
    setPathOverrides({ KIRO_IDE_SESSIONS_PATH: undefined });
    setPathOverrides({ KIRO_USER_MCP_PATH: undefined });
    setPathOverrides({ KIRO_CREW_PATH: undefined });
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("happy path: extracts sessions from IDE + legacy + CLI formats and returns count > 0", () => {
    const count = extractKiro(db);
    assert.ok(typeof count === "number", "count must be a number");
    assert.ok(count >= 3, `expected at least 3 sessions (IDE + legacy + CLI), got ${count}`);
  });

  // ── Legacy desktop ───────────────────────────────────────────────────────────

  it("legacy: upserts a row with ide_type=kiro", () => {
    const rows = db.getPendingConversations(100);
    const legacy = rows.find((r) => r.session_id.startsWith("kiro-desktop-legacy:"));
    assert.ok(legacy, "expected a legacy desktop row");
    assert.equal(legacy!.ide_type, "kiro");
  });

  it("legacy: session_meta source is 'kiro'", () => {
    const rows = db.getPendingConversations(100);
    const legacy = rows.find((r) => r.session_id.startsWith("kiro-desktop-legacy:"));
    const meta = JSON.parse(legacy!.session_meta!) as { source?: string };
    assert.equal(meta.source, "kiro");
  });

  it("legacy: session_meta session_title from session JSON title", () => {
    const rows = db.getPendingConversations(100);
    const legacy = rows.find((r) => r.session_id.startsWith("kiro-desktop-legacy:"));
    const meta = JSON.parse(legacy!.session_meta!) as { session_title?: string };
    assert.equal(meta.session_title, "Legacy fixture session");
  });

  it("legacy: session_meta agent_mode normalized from sessionType", () => {
    const rows = db.getPendingConversations(100);
    const legacy = rows.find((r) => r.session_id.startsWith("kiro-desktop-legacy:"));
    const meta = JSON.parse(legacy!.session_meta!) as { agent_mode?: string };
    assert.equal(meta.agent_mode, "agent");
  });

  it("legacy: session_meta autonomy_mode normalized from autonomyMode", () => {
    const rows = db.getPendingConversations(100);
    const legacy = rows.find((r) => r.session_id.startsWith("kiro-desktop-legacy:"));
    const meta = JSON.parse(legacy!.session_meta!) as { autonomy_mode?: string };
    assert.equal(meta.autonomy_mode, "supervised");
  });

  it("legacy: session_meta ide_context_usage_percent from contextUsagePercentage", () => {
    const rows = db.getPendingConversations(100);
    const legacy = rows.find((r) => r.session_id.startsWith("kiro-desktop-legacy:"));
    const meta = JSON.parse(legacy!.session_meta!) as { ide_context_usage_percent?: number };
    assert.equal(meta.ide_context_usage_percent, 4.354499816894531);
  });

  it("legacy: session_meta mcp_context_percent from initialContextEstimate", () => {
    const rows = db.getPendingConversations(100);
    const legacy = rows.find((r) => r.session_id.startsWith("kiro-desktop-legacy:"));
    const meta = JSON.parse(legacy!.session_meta!) as { mcp_context_percent?: number };
    assert.equal(meta.mcp_context_percent, 0);
  });

  it("legacy: conversation has user and assistant prompts", () => {
    const rows = db.getPendingConversations(100);
    const legacy = rows.find((r) => r.session_id.startsWith("kiro-desktop-legacy:"));
    const conv = JSON.parse(legacy!.conversation) as { role: string; content: string }[];
    assert.ok(conv.some((m) => m.role === "user" && m.content.includes("fibonacci")));
    assert.ok(conv.some((m) => m.role === "assistant"));
  });

  it("legacy: session_meta user_message_count and assistant_message_count", () => {
    const rows = db.getPendingConversations(100);
    const legacy = rows.find((r) => r.session_id.startsWith("kiro-desktop-legacy:"));
    const meta = JSON.parse(legacy!.session_meta!) as { user_message_count?: number; assistant_message_count?: number };
    assert.equal(meta.user_message_count, 1);
    assert.equal(meta.assistant_message_count, 1);
  });

  it("kiro: the shared builder offers no branch at all — only a transcript can", () => {
    // A branch the session never worked on is worse than no branch: BRANCH_MATCH
    // treats any branch as strong evidence and cannot tell an extraction-time
    // HEAD read apart from one the transcript proves, so every session extracted
    // in one sitting was attributed to whichever PR owned the branch the
    // developer happened to be standing on.
    //
    // Guarded on the builder rather than the fixtures because it is the choke
    // point all three surfaces share, and because it fails deterministically:
    // a fixture workspace is not inside a git checkout, so getGitBranch there
    // returns undefined and a reintroduced snapshot would pass unnoticed.
    const fields = buildSharedSessionFields({
      projectPath: "/tmp/project",
      artifacts: { specCount: 0, steeringFileCount: 0, hookCount: 0 },
      mcpServers: [],
      prLink: null,
      usesWebSearch: false,
      usesWebFetch: false,
      languages: undefined,
      firstPrompt: undefined,
      lastPrompt: undefined,
    });
    assert.ok(!("git_branch" in fields), "shared builder must not emit git_branch");
    assert.ok(!("git_branches" in fields), "shared builder must not emit git_branches");
  });

  it("kiro: no surface emits the deprecated git_branch scalar", () => {
    // The scalar carried nothing but the extraction-time snapshot, and the
    // consumer back-fills it into git_branches, so leaving
    // it populated would feed BRANCH_MATCH the same wrong branch by another
    // route. git_branches may still be set — from the transcript only, which
    // the turn-final-prose test below covers.
    const rows = db.getPendingConversations(100);
    for (const prefix of ["kiro-desktop-legacy:", "kiro-ide:", "kiro-cli:"]) {
      const row = rows.find((r) => r.session_id.startsWith(prefix));
      assert.ok(row, `expected a ${prefix} row`);
      const meta = JSON.parse(row!.session_meta!) as { git_branch?: string };
      assert.equal(meta.git_branch, undefined, `${prefix} must not emit git_branch`);
    }
  });

  it("legacy: incremental tracking — second run returns 0 (no file changes)", () => {
    const count2 = extractKiro(db);
    // All rows already in DB with same mtime/size — no re-processing expected
    assert.equal(count2, 0, "no sessions should be re-processed on second run without file changes");
  });

  // ── CLI ──────────────────────────────────────────────────────────────────────

  it("cli: upserts a row with ide_type=kiro", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    assert.ok(cli, "expected a CLI row");
    assert.equal(cli!.ide_type, "kiro");
  });

  it("cli: session_meta source is 'kiro-cli'", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { source?: string };
    assert.equal(meta.source, "kiro-cli");
  });

  // ── CLI line counting (regression: per-write over-count of lines_added) ────────

  it("cli: parseCliJsonl tool count double-counts repeated writes of one file", () => {
    const fiveLines = "l1\nl2\nl3\nl4\nl5\n"; // .split("\n") → 6 entries
    const parsed = parseCliJsonl([
      JSON.stringify({
        kind: "AssistantMessage",
        data: { message_id: "m1", content: [
          { kind: "toolUse", data: { name: "write", input: { path: "same.ts", content: fiveLines } } },
          { kind: "toolUse", data: { name: "write", input: { path: "same.ts", content: fiveLines } } },
        ] },
      }),
    ]);
    // Two writes of the same file double-count (6+6) — the per-write tool signal.
    // It now feeds composer_suggested_lines only; lines_added comes from git diff.
    assert.equal(parsed.composerSuggestedLines, 12);
    assert.equal(parsed.filesEdited.size, 1); // distinct files (Set-deduped) stays correct
  });

  it("ide: an append-only edit contributes its lines, not just its filename", () => {
    // fs_append was admitted as an edit (so the file counted as modified) while
    // no branch counted its text, so append-only sessions reported changed files
    // against zero AI volume. Everything an append writes is new — nothing is
    // replaced — so the whole payload counts, as with fs_write.
    const parsed = parseIdeMessages([
      JSON.stringify({
        id: "t1", timestamp: "2026-08-06T18:00:00.000Z",
        payload: {
          type: "tool_call", toolCallId: "tc-a", toolName: "fs_append", kind: "edit",
          filePath: "/tmp/project/log.ts", args: { path: "/tmp/project/log.ts", text: "a\nb\nc" },
          status: "completed", executionId: "e1",
        },
      }),
    ]);
    assert.equal(parsed.composerSuggestedLines, 3);
    assert.ok(parsed.filesEdited.has("/tmp/project/log.ts"));
  });

  it("cli: lines_added is git-diff derived, not the per-write tool count", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { lines_added?: number };
    // Fixture cwd "/tmp/project" is not a git repo → getFullSessionDiffStats yields
    // no insertions. Pre-fix this carried the inflated per-write tool count; now it
    // must not (the tool count lives in composer_suggested_lines instead).
    assert.equal(meta.lines_added, undefined);
  });

  it("cli: session_meta session_title from session JSON title", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { session_title?: string };
    assert.equal(meta.session_title, "CLI fixture session");
  });

  it("cli: session_meta billing_credits_used summed from metering_usage", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { billing_credits_used?: number };
    // 5.5 + 1.5 across the two turns.
    assert.equal(meta.billing_credits_used, 7);
  });

  it("cli: session_meta total_model_request_count summed from turn metadata", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { total_model_request_count?: number };
    // 3 + 1 across the two turns.
    assert.equal(meta.total_model_request_count, 4);
  });

  it("cli: session_meta total_agent_cycles summed from turn metadata", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { total_agent_cycles?: number };
    assert.equal(meta.total_agent_cycles, 2);
  });

  it("cli: session_meta sandbox_allowed_read_paths from permissions", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { sandbox_allowed_read_paths?: string[] };
    assert.deepEqual(meta.sandbox_allowed_read_paths, ["/tmp/project"]);
  });

  it("cli: session_meta sandbox_allowed_write_paths from permissions", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { sandbox_allowed_write_paths?: string[] };
    assert.deepEqual(meta.sandbox_allowed_write_paths, ["/tmp/project/src"]);
  });

  it("cli: user_message_timestamps from Prompt meta.timestamp (epoch seconds)", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { user_message_timestamps?: string[] };
    assert.deepEqual(meta.user_message_timestamps, [
      "2026-04-01T10:00:05.000Z",
      "2026-04-01T10:01:35.000Z",
    ]);
  });

  it("cli: message_hours derived from the prompt timestamps", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { message_hours?: number[] };
    assert.deepEqual(meta.message_hours, [10, 10]);
  });

  it("cli: user_response_times measured from turn end to the next prompt", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { user_response_times?: number[] };
    // Turn 1 ended 10:00:35; the next prompt is 10:01:35. The FIRST prompt has no
    // preceding turn end, so it contributes nothing.
    assert.deepEqual(meta.user_response_times, [60]);
  });

  it("cli: a ToolUseRejected turn is categorised as a rejected tool", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { tool_error_categories?: Record<string, number> };
    assert.ok(meta.tool_error_categories, "tool_error_categories must be present");
    assert.equal(meta.tool_error_categories!["tool_rejected"], 1);
  });

  it("cli: uses_extended_thinking set from a thinking content block", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { uses_extended_thinking?: boolean };
    assert.equal(meta.uses_extended_thinking, true);
  });

  it("cli: absolute context occupancy recovered from percentage x window size", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as {
      context_token_limit?: number; context_tokens_used?: number;
    };
    assert.equal(meta.context_token_limit, 200000);
    // 0.3% of a 200k window — the value is a percentage, not a fraction.
    assert.equal(meta.context_tokens_used, 600);
  });

  it("cli: kiro_id uses the same surface-qualified shape as the IDE", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { kiro_id?: string };
    assert.equal(meta.kiro_id, "kiro-cli:session-cli-001");
    assert.equal(meta.kiro_id, cli!.session_id);

    // The prefix is what keeps the two surfaces apart in a single field — an
    // IDE and a CLI session can never collide on kiro_id.
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const ideMeta = JSON.parse(ide!.session_meta!) as { kiro_id?: string };
    assert.ok(ideMeta.kiro_id!.startsWith("kiro-ide:"));
    assert.ok(meta.kiro_id!.startsWith("kiro-cli:"));
  });

  it("cli: model_request_attempts exceeds request count by the retries", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as {
      model_request_attempts?: number; total_model_request_count?: number;
    };
    // 3+1 attempts against 3+1 requests — no retries in this fixture, but the
    // pair is what makes the retry count derivable at all.
    assert.equal(meta.model_request_attempts, 4);
    assert.equal(meta.total_model_request_count, 4);
  });

  it("cli: agent_active_seconds sums turn_duration secs + nanos", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { agent_active_seconds?: number };
    // 30s + 5s of real work inside a 600s wall-clock session.
    assert.equal(meta.agent_active_seconds, 35);
  });

  it("cli: turn_usage carries per-turn model, context and end_reason", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as {
      turn_usage?: Array<{ credits?: number; model?: string; end_reason?: string; context_usage_percent?: number }>;
    };
    assert.equal(meta.turn_usage?.length, 2);
    assert.equal(meta.turn_usage![0]!.model, "claude-sonnet-4-5");
    assert.equal(meta.turn_usage![0]!.end_reason, "UserTurnEnd");
    assert.equal(meta.turn_usage![1]!.end_reason, "ToolUseRejected");
    // 0-100 scale, verified against real captured turns (5.13 / 8.07 / 15.53).
    assert.equal(meta.turn_usage![1]!.context_usage_percent, 7.9424);
  });

  it("cli: prompt/response chars and builtin tool uses come from turn metadata", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as {
      user_prompt_chars?: number; assistant_response_chars?: number; builtin_tool_uses?: number;
    };
    assert.equal(meta.user_prompt_chars, 120);
    assert.equal(meta.assistant_response_chars, 2400);
    assert.equal(meta.builtin_tool_uses, 3);
  });

  it("cli: approval outcomes and sub-agent runs stay unset — the CLI reports neither", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as {
      tool_approval_outcomes?: unknown; sub_agent_runs?: unknown;
    };
    // The CLI records THAT a tool was rejected (end_reason) but not which option
    // was offered, nor a per-delegation outcome. Synthesising either would
    // report a decision the user never made.
    assert.equal(meta.tool_approval_outcomes, undefined);
    assert.equal(meta.sub_agent_runs, undefined);
  });

  it("cli: git_pushes counts only shell pushes whose tool result succeeded", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { git_pushes?: number };
    // Two `git push` commands ran; the second errored.
    assert.equal(meta.git_pushes, 1);
  });

  it("cli: tracked_file_paths from read tool operations[].path", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { tracked_file_paths?: string[] };
    assert.ok(Array.isArray(meta.tracked_file_paths), "tracked_file_paths must be present");
    assert.ok(meta.tracked_file_paths!.some((f) => f.includes("README.md")));
  });

  it("kiro: pr_references is written, not just the deprecated scalars", () => {
    // PR attribution prefers pr_references when present, so writing only the
    // deprecated pr_url/pr_number/pr_repository sent Kiro rows down a different
    // attribution path than every other IDE.
    const link = { prUrl: "https://github.com/o/r/pull/42", prNumber: 42, prRepository: "o/r" };
    const fields = buildSharedSessionFields({
      projectPath: "/tmp/project",
      artifacts: { specCount: 0, steeringFileCount: 0, hookCount: 0 },
      mcpServers: [],
      prLink: link,
      usesWebSearch: false,
      usesWebFetch: false,
      languages: undefined,
      firstPrompt: undefined,
      lastPrompt: undefined,
    });
    // Stamped ambient: this reference came from reading the local checkout, not
    // from anything the session did, so it may scope a search and never attribute.
    assert.deepEqual(fields.pr_references, [
      {
        pr_url: "https://github.com/o/r/pull/42",
        pr_number: 42,
        pr_repository: "o/r",
        source: "SIGNAL_SOURCE_LOCAL_GIT_WINDOWED",
      },
    ]);
    // The scalars stay populated for readers that predate the array.
    assert.equal(fields.pr_url, "https://github.com/o/r/pull/42");
  });

  it("kiro: NO surface is lineage-tagged, so no Kiro session is ever folded away", () => {
    // A Kiro plugin, hook or sub-agent runs INSIDE the session that used it — it
    // never opens its own conversation the way a Claude Code or Codex subagent
    // does. Setting lineage on any of them would make a consumer fold that row
    // into a parent and mark it `skipped`, losing
    // a real session. Sub-execution transcripts are folded client-side into
    // their parent instead, which is why they need no lineage either.
    const rows = db.getPendingConversations(100);
    const kiro = rows.filter((r) => r.ide_type === "kiro");
    assert.ok(kiro.length > 0, "expected Kiro rows");
    for (const row of kiro) {
      const meta = JSON.parse(row.session_meta!) as { lineage?: unknown };
      assert.equal(meta.lineage, undefined, `${row.session_id} must not carry lineage`);
    }
  });

  it("kiro: a plugin-served tool is identified on the session that used it", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { tool_origin_counts?: Record<string, number> };
    assert.ok(meta.tool_origin_counts, "tool_origin_counts must be present");
    // `@kirocrew-cron/cron_list` is attributed to its server; `write` is built-in.
    assert.equal(meta.tool_origin_counts!["kirocrew-cron"], 1);
    assert.ok((meta.tool_origin_counts!["default"] ?? 0) >= 1);
  });

  it("kiro: mcp_server_names unions the user-level config, not workspace only", () => {
    // Reading only <workspace>/.kiro/settings/mcp.json under-reported everyone
    // who configures MCP globally — the common case — leaving uses_mcp false for
    // sessions that did have servers.
    const rows = db.getPendingConversations(100);
    const withMcp = rows
      .map((r) => JSON.parse(r.session_meta!) as { mcp_server_names?: string[]; uses_mcp?: boolean })
      .filter((m) => m.mcp_server_names?.includes("user-level-server"));
    assert.ok(withMcp.length > 0, "user-level MCP servers must reach session_meta");
    assert.ok(withMcp.every((m) => m.uses_mcp === true), "uses_mcp must follow the union");
  });

  it("kiro: pr_references stays unset when no PR was resolved", () => {
    const fields = buildSharedSessionFields({
      projectPath: "/tmp/project",
      artifacts: { specCount: 0, steeringFileCount: 0, hookCount: 0 },
      mcpServers: [],
      prLink: null,
      usesWebSearch: false,
      usesWebFetch: false,
      languages: undefined,
      firstPrompt: undefined,
      lastPrompt: undefined,
    });
    assert.equal(fields.pr_references, undefined);
  });

  it("cli: session_meta files_edited from write toolUse in JSONL", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { files_edited?: string[] };
    assert.ok(Array.isArray(meta.files_edited), "files_edited must be array");
    assert.ok(meta.files_edited!.includes("src/cli.ts"), "must include src/cli.ts");
  });

  it("cli: ai_attribution composer_suggested_lines from write toolUse content", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    assert.ok(cli!.ai_attribution, "ai_attribution must be present");
    const attr = JSON.parse(cli!.ai_attribution!) as { composer_suggested_lines?: number };
    assert.ok((attr.composer_suggested_lines ?? 0) > 0, "write toolUse must contribute composer_suggested_lines");
  });

  it("cli: conversation has user and assistant prompts from JSONL", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const conv = JSON.parse(cli!.conversation) as { role: string; content: string }[];
    assert.ok(conv.some((m) => m.role === "user" && m.content.includes("CLI tool")));
    assert.ok(conv.some((m) => m.role === "assistant"));
  });

  it("cli: session_meta first_prompt and last_prompt via buildSharedSessionFields", () => {
    const rows = db.getPendingConversations(100);
    const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
    const meta = JSON.parse(cli!.session_meta!) as { first_prompt?: string; last_prompt?: string };
    assert.equal(meta.first_prompt, "Implement a CLI tool");
    assert.equal(meta.last_prompt, "Now add a --help flag");
  });

  // ── IDE (new format) ─────────────────────────────────────────────────────────

  it("ide: upserts a row with ide_type=kiro and kiro-ide: prefix", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    assert.ok(ide, "expected an IDE row");
    assert.equal(ide!.ide_type, "kiro");
  });

  it("ide: session_meta source is 'kiro-ide', distinct from the legacy desktop 'kiro'", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { source?: string };
    assert.equal(meta.source, "kiro-ide");

    // The legacy desktop row keeps its original provenance so older is stored
    // stay attributable to the format they came from.
    const legacy = rows.find((r) => r.session_id.startsWith("kiro-desktop-legacy:"));
    assert.ok(legacy, "expected a legacy desktop row");
    const legacyMeta = JSON.parse(legacy!.session_meta!) as { source?: string };
    assert.equal(legacyMeta.source, "kiro");
  });

  it("ide: entrypoint is kiro-ide while the legacy desktop row stays kiro-desktop", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const ideInstall = JSON.parse(ide!.installation_metadata!) as { entrypoint?: string };
    assert.equal(ideInstall.entrypoint, "kiro-ide");

    const legacy = rows.find((r) => r.session_id.startsWith("kiro-desktop-legacy:"));
    const legacyInstall = JSON.parse(legacy!.installation_metadata!) as { entrypoint?: string };
    assert.equal(legacyInstall.entrypoint, "kiro-desktop");
  });

  it("ide: session_meta session_title from session.json", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { session_title?: string };
    assert.equal(meta.session_title, "IDE fixture session");
  });

  it("ide: session_meta agent_mode from session.json agentMode", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { agent_mode?: string };
    assert.equal(meta.agent_mode, "vibe");
  });

  it("ide: session_meta autonomy_mode derived from autopilot flag", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id === "kiro-ide:sess_test-ide-001");
    const meta = JSON.parse(ide!.session_meta!) as { autonomy_mode?: string };
    assert.equal(meta.autonomy_mode, "autopilot");
  });

  it("ide: autonomy_mode is absent when session.json omits autopilot", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id === "kiro-ide:sess_test-ide-002");
    assert.ok(ide, "expected the second IDE row");
    const meta = JSON.parse(ide!.session_meta!) as { autonomy_mode?: string };
    // Reporting "supervised" here would publish a supervision level that was
    // never observed — an unmeasured value rendered as a confident one.
    assert.equal(meta.autonomy_mode, undefined);
  });

  it("ide: session_meta billing_credits_used summed from usage_summary events", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { billing_credits_used?: number };
    // 0.25 + 0.15 = 0.40
    assert.ok(Math.abs((meta.billing_credits_used ?? 0) - 0.40) < 0.001, `expected ~0.40, got ${meta.billing_credits_used}`);
  });

  it("ide: session_meta tool_counts from tool_call events (including sub-exec)", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { tool_counts?: Record<string, number> };
    assert.ok(meta.tool_counts, "tool_counts must be present");
    assert.equal(meta.tool_counts!["fs_write"], 1);
    // npm test + two git push attempts
    assert.equal(meta.tool_counts!["execute_bash"], 3);
    // str_replace from sub-execution
    assert.equal(meta.tool_counts!["str_replace"], 1);
  });

  it("ide: session_meta tool_errors from failed tool_results (main + sub-exec)", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { tool_errors?: number };
    // the failed git push in the main session + the sub-exec tool_result success=false
    assert.equal(meta.tool_errors, 2);
  });

  it("ide: a token-limit finish is not counted as a user interruption", () => {
    // user_interruptions is read as "the user stopped the assistant" and feeds
    // friction metrics; max_tokens ends a turn with nobody cancelling anything.
    const parsed = parseIdeMessages([
      JSON.stringify({ id: "t1", timestamp: "2026-08-06T18:00:00.000Z", payload: { type: "turn_end", stopReason: "max_tokens", executionId: "e1" } }),
      JSON.stringify({ id: "t2", timestamp: "2026-08-06T18:01:00.000Z", payload: { type: "turn_end", stopReason: "cancelled", executionId: "e2" } }),
      JSON.stringify({ id: "t3", timestamp: "2026-08-06T18:02:00.000Z", payload: { type: "turn_end", stopReason: "end_turn", executionId: "e3" } }),
    ]);
    assert.equal(parsed.userInterruptions, 1, "only the cancel counts");
  });

  it("ide: session_meta user_interruptions counts user cancellations", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { user_interruptions?: number };
    assert.equal(meta.user_interruptions, 1); // turn-3 has stopReason=user_interrupt
  });

  it("ide: session_meta user_message_timestamps from messages.jsonl event timestamps", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { user_message_timestamps?: string[] };
    assert.ok(Array.isArray(meta.user_message_timestamps), "must be array");
    assert.equal(meta.user_message_timestamps!.length, 3); // 3 user messages
    assert.equal(meta.user_message_timestamps![0], "2026-08-06T18:00:10.000Z");
  });

  it("ide: session_meta message_hours derived from timestamps", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { message_hours?: number[] };
    assert.ok(Array.isArray(meta.message_hours), "must be array");
    assert.equal(meta.message_hours!.length, 3);
    // All timestamps are 18:xx UTC
    assert.ok(meta.message_hours!.every((h) => h === 18), "all hours should be 18 UTC");
  });

  it("ide: session_meta user_response_times gap between turn_end and next user msg", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { user_response_times?: number[] };
    assert.ok(Array.isArray(meta.user_response_times), "must be array");
    // turn-1-end at 18:00:15.020 → msg-u2 at 18:01:00.000 → ~45s gap
    // turn-2-end at 18:01:05.020 → msg-u3 at 18:02:00.000 → ~55s gap
    assert.equal(meta.user_response_times!.length, 2);
    assert.ok(meta.user_response_times![0]! >= 44 && meta.user_response_times![0]! <= 46);
    assert.ok(meta.user_response_times![1]! >= 54 && meta.user_response_times![1]! <= 56);
  });

  it("ide: session_meta ide_context_usage_percent from session_metadata events", () => {
    const rows = db.getPendingConversations(100);
    // Pinned to the session, not the first "kiro-ide:" row: the peak now spans
    // sub-executions, so a positional match reads whichever session sorts first.
    const ide = rows.find((r) => r.session_id === "kiro-ide:sess_test-ide-001");
    assert.ok(ide?.session_meta);
    const meta = JSON.parse(ide.session_meta) as { ide_context_usage_percent?: number };
    // 12.5 is the parent's own peak; 61.25 is the session's once the delegated
    // execution is folded in. See the sub-execution case below.
    assert.equal(meta.ide_context_usage_percent, 61.25);
  });

  it("ide: context peak includes the sub-execution's, not just the parent's", () => {
    const rows = db.getPendingConversations(100);
    const row = rows.find((r) => r.session_id === "kiro-ide:sess_test-ide-001");
    assert.ok(row?.session_meta);
    const meta = JSON.parse(row.session_meta) as { ide_context_usage_percent?: number };
    // The parent alone peaks at 12.5%; the sub-agent reached 61.25%.
    assert.equal(meta.ide_context_usage_percent, 61.25);
  });

  it("ide: turn_usage carries per-turn context and the session model", () => {
    const rows = db.getPendingConversations(100);
    const row = rows.find((r) => r.session_id === "kiro-ide:sess_test-ide-001");
    assert.ok(row?.session_meta);
    const meta = JSON.parse(row.session_meta) as {
      turn_usage?: Array<{ context_usage_percent?: number; model?: string }>;
    };
    // exec-001 reported 12.5%; exec-002 reported none, so it stays absent rather
    // than inheriting a neighbouring turn's occupancy.
    assert.equal(meta.turn_usage?.[0]?.context_usage_percent, 12.5);
    assert.equal(meta.turn_usage?.[1]?.context_usage_percent, undefined);
    // Kiro has no per-turn model switch, so every turn carries session.json's.
    // "auto" is Kiro's router alias and is stored verbatim rather than guessed at.
    for (const t of meta.turn_usage ?? []) assert.equal(t.model, "auto");
  });

  it("ide: session_meta uses_task_agent true when sub-executions exist", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { uses_task_agent?: boolean };
    assert.equal(meta.uses_task_agent, true);
  });

  it("ide: spawned_agent_names are real names, never sub-execution UUIDs", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { spawned_agent_names?: string[] };
    assert.ok(Array.isArray(meta.spawned_agent_names));
    assert.deepEqual(meta.spawned_agent_names, ["context-gatherer"]);
    // The sub-execution filename is an opaque id: publishing it as an agent name
    // makes the field unusable and unbounded in cardinality.
    assert.ok(
      !meta.spawned_agent_names!.includes("a632ca2d-8615-4edf-910d-bd24a77d8ab8"),
      "sub-execution UUID must not be reported as an agent name",
    );
  });

  it("ide: kiro_id is the surface-qualified session key", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id === "kiro-ide:sess_test-ide-001");
    const meta = JSON.parse(ide!.session_meta!) as { kiro_id?: string };
    assert.equal(meta.kiro_id, "kiro-ide:sess_test-ide-001");
    // Same value as the row key, carried inside session_meta so the blob is
    // self-identifying on its own.
    assert.equal(meta.kiro_id, ide!.session_id);
  });

  it("ide: tool_approval_outcomes keyed by the vendor's option kind", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id === "kiro-ide:sess_test-ide-001");
    const meta = JSON.parse(ide!.session_meta!) as { tool_approval_outcomes?: Record<string, number> };
    // The fixture's one approval was answered "reject", whose kind is reject_once.
    // Keyed by kind, not by the optionId the event echoes back.
    assert.deepEqual(meta.tool_approval_outcomes, { reject_once: 1 });
  });

  it("ide: agent_active_seconds is vendor-measured, converted from ms", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id === "kiro-ide:sess_test-ide-001");
    const meta = JSON.parse(ide!.session_meta!) as {
      agent_active_seconds?: number; session_duration_seconds?: number;
    };
    // elapsedTime 5000ms + 4990ms → 9.99s of work inside a 900s wall-clock span.
    assert.ok(Math.abs((meta.agent_active_seconds ?? 0) - 9.99) < 0.001);
    assert.equal(meta.session_duration_seconds, 900);
  });

  it("ide: turn_usage carries per-turn credits, tools and the stop reason", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id === "kiro-ide:sess_test-ide-001");
    const meta = JSON.parse(ide!.session_meta!) as {
      turn_usage?: Array<{ credits?: number; active_seconds?: number; tool_names?: string[]; end_reason?: string }>;
      billing_credits_used?: number;
    };
    assert.equal(meta.turn_usage?.length, 2);
    assert.deepEqual(meta.turn_usage![0]!.tool_names, ["fs_write", "execute_bash"]);
    assert.equal(meta.turn_usage![0]!.active_seconds, 5);
    // turn_end arrives after usage_summary, so this only resolves in the second pass.
    assert.equal(meta.turn_usage![0]!.end_reason, "end_turn");
    // The session total is the sum of the per-turn credits.
    const summed = meta.turn_usage!.reduce((s, t) => s + (t.credits ?? 0), 0);
    assert.ok(Math.abs(summed - (meta.billing_credits_used ?? 0)) < 1e-9);
  });

  it("ide: sub_agent_runs pair the delegation name with its outcome", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id === "kiro-ide:sess_test-ide-001");
    const meta = JSON.parse(ide!.session_meta!) as {
      sub_agent_runs?: Array<{ name?: string; status?: string; sub_session_id?: string }>;
    };
    assert.equal(meta.sub_agent_runs?.length, 1);
    assert.equal(meta.sub_agent_runs![0]!.name, "context-gatherer");
    assert.equal(meta.sub_agent_runs![0]!.status, "success");
    assert.equal(meta.sub_agent_runs![0]!.sub_session_id, "a632ca2d-8615-4edf-910d-bd24a77d8ab8");
  });

  it("ide: tool_origin_counts separates ACP tools from built-ins", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id === "kiro-ide:sess_test-ide-001");
    const meta = JSON.parse(ide!.session_meta!) as {
      tool_origin_counts?: Record<string, number>; builtin_tool_uses?: number; uses_mcp?: boolean;
    };
    assert.equal(meta.tool_origin_counts!["default"], 2);
    assert.equal(meta.tool_origin_counts!["acp"], 1);
    // builtin_tool_uses counts only the "default"-origin calls.
    assert.equal(meta.builtin_tool_uses, 2);
    // An ACP peer is not an MCP server. uses_mcp must track the configured
    // server list only — never a tool origin — so "acp" never leaks into it.
    const full = JSON.parse(ide!.session_meta!) as { mcp_server_names?: string[] };
    assert.ok(
      !(full.mcp_server_names ?? []).includes("acp"),
      "an ACP tool origin must not be reported as an MCP server",
    );
    assert.equal(meta.uses_mcp === true, (full.mcp_server_names ?? []).length > 0);
  });

  it("ide: agentic_session_config omits flags session.json never reported", () => {
    const rows = db.getPendingConversations(100);
    const withFlags = rows.find((r) => r.session_id === "kiro-ide:sess_test-ide-001");
    const meta = JSON.parse(withFlags!.session_meta!) as {
      agentic_session_config?: Record<string, unknown>;
    };
    assert.equal(meta.agentic_session_config!["status"], "completed");
    assert.equal(meta.agentic_session_config!["spec_workflow"], "quick");
    assert.equal(meta.agentic_session_config!["fta_enabled"], false);

    // The second session declares only status + specWorkflow. A written
    // fta_enabled:false there would claim the user turned the setting off.
    const sparse = rows.find((r) => r.session_id === "kiro-ide:sess_test-ide-002");
    const sparseMeta = JSON.parse(sparse!.session_meta!) as {
      agentic_session_config?: Record<string, unknown>;
    };
    assert.equal(sparseMeta.agentic_session_config!["status"], "idle");
    assert.ok(!("fta_enabled" in sparseMeta.agentic_session_config!));
    assert.ok(!("semantic_review_enabled" in sparseMeta.agentic_session_config!));
  });

  it("ide: free text from approvals and sub-agent prompts never reaches session_meta", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id === "kiro-ide:sess_test-ide-001");
    const serialized = ide!.session_meta!;
    // session_meta is stored on its own path; these two vendor fields are free
    // text that can carry secrets (a raw shell command, a delegation prompt), so
    // the extractor must never capture them into any agentic-detail field.
    assert.ok(
      !serialized.includes("rm -rf"),
      "the shell command awaiting approval must not be captured",
    );
    assert.ok(
      !serialized.includes("Find the RFC"),
      "the sub-agent delegation prompt must not be captured",
    );
    assert.ok(
      !serialized.includes("=== Context Gathering Summary ==="),
      "the sub-agent response body must not be captured",
    );
    // ...while the structured facts derived from those same events survive.
    const meta = JSON.parse(serialized) as { tool_approval_outcomes?: Record<string, number> };
    assert.deepEqual(meta.tool_approval_outcomes, { reject_once: 1 });
  });

  it("ide: git_branches carries the branch recovered from the turn's closing prose", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id === "kiro-ide:sess_test-ide-001");
    const meta = JSON.parse(ide!.session_meta!) as { git_branches?: string[] };
    assert.ok(Array.isArray(meta.git_branches), "git_branches must be present");
    // The transcript is the only source a Kiro branch may come from, so this is
    // the whole array, not the first of several — and the remote prefix is stripped.
    assert.deepEqual(meta.git_branches, ["feat/kiro-ide-session-extraction"]);
  });

  it("ide: tracked_file_paths from read_file path and read_code files[].path", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { tracked_file_paths?: string[] };
    assert.ok(Array.isArray(meta.tracked_file_paths), "tracked_file_paths must be present");
    assert.ok(meta.tracked_file_paths!.some((f) => f.includes("README.md")), "read_file path");
    assert.ok(meta.tracked_file_paths!.some((f) => f.includes("index.ts")), "read_code files[].path");
  });

  it("ide: git_pushes counts only shell pushes whose tool_result succeeded", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { git_pushes?: number };
    // Two `git push` commands ran; only one exited successfully.
    assert.equal(meta.git_pushes, 1);
  });

  it("ide: a denied tool approval is categorised, not silently dropped", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { tool_error_categories?: Record<string, number> };
    assert.ok(meta.tool_error_categories, "tool_error_categories must be present");
    assert.equal(meta.tool_error_categories!["tool_rejected"], 1);
  });

  it("ide: every prompt carries the session model from session.json modelId", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const conv = JSON.parse(ide!.conversation) as { role: string; metadata?: { model?: string } }[];
    assert.ok(conv.length > 0, "expected prompts");
    assert.ok(
      conv.every((p) => p.metadata?.model === "auto"),
      "every prompt must carry the session model, so IDE rows are not model-blind",
    );
  });

  it("ide: session_meta files_edited from tool_call args (main + sub-exec), excluding failed edits", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { files_edited?: string[] };
    assert.ok(Array.isArray(meta.files_edited));
    // hello.ts from the main session, greeting.ts from a SUCCESSFUL sub-execution edit.
    assert.ok(meta.files_edited!.some((f) => f.includes("hello.ts")));
    assert.ok(meta.files_edited!.some((f) => f.includes("greeting.ts")));
    // utils.ts's only edit (the sub-exec str_replace) reported success:false, so it
    // is NOT counted — a failed edit is not an edit.
    assert.ok(!meta.files_edited!.some((f) => f.includes("utils.ts")), "a failed edit must not appear in files_edited");
  });

  it("ide: ai_attribution composer_suggested_lines from write tool args", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    assert.ok(ide!.ai_attribution, "ai_attribution must be present");
    const attr = JSON.parse(ide!.ai_attribution!) as { composer_suggested_lines?: number };
    // Logical (git/patch-style) line counts, excluding failed edits:
    //   main fs_write hello.ts "…hello');\n…world');\n" = 2 lines (trailing newline
    //     terminates the last line, not a 3rd empty one)
    //   sub-exec fs_append greeting.ts "export const hi = 1;\n" = 1 line
    //   sub-exec str_replace utils.ts FAILED → 0
    // = 3.
    assert.equal(attr.composer_suggested_lines ?? 0, 3, `expected 3, got ${attr.composer_suggested_lines}`);
  });

  it("ide: conversation has user and assistant prompts with timestamps", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id === "kiro-ide:sess_test-ide-001");
    assert.ok(ide?.conversation);
    const conv = JSON.parse(ide.conversation) as {
      role: string; content: string; timestamp?: string; metadata?: { isSubAgent?: boolean };
    }[];
    const human = conv.filter((m) => m.role === "user" && !m.metadata?.isSubAgent);
    const assistants = conv.filter((m) => m.role === "assistant");
    assert.equal(human.length, 3);
    assert.equal(assistants.length, 3);
    assert.ok(human[0]!.content.includes("hello world"));
    // Timestamps should be present on messages
    assert.ok(human[0]!.timestamp, "user prompts should have timestamps");
  });

  it("ide: folds the sub-execution's turns into the parent conversation", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id === "kiro-ide:sess_test-ide-001");
    assert.ok(ide?.conversation && ide.session_meta);
    const conv = JSON.parse(ide.conversation) as {
      role: string; content: string; timestamp?: string; metadata?: { isSubAgent?: boolean; model?: string };
    }[];

    // A Kiro sub-execution never becomes its own session, so its work belongs to
    // this conversation rather than being narrated second-hand by the parent.
    const delegated = conv.filter((m) => m.metadata?.isSubAgent);
    assert.equal(delegated.length, 1);
    assert.ok(delegated[0]!.content.includes("format code"));
    // Same session model as the rest of the conversation.
    assert.equal(delegated[0]!.metadata?.model, "auto");

    // Interleaved by time, not appended after the parent's closing summary.
    const times = conv.map((m) => (m.timestamp ? Date.parse(m.timestamp) : 0));
    assert.deepEqual(times, [...times].sort((a, b) => a - b));

    // The human's own counts must not move: a sub-agent's task prompt is the
    // main agent talking to itself, and counting it would inflate per-prompt
    // rates. Assistant output does fold, as its chars and credits already do.
    const meta = JSON.parse(ide.session_meta) as {
      user_message_count?: number; assistant_message_count?: number;
    };
    assert.equal(meta.user_message_count, 3);
    assert.equal(meta.assistant_message_count, 3);
  });

  it("ide: session_meta user_message_count and assistant_message_count", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { user_message_count?: number; assistant_message_count?: number };
    assert.equal(meta.user_message_count, 3);
    assert.equal(meta.assistant_message_count, 3);
  });

  it("ide: session_meta session_duration_seconds from createdAt/lastModifiedAt", () => {
    const rows = db.getPendingConversations(100);
    const ide = rows.find((r) => r.session_id.startsWith("kiro-ide:"));
    const meta = JSON.parse(ide!.session_meta!) as { session_duration_seconds?: number };
    // 18:00 → 18:15 = 900 seconds
    assert.equal(meta.session_duration_seconds, 900);
  });

  it("ide: incremental tracking — second run returns 0 (no file changes)", () => {
    const count2 = extractKiro(db);
    assert.equal(count2, 0, "no sessions should be re-processed on second run without file changes");
  });

  // ── Error handling ───────────────────────────────────────────────────────────

  it("returns 0 when all paths point to nonexistent directories", () => {
    const nonexistent = join(tmpDir, "definitely-does-not-exist");
    const savedLegacy = getPathOverride("KIRO_SESSIONS_PATH");
    const savedCli = getPathOverride("KIRO_CLI_SESSIONS_PATH");
    const savedIde = getPathOverride("KIRO_IDE_SESSIONS_PATH");
    const savedCrew = getPathOverride("KIRO_CREW_PATH");
    setPathOverrides({ KIRO_SESSIONS_PATH: nonexistent });
    setPathOverrides({ KIRO_CLI_SESSIONS_PATH: nonexistent });
    setPathOverrides({ KIRO_IDE_SESSIONS_PATH: nonexistent });
    setPathOverrides({ KIRO_CREW_PATH: nonexistent });
    try {
      const emptyDb = new SessionStore(join(tmpDir, "empty.db"));
      const count = extractKiro(emptyDb);
      assert.equal(count, 0, "should return 0 when no session dirs found");
    } finally {
      setPathOverrides({ KIRO_SESSIONS_PATH: savedLegacy });
      setPathOverrides({ KIRO_CLI_SESSIONS_PATH: savedCli });
      if (savedCrew === undefined) setPathOverrides({ KIRO_CREW_PATH: undefined });
      else setPathOverrides({ KIRO_CREW_PATH: savedCrew });
      setPathOverrides({ KIRO_IDE_SESSIONS_PATH: savedIde });
    }
  });
});

// ── parseIdeMessages unit tests ────────────────────────────────────────────────

describe("parseIdeMessages — unit", () => {
  it("extracts user and assistant prompts with timestamps", () => {
    const lines = [
      JSON.stringify({ id: "u1", timestamp: "2026-01-01T10:00:00Z", payload: { type: "user", content: "hello" } }),
      JSON.stringify({ id: "a1", timestamp: "2026-01-01T10:00:05Z", payload: { type: "assistant", content: "hi there" } }),
    ];
    const result = parseIdeMessages(lines);
    assert.equal(result.prompts.length, 2);
    assert.equal(result.prompts[0]!.role, "user");
    assert.equal(result.prompts[0]!.timestamp, "2026-01-01T10:00:00Z");
    assert.equal(result.prompts[1]!.role, "assistant");
  });

  it("counts tools from tool_call events", () => {
    const lines = [
      JSON.stringify({ id: "tc1", timestamp: "2026-01-01T10:00:00Z", payload: { type: "tool_call", toolName: "read_file", args: {} } }),
      JSON.stringify({ id: "tc2", timestamp: "2026-01-01T10:00:01Z", payload: { type: "tool_call", toolName: "read_file", args: {} } }),
      JSON.stringify({ id: "tc3", timestamp: "2026-01-01T10:00:02Z", payload: { type: "tool_call", toolName: "fs_write", args: { path: "a.ts", text: "x\ny\n" } } }),
    ];
    const result = parseIdeMessages(lines);
    assert.equal(result.toolCounts["read_file"], 2);
    assert.equal(result.toolCounts["fs_write"], 1);
    assert.equal(result.filesEdited.size, 1);
    assert.ok(result.filesEdited.has("a.ts"));
  });

  it("counts tool errors from failed tool_results", () => {
    const lines = [
      JSON.stringify({ id: "tr1", payload: { type: "tool_result", success: false } }),
      JSON.stringify({ id: "tr2", payload: { type: "tool_result", success: true } }),
      JSON.stringify({ id: "tr3", payload: { type: "tool_result", success: false } }),
    ];
    const result = parseIdeMessages(lines);
    assert.equal(result.toolErrors, 2);
  });

  it("counts only user cancellations as interruptions, not every non-end_turn reason", () => {
    const lines = [
      JSON.stringify({ id: "te1", timestamp: "2026-01-01T10:00:00Z", payload: { type: "turn_end", stopReason: "end_turn" } }),
      JSON.stringify({ id: "te2", timestamp: "2026-01-01T10:00:01Z", payload: { type: "turn_end", stopReason: "user_interrupt" } }),
      JSON.stringify({ id: "te3", timestamp: "2026-01-01T10:00:02Z", payload: { type: "turn_end", stopReason: "max_tokens" } }),
    ];
    const result = parseIdeMessages(lines);
    // max_tokens is the model running out of room, not the user stopping it.
    assert.equal(result.userInterruptions, 1);
  });

  it("sums credits from usage_summary events", () => {
    const lines = [
      JSON.stringify({ id: "us1", payload: { type: "usage_summary", promptTurnSummaries: [{ usage: 1.5 }], elapsedTime: 3000 } }),
      JSON.stringify({ id: "us2", payload: { type: "usage_summary", promptTurnSummaries: [{ usage: 2.0 }], elapsedTime: 2000 } }),
    ];
    const result = parseIdeMessages(lines);
    assert.ok(Math.abs(result.totalCredits - 3.5) < 0.001);
    assert.equal(result.totalElapsedMs, 5000);
  });

  it("tracks max context usage percent from session_metadata events", () => {
    const lines = [
      JSON.stringify({ id: "sm1", payload: { type: "session_metadata", key: "contextUsage", value: { usagePercentage: 5.0 } } }),
      JSON.stringify({ id: "sm2", payload: { type: "session_metadata", key: "contextUsage", value: { usagePercentage: 25.0 } } }),
      JSON.stringify({ id: "sm3", payload: { type: "session_metadata", key: "contextUsage", value: { usagePercentage: 15.0 } } }),
    ];
    const result = parseIdeMessages(lines);
    assert.equal(result.maxContextUsagePercent, 25.0);
  });

  // ── unset-vs-zero presence (the `optional` turn-telemetry proto fields) ──────
  // A turn whose elapsed time or context occupancy was measured as 0 must emit
  // that 0, distinct from a turn where the value was never reported (field
  // omitted). Each assertion below FAILS if the producer reverts to the old
  // `elapsedTime > 0` / `?? 0` guards that collapsed a real 0 into "absent".

  it("presence: elapsedTime of 0 keeps active_seconds: 0; an absent elapsedTime omits it", () => {
    const lines = [
      // A turn that ran but reported 0ms elapsed — a measured zero.
      JSON.stringify({ id: "us1", payload: { type: "usage_summary", executionId: "e1", elapsedTime: 0, promptTurnSummaries: [{ usage: 1.0 }] } }),
      // A turn with no elapsedTime field at all — genuinely unmeasured.
      JSON.stringify({ id: "us2", payload: { type: "usage_summary", executionId: "e2", promptTurnSummaries: [{ usage: 1.0 }] } }),
    ];
    const result = parseIdeMessages(lines);
    assert.equal(result.turnUsage.length, 2);
    assert.equal(result.turnUsage[0]!.active_seconds, 0, "0ms elapsed → active_seconds 0, not dropped");
    assert.equal(result.turnUsage[1]!.active_seconds, undefined, "no elapsedTime → active_seconds omitted");
  });

  it("presence: a contextUsage report of 0 keeps context_usage_percent: 0; no report omits it", () => {
    const lines = [
      // Turn e1: usage_summary creates the turn; a contextUsage of 0 on the same
      // execution is a measured 0% occupancy.
      JSON.stringify({ id: "us1", payload: { type: "usage_summary", executionId: "e1", elapsedTime: 5000, promptTurnSummaries: [{ usage: 1.0 }] } }),
      JSON.stringify({ id: "sm1", payload: { type: "session_metadata", key: "contextUsage", value: { usagePercentage: 0 }, executionId: "e1" } }),
      // Turn e2: no contextUsage event → occupancy genuinely unmeasured.
      JSON.stringify({ id: "us2", payload: { type: "usage_summary", executionId: "e2", elapsedTime: 5000, promptTurnSummaries: [{ usage: 1.0 }] } }),
    ];
    const result = parseIdeMessages(lines);
    assert.equal(result.turnUsage.length, 2);
    assert.equal(result.turnUsage[0]!.context_usage_percent, 0, "a 0% occupancy report → context_usage_percent 0, not dropped");
    assert.equal(result.turnUsage[1]!.context_usage_percent, undefined, "no occupancy report → context_usage_percent omitted");
  });

  it("skips malformed JSON lines gracefully", () => {
    const lines = [
      "not valid json",
      JSON.stringify({ id: "u1", timestamp: "2026-01-01T10:00:00Z", payload: { type: "user", content: "valid" } }),
      "{incomplete",
    ];
    const result = parseIdeMessages(lines);
    assert.equal(result.prompts.length, 1);
    assert.equal(result.prompts[0]!.content, "valid");
  });

  it("skips empty user content", () => {
    const lines = [
      JSON.stringify({ id: "u1", payload: { type: "user", content: "" } }),
      JSON.stringify({ id: "u2", payload: { type: "user", content: "  " } }),
      JSON.stringify({ id: "u3", payload: { type: "user", content: "real content" } }),
    ];
    const result = parseIdeMessages(lines);
    assert.equal(result.prompts.length, 1);
    assert.equal(result.prompts[0]!.content, "real content");
  });
});

// ── Workspace artifact counters ───────────────────────────────────────────────

describe("countWorkspaceArtifacts — hook glob", () => {
  let wsDir: string;

  before(() => {
    wsDir = mkdtempSync(join(tmpdir(), "lse-kiro-artifacts-"));
    const hooksDir = join(wsDir, ".kiro", "hooks");
    mkdirSync(hooksDir, { recursive: true });
    // A .json hook manifest AND a .kiro.hook manifest — both counted, so the
    // adoption signal doesn't undercount either format.
    writeJson(join(hooksDir, "legacy.json"), {
      version: "v1",
      hooks: [{ name: "legacy", trigger: "PostFileSave", action: { type: "command", command: "echo hi" } }],
    });
    writeFileSync(join(hooksDir, "format-on-save.kiro.hook"), "{}", "utf-8");
    // Triggerless JSON is NOT a hook — it is rejected by the asset inventory, so
    // counting it here would report adoption as healthier than the inventory shows.
    writeJson(join(hooksDir, "notes.json"), { note: "scratch" });
    // A non-hook file in the dir must not inflate the count.
    writeFileSync(join(hooksDir, "README.md"), "notes", "utf-8");
  });

  after(() => {
    rmSync(wsDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("counts both manifest formats, and no triggerless JSON", () => {
    const artifacts = countWorkspaceArtifacts(wsDir);
    // legacy.json + format-on-save.kiro.hook; notes.json and README.md excluded.
    assert.equal(artifacts.hookCount, 2);
  });
});

// ── Kiro Desktop: reflog branch recovery ──────────────────────────────────────
//
// Its own fixture, not the shared one above: that suite's assertions locate the
// legacy row with `find(startsWith("kiro-desktop-legacy:"))`, so a second legacy
// session there would be picked up by whichever assertion ran first.
describe("kiroExtractor — desktop surface recovers a windowed branch", () => {
  let tmpDir: string;
  let db: SessionStore;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-kiro-desktop-reflog-"));
    db = new SessionStore(join(tmpDir, "test.db"));

    const wsDir = join(tmpDir, "repo");
    mkdirSync(wsDir, { recursive: true });
    const git = (...args: string[]): void => {
      execFileSync("git", args, { cwd: wsDir, stdio: "ignore" });
    };
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(wsDir, "a.txt"), "a\n", "utf-8");
    git("add", "-A");
    git("commit", "-qm", "init");
    // Writes `checkout: moving from <trunk> to feat/desktop-recovered`, stamped
    // now — inside the window built below.
    git("checkout", "-qb", "feat/desktop-recovered");

    const legacyRoot = join(tmpDir, "legacy-sessions");
    const legacyWsDir = join(legacyRoot, "legacy-ws-001");
    mkdirSync(legacyWsDir, { recursive: true });
    writeJson(join(legacyWsDir, "sessions.json"), [
      {
        sessionId: "kiro-legacy-git-001",
        title: "Legacy git session",
        dateCreated: String(Date.now() - 60 * 60 * 1000),
        workspaceDirectory: wsDir,
      },
    ]);
    writeJson(join(legacyWsDir, "kiro-legacy-git-001.json"), {
      sessionId: "kiro-legacy-git-001",
      title: "Legacy git session",
      workspacePath: wsDir,
      autonomyMode: "supervised",
      sessionType: "agent",
      selectedModel: "claude-sonnet-4-5",
      history: [
        { message: { role: "user", content: "Refactor the parser", id: "u1" } },
        { message: { role: "assistant", content: "Done.", id: "a1" } },
      ],
    });

    setPathOverrides({ KIRO_SESSIONS_PATH: legacyRoot });
    // Every other Kiro surface points at nothing, so the only row is the desktop one.
    setPathOverrides({ KIRO_CLI_SESSIONS_PATH: join(tmpDir, "none-cli") });
    setPathOverrides({ KIRO_IDE_SESSIONS_PATH: join(tmpDir, "none-ide") });
    setPathOverrides({ KIRO_DB_PATH: join(tmpDir, "none-db") });
    setPathOverrides({ KIRO_CLI_DB_PATH: join(tmpDir, "none-cli.sqlite3") });
    setPathOverrides({ KIRO_CREW_PATH: join(tmpDir, "none-crew") });
    setPathOverrides({ KIRO_USER_MCP_PATH: join(tmpDir, "none-mcp.json") });

    extractKiro(db);
  });

  after(() => {
    setPathOverrides({ KIRO_SESSIONS_PATH: undefined, KIRO_CLI_SESSIONS_PATH: undefined, KIRO_IDE_SESSIONS_PATH: undefined, KIRO_DB_PATH: undefined, KIRO_CLI_DB_PATH: undefined, KIRO_CREW_PATH: undefined, KIRO_USER_MCP_PATH: undefined });
    db.close();
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("stamps the reflog-recovered branch, so the gate has evidence to judge", () => {
    // This surface reads a stored JSON session: no command transcript, so no
    // `gh pr create` receipt, so the reflog is its only route to a branch. With
    // no branch at all, matchBranch returns before the corroborator gate runs and
    // the session's stored branch match becomes withdrawable with nothing to
    // replace it — the gate keys on ide_type, which covers all three Kiro
    // surfaces, so a surface without a producer loses attribution rather than
    // having it corrected.
    const rows = db.getPendingConversations(100);
    const legacy = rows.find((r) => r.session_id.startsWith("kiro-desktop-legacy:"));
    assert.ok(legacy, "expected a legacy desktop row");
    const meta = JSON.parse(legacy!.session_meta!) as {
      git_branches?: string[];
      branch_signals?: Array<{ name: string; source: string }>;
    };
    assert.deepEqual(meta.git_branches, ["feat/desktop-recovered"]);
    assert.deepEqual(meta.branch_signals, [
      { name: "feat/desktop-recovered", source: "SIGNAL_SOURCE_LOCAL_GIT_WINDOWED" },
    ]);
  });
});

// ── Kiro CLI: unset-vs-zero presence for per-turn active_seconds ────────────────
//
// Its own fixture, not the shared one above: that suite pins agent_active_seconds
// = 35 and a two-turn shape, so it has no zero-duration or duration-less turn to
// exercise the `optional` proto contract. A turn whose turn_duration is a real
// {secs:0,nanos:0} must emit active_seconds: 0; a turn with no turn_duration must
// omit it. The 0 assertion FAILS if buildTurnUsage reverts to the old
// `activeSeconds > 0` guard that collapsed a measured 0 back into "absent".
describe("kiroExtractor — CLI per-turn active_seconds presence", () => {
  let tmpDir: string;
  let db: SessionStore;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lse-kiro-cli-presence-"));
    db = new SessionStore(join(tmpDir, "test.db"));

    const cliRoot = join(tmpDir, "cli-sessions");
    mkdirSync(cliRoot, { recursive: true });

    writeJson(join(cliRoot, "session-cli-zero.json"), {
      session_id: "session-cli-zero",
      cwd: "/tmp/project",
      created_at: "2026-04-01T10:00:00.000Z",
      updated_at: "2026-04-01T10:10:00.000Z",
      title: "CLI presence fixture",
      session_state: {
        conversation_metadata: {
          user_turn_metadatas: [
            {
              loop_id: { agent_id: { name: "main", parent_id: null }, rand: 1 },
              metering_usage: [{ value: 1.0, unit: "credits" }],
              end_reason: "UserTurnEnd",
              model: "claude-sonnet-4-5",
              // A real turn that finished in under a second: Kiro's Rust Duration
              // split is {secs:0,nanos:0}. Present, and genuinely zero.
              turn_duration: { secs: 0, nanos: 0 },
            },
            {
              loop_id: { agent_id: { name: "main", parent_id: null }, rand: 2 },
              metering_usage: [{ value: 1.0, unit: "credits" }],
              end_reason: "UserTurnEnd",
              model: "claude-sonnet-4-5",
              // No turn_duration key at all — the CLI never reported one.
            },
          ],
        },
        rts_model_state: { model_info: { model_id: "claude-sonnet-4-5" } },
        agent_name: "main",
      },
    });

    const epochSecs = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    writeJsonl(join(cliRoot, "session-cli-zero.jsonl"), [
      { kind: "Prompt", data: { message_id: "m1", meta: { timestamp: epochSecs("2026-04-01T10:00:05.000Z") }, content: [{ kind: "text", data: "Do the thing" }] } },
      { kind: "AssistantMessage", data: { message_id: "m2", content: [{ kind: "text", data: "Done." }] } },
    ]);

    // Point every Kiro surface except the CLI at nothing, and keep the run off
    // the developer's real ~/.kiro / global storage.
    setPathOverrides({ KIRO_CLI_SESSIONS_PATH: cliRoot });
    setPathOverrides({ KIRO_SESSIONS_PATH: join(tmpDir, "none-legacy") });
    setPathOverrides({ KIRO_IDE_SESSIONS_PATH: join(tmpDir, "none-ide") });
    setPathOverrides({ KIRO_DB_PATH: join(tmpDir, "none-db") });
    setPathOverrides({ KIRO_CLI_DB_PATH: join(tmpDir, "none-cli.sqlite3") });
    setPathOverrides({ KIRO_CREW_PATH: join(tmpDir, "none-crew") });
    setPathOverrides({ KIRO_USER_MCP_PATH: join(tmpDir, "none-mcp.json") });

    extractKiro(db);
  });

  after(() => {
    setPathOverrides({ KIRO_CLI_SESSIONS_PATH: undefined, KIRO_SESSIONS_PATH: undefined, KIRO_IDE_SESSIONS_PATH: undefined, KIRO_DB_PATH: undefined, KIRO_CLI_DB_PATH: undefined, KIRO_CREW_PATH: undefined, KIRO_USER_MCP_PATH: undefined });
    db.close();
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const cases: Array<{ name: string; idx: number; expected: number | undefined }> = [
    { name: "a {secs:0,nanos:0} turn keeps active_seconds: 0", idx: 0, expected: 0 },
    { name: "a turn with no turn_duration omits active_seconds", idx: 1, expected: undefined },
  ];
  for (const c of cases) {
    it(`cli: ${c.name}`, () => {
      const rows = db.getPendingConversations(100);
      const cli = rows.find((r) => r.session_id.startsWith("kiro-cli:"));
      assert.ok(cli?.session_meta, "expected a CLI row with session_meta");
      const meta = JSON.parse(cli.session_meta) as {
        turn_usage?: Array<{ active_seconds?: number }>;
      };
      assert.equal(meta.turn_usage?.length, 2, "both turns must appear in turn_usage");
      assert.equal(meta.turn_usage![c.idx]!.active_seconds, c.expected);
    });
  }
});
