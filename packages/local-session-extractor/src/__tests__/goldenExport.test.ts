// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The public path reproduces the goldens: `readAll` over the golden's staged
 * inputs, then `exportSessions` of the rows with the sync state, equals
 * `fixtures/golden.jsonl` once the wall-clock columns the golden excludes are
 * dropped, and the default export equals `fixtures/golden-conversation.jsonl`.
 */
import { after, it } from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { comparableConversations, goldenLines, isolateHome, readGolden, stageGolden } from "../../scripts/golden";
import { exportSessions, readAll } from "../index";
import { SessionStore } from "../store/SessionStore";

const home = isolateHome();
after(() => rmSync(home, { recursive: true, force: true }));

it("exportSessions over a scanned store equals the goldens, modulo the bookkeeping columns", async () => {
  const stage = stageGolden(home);
  try {
    const store = new SessionStore(join(stage.tmp, "export.db"));
    try {
      // The golden's run order; Codex runs once per mode, each pass finding only its own root.
      await readAll(store, { sources: ["claude-code", "cursor", "copilot", "antigravity"] });
      await readAll(store, {
        sources: ["codex"],
        paths: { CODEX_HOME: join(stage.absent, "codex-home"), CODEX_SQLITE_HOME: stage.codexSqliteHome },
      });
      await readAll(store, {
        sources: ["codex"],
        paths: { CODEX_HOME: stage.codexHome, CODEX_SQLITE_HOME: join(stage.absent, "codex-sqlite-home") },
      });
      await readAll(store, { sources: ["kiro"] });

      const out = join(stage.tmp, "export.jsonl");
      const { written } = await exportSessions(store, { format: "jsonl", shape: "row", out, includeSyncState: true });
      const exported = readFileSync(out, "utf8").split("\n").filter((l) => l.length > 0);
      assert.equal(written, exported.length);

      // goldenLines applies the golden's order and drops the same four columns.
      const lines = goldenLines(exported.map((l) => JSON.parse(l) as Record<string, unknown>));
      const golden = readGolden();
      assert.equal(lines.length, golden.length, "row count");
      for (let i = 0; i < golden.length; i++) {
        const want = JSON.parse(golden[i]!) as { ide_type: string; session_id: string };
        assert.deepEqual(JSON.parse(lines[i]!), want, `${want.ide_type}/${want.session_id}`);
      }

      for (const format of ["jsonl", "json"] as const) {
        const file = join(stage.tmp, `export-conversation.${format}`);
        await exportSessions(store, { format, out: file });
        const text = readFileSync(file, "utf8");
        const conversations = (format === "json" ? JSON.parse(text) : text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l))) as Record<string, unknown>[];
        const { got, want } = comparableConversations(conversations);
        assert.equal(got.length, want.length, `${format} count`);
        for (let i = 0; i < want.length; i++) assert.deepEqual(got[i], want[i], `${format} ${String(want[i]!["ideType"])}/${String(want[i]!["sessionId"])}`);
      }
    } finally {
      store.close();
    }
  } finally {
    stage.cleanup();
  }
});
