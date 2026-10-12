// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { flushLogs, initLogger, logger } from "../logger";

// Contract pinned here: a head line past the age cutoff but within
// RETENTION_TIME_SLACK_MS is retained (no rewrite fires); past cutoff + slack
// it is trimmed. Mechanism why lives at the constant.

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const T0 = new Date("2026-01-01T00:00:00.000Z").getTime();

let tmpDir: string;

function logText(): string {
  flushLogs();
  try {
    return readFileSync(join(tmpDir, "logs", "main.log"), "utf-8");
  } catch {
    return "";
  }
}

describe("logger time-based retention hysteresis", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["Date"], now: T0 });
    tmpDir = mkdtempSync(join(tmpdir(), "logger-retention-"));
    initLogger(tmpDir);
  });
  afterEach(() => {
    mock.timers.reset();
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it("keeps a head past the cutoff but inside the slack; trims past cutoff + slack", () => {
    logger.info("test", "line_A");
    assert.ok(logText().includes("line_A"), "line A written");

    // 3d + 3h: A is past the 3-day cutoff but inside the 6h slack — retained.
    mock.timers.setTime(T0 + 3 * DAY + 3 * HOUR);
    logger.info("test", "line_B");
    const midText = logText();
    assert.ok(midText.includes("line_A"), "inside the slack window the head must be retained (no per-check rewrite)");
    assert.ok(midText.includes("line_B"));

    // 3d + 7h: A is now past cutoff + slack — the trim fires and drops it,
    // keeping everything younger than the cutoff.
    mock.timers.setTime(T0 + 3 * DAY + 7 * HOUR);
    logger.info("test", "line_C");
    const finalText = logText();
    assert.ok(!finalText.includes("line_A"), "head past cutoff + slack must be trimmed");
    assert.ok(finalText.includes("line_B"), "lines younger than the cutoff survive the trim");
    assert.ok(finalText.includes("line_C"));
  });
});

// A first log entry larger than the head-probe window must NOT be mistaken for
// a corrupt file and wiped at boot; readFirstLine falls back to a full read.
describe("logger boot validation tolerates an oversized first line", () => {
  const ORIGINAL = "x".repeat(20_000); // safely exceeds FIRST_LINE_PROBE_BYTES (8192)

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "logger-bigline-"));
    initLogger(tmpDir);
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  it("does not wipe a healthy log whose first entry exceeds the probe window", () => {
    logger.error("test", "big_first_entry", { blob: ORIGINAL });
    logger.info("test", "later_entry");

    // Re-init simulates the next boot: validateLogFile runs on the existing
    // file and must keep it, not reset.
    initLogger(tmpDir);

    const text = logText();
    assert.ok(text.includes("later_entry"), "the healthy log must survive re-init, not be wiped");
    assert.ok(!text.includes("log_file_reset"), "validateLogFile must not treat an oversized first line as corruption");
  });
});
