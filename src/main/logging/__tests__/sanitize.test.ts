// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import { sanitize, type LogEntry } from "../logger";

const home = `/Users/${userInfo().username}`;

function entry(data: Record<string, unknown>, event = "e"): LogEntry {
  return { ts: "2026-01-01T00:00:00.000Z", session_id: "s", level: "info", component: "c", event, data };
}

describe("sanitize", () => {
  it("redacts token shapes, masks emails and replaces the home folder in string values", () => {
    const out = sanitize(entry({ msg: `Bearer abc.def at ${home}/src/app by jane@example.com` }));
    assert.equal(out.data?.msg, "[REDACTED] at ~/src/app by j***@e***.com");
  });

  it("masks the whole value of a personal-data key", () => {
    const out = sanitize(entry({ name: "Jane Doe", email: "jane@example.com" }));
    assert.deepEqual(out.data, { name: "J***", email: "j***@e***.com" });
  });

  it("sanitises nested objects", () => {
    const out = sanitize(entry({ outer: { inner: "ghp_secret123" } }));
    assert.deepEqual(out.data, { outer: { inner: "[REDACTED]" } });
  });

  it("sanitises every element of an array, at any depth", () => {
    const out = sanitize(
      entry({
        items: [`${home}/secret-project`, "Bearer abc.def.ghi", "jane@example.com", 7, null],
        nested: [{ token: "sk-live" }, ["xoxb-1"]],
      }),
    );
    assert.deepEqual(out.data, {
      items: ["~/secret-project", "[REDACTED]", "j***@e***.com", 7, null],
      nested: [{ token: "s***" }, ["[REDACTED]"]],
    });
  });

  it("masks every element of an array under a personal-data key", () => {
    const out = sanitize(entry({ name: ["Jane Doe", "John Doe"] }));
    assert.deepEqual(out.data, { name: ["J***", "J***"] });
  });

  it("redacts the event name too", () => {
    const out = sanitize(entry({}, "failed with Bearer abc"));
    assert.equal(out.event, "failed with [REDACTED]");
  });

  it("replaces the home folder with no slash after it", () => {
    for (const [given, want] of [
      [home, "~"],
      [`root ${home}: skipped`, "root ~: skipped"],
      [`cwd=${home}`, "cwd=~"],
      [`${home}2/other`, `${home}2/other`],
    ]) {
      assert.equal(sanitize(entry({ msg: given })).data?.msg, want, given);
    }
  });

  it("redacts GitHub fine-grained, user and refresh tokens and AWS access key ids", () => {
    const out = sanitize(
      entry({ msg: "github_pat_11ABC ghu_abc ghr_def AKIAIOSFODNN7EXAMPLE" }),
    );
    assert.equal(out.data?.msg, "[REDACTED] [REDACTED] [REDACTED] [REDACTED]");
  });

  it("redacts an sk- key but not sk- inside a word", () => {
    const out = sanitize(
      entry({ msg: "sk-ant-api03-abc key=sk-live ~/out/Agent Desk-darwin-arm64/Agent Desk.app task-runner disk-usage" }),
    );
    assert.equal(out.data?.msg, "[REDACTED] key=[REDACTED] ~/out/Agent Desk-darwin-arm64/Agent Desk.app task-runner disk-usage");
  });

  // A stack-read caller in a bundle is the bundle's absolute path, which names the
  // home folder when the app runs from ~/Downloads or ~/Applications.
  it("replaces the home folder in the caller", () => {
    const out = sanitize({ ...entry({}), caller: `${home}/Downloads/Agent Desk.app/Contents/Resources/app.asar/.vite/build/extractionWorker.js:375` });
    assert.equal(out.caller, "~/Downloads/Agent Desk.app/Contents/Resources/app.asar/.vite/build/extractionWorker.js:375");
  });
});
