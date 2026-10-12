// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * `exportSessions` with `split`: one strict Session Intelligence `Conversation`
 * per file, named by a hash of the redacted session id, in a folder it creates
 * or finds empty, each file written whole at mode 0600.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageHomes } from "../../scripts/golden";
import { exportSessions, writeSplit, type ExportOptions } from "../export";
import { setRunningUsernameForTests } from "../redaction/anonymizer";
import { readAll } from "../scan";
import { SessionStore, openStore } from "../store/SessionStore";
import { IDE_TYPES } from "../types/session";
import { assertConversation } from "./sessionIntelligenceDescriptor";

const tmp = mkdtempSync(join(tmpdir(), "lse-export-split-"));
let store: SessionStore;
let storedIds: string[];

before(async () => {
  const staged = stageHomes(join(tmp, "staged"));
  store = openStore(join(tmp, "fixtures.db"));
  await readAll(store, { home: staged.home, captureLineage: true });
  storedIds = (store.raw().prepare("SELECT session_id FROM conversations").all() as Array<{ session_id: string }>).map((r) => r.session_id);
});

after(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((p) => statSync(join(dir, p)).isFile())
    .sort();
}

const NAME = new RegExp(`^(${IDE_TYPES.join("|")})/[0-9a-f]{32}\\.json$`);

describe("exportSessions with split", () => {
  it("writes each session as one strict Conversation, one file each, at mode 0600", async () => {
    const dir = join(tmp, "out", "new");
    const { written } = await exportSessions(store, { split: dir });
    assert.ok(storedIds.length >= 20, `the staged fixtures hold ${storedIds.length} sessions`);
    assert.equal(written, storedIds.length);
    const files = filesUnder(dir);
    assert.equal(files.length, storedIds.length);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      assert.equal(text.trimEnd().split("\n").length, 1, `${file} holds one object`);
      const conversation = JSON.parse(text) as { ideType: string; sessionId: string };
      assertConversation(conversation, file);
      assert.equal(`IDE_TYPE_${file.split("/")[0]!.replace("-", "_").toUpperCase()}`, conversation.ideType);
      assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600, file);
    }
  });

  it("names each file from its redacted session id only: no separator, no `..`, no id, no user name", async () => {
    const restore = setRunningUsernameForTests("alice");
    try {
      const own = new SessionStore(join(tmp, "names.db"));
      const base = { conversation: [{ role: "user" as const, content: "hi" }], lastMtimeMs: 1, lastSize: 1, lastOffset: 0 };
      const ids = ["-Users-alice-src-shop/api::0f8e2c1a-1111-4222-8333-944455556666", "../../etc/passwd::x", "a\\b:c*d?e"];
      for (const sessionId of ids) own.upsert({ ideType: "claude-code", sessionId, ...base });
      own.upsert({ ideType: "codex", sessionId: "/Users/alice/.codex/thread-1", ...base });
      const dir = join(tmp, "names");
      assert.equal((await exportSessions(own, { split: dir })).written, 4);
      own.close();
      const files = filesUnder(dir);
      assert.equal(files.length, 4);
      for (const file of files) {
        assert.match(file, NAME);
        assert.ok(!file.includes("alice"), file);
        const conversation = JSON.parse(readFileSync(join(dir, file), "utf8")) as { sessionId: string };
        assert.ok(!conversation.sessionId.includes("alice"), "the id in the file is redacted");
        const hash = createHash("sha256").update(conversation.sessionId).digest("hex").slice(0, 32);
        assert.equal(file.split("/")[1], `${hash}.json`, "the hash of the redacted id in the file");
      }
    } finally {
      restore();
    }
    const dir = join(tmp, "names-fixtures");
    await exportSessions(store, { split: dir });
    for (const file of filesUnder(dir)) {
      assert.match(file, NAME);
      for (const id of storedIds) assert.ok(!file.includes(id), `${file} holds the stored id ${id}`);
    }
  });

  it("writes the same Conversations as the one-file export", async () => {
    const dir = join(tmp, "same");
    const jsonl = join(tmp, "same.jsonl");
    await exportSessions(store, { split: dir });
    await exportSessions(store, { format: "jsonl", out: jsonl });
    const fromFiles = filesUnder(dir).map((f) => readFileSync(join(dir, f), "utf8").trimEnd()).sort();
    const fromLines = readFileSync(jsonl, "utf8").trimEnd().split("\n").sort();
    assert.deepEqual(fromFiles, fromLines);
  });

  it("refuses a folder that is not empty, unless force, which leaves other files alone", async () => {
    const dir = join(tmp, "nonempty");
    mkdirSync(dir);
    writeFileSync(join(dir, "notes.txt"), "mine\n");
    await assert.rejects(exportSessions(store, { split: dir }), /refusing to export to .*nonempty: it is not empty/);
    assert.deepEqual(readdirSync(dir), ["notes.txt"]);
    const { written } = await exportSessions(store, { split: dir, force: true });
    assert.equal(filesUnder(dir).length, written + 1);
    assert.equal(readFileSync(join(dir, "notes.txt"), "utf8"), "mine\n");
    const again = await exportSessions(store, { split: dir, force: true });
    assert.equal(filesUnder(dir).length, again.written + 1, "a second export replaces the same files");
  });

  it("refuses a symlink in place of the folder, a source folder or a file, and leaves its target alone", async () => {
    const target = join(tmp, "link-target");
    mkdirSync(target);
    const linked = join(tmp, "linked");
    symlinkSync(target, linked);
    await assert.rejects(exportSessions(store, { split: linked }), /symlink/);
    assert.deepEqual(readdirSync(target), []);

    const names = join(tmp, "link-names");
    await exportSessions(store, { split: names });
    const [file] = filesUnder(names);
    const dir = join(tmp, "link-file");
    mkdirSync(join(dir, file!.split("/")[0]!), { recursive: true });
    const victim = join(tmp, "victim.txt");
    writeFileSync(victim, "victim\n");
    symlinkSync(victim, join(dir, file!));
    await assert.rejects(exportSessions(store, { split: dir, force: true }), /symlink/);
    assert.equal(readFileSync(victim, "utf8"), "victim\n");

    const sourceLinked = join(tmp, "link-source");
    mkdirSync(sourceLinked);
    symlinkSync(target, join(sourceLinked, file!.split("/")[0]!));
    await assert.rejects(exportSessions(store, { split: sourceLinked, force: true }), /symlink/);
    assert.deepEqual(readdirSync(target), []);
  });

  it("leaves no temp file behind when a write fails, and every file it wrote whole", async () => {
    const names = join(tmp, "fail-names");
    await exportSessions(store, { split: names });
    const files = filesUnder(names);
    const dir = join(tmp, "fail");
    // A folder where the last file goes: its rename fails after the files before it are written.
    mkdirSync(join(dir, files.at(-1)!), { recursive: true });
    await assert.rejects(exportSessions(store, { split: dir, force: true }));
    const left = filesUnder(dir);
    assert.deepEqual(
      left.filter((f) => !NAME.test(f)),
      [],
      "only finished files are left",
    );
    for (const f of left) assertConversation(JSON.parse(readFileSync(join(dir, f), "utf8")), f);
  });

  it("leaves no temp file behind when the read fails between pages", () => {
    const dir = join(tmp, "fail-page");
    assert.throws(
      () =>
        writeSplit(store, { split: dir }, {
          pageSize: 2,
          afterPage: () => {
            throw new Error("disk full");
          },
        }),
      /disk full/,
    );
    assert.deepEqual(
      filesUnder(dir).filter((f) => !NAME.test(f)),
      [],
    );
    assert.equal(filesUnder(dir).length, 2);
  });

  it("gives two sessions whose ids redact alike a file each", async () => {
    const restore = setRunningUsernameForTests("alice");
    try {
      const own = new SessionStore(join(tmp, "alike.db"));
      const base = { conversation: [{ role: "user" as const, content: "hi" }], lastMtimeMs: 1, lastSize: 1, lastOffset: 0 };
      own.upsert({ ideType: "claude-code", sessionId: "-Users-alice-app::0001", ...base });
      own.upsert({ ideType: "claude-code", sessionId: "-Users-Alice-app::0001", ...base });
      const dir = join(tmp, "alike");
      const { written } = await exportSessions(own, { split: dir });
      own.close();
      const files = filesUnder(dir);
      const ids = files.map((f) => (JSON.parse(readFileSync(join(dir, f), "utf8")) as { sessionId: string }).sessionId);
      assert.equal(written, 2);
      assert.equal(files.length, 2);
      assert.equal(ids[0], ids[1], "the two ids redact alike");
    } finally {
      restore();
    }
  });

  for (const [name, opts, message] of [
    ["out", { split: "x", out: "y.jsonl" }, /takes no out/],
    ["format json", { split: "x", format: "json" }, /takes no format/],
    ["format jsonl", { split: "x", format: "jsonl" }, /takes no format/],
    ["shape row", { split: "x", shape: "row" }, /takes no shape "row"/],
    ["includeSyncState", { split: "x", includeSyncState: true }, /takes no includeSyncState/],
    ["an empty folder path", { split: "" }, /split needs a folder path/],
  ] as const) {
    it(`rejects split with ${name}, writing nothing`, async () => {
      const cwd = process.cwd();
      process.chdir(tmp);
      try {
        await assert.rejects(exportSessions(store, opts as unknown as ExportOptions), message);
      } finally {
        process.chdir(cwd);
      }
      assert.deepEqual(
        readdirSync(tmp).filter((f) => f === "x" || f === "y.jsonl"),
        [],
      );
    });
  }
});
