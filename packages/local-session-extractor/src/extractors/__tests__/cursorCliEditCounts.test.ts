// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Cursor CLI per-message files_edited + line counts.
 *
 * The tool names and arg shapes here were read off live ~/.cursor/chats store.db
 * sessions (current cursor-agent), not invented to match the decoder:
 *   - Write     args { path, contents }                    → all-added, 0 removed
 *   - StrReplace args { path, old_string, new_string }     → +new / -old lines
 *   - Delete    args { path }                              → uncountable (no content)
 *   - Read      args { path }                              → not an edit
 * A failed StrReplace (structured error) changed nothing, so it must count nothing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPrompts, cliEditCounts, parseCliBlobs } from "../../internal";

// ── minimal protobuf-root harness (mirrors cursorCliConversationOrder.test.ts) ──

function encodeVarint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v & 0x7f);
  return out;
}
function shaField(field: number, hexId: string): number[] {
  const payload = [...Buffer.from(hexId, "hex")];
  return [(field << 3) | 2, ...encodeVarint(payload.length), ...payload];
}
function blobId(n: number): string {
  return Buffer.alloc(32, n).toString("hex");
}
function rootBlob(childIds: string[]): Buffer {
  const parts: number[] = [];
  for (const id of childIds) parts.push(...shaField(1, id));
  return Buffer.from(parts);
}
function tagged(name: string, body: string): string {
  return ["<", name, ">", body, "</", name, ">"].join("");
}
function userBlob(query: string, ts: string): Buffer {
  const text = tagged("timestamp", ts) + "\n" + tagged("user_query", "\n" + query + "\n");
  return Buffer.from(JSON.stringify({ role: "user", content: [{ type: "text", text }] }), "utf8");
}
function assistantToolBlob(toolName: string, args: Record<string, unknown>, toolCallId = "t1"): Buffer {
  return Buffer.from(
    JSON.stringify({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId, toolName, args }],
    }),
    "utf8",
  );
}
function okToolResultBlob(toolCallId: string, result = "done"): Buffer {
  // A real completed edit persists a success tool-result (e.g. "Wrote contents to …",
  // "The file … has been updated."). The counter only stamps a delta once this exists.
  return Buffer.from(
    JSON.stringify({ role: "tool", content: [{ type: "tool-result", toolCallId, result }] }),
    "utf8",
  );
}

function erroredToolResultBlob(toolCallId: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      role: "tool",
      content: [{ type: "tool-result", toolCallId, result: "not found" }],
      providerOptions: { cursor: { highLevelToolCallResult: { output: { error: "old_string not found" } } } },
    }),
    "utf8",
  );
}

const TS = "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)";

describe("cliEditCounts — real CLI edit-op arg shapes", () => {
  it("counts a Write as all-added from `contents`, nothing removed", () => {
    assert.deepEqual(cliEditCounts("Write", { path: "/a/b.ts", contents: "x\ny\nz" }), {
      filePath: "/a/b.ts",
      linesAdded: 3,
      linesRemoved: 0,
    });
  });

  it("counts a StrReplace as +new_string / -old_string lines", () => {
    assert.deepEqual(
      cliEditCounts("StrReplace", { path: "/a/b.ts", old_string: "one\ntwo", new_string: "just one" }),
      { filePath: "/a/b.ts", linesAdded: 1, linesRemoved: 2 },
    );
  });

  it("reports a Delete's file with UNCOUNTABLE lines (path but no line content)", () => {
    assert.deepEqual(cliEditCounts("Delete", { path: "/a/gone.ts" }), { filePath: "/a/gone.ts" });
  });

  it("returns null for a Read (not an edit) and for an edit tool with no path", () => {
    assert.equal(cliEditCounts("Read", { path: "/a/b.ts" }), null);
    assert.equal(cliEditCounts("Write", { contents: "x" }), null);
  });
});

describe("buildPrompts — per-message files_edited + line counts", () => {
  it("stamps filesEdited + line counts on a Write tool prompt", () => {
    const user = blobId(1);
    const asst = blobId(2);
    const res = blobId(3);
    const root = blobId(9);
    const parsed = parseCliBlobs(
      [
        { id: user, data: userBlob("edit the readme", TS) },
        { id: asst, data: assistantToolBlob("Write", { path: "/repo/README.md", contents: "a\nb\nc\n" }) },
        { id: res, data: okToolResultBlob("t1", "Wrote contents to /repo/README.md") },
        { id: root, data: rootBlob([user, asst, res]) },
      ],
      { latestRootBlobId: root },
    );
    const p = buildPrompts(parsed, undefined).find((x) => x.role === "assistant")!;
    assert.deepEqual(p.metadata?.filesEdited, ["/repo/README.md"]);
    assert.equal(p.metadata?.linesAdded, 3); // "a\nb\nc\n" → 3 logical lines
    assert.equal(p.metadata?.linesRemoved, 0);
    // The edited path also reaches the session-level edited set.
    assert.deepEqual(parsed.editedFilePaths, ["/repo/README.md"]);
  });

  it("stamps +new/-old on a StrReplace tool prompt", () => {
    const user = blobId(1);
    const asst = blobId(2);
    const res = blobId(3);
    const root = blobId(9);
    const parsed = parseCliBlobs(
      [
        { id: user, data: userBlob("swap the import", TS) },
        {
          id: asst,
          data: assistantToolBlob("StrReplace", {
            path: "/repo/x.ts",
            old_string: "import A\nimport B",
            new_string: "import C",
          }),
        },
        { id: res, data: okToolResultBlob("t1", "The file /repo/x.ts has been updated.") },
        { id: root, data: rootBlob([user, asst, res]) },
      ],
      { latestRootBlobId: root },
    );
    const p = buildPrompts(parsed, undefined).find((x) => x.role === "assistant")!;
    assert.deepEqual(p.metadata?.filesEdited, ["/repo/x.ts"]);
    assert.equal(p.metadata?.linesAdded, 1);
    assert.equal(p.metadata?.linesRemoved, 2);
  });

  it("records a Delete's file with line fields ABSENT (uncountable, not zero)", () => {
    const user = blobId(1);
    const asst = blobId(2);
    const res = blobId(3);
    const root = blobId(9);
    const parsed = parseCliBlobs(
      [
        { id: user, data: userBlob("remove the file", TS) },
        { id: asst, data: assistantToolBlob("Delete", { path: "/repo/old.ts" }) },
        { id: res, data: okToolResultBlob("t1") },
        { id: root, data: rootBlob([user, asst, res]) },
      ],
      { latestRootBlobId: root },
    );
    const p = buildPrompts(parsed, undefined).find((x) => x.role === "assistant")!;
    assert.deepEqual(p.metadata?.filesEdited, ["/repo/old.ts"]);
    assert.equal(p.metadata?.linesAdded, undefined);
    assert.equal(p.metadata?.linesRemoved, undefined);
    assert.deepEqual(parsed.editedFilePaths, ["/repo/old.ts"]);
  });

  it("leaves line fields ABSENT for a non-edit tool (Read)", () => {
    const user = blobId(1);
    const asst = blobId(2);
    const res = blobId(3);
    const root = blobId(9);
    const parsed = parseCliBlobs(
      [
        { id: user, data: userBlob("read it", TS) },
        { id: asst, data: assistantToolBlob("Read", { path: "/repo/x.ts" }) },
        { id: res, data: okToolResultBlob("t1", "file body") },
        { id: root, data: rootBlob([user, asst, res]) },
      ],
      { latestRootBlobId: root },
    );
    const p = buildPrompts(parsed, undefined).find((x) => x.role === "assistant")!;
    assert.equal(p.metadata?.filesEdited, undefined);
    assert.equal(p.metadata?.linesAdded, undefined);
    assert.equal(p.metadata?.linesRemoved, undefined);
    assert.deepEqual(parsed.editedFilePaths, []);
  });

  it("does not count a StrReplace that failed (structured error)", () => {
    const user = blobId(1);
    const asst = blobId(2);
    const toolRes = blobId(3);
    const root = blobId(9);
    const parsed = parseCliBlobs(
      [
        { id: user, data: userBlob("swap", TS) },
        {
          id: asst,
          data: assistantToolBlob(
            "StrReplace",
            { path: "/repo/x.ts", old_string: "missing", new_string: "new" },
            "call-err",
          ),
        },
        { id: toolRes, data: erroredToolResultBlob("call-err") },
        { id: root, data: rootBlob([user, asst, toolRes]) },
      ],
      { latestRootBlobId: root },
    );
    const p = buildPrompts(parsed, undefined).find((x) => x.role === "assistant")!;
    assert.equal(p.metadata?.filesEdited, undefined);
    assert.equal(p.metadata?.linesAdded, undefined);
    assert.deepEqual(parsed.editedFilePaths, []);
  });

  it("stamps no per-message delta for a result-less edit, but still attributes its file", () => {
    // No tool-result blob → outcome undefined → completion unconfirmed. The per-message
    // line delta is withheld (no confident count), but the session-level file set still
    // attributes it (recall-oriented, matching the Shell 'missing result = ran' default).
    const user = blobId(1);
    const asst = blobId(2);
    const root = blobId(9);
    const parsed = parseCliBlobs(
      [
        { id: user, data: userBlob("write then crash", TS) },
        { id: asst, data: assistantToolBlob("Write", { path: "/repo/x.ts", contents: "a\nb" }) },
        { id: root, data: rootBlob([user, asst]) },
      ],
      { latestRootBlobId: root },
    );
    const p = buildPrompts(parsed, undefined).find((x) => x.role === "assistant")!;
    assert.equal(p.metadata?.filesEdited, undefined);
    assert.equal(p.metadata?.linesAdded, undefined);
    assert.deepEqual(parsed.editedFilePaths, ["/repo/x.ts"]);
  });

  it("reports a Write's file but ABSENT lines when `contents` is missing (uncountable, not zero)", () => {
    assert.deepEqual(cliEditCounts("Write", { path: "/a/b.ts" }), { filePath: "/a/b.ts" });
    // A StrReplace missing one side is likewise uncountable, not a fabricated zero.
    assert.deepEqual(cliEditCounts("StrReplace", { path: "/a/b.ts", new_string: "x" }), { filePath: "/a/b.ts" });
  });

  it("drops per-message edit metadata on the legacy fallback path, but keeps session editedFilePaths", () => {
    // No latestRootBlobId → the protobuf-root order is not recovered → buildPrompts takes
    // the users-then-assistants fallback, which cannot attach per-message edits (same limit
    // as the messageId stamp). The session-level edited set is still populated.
    const parsed = parseCliBlobs([
      { id: blobId(1), data: userBlob("edit it", TS) },
      { id: blobId(2), data: assistantToolBlob("Write", { path: "/repo/x.ts", contents: "a\nb\nc" }) },
      { id: blobId(3), data: okToolResultBlob("t1", "Wrote contents to /repo/x.ts") },
    ]); // no opts → no ordered entries
    const prompts = buildPrompts(parsed, undefined);
    assert.equal(prompts.some((p) => p.metadata?.filesEdited), false);
    assert.deepEqual(parsed.editedFilePaths, ["/repo/x.ts"]);
  });
});
