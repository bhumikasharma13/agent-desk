// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import * as https from "node:https";
import { accessSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationPrompt, SessionMetaPayload } from "../types/session";
import type { SessionSink } from "../types/store";
import { redactPrompts, redactPath, sanitizeSessionMeta } from "../redaction";
import { SQLiteReader, openVendorDb } from "./sqliteReader";
import { logger } from "../seams/logger";
import { reportRecordError, reportSourceError } from "../seams/scanScope";
import {
  getAntigravityDbPath,
  getAntigravityBrainPath,
  getAntigravityWorkspaceStoragePath,
  hasPathOverride,
  homeRootOverride,
} from "./pathResolver";
import { resolveProjectAndRepo } from "./gitUtils";

const execAsync = promisify(execCb);

// ── Server discovery types ──────────────────────────────────────────────────

interface ServerInfo {
  pid: number;
  csrfToken: string;
  extensionPort: number;
  connectPort: number;
  /** Workspace ID from command line, e.g. "file_Users_name_projects_repo" */
  workspaceId: string | undefined;
}

// ── API response types ──────────────────────────────────────────────────────

interface WorkspaceInfo {
  workspaceFolderAbsoluteUri: string;
  gitRootAbsoluteUri?: string;
  repository?: {
    computedName?: string;   // "org/repo" format
    gitOriginUrl?: string;   // full remote URL
  };
  branchName?: string;
}

interface TrajectorySummaryApi {
  summary: string;
  stepCount: number;
  lastModifiedTime: string;
  createdTime: string;
  trajectoryId: string;
  status: string;
  workspaces: WorkspaceInfo[];
  lastUserInputStepIndex: number;
}

interface TrajectoryStep {
  type: string;
  status: string;
  metadata?: { createdAt?: string; completedAt?: string };
  userInput?: { userResponse?: string };
  notifyUser?: { message?: string };
}

// ── Minimal protobuf binary parser (fallback) ───────────────────────────────

type ProtoValue = number | Buffer;
type ProtoFields = Map<number, ProtoValue[]>;

function readVarint(buf: Buffer, pos: number): [number, number] {
  let result = 0;
  let multiplier = 1;
  while (pos < buf.length) {
    const byte = buf[pos++]!;
    result += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) break;
    multiplier *= 128;
    if (multiplier > Number.MAX_SAFE_INTEGER) break;
  }
  return [result, pos];
}

function parseProto(buf: Buffer): ProtoFields {
  const fields: ProtoFields = new Map();
  let pos = 0;
  while (pos < buf.length) {
    let tag: number;
    [tag, pos] = readVarint(buf, pos);
    if (pos > buf.length) break;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    const arr = fields.get(fieldNum) ?? [];
    if (!fields.has(fieldNum)) fields.set(fieldNum, arr);
    if (wireType === 0) {
      let val: number;
      [val, pos] = readVarint(buf, pos);
      arr.push(val);
    } else if (wireType === 2) {
      let len: number;
      [len, pos] = readVarint(buf, pos);
      if (pos + len > buf.length) break;
      arr.push(buf.subarray(pos, pos + len) as unknown as Buffer);
      pos += len;
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break;
    }
  }
  return fields;
}

function getString(fields: ProtoFields, fieldNum: number): string | undefined {
  const vals = fields.get(fieldNum);
  if (!vals || vals.length === 0) return undefined;
  const v = vals[0];
  if (!(v instanceof Buffer)) return undefined;
  return v.toString("utf8");
}

function getInt(fields: ProtoFields, fieldNum: number): number | undefined {
  const vals = fields.get(fieldNum);
  if (!vals || vals.length === 0) return undefined;
  const v = vals[0];
  if (typeof v !== "number") return undefined;
  return v;
}

function getMessages(fields: ProtoFields, fieldNum: number): ProtoFields[] {
  const vals = fields.get(fieldNum);
  if (!vals) return [];
  const result: ProtoFields[] = [];
  for (const v of vals) {
    if (v instanceof Buffer) {
      try {
        result.push(parseProto(v));
      } catch {
        // skip malformed
      }
    }
  }
  return result;
}

// ── Data types ──────────────────────────────────────────────────────────────

interface TrajectorySummary {
  id: string;
  title: string;
  stepCount: number;
  updatedAtMs: number;
  createdAtMs: number;
  workspaceUri: string | undefined;
}

const SYSTEM_GENERATED_PREFIX = "This is a system-generated message";
const SERVICE_PATH = "/exa.language_server_pb.LanguageServerService";

// Antigravity Connect-RPC API tunables. probe = how long to wait for
// discovery; request = per-trajectory fetch budget; max_steps = cap on
// steps pulled per trajectory.
const PROBE_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_API_STEPS = 10_000;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Extracts Antigravity IDE conversations. Tries the local Connect-RPC API
 * first (full step data for ALL trajectories), falls back to state.vscdb
 * protobuf parsing + brain directory when Antigravity isn't running.
 */
export async function extractAntigravity(db: SessionSink): Promise<number> {
  // A caller that redirected the DB path or the home root is reading a fixture
  // or another home, so API discovery is skipped and the offline fallback runs
  // deterministically: the running Antigravity process serves this machine's
  // real sessions, which lie outside the redirected tree.
  const skipApi = hasPathOverride("ANTIGRAVITY_DB_PATH") || homeRootOverride() !== undefined;

  // Try API-first (highest quality — actual user prompts + assistant responses)
  // Only skip the offline fallback if we actually contacted a server successfully.
  if (!skipApi) {
    try {
      const servers = await discoverServers();
      if (servers.length > 0) {
        const fromApi = await extractFromApi(db, servers);
        if (fromApi !== null) return fromApi;
        logger.warn("extraction.antigravity", "api_listing_failed_using_offline", { servers: servers.length });
      }
    } catch (err) {
      logger.warn("extraction.antigravity", "api_extraction_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Fallback: protobuf parsing from state.vscdb + brain directory
  return extractFromOffline(db);
}

// ── API-based extraction ────────────────────────────────────────────────────

/**
 * Reads every server's sessions; the count written, or null when no server's
 * session list could be read at all (the caller then reads the offline store).
 */
async function extractFromApi(db: SessionSink, servers: ServerInfo[]): Promise<number | null> {
  let extracted = 0;
  let listedAny = false;

  for (const server of servers) {
    let summaries: Record<string, TrajectorySummaryApi>;
    try {
      const resp = await apiPost<{ trajectorySummaries: Record<string, TrajectorySummaryApi> }>(
        server, "GetAllCascadeTrajectories", {}
      );
      summaries = resp.trajectorySummaries ?? {};
      listedAny = true;
    } catch {
      continue;
    }

    for (const [cascadeId, summary] of Object.entries(summaries)) {
      try {
        const updated = await processApiTrajectory(db, server, cascadeId, summary);
        if (updated) extracted++;
      } catch (err) {
        logger.error("extraction.antigravity", "api_trajectory_processing_error", {
          cascadeId,
          error: err instanceof Error ? err.message : String(err),
        });
        reportRecordError(cascadeId, null, err);
      }
    }
  }

  return listedAny ? extracted : null;
}

async function processApiTrajectory(
  db: SessionSink,
  server: ServerInfo,
  cascadeId: string,
  summary: TrajectorySummaryApi
): Promise<boolean> {
  const sessionId = cascadeId;
  const updatedAtMs = summary.lastModifiedTime
    ? new Date(summary.lastModifiedTime).getTime()
    : 0;

  // Resolve project path and repo name from trajectory workspaces.
  // The API provides gitRootAbsoluteUri and repository.computedName directly.
  const rawProjectPath =
    extractGitRootFromWorkspaces(summary.workspaces) ??
    extractProjectPathFromWorkspaces(summary.workspaces) ??
    resolveWorkspaceId(server.workspaceId);
  const apiRepoName = extractRepoNameFromWorkspaces(summary.workspaces);

  // Central resolution: use API-provided repo name if available, otherwise infer
  const workspaceFilePaths = extractAllWorkspacePaths(summary.workspaces);
  const resolved = resolveProjectAndRepo(rawProjectPath ?? undefined, workspaceFilePaths);
  const finalProjectPath = resolved?.projectPath ?? rawProjectPath;
  const repoName = apiRepoName ?? resolved?.repoName;

  const tracking = db.getTracking("antigravity", sessionId);
  if (tracking && tracking.last_mtime_ms === updatedAtMs) {
    if (finalProjectPath) {
      const redacted = redactPath(finalProjectPath);
      if (redacted !== tracking.project_path) {
        db.updateProjectPath("antigravity", sessionId, redacted);
      }
    }
    if (repoName && repoName !== tracking.repo_name) {
      db.updateRepoName("antigravity", sessionId, repoName);
    }
    return false;
  }

  // Fetch full step data
  let steps: TrajectoryStep[];
  try {
    const resp = await apiPost<{ steps: TrajectoryStep[] }>(
      server, "GetCascadeTrajectorySteps",
      { cascadeId, startIndex: 0, endIndex: MAX_API_STEPS }
    );
    steps = Array.isArray(resp.steps) ? resp.steps : [];
  } catch {
    return false;
  }

  const prompts = buildApiConversation(summary, steps);
  if (prompts.length === 0) return false;

  const redactedPrompts = redactPrompts(prompts);
  const redactedProjectPath = finalProjectPath ? redactPath(finalProjectPath) : undefined;

  // summary.summary is the trajectory's title despite the field name — the
  // same concept as the offline protobuf's title field (buildApiConversation
  // above already treats it as one, using it as a fallback prompt).
  const meta: SessionMetaPayload = {};
  const apiTitle = typeof summary.summary === "string" ? summary.summary.trim() : "";
  if (apiTitle) meta.session_title = apiTitle;
  const sessionMetaJson = Object.keys(meta).length > 0 ? JSON.stringify(sanitizeSessionMeta(meta)) : undefined;

  db.upsert({
    ideType: "antigravity",
    sessionId,
    conversation: redactedPrompts,
    projectPath: redactedProjectPath,
    repoName,
    lastMtimeMs: updatedAtMs,
    lastSize: summary.stepCount ?? steps.length,
    lastOffset: 0,
    sessionMeta: sessionMetaJson,
  });

  return true;
}

function buildApiConversation(
  summary: TrajectorySummaryApi,
  steps: TrajectoryStep[]
): ConversationPrompt[] {
  const prompts: ConversationPrompt[] = [];

  for (const step of steps) {
    if (step.type === "CORTEX_STEP_TYPE_USER_INPUT") {
      const text = step.userInput?.userResponse ?? "";
      if (!text.trim() || text.startsWith(SYSTEM_GENERATED_PREFIX)) continue;
      prompts.push({
        role: "user",
        content: text,
        timestamp: step.metadata?.createdAt,
      });
    }

    if (step.type === "CORTEX_STEP_TYPE_NOTIFY_USER") {
      const text = step.notifyUser?.message ?? "";
      if (!text.trim()) continue;
      prompts.push({
        role: "assistant",
        content: text,
        timestamp: step.metadata?.createdAt,
      });
    }
  }

  // If API returned no user/notify steps, use title as a fallback user prompt
  if (prompts.length === 0 && summary.summary?.trim()) {
    prompts.push({
      role: "user",
      content: summary.summary,
      timestamp: summary.createdTime,
    });
  }

  return prompts;
}

function extractProjectPathFromWorkspaces(
  workspaces: WorkspaceInfo[] | undefined
): string | undefined {
  if (!Array.isArray(workspaces) || workspaces.length === 0) return undefined;
  const uri = workspaces[0]?.workspaceFolderAbsoluteUri;
  if (typeof uri !== "string") return undefined;
  return resolveProjectPath(uri);
}

/**
 * Extracts the git root path from workspace data (the API provides it directly).
 */
function extractGitRootFromWorkspaces(
  workspaces: WorkspaceInfo[] | undefined
): string | undefined {
  if (!Array.isArray(workspaces) || workspaces.length === 0) return undefined;
  const uri = workspaces[0]?.gitRootAbsoluteUri;
  if (typeof uri !== "string") return undefined;
  return resolveProjectPath(uri);
}

/**
 * Extracts the repo name ("org/repo") from workspace data.
 * The API provides repository.computedName directly — no need to read .git/config.
 */
function extractRepoNameFromWorkspaces(
  workspaces: WorkspaceInfo[] | undefined
): string | undefined {
  if (!Array.isArray(workspaces) || workspaces.length === 0) return undefined;
  const name = workspaces[0]?.repository?.computedName;
  if (typeof name === "string" && name.includes("/")) return name;
  return undefined;
}

/**
 * Extracts ALL workspace folder paths from the trajectory (not just the first).
 * Used as fallback file paths for repo inference when the primary path has no .git.
 */
function extractAllWorkspacePaths(
  workspaces: WorkspaceInfo[] | undefined
): string[] {
  if (!Array.isArray(workspaces)) return [];
  const paths: string[] = [];
  for (const ws of workspaces) {
    const p = resolveProjectPath(ws.workspaceFolderAbsoluteUri);
    if (p) paths.push(p);
    const gitRoot = resolveProjectPath(ws.gitRootAbsoluteUri);
    if (gitRoot && gitRoot !== p) paths.push(gitRoot);
  }
  return paths;
}

// ── Token sanitization ──────────────────────────────────────────────────────

/**
 * Sanitizes values parsed from process command-line arguments before use in
 * HTTP headers. Strips control characters and enforces a length limit to
 * prevent header injection.
 */
function sanitizeHeaderValue(value: string): string | null {
  // Remove any characters outside printable ASCII (0x20–0x7E), excluding CR/LF
  const sanitized = value.replace(/[^\x20-\x7E]/g, "");
  // Reject if empty or suspiciously long after sanitization
  if (sanitized.length === 0 || sanitized.length > 512) return null;
  // Reject if it contains header injection sequences
  if (/[\r\n]/.test(sanitized)) return null;
  return sanitized;
}

// ── Server discovery ────────────────────────────────────────────────────────

async function discoverServers(): Promise<ServerInfo[]> {
  let stdout: string;
  try {
    const result = await execAsync("ps -ax -o pid=,command=", {
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    stdout = result.stdout;
  } catch {
    return [];
  }

  const lines = stdout.split("\n");
  const candidates: { pid: number; csrfToken: string; extensionPort: number; workspaceId: string | undefined }[] = [];

  for (const line of lines) {
    if (!line.includes("language_server_macos") || !line.includes("antigravity")) continue;

    const pidMatch = /^\s*(\d+)\s+/.exec(line);
    if (!pidMatch) continue;
    const pid = parseInt(pidMatch[1]!, 10);

    const csrfMatch = /--csrf_token\s+(\S+)/.exec(line);
    const portMatch = /--extension_server_port\s+(\d+)/.exec(line);
    if (!csrfMatch || !portMatch) continue;

    const csrfToken = sanitizeHeaderValue(csrfMatch[1]!);
    if (!csrfToken) continue;
    const extensionPort = parseInt(portMatch[1]!, 10);
    if (isNaN(extensionPort) || extensionPort <= 0 || extensionPort > 65535) continue;

    const workspaceIdMatch = /--workspace_id\s+(\S+)/.exec(line);
    const workspaceId = workspaceIdMatch?.[1];

    candidates.push({ pid, csrfToken, extensionPort, workspaceId });
  }

  const results = await Promise.all(
    candidates.map(async (c) => {
      const connectPort = await findConnectPort(c.extensionPort, c.csrfToken);
      if (connectPort === null) return null;
      return { ...c, connectPort } satisfies ServerInfo;
    })
  );

  return results.filter((s): s is ServerInfo => s !== null);
}

async function findConnectPort(
  extensionPort: number,
  csrfToken: string
): Promise<number | null> {
  for (let offset = 1; offset <= 3; offset++) {
    const candidate = extensionPort + offset;
    if (candidate > 65535) break;
    const ok = await probePort(candidate, csrfToken);
    if (ok) return candidate;
  }
  return null;
}

function probePort(port: number, csrfToken: string): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify({});
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `${SERVICE_PATH}/GetUnleashData`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "Connect-Protocol-Version": "1",
          "X-Codeium-Csrf-Token": csrfToken,
        },
        rejectUnauthorized: false, // self-signed cert on loopback — safe for localhost-only API
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

// ── API client ──────────────────────────────────────────────────────────────

function apiPost<T>(
  server: ServerInfo,
  method: string,
  body: Record<string, unknown>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestBody = JSON.stringify(body);
    let settled = false;
    const fail = (err: Error): void => { if (!settled) { settled = true; reject(err); } };
    const succeed = (val: T): void => { if (!settled) { settled = true; resolve(val); } };

    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: server.connectPort,
        path: `${SERVICE_PATH}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(requestBody),
          "Connect-Protocol-Version": "1",
          "X-Codeium-Csrf-Token": server.csrfToken,
        },
        rejectUnauthorized: false, // self-signed cert on loopback — safe for localhost-only API
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          if (settled) return;
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          if (res.statusCode !== 200) {
            fail(new Error(`Server returned status ${res.statusCode ?? 0}`));
            return;
          }
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
            succeed(parsed);
          } catch {
            fail(new Error("Response is not valid JSON"));
          }
        });
        res.on("error", (e: Error) => fail(e));
      }
    );
    req.on("error", (e: Error) => fail(e));
    req.on("timeout", () => { req.destroy(); fail(new Error("Request timed out")); });
    req.write(requestBody);
    req.end();
  });
}

// ── Offline fallback extraction ─────────────────────────────────────────────

function extractFromOffline(db: SessionSink): number {
  const dbPath = getAntigravityDbPath();

  try {
    accessSync(dbPath);
  } catch {
    return 0;
  }

  const reader = new SQLiteReader(dbPath);
  let extracted = 0;

  try {
    reader.open();

    const summaries = readTrajectorySummaries(reader);
    const workspaceMap = buildWorkspaceMap();

    for (const summary of summaries) {
      try {
        if (processOfflineSummary(db, summary, workspaceMap)) {
          extracted++;
        }
      } catch (err) {
        logger.error("extraction.antigravity", "offline_trajectory_processing_error", {
          trajectoryId: summary.id,
          error: err instanceof Error ? err.message : String(err),
        });
        reportRecordError(summary.id, null, err);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("locked")) {
      logger.warn("extraction.antigravity", "db_locked");
    } else {
      logger.error("extraction.antigravity", "db_access_error", { error: msg });
    }
    reportSourceError(dbPath, err);
  } finally {
    reader.close();
  }

  return extracted;
}

// ── Offline internals ───────────────────────────────────────────────────────

function readTrajectorySummaries(reader: SQLiteReader): TrajectorySummary[] {
  const rows = reader.query<{ value: string }>(
    `SELECT value FROM ItemTable WHERE key = ?`,
    ["antigravityUnifiedStateSync.trajectorySummaries"]
  );

  if (rows.length === 0) return [];

  const raw = rows[0]!.value;
  let outerBuf: Buffer;
  try {
    outerBuf = Buffer.from(raw, "base64");
  } catch {
    return [];
  }

  const outerFields = parseProto(outerBuf);
  const summaries: TrajectorySummary[] = [];

  const entries = getMessages(outerFields, 1);
  for (const entry of entries) {
    const id = getString(entry, 1);
    if (!id) continue;

    const blobMessages = getMessages(entry, 2);
    if (blobMessages.length === 0) continue;

    const innerBase64 = getString(blobMessages[0]!, 1);
    if (!innerBase64) continue;

    let innerBuf: Buffer;
    try {
      innerBuf = Buffer.from(innerBase64, "base64");
    } catch {
      continue;
    }

    const innerFields = parseProto(innerBuf);
    const summary = parseSummaryInner(id, innerFields);
    if (summary) summaries.push(summary);
  }

  return summaries;
}

function parseSummaryInner(
  id: string,
  fields: ProtoFields
): TrajectorySummary | null {
  const title = getString(fields, 1);
  if (!title || !title.trim()) return null;

  const stepCount = getInt(fields, 2) ?? 0;

  const updatedAtMsgs = getMessages(fields, 3);
  const updatedAtSecs =
    updatedAtMsgs.length > 0 ? (getInt(updatedAtMsgs[0]!, 1) ?? 0) : 0;

  const createdAtMsgs = getMessages(fields, 7);
  const createdAtSecs =
    createdAtMsgs.length > 0 ? (getInt(createdAtMsgs[0]!, 1) ?? 0) : 0;

  const workspaceMsgs = getMessages(fields, 9);
  const workspaceUri =
    workspaceMsgs.length > 0 ? getString(workspaceMsgs[0]!, 1) : undefined;

  return {
    id,
    title,
    stepCount,
    updatedAtMs: updatedAtSecs * 1000,
    createdAtMs: createdAtSecs * 1000,
    workspaceUri,
  };
}

function processOfflineSummary(
  db: SessionSink,
  summary: TrajectorySummary,
  workspaceMap: Map<string, string>
): boolean {
  const sessionId = summary.id;
  const lastUpdatedAt = summary.updatedAtMs;

  const rawProjectPath =
    resolveProjectPath(summary.workspaceUri) ?? workspaceMap.get(summary.id);

  // Collect fallback paths: workspace URI path + workspace map path
  const fallbackPaths: string[] = [];
  const wsPath = resolveProjectPath(summary.workspaceUri);
  if (wsPath) fallbackPaths.push(wsPath);
  const mapPath = workspaceMap.get(summary.id);
  if (mapPath) fallbackPaths.push(mapPath);

  // Central resolution: try findGitRoot(path), fallback to workspace paths
  const resolved = resolveProjectAndRepo(rawProjectPath ?? undefined, fallbackPaths);
  const finalProjectPath = resolved?.projectPath ?? rawProjectPath;
  const repoName = resolved?.repoName;

  const tracking = db.getTracking("antigravity", sessionId);

  if (tracking && tracking.last_mtime_ms === lastUpdatedAt) {
    if (finalProjectPath) {
      const redacted = redactPath(finalProjectPath);
      if (redacted !== tracking.project_path) {
        db.updateProjectPath("antigravity", sessionId, redacted);
      }
    }
    if (repoName && repoName !== tracking.repo_name) {
      db.updateRepoName("antigravity", sessionId, repoName);
    }
    return false;
  }

  const prompts = buildOfflineConversation(summary);
  if (prompts.length === 0) return false;

  const redactedPrompts = redactPrompts(prompts);
  const redactedProjectPath = finalProjectPath ? redactPath(finalProjectPath) : undefined;

  // parseSummaryInner validates title.trim() is non-empty but stores the
  // untrimmed value — trim here so offline titles match the API path.
  const meta: SessionMetaPayload = {};
  const offlineTitle = summary.title.trim();
  if (offlineTitle) meta.session_title = offlineTitle;
  const sessionMetaJson = Object.keys(meta).length > 0 ? JSON.stringify(sanitizeSessionMeta(meta)) : undefined;

  db.upsert({
    ideType: "antigravity",
    sessionId,
    conversation: redactedPrompts,
    projectPath: redactedProjectPath,
    repoName,
    lastMtimeMs: lastUpdatedAt,
    lastSize: summary.stepCount,
    lastOffset: 0,
    sessionMeta: sessionMetaJson,
  });

  return true;
}

function buildOfflineConversation(summary: TrajectorySummary): ConversationPrompt[] {
  const prompts: ConversationPrompt[] = [];

  if (summary.title.trim()) {
    prompts.push({
      role: "user",
      content: summary.title,
      timestamp: summary.createdAtMs > 0
        ? new Date(summary.createdAtMs).toISOString()
        : undefined,
    });
  }

  const brainSummary = readBrainSummary(summary.id);
  if (brainSummary) {
    prompts.push({
      role: "assistant",
      content: brainSummary,
      timestamp: summary.updatedAtMs > 0
        ? new Date(summary.updatedAtMs).toISOString()
        : undefined,
    });
  }

  return prompts;
}

function readBrainSummary(trajectoryId: string): string | undefined {
  const brainBase = getAntigravityBrainPath();
  const metaPath = join(brainBase, trajectoryId, "task.md.metadata.json");

  if (!existsSync(metaPath)) return undefined;

  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    const summary = meta["summary"];
    if (typeof summary === "string" && summary.trim()) {
      return summary;
    }
  } catch {
    // ignore
  }

  return undefined;
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function buildWorkspaceMap(): Map<string, string> {
  const map = new Map<string, string>();
  const storagePath = getAntigravityWorkspaceStoragePath();

  let entries: string[];
  try {
    entries = readdirSync(storagePath);
  } catch {
    return map;
  }

  for (const entry of entries) {
    try {
      const wsDir = join(storagePath, entry);
      const wsJsonPath = join(wsDir, "workspace.json");
      if (!existsSync(wsJsonPath)) continue;

      const wsJson = JSON.parse(readFileSync(wsJsonPath, "utf8")) as Record<string, unknown>;
      const folderUri = wsJson["folder"];
      if (typeof folderUri !== "string" || !folderUri.startsWith("file://")) continue;

      const folderPath = decodeURIComponent(folderUri.slice("file://".length));
      if (!folderPath) continue;

      const wsDbPath = join(wsDir, "state.vscdb");
      if (!existsSync(wsDbPath)) continue;

      const wsDb = openVendorDb(wsDbPath, 5000);

      try {
        const rows = wsDb
          .prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'jetski%' OR key LIKE 'antigravity%'")
          .all() as Array<{ key: string; value: string }>;

        for (const row of rows) {
          const uuidMatches = (row.key + " " + row.value).match(
            /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
          );
          if (uuidMatches) {
            for (const uuid of uuidMatches) {
              const lc = uuid.toLowerCase();
              if (!map.has(lc)) {
                map.set(lc, folderPath);
              }
            }
          }
        }
      } finally {
        wsDb.close();
      }
    } catch {
      // skip
    }
  }

  return map;
}

/**
 * Converts a workspace_id like "file_Users_name_projects_repo" back to
 * a filesystem path "/Users/name/projects/repo".
 *
 * Limitation: the workspace_id format is lossy — underscores in directory names
 * are indistinguishable from path separators (e.g. "/Users/john_doe/repo" and
 * "/Users/john/doe/repo" both encode to "file_Users_john_doe_repo"). The
 * existsSync check below catches most bad paths; for ambiguous cases the
 * trajectory workspace URI (tried first by the caller) is more reliable.
 */
function resolveWorkspaceId(workspaceId: string | undefined): string | undefined {
  if (!workspaceId) return undefined;
  // Strip the "file_" prefix and convert underscores back to path separators
  if (!workspaceId.startsWith("file_")) return undefined;
  const path = "/" + workspaceId.slice("file_".length).replace(/_/g, "/");
  // Validate the path actually exists
  if (!existsSync(path)) return undefined;
  return path;
}

function resolveProjectPath(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  if (!uri.startsWith("file://")) return undefined;

  const withoutScheme = uri.slice("file://".length);
  try {
    const decoded = decodeURIComponent(withoutScheme);
    return decoded.replace(/\/$/, "") || undefined;
  } catch {
    return withoutScheme.replace(/\/$/, "") || undefined;
  }
}

