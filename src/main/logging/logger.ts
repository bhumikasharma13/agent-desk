// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
  appendFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";

// ── Types ─────────────────────────────────────────────────────────────────────

export type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogEntry {
  ts: string;
  session_id: string;
  level: LogLevel;
  component: string;
  event: string;
  data?: Record<string, unknown>;
  // Origin call site (e.g. "src/main/extraction/workerHost.ts:124"), stamped at
  // build time by scripts/vite-plugin-logger-caller.ts or read from the V8 stack.
  caller?: string;
}

// ── Sanitization ─────────────────────────────────────────────────────────────

const TOKEN_PATTERNS = [
  /Bearer\s+\S+/gi,
  /ya29\.\S+/g,
  /gho_\S+/g,
  /ghp_\S+/g,
  /ghs_\S+/g,
  /ghu_\S+/g,
  /ghr_\S+/g,
  /github_pat_\S+/g,
  /AKIA[0-9A-Z]{16}/g,
  // Not after a letter or digit: "task-runner", "disk-usage" and "Desk-darwin" are words.
  /(?<![A-Za-z0-9])sk-\S+/g,
  /xoxb-\S+/g,
  /xoxp-\S+/g,
  /xoxa-\S+/g,
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWT
];

const PII_KEYS = new Set([
  "email",
  "name",
  "token",
  "secret",
  "password",
  "authorization",
  "session_token",
  "access_token",
  "refresh_token",
  "api_key",
]);

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "[REDACTED]";
  const [domainName, ...rest] = domain.split(".");
  const maskedLocal = local[0] + "***";
  const maskedDomain = (domainName?.[0] ?? "") + "***." + rest.join(".");
  return `${maskedLocal}@${maskedDomain}`;
}

function maskString(value: string): string {
  if (value.length <= 1) return value;
  return value[0] + "***";
}

function redactTokens(text: string): string {
  let result = text;
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

// Replaces the home folder with "~", followed by a slash or not ("/Users/jane",
// "root /Users/jane: skipped", "cwd=/Users/jane"): the home path itself
// (os.homedir()), then the usual /Users/<name> or /home/<name> spelling.
function replacePathUsername(text: string): string {
  let result = text;
  const home = os.homedir();
  if (home && home !== "/") {
    result = result.replace(new RegExp(`${escapeRegex(home)}(?=/|$|\\W)`, "g"), "~");
  }
  const username = os.userInfo().username;
  if (username) {
    result = result.replace(new RegExp(`/(Users|home)/${escapeRegex(username)}(?=/|$|\\W)`, "g"), "~");
  }
  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Caller capture ──────────────────────────────────────────────────────────
//
// captureCallerSite returns the first stack frame that is NOT inside this
// module — i.e. the file:line that called `logger.info(...)` (or peers).

const LOGGER_FILE_FRAGMENTS = [
  "/logging/logger.ts",
  "/logging/logger.js",
  "/logging/logger.mjs",
];

function captureCallerSite(): string {
  const err = new Error();
  if (!err.stack) return "";
  const lines = err.stack.split("\n");
  // V8 format: lines[0] = "Error", lines[1..] = "    at fn (path:line:col)".
  // Skip the captureCallerSite frame and the log() / wrapper frames inside
  // this module; return the first frame outside.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line) continue;
    if (LOGGER_FILE_FRAGMENTS.some((f) => line.includes(f))) continue;

    // "    at fnName (path:line:col)" — V8 format with a function name.
    const parens = line.match(/at\s.+?\(([^)]+?):(\d+):\d+\)/);
    if (parens && parens[1] && parens[2]) {
      return shortenSourcePath(parens[1]) + ":" + parens[2];
    }
    // "    at path:line:col" — top-level / anonymous frames.
    const bare = line.match(/at\s+([^\s()]+?):(\d+):\d+/);
    if (bare && bare[1] && bare[2]) {
      return shortenSourcePath(bare[1]) + ":" + bare[2];
    }
  }
  return "";
}

// Trims an absolute path down to the project-relative segment from `src/` on,
// so a log line carries no home-folder prefix.
function shortenSourcePath(p: string): string {
  const cleaned = p.replace(/^webpack:\/\//, "").replace(/^file:\/\//, "");
  const srcIdx = cleaned.lastIndexOf("/src/");
  if (srcIdx >= 0) return cleaned.substring(srcIdx + 1); // keep the leading "src/"
  return cleaned;
}

/**
 * Sanitizes a log entry to remove PII and secrets.
 * All log entries pass through this before being written.
 */
export function sanitize(entry: LogEntry): LogEntry {
  const sanitized = structuredClone(entry);

  if (sanitized.data) {
    sanitized.data = sanitizeData(sanitized.data);
  }

  // The token patterns run over the message string, not only over `data`. A
  // secret interpolated into the event name is the easier mistake to make than
  // one passed as a structured field, so covering only `data` would leave the
  // likelier leak in the clear. This is a backstop: callers still owe the
  // no-secret-in-logs rule, because a pattern list only catches shapes it knows.
  sanitized.event = replacePathUsername(redactTokens(sanitized.event));
  // A caller read from the stack of a bundle is the bundle's absolute path.
  if (sanitized.caller) sanitized.caller = replacePathUsername(sanitized.caller);

  return sanitized;
}

function sanitizeData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    result[key] = sanitizeValue(key, value);
  }
  return result;
}

// Sanitises one value under its key: strings are masked or redacted, objects
// recurse with their own keys, and every array element is sanitised under the
// array's key, at any depth.
function sanitizeValue(key: string, value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(key, value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(key, item));
  if (typeof value === "object" && value !== null) return sanitizeData(value as Record<string, unknown>);
  return value;
}

function sanitizeString(key: string, value: string): string {
  if (PII_KEYS.has(key.toLowerCase())) {
    EMAIL_REGEX.lastIndex = 0;
    if (EMAIL_REGEX.test(value)) {
      EMAIL_REGEX.lastIndex = 0;
      return value.replace(EMAIL_REGEX, maskEmail);
    }
    return maskString(value);
  }
  let sanitized = redactTokens(value);
  EMAIL_REGEX.lastIndex = 0;
  sanitized = sanitized.replace(EMAIL_REGEX, maskEmail);
  return replacePathUsername(sanitized);
}

// ── Logger ───────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15 MB
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const RETENTION_CHECK_INTERVAL_MS = 60_000; // 60 seconds
// Hysteresis for time-based retention: trim only once the head is this far
// past the age cutoff. On any install older than MAX_AGE_MS the first line
// sits at the cutoff right after a trim, so a slackless `firstTs < cutoff`
// would rewrite the whole file on virtually every retention check. The slack
// bounds rewrites to one per slack window.
const RETENTION_TIME_SLACK_MS = 6 * 60 * 60 * 1000; // 6 hours
// Head-probe window for first-line reads. Log lines are single JSON objects,
// far below this; a head with no newline inside the probe falls back to a
// full read rather than being mistaken for corruption.
const FIRST_LINE_PROBE_BYTES = 8192;
const isDev = process.env.NODE_ENV === "development";

export type ProcessName = "main" | "worker";

const MAIN_LOG_FILENAME = "main.log";
const WORKER_LOG_FILENAME = "worker.log";

function logFilenameFor(processName: ProcessName): string {
  return processName === "worker" ? WORKER_LOG_FILENAME : MAIN_LOG_FILENAME;
}

let logFilePath: string | null = null;
let lastRetentionCheckMs = 0;
const sessionId = randomUUID();

// ── Buffered append ───────────────────────────────────────────────────────────
//
// Per-file queues of not-yet-written lines (this process only). A log call
// enqueues and returns; the batch is written in one append on the next
// macrotask, so a burst of info/debug lines costs one append instead of one
// per line.
//
// Durability: error lines flush synchronously and warns force a flush at most
// once per throttle window per file (they explain a crash, so they must reach
// disk before one — but a warn-per-file burst must not become a syscall storm;
// see shouldForceFlush). Any disk read/rewrite/reset of a file flushes its
// queue first so on-disk content is authoritative whenever anyone reads it. A
// clean exit drains the rest.
const pendingWrites = new Map<string, string[]>();
let flushScheduled = false;
let exitDrainRegistered = false;

// Warn-flush throttle: a warn must reach disk without waiting for the
// macrotask (a long synchronous pass can hold the event loop long enough that
// a queued warn dies with a mid-pass crash), but a systemic condition
// (permission flip, disk hiccup) can emit a warn per failing file. So at most
// one FORCED flush per path per this window; in-between warns ride the queue
// (drained by the next forced flush or the macrotask). Errors are never
// throttled.
const WARN_FLUSH_THROTTLE_MS = 15;
const lastForcedFlushMs = new Map<string, number>();

/** Whether this line must hit disk NOW: error always; warn at most once per
 *  throttle window per path; info/debug never (macrotask batch). Only WARNS
 *  stamp the throttle window — an error must not arm it, or the crash-context
 *  warn that often follows an error within the window would ride the queue
 *  and die with the very crash it explains. */
function shouldForceFlush(filePath: string, level: LogLevel): boolean {
  if (level === "error") return true;
  if (level !== "warn") return false;
  const now = Date.now();
  if (now - (lastForcedFlushMs.get(filePath) ?? 0) < WARN_FLUSH_THROTTLE_MS) return false;
  lastForcedFlushMs.set(filePath, now);
  return true;
}

/** Write one file's queued lines in a single append. Synchronous so it is safe
 *  to call from a read path, retention, or the exit drain. */
function flushFile(filePath: string): void {
  const queue = pendingWrites.get(filePath);
  if (!queue || queue.length === 0) return;
  pendingWrites.delete(filePath);
  try {
    appendFileSync(filePath, queue.join(""));
  } catch (err) {
    // A vanished log directory (ENOENT) can't be written to and can't be
    // reported through the logger itself — drop silently. Any other failure is
    // surfaced to the console (the logger can't log its own write failure).
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
    console.error("[logger] Failed to flush log entries:", err);
  }
}

/** Writes every queued line now. Runs on exit; tests call it before reading a log file. */
export function flushLogs(): void {
  for (const filePath of [...pendingWrites.keys()]) flushFile(filePath);
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(() => {
    flushScheduled = false;
    flushLogs();
  }, 0);
}

/** Enqueue one line; flush now for durability-critical (error) lines. */
function enqueueLine(filePath: string, line: string, flushNow: boolean): void {
  let queue = pendingWrites.get(filePath);
  if (!queue) {
    queue = [];
    pendingWrites.set(filePath, queue);
  }
  queue.push(line);
  if (flushNow) flushFile(filePath);
  else scheduleFlush();
}

/**
 * Initializes the logger with the app's userData path. Called once at startup
 * of each process (main and the extraction utility process); each process
 * writes its own JSON-lines file under `<userData>/logs`, so neither blocks on
 * the other when appending.
 */
export function initLogger(
  userDataPath: string,
  processName: ProcessName = "main",
): void {
  // Drain buffered lines on a clean exit so a graceful shutdown never loses
  // them. A hard kill can still drop the last un-flushed batch — acceptable for
  // logs; error lines never buffer, and each warn burst lands its lead line
  // (shouldForceFlush).
  if (!exitDrainRegistered) {
    exitDrainRegistered = true;
    process.on("exit", flushLogs);
    process.on("beforeExit", flushLogs);
  }
  const logDir = path.join(userDataPath, "logs");
  mkdirSync(logDir, { recursive: true });
  logFilePath = path.join(logDir, logFilenameFor(processName));

  if (existsSync(logFilePath)) {
    try {
      validateLogFile(logFilePath);
    } catch {
      resetLogFile(logFilePath, "corrupted log file detected on init");
    }
  }
}

/**
 * Writes a structured log entry.
 *
 * `callerOverride` is supplied by the build-time vite-plugin-logger-caller
 * transform — it embeds the original src/main/...:LINE string at each call
 * site so bundled builds don't collapse every caller to the bundle's own file.
 * If absent (tests, hand-written calls without the plugin), we fall back to
 * V8 stack parsing.
 */
export function log(
  level: LogLevel,
  component: string,
  event: string,
  data?: Record<string, unknown>,
  callerOverride?: string,
): void {
  const caller = callerOverride ?? captureCallerSite();
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    session_id: sessionId,
    level,
    component,
    event,
    ...(data !== undefined ? { data } : {}),
    ...(caller ? { caller } : {}),
  };

  const sanitized = sanitize(entry);

  if (isDev) {
    const consoleMethod =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : console.log;
    consoleMethod(`[${component}] ${event}`, data ?? "");
  }

  if (!logFilePath) return;

  try {
    const now = Date.now();
    if (now - lastRetentionCheckMs >= RETENTION_CHECK_INTERVAL_MS) {
      lastRetentionCheckMs = now;
      enforceRetention(logFilePath);
    }
    enqueueLine(logFilePath, JSON.stringify(sanitized) + "\n", shouldForceFlush(logFilePath, level));
  } catch (err) {
    console.error("[logger] Failed to write log entry:", err);
  }
}

// ── Convenience methods ──────────────────────────────────────────────────────

export const logger = {
  info: (component: string, event: string, data?: Record<string, unknown>, __callerOverride?: string) =>
    log("info", component, event, data, __callerOverride),
  warn: (component: string, event: string, data?: Record<string, unknown>, __callerOverride?: string) =>
    log("warn", component, event, data, __callerOverride),
  error: (component: string, event: string, data?: Record<string, unknown>, __callerOverride?: string) =>
    log("error", component, event, data, __callerOverride),
  debug: (component: string, event: string, data?: Record<string, unknown>, __callerOverride?: string) =>
    log("debug", component, event, data, __callerOverride),
};

// ── Retention ────────────────────────────────────────────────────────────────

// Returns the file's first line from an 8 KB head read. Null only for an empty
// file, or a non-empty file with no newline anywhere (a genuinely malformed
// head). A first line longer than the probe (a rare oversized entry — a large
// error body or stack) falls back to a full read so it is parsed correctly,
// never mistaken for corruption.
function readFirstLine(filePath: string): string | null {
  flushFile(filePath); // ensure the head reflects any queued lines
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(FIRST_LINE_PROBE_BYTES);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    if (bytes === 0) return null;
    const head = buf.subarray(0, bytes).toString("utf-8");
    const nl = head.indexOf("\n");
    if (nl >= 0) return head.substring(0, nl);
    // Fewer bytes than the probe means EOF with no newline → one unterminated
    // line; the head IS the whole first line only if that's the entire file.
    if (bytes < FIRST_LINE_PROBE_BYTES) return null;
  } finally {
    closeSync(fd);
  }
  // First line exceeds the probe window: read the whole file to find it.
  const text = readFileSync(filePath, "utf-8");
  const nl = text.indexOf("\n");
  return nl >= 0 ? text.substring(0, nl) : null;
}

function enforceRetention(filePath: string): void {
  flushFile(filePath); // retention reads + rewrites the file; drain the queue first
  if (!existsSync(filePath)) return;

  try {
    const stat = statSync(filePath);

    // Size cap: if over 15 MB, keep only the last ~10 MB, from the start of
    // the first complete line.
    if (stat.size > MAX_FILE_SIZE) {
      const data = readFileSync(filePath);
      const keepFrom = Math.max(0, data.length - 10 * 1024 * 1024);
      const text = data.subarray(keepFrom).toString("utf-8");
      const newlineIdx = text.indexOf("\n");
      const kept =
        newlineIdx >= 0 && newlineIdx < text.length - 1 ? text.substring(newlineIdx + 1) : text;
      writeFileSync(filePath, kept);
      return;
    }

    // Time-based retention: probe just the head for the age check; the full
    // file is read + rewritten only when a trim actually fires.
    const firstLine = readFirstLine(filePath);
    if (firstLine === null) return;

    try {
      const parsed = JSON.parse(firstLine) as LogEntry;
      const firstTs = new Date(parsed.ts).getTime();
      const cutoff = Date.now() - MAX_AGE_MS;

      if (firstTs < cutoff - RETENTION_TIME_SLACK_MS) {
        const lines = readFileSync(filePath, "utf-8").split("\n");
        let keepFromLine = -1;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line) as LogEntry;
            if (new Date(entry.ts).getTime() >= cutoff) {
              keepFromLine = i;
              break;
            }
          } catch {
            continue;
          }
        }
        writeFileSync(filePath, keepFromLine < 0 ? "" : lines.slice(keepFromLine).join("\n"));
      }
    } catch (err) {
      console.error("[logger] Failed to parse first log line during retention:", err);
    }
  } catch (err) {
    console.error("[logger] Retention check failed:", err);
  }
}

function validateLogFile(filePath: string): void {
  if (statSync(filePath).size === 0) return;

  // Head probe only — validation runs at every boot on files up to
  // MAX_FILE_SIZE and only ever inspects the first line.
  const firstLine = readFirstLine(filePath);
  if (firstLine === null) throw new Error("no newline found");

  const parsed = JSON.parse(firstLine);
  if (!parsed.ts || !parsed.level)
    throw new Error("invalid log entry structure");
}

function resetLogFile(filePath: string, reason: string): void {
  // The file is being wiped for corruption — drop any queued lines for it too.
  pendingWrites.delete(filePath);
  try {
    unlinkSync(filePath);
  } catch {
    // File may not exist
  }

  const entry: LogEntry = {
    ts: new Date().toISOString(),
    session_id: sessionId,
    level: "warn",
    component: "logger",
    event: "log_file_reset",
    data: { reason },
  };
  writeFileSync(filePath, JSON.stringify(entry) + "\n");
}
