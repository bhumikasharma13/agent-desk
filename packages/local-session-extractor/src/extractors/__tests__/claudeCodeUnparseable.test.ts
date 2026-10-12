// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A Claude Code transcript none of whose lines parses is reported as a
 * session-scoped error, not skipped as if it held no session.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, readAll } from "../../index";

const tmp = mkdtempSync(join(tmpdir(), "lse-cc-unparseable-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function homeWith(files: Record<string, string>): string {
  const home = mkdtempSync(join(tmp, "home-"));
  const dir = join(home, ".claude", "projects", "-Users-you-app");
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return home;
}

const good = JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-04-01T10:00:00.000Z", sessionId: "ok", cwd: "/Users/you/app", message: { role: "user", content: "hello" } });

describe("claudeCodeExtractor — a transcript with no parseable line", () => {
  it("records one session-scoped error for it, and still stores the readable session", async () => {
    const home = homeWith({ "ok.jsonl": `${good}\n`, "broken.jsonl": "{not json\n{still not\n" });
    const store = openStore(join(tmp, "a.db"));
    try {
      const result = await readAll(store, { home, sources: ["claude-code"] });
      assert.equal(result.counts["claude-code"], 1);
      assert.equal(result.partial["claude-code"], false);
      assert.equal(result.errors.length, 1, JSON.stringify(result.errors));
      const [e] = result.errors;
      assert.equal(e!.scope, "session");
      assert.equal(e!.source, "claude-code");
      assert.equal(e!.sessionId, "-Users-you-app::broken");
      assert.match(e!.file ?? "", /broken\.jsonl$/);
    } finally {
      store.close();
    }
  });

  it("skips a line that is JSON but not an object, as it skips a malformed one, and keeps the session", async () => {
    const notObjects = ["null", "42", `"x"`, "[]", "true"].join("\n");
    const home = homeWith({ "odd.jsonl": `${notObjects}\n${good}\n${notObjects}\n`, "only-odd.jsonl": `${notObjects}\n` });
    const store = openStore(join(tmp, "c.db"));
    try {
      const result = await readAll(store, { home, sources: ["claude-code"] });
      assert.equal(result.counts["claude-code"], 1, JSON.stringify(result.errors));
      assert.deepEqual(
        result.errors.map((e) => [e.scope, e.sessionId, e.message]),
        [["session", "-Users-you-app::only-odd", "none of the transcript's 5 line(s) is a JSON object"]],
      );
    } finally {
      store.close();
    }
  });

  it("reports nothing for an empty file or one whose bad lines sit beside good ones", async () => {
    const home = homeWith({ "empty.jsonl": "", "mixed.jsonl": `{not json\n${good}\n` });
    const store = openStore(join(tmp, "b.db"));
    try {
      const result = await readAll(store, { home, sources: ["claude-code"] });
      assert.deepEqual(result.errors, []);
      assert.equal(result.counts["claude-code"], 1);
    } finally {
      store.close();
    }
  });
});
