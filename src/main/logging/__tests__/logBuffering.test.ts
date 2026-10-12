// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { flushLogs, initLogger, logger } from "../logger";

let tmpDir: string;

// Events in the main log file after a flush, parsed line by line (each line is one JSON entry).
function loggedEvents(): string[] {
  flushLogs();
  let content = "";
  try {
    content = readFileSync(join(tmpDir, "logs", "main.log"), "utf-8");
  } catch {
    return [];
  }
  const events: string[] = [];
  for (const raw of content.split("\n")) {
    if (!raw.trim()) continue;
    const parsed = JSON.parse(raw) as { event: string };
    events.push(parsed.event);
  }
  return events;
}

describe("logger buffered append round trip", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "logger-buffering-"));
    initLogger(tmpDir);
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  it("flushes buffered info lines on the next macrotask", async () => {
    for (let i = 0; i < 3; i++) logger.info("test", `async_${i}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const events = loggedEvents();
    for (let i = 0; i < 3; i++) {
      assert.ok(events.includes(`async_${i}`), `async_${i} flushed on macrotask`);
    }
  });

  it("round-trips an error line interleaved with a buffered info line", () => {
    logger.info("test", "info_before_err"); // buffered
    logger.error("test", "err_line"); // flushes the whole queue in order
    const events = loggedEvents();
    assert.deepEqual(
      events.filter((e) => e === "info_before_err" || e === "err_line"),
      ["info_before_err", "err_line"],
      "the buffered info line and the error land in order",
    );
  });
});

describe("logger warn flush throttling", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "logger-warnthrottle-"));
    initLogger(tmpDir);
  });
  afterEach(() => {
    mock.timers.reset();
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  // Read the log file WITHOUT flushing, which would hide what was (or wasn't)
  // forced to disk.
  function onDiskEvents(): string[] {
    let text: string;
    try {
      text = readFileSync(join(tmpDir, "logs", "main.log"), "utf-8");
    } catch {
      return [];
    }
    const events: string[] = [];
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      events.push((JSON.parse(raw) as { event: string }).event);
    }
    return events;
  }

  it("a lone warn is durable immediately (no flush trigger needed)", () => {
    logger.warn("test", "lone_warn");
    assert.ok(onDiskEvents().includes("lone_warn"), "the warn was force-flushed on write");
  });

  it("a warn right after an error still flushes immediately (error must not arm the throttle)", () => {
    logger.error("test", "err_first");
    logger.warn("test", "warn_after_err"); // within the throttle window of the error
    const events = onDiskEvents();
    assert.ok(events.includes("err_first"));
    assert.ok(
      events.includes("warn_after_err"),
      "the crash-context warn following an error must be on disk, not queued",
    );
  });

  it("a tight warn burst forces one append, and the macrotask drain lands the rest", async () => {
    // Freeze Date so the whole burst sits inside one throttle window.
    mock.timers.enable({ apis: ["Date"], now: Date.now() });
    for (let i = 0; i < 50; i++) logger.warn("test", `burst_${i}`);
    const forced = onDiskEvents().filter((e) => e.startsWith("burst_")).length;
    assert.equal(forced, 1, "exactly the lead warn is forced inside one throttle window");

    mock.timers.reset(); // real timers were never mocked; restore Date for the drain
    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = onDiskEvents().filter((e) => e.startsWith("burst_")).length;
    assert.equal(after, 50, "every burst warn survives via the macrotask drain");
  });
});
