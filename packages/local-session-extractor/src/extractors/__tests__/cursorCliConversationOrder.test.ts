// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Cursor CLI transcript order.
 *
 * store.db blobs are content-addressed (unordered in the table). The protobuf
 * root's top-level field 1 is the SHA-256 of each child blob as 32 raw bytes
 * (hex = blobs.id); field 13 points at prior-era roots after summarization.
 * Those field numbers and lengths were read off live ~/.cursor/chats store.db
 * sessions (current cursor-agent), not invented to match the decoder.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPrompts, countCliAssistantTexts, MAX_CHECKPOINTS, parseCliBlobs } from "../../internal";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/extraction");
const CAPTURED_IDS = JSON.parse(
  readFileSync(join(FIXTURES, "cursor-cli-root-ids.json"), "utf8"),
) as {
  latestRoot: { file: string; childIds: string[] };
  summarized: {
    latestFile: string;
    priorFile: string;
    otherPriorFile: string;
    priorRootId: string;
    otherPriorRootId: string;
    priorOnlyChildId: string;
    latestOnlyChildId: string;
  };
};

function encodeVarint(value: number): number[] {
  const out: number[] = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return out;
}

function lenDelim(field: number, payload: number[]): number[] {
  return [(field << 3) | 2, ...encodeVarint(payload.length), ...payload];
}

/** 32-byte id used as both blobs.id and a protobuf field-1 / field-13 value. */
function blobId(n: number): string {
  return Buffer.alloc(32, n).toString("hex");
}

function shaField(field: number, hexId: string): number[] {
  return lenDelim(field, [...Buffer.from(hexId, "hex")]);
}

function rootBlob(childIds: string[], priorRootIds: string[] = []): Buffer {
  const parts: number[] = [];
  for (const id of childIds) parts.push(...shaField(1, id));
  for (const id of priorRootIds) parts.push(...shaField(13, id));
  return Buffer.from(parts);
}

// A protobuf tag is itself a varint, so fields >= 16 need a multi-byte tag —
// lenDelim/shaField above hard-code a single tag byte and are only correct for
// the low field numbers (1, 13) they are used with. These varint-tag builders
// handle the high-numbered fields a real root carries.
function tagBytes(field: number, wire: number): number[] {
  return encodeVarint((field << 3) | wire);
}
function vField(field: number, value: number): number[] {
  return [...tagBytes(field, 0), ...encodeVarint(value)];
}
function lField(field: number, payload: number[]): number[] {
  return [...tagBytes(field, 2), ...encodeVarint(payload.length), ...payload];
}

/**
 * A root that reproduces the TOP-LEVEL field:wire shape of a real cursor-agent
 * root (read off live ~/.cursor/chats store.db roots): besides field-1 children
 * and field-13 priors, every real root carries field 5 (wire 2, the context
 * composition), fields 8/9/18/22/27 (wire 2), and the VARINT fields 10 and 26.
 * The payloads here are synthetic/numeric — no prompt text — but the field/wire
 * mix is real, so topLevelDecodeComplete has to walk varint AND length-delimited
 * top-level fields all the way to buf.length, and readSha256BlobRefs has to
 * ignore the non-32-byte ones. The committed .bin fixtures are field-1/13-only
 * reductions, so this is the only path that pins the gate against a real root's
 * full shape rather than a stripped one.
 */
function realShapedRoot(childIds: string[], priorRootIds: string[] = []): Buffer {
  const parts: number[] = [];
  for (const id of childIds) parts.push(...lField(1, [...Buffer.from(id, "hex")]));
  parts.push(...lField(5, [...vField(1, 6652), ...vField(2, 200000)]));
  parts.push(...lField(8, [1, 2, 3]));
  parts.push(...lField(9, [4, 5]));
  parts.push(...vField(10, 1)); // wire-0 varint sitting between id fields
  for (const id of priorRootIds) parts.push(...lField(13, [...Buffer.from(id, "hex")]));
  parts.push(...lField(18, [6, 7, 8, 9]));
  parts.push(...lField(22, [0]));
  parts.push(...vField(26, 1_750_000_000)); // session-constant varint
  parts.push(...lField(27, [10]));
  return Buffer.from(parts);
}

/** Build a Cursor CLI XML tag. A literal open-tag in TS source is parsed as a type argument. */
function tagged(name: string, body: string): string {
  return ["<", name, ">", body, "</", name, ">"].join("");
}

function userBlob(query: string, ts: string): Buffer {
  const text = tagged("timestamp", ts) + "\n" + tagged("user_query", "\n" + query + "\n");
  return Buffer.from(JSON.stringify({ role: "user", content: [{ type: "text", text }] }), "utf8");
}

function userInfoBlob(): Buffer {
  return Buffer.from(JSON.stringify({ role: "user", content: tagged("user_info", "cwd=x") }), "utf8");
}

/** A user blob carrying Cursor's generation-id join key (providerOptions.cursor.requestId). */
function userBlobWithRequestId(query: string, ts: string, requestId: string): Buffer {
  const text = tagged("timestamp", ts) + "\n" + tagged("user_query", "\n" + query + "\n");
  return Buffer.from(
    JSON.stringify({ role: "user", content: [{ type: "text", text }], providerOptions: { cursor: { requestId } } }),
    "utf8",
  );
}

function assistantBlob(text: string): Buffer {
  return Buffer.from(JSON.stringify({ role: "assistant", content: [{ type: "text", text }] }), "utf8");
}

function assistantBlobWithTool(text: string, toolName: string, args: Record<string, unknown>): Buffer {
  return Buffer.from(
    JSON.stringify({
      role: "assistant",
      content: [
        { type: "text", text },
        { type: "tool-call", toolCallId: "t1", toolName, args },
      ],
    }),
    "utf8",
  );
}

describe("Cursor CLI conversation order from the protobuf root", () => {
  it("emits user, assistant, user — not every user prompt first", () => {
    const userA = blobId(1);
    const asst = blobId(2);
    const userB = blobId(3);
    const root = blobId(9);
    // SQL/table order is reversed on purpose; the root chain is the order source.
    const parsed = parseCliBlobs(
      [
        { id: userB, data: userBlob("later prompt", "Wednesday, Jul 8, 2026, 8:00 PM (UTC+0)") },
        { id: userA, data: userBlob("first prompt", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
        { id: asst, data: assistantBlob("working on it") },
        { id: root, data: rootBlob([userA, asst, userB]) },
      ],
      { latestRootBlobId: root },
    );
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "first prompt"],
        ["assistant", "working on it"],
        ["user", "later prompt"],
      ],
    );
  });

  it("stamps each user turn's requestId as messageId on the first assistant prompt of its run", () => {
    const user1 = blobId(1);
    const asst1 = blobId(2); // text + tool → two assistant prompts, one run
    const user2 = blobId(3);
    const asst2 = blobId(4);
    const root = blobId(9);
    const parsed = parseCliBlobs(
      [
        { id: user1, data: userBlobWithRequestId("q1", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)", "gen-1") },
        { id: asst1, data: assistantBlobWithTool("working", "Shell", { command: "ls" }) },
        { id: user2, data: userBlobWithRequestId("q2", "Wednesday, Jul 8, 2026, 7:05 PM (UTC+0)", "gen-2") },
        { id: asst2, data: assistantBlob("done") },
        { id: root, data: rootBlob([user1, asst1, user2, asst2]) },
      ],
      { latestRootBlobId: root },
    );
    const prompts = buildPrompts(parsed, undefined);
    const asst = prompts.filter((p) => p.role === "assistant");
    // First assistant of turn 1's run carries gen-1; the tool placeholder in the same run does not.
    assert.equal(asst[0]!.metadata?.messageId, "gen-1");
    assert.equal(asst[1]!.metadata?.messageId, undefined);
    // Turn 2's assistant carries gen-2 — by its own user turn's id, not by position.
    assert.equal(asst[2]!.metadata?.messageId, "gen-2");
  });

  it("skips the leading user_info context blob the way parseUserBlob already does", () => {
    const info = blobId(1);
    const userA = blobId(2);
    const asst = blobId(3);
    const root = blobId(9);
    const parsed = parseCliBlobs(
      [
        { id: info, data: userInfoBlob() },
        { id: userA, data: userBlob("first prompt", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
        { id: asst, data: assistantBlob("ok") },
        { id: root, data: rootBlob([info, userA, asst]) },
      ],
      { latestRootBlobId: root },
    );
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "first prompt"],
        ["assistant", "ok"],
      ],
    );
  });

  it("walks field-13 prior-era roots so a summarized session keeps early turns", () => {
    const userA = blobId(1);
    const asst1 = blobId(2);
    const asst2 = blobId(3);
    const userB = blobId(4);
    const era1 = blobId(8);
    const latest = blobId(9);
    const parsed = parseCliBlobs(
      [
        { id: userA, data: userBlob("first prompt", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
        { id: asst1, data: assistantBlob("era 1 reply") },
        { id: asst2, data: assistantBlob("era 2 reply") },
        { id: userB, data: userBlob("later prompt", "Wednesday, Jul 8, 2026, 8:00 PM (UTC+0)") },
        { id: era1, data: rootBlob([userA, asst1]) },
        { id: latest, data: rootBlob([asst2, userB], [era1]) },
      ],
      { latestRootBlobId: latest },
    );
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "first prompt"],
        ["assistant", "era 1 reply"],
        ["assistant", "era 2 reply"],
        ["user", "later prompt"],
      ],
    );
  });

  it("does not emit a JSON blob that exists in the store but is not on the root chain", () => {
    const userA = blobId(1);
    const asst = blobId(2);
    const leftover = blobId(3);
    const root = blobId(9);
    const parsed = parseCliBlobs(
      [
        { id: leftover, data: userBlob("orphan prompt", "Wednesday, Jul 8, 2026, 9:00 PM (UTC+0)") },
        { id: userA, data: userBlob("first prompt", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
        { id: asst, data: assistantBlob("ok") },
        { id: root, data: rootBlob([userA, asst]) },
      ],
      { latestRootBlobId: root },
    );
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "first prompt"],
        ["assistant", "ok"],
      ],
    );
    assert.equal(parsed.userTurns.length, 2, "orphan is still parsed; prompts[] drop it when the chain is complete");
  });

  it("falls back to every parsed turn when a field-13 prior root is missing from the store", () => {
    const userA = blobId(1);
    const asst1 = blobId(2);
    const asst2 = blobId(3);
    const userB = blobId(4);
    const era1 = blobId(8);
    const latest = blobId(9);
    const parsed = parseCliBlobs(
      [
        { id: userA, data: userBlob("first prompt", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
        { id: asst1, data: assistantBlob("era 1 reply") },
        { id: asst2, data: assistantBlob("era 2 reply") },
        { id: userB, data: userBlob("later prompt", "Wednesday, Jul 8, 2026, 8:00 PM (UTC+0)") },
        { id: latest, data: rootBlob([asst2, userB], [era1]) },
      ],
      { latestRootBlobId: latest },
    );
    assert.equal(parsed.conversationEntries.length, 0);
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "first prompt"],
        ["user", "later prompt"],
        ["assistant", "era 1 reply"],
        ["assistant", "era 2 reply"],
      ],
    );
  });

  it("falls back when a field-13 prior root exists but is an empty blob", () => {
    const userA = blobId(1);
    const asst1 = blobId(2);
    const asst2 = blobId(3);
    const userB = blobId(4);
    const era1 = blobId(8);
    const latest = blobId(9);
    const parsed = parseCliBlobs(
      [
        { id: userA, data: userBlob("first prompt", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
        { id: asst1, data: assistantBlob("era 1 reply") },
        { id: asst2, data: assistantBlob("era 2 reply") },
        { id: userB, data: userBlob("later prompt", "Wednesday, Jul 8, 2026, 8:00 PM (UTC+0)") },
        { id: era1, data: Buffer.alloc(0) },
        { id: latest, data: rootBlob([asst2, userB], [era1]) },
      ],
      { latestRootBlobId: latest },
    );
    assert.equal(parsed.conversationEntries.length, 0);
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "first prompt"],
        ["user", "later prompt"],
        ["assistant", "era 1 reply"],
        ["assistant", "era 2 reply"],
      ],
    );
  });

  it("falls back to users-then-assistants when no root id is supplied", () => {
    const parsed = parseCliBlobs([
      { data: userBlob("first prompt", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
      { data: assistantBlob("working on it") },
      { data: userBlob("later prompt", "Wednesday, Jul 8, 2026, 8:00 PM (UTC+0)") },
    ]);
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "first prompt"],
        ["user", "later prompt"],
        ["assistant", "working on it"],
      ],
    );
  });

  it("falls back when a truncated root blob cannot be decoded to the end", () => {
    const userA = blobId(1);
    const asst = blobId(2);
    const era1 = blobId(8);
    const latest = blobId(9);
    const full = rootBlob([asst], [era1]);
    const parsed = parseCliBlobs(
      [
        { id: userA, data: userBlob("first prompt", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
        { id: asst, data: assistantBlob("ok") },
        { id: era1, data: rootBlob([userA]) },
        { id: latest, data: full.subarray(0, full.length - 1) },
      ],
      { latestRootBlobId: latest },
    );
    assert.equal(parsed.conversationEntries.length, 0);
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "first prompt"],
        ["assistant", "ok"],
      ],
    );
  });

  it("falls back when the chain has no user turn but the store still has one", () => {
    const asst = blobId(2);
    const leftover = blobId(3);
    const root = blobId(9);
    const parsed = parseCliBlobs(
      [
        { id: leftover, data: userBlob("orphan prompt", "Wednesday, Jul 8, 2026, 9:00 PM (UTC+0)") },
        { id: asst, data: assistantBlob("ok") },
        { id: root, data: rootBlob([asst]) },
      ],
      { latestRootBlobId: root },
    );
    assert.equal(parsed.conversationEntries.length, 0);
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "orphan prompt"],
        ["assistant", "ok"],
      ],
    );
  });

  it("falls back when latestRootBlobId is absent from the blob rows", () => {
    const parsed = parseCliBlobs(
      [
        { id: blobId(1), data: userBlob("first prompt", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
        { id: blobId(2), data: assistantBlob("ok") },
      ],
      { latestRootBlobId: blobId(9) },
    );
    assert.equal(parsed.conversationEntries.length, 0);
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "first prompt"],
        ["assistant", "ok"],
      ],
    );
  });

  it("decodes field-1 child ids from a captured Cursor root (not a synthetic encoder)", () => {
    const childIds = CAPTURED_IDS.latestRoot.childIds;
    assert.ok(childIds.length >= 3, "captured root must list at least three children");
    const rootId = "captured-latest-root";
    const parsed = parseCliBlobs(
      [
        { id: childIds[2], data: userBlob("later prompt", "Wednesday, Jul 8, 2026, 8:00 PM (UTC+0)") },
        { id: childIds[0], data: userBlob("first prompt", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
        { id: childIds[1], data: assistantBlob("working on it") },
        { id: rootId, data: readFileSync(join(FIXTURES, CAPTURED_IDS.latestRoot.file)) },
      ],
      { latestRootBlobId: rootId },
    );
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "first prompt"],
        ["assistant", "working on it"],
        ["user", "later prompt"],
      ],
    );
  });

  it("walks field-13 on a captured summarized root so a prior-era child precedes a later-era child", () => {
    const {
      priorRootId,
      otherPriorRootId,
      priorOnlyChildId,
      latestOnlyChildId,
      latestFile,
      priorFile,
      otherPriorFile,
    } = CAPTURED_IDS.summarized;
    const latestId = "captured-summarized-latest";
    const parsed = parseCliBlobs(
      [
        { id: latestOnlyChildId, data: userBlob("later prompt", "Wednesday, Jul 8, 2026, 8:00 PM (UTC+0)") },
        { id: priorOnlyChildId, data: userBlob("first prompt", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
        { id: priorRootId, data: readFileSync(join(FIXTURES, priorFile)) },
        { id: otherPriorRootId, data: readFileSync(join(FIXTURES, otherPriorFile)) },
        { id: latestId, data: readFileSync(join(FIXTURES, latestFile)) },
      ],
      { latestRootBlobId: latestId },
    );
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "first prompt"],
        ["user", "later prompt"],
      ],
    );
    assert.ok(parsed.conversationEntries.length > 0, "complete captured chain must not fall back");
  });

  it("counts two identical assistant texts as two, not one", () => {
    const userA = blobId(1);
    const asst1 = blobId(2);
    const asst2 = blobId(3);
    const root = blobId(9);
    const parsed = parseCliBlobs(
      [
        { id: userA, data: userBlob("go", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
        { id: asst1, data: assistantBlob("Done.") },
        { id: asst2, data: assistantBlob("Done.") },
        { id: root, data: rootBlob([userA, asst1, asst2]) },
      ],
      { latestRootBlobId: root },
    );
    assert.equal(countCliAssistantTexts(parsed), 2);
    assert.equal(parsed.conversationEntries.filter((e) => e.kind === "assistant").length, 2);
  });

  it("does not count on-chain tool placeholders toward assistantMessageCount", () => {
    const userA = blobId(1);
    const asst = blobId(2);
    const root = blobId(9);
    const parsed = parseCliBlobs(
      [
        { id: userA, data: userBlob("read it", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
        { id: asst, data: assistantBlobWithTool("looking", "Read", { path: "/tmp/a.ts" }) },
        { id: root, data: rootBlob([userA, asst]) },
      ],
      { latestRootBlobId: root },
    );
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "read it"],
        ["assistant", "looking"],
        ["assistant", "[Tool: Read path=/tmp/a.ts]"],
      ],
    );
    assert.equal(countCliAssistantTexts(parsed), 1);
    const asstEntries = parsed.conversationEntries.filter((e) => e.kind === "assistant");
    assert.equal(asstEntries.length, 2);
    assert.equal(asstEntries[0]?.blobId, asst);
    assert.equal(asstEntries[1]?.blobId, asst);
  });

  it("engages on a root carrying a real cursor-agent field mix (field-5, varint fields 10/26), not only field-1/13", () => {
    const userA = blobId(1);
    const asst = blobId(2);
    const userB = blobId(3);
    const root = blobId(9);
    const parsed = parseCliBlobs(
      [
        { id: userB, data: userBlob("later prompt", "Wednesday, Jul 8, 2026, 8:00 PM (UTC+0)") },
        { id: userA, data: userBlob("first prompt", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
        { id: asst, data: assistantBlob("working on it") },
        { id: root, data: realShapedRoot([userA, asst, userB]) },
      ],
      { latestRootBlobId: root },
    );
    // The gate accepted a real-shaped root (every top-level varint and
    // length-delimited field decoded to the end) and the walk ran, so we are NOT
    // on the users-then-assistants fallback — this is the case the stripped .bin
    // fixtures cannot exercise.
    assert.ok(parsed.conversationEntries.length > 0, "real-shaped root must not fall back");
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "first prompt"],
        ["assistant", "working on it"],
        ["user", "later prompt"],
      ],
    );
  });

  it("recovers only 32-byte field-1/13 ids from a real-shaped summarized chain, ignoring the other top-level fields", () => {
    // Two real-shaped roots (latest + a field-13 prior). Asserts the non-id
    // top-level fields (5/8/9/18/22/27) and the mid-stream varints (10/26) are
    // neither mistaken for child ids nor desync the walk across eras.
    const userA = blobId(1);
    const asst1 = blobId(2);
    const userB = blobId(3);
    const asst2 = blobId(4);
    const era1 = blobId(8);
    const latest = blobId(9);
    const parsed = parseCliBlobs(
      [
        { id: userA, data: userBlob("first prompt", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
        { id: asst1, data: assistantBlob("era 1 reply") },
        { id: userB, data: userBlob("later prompt", "Wednesday, Jul 8, 2026, 8:00 PM (UTC+0)") },
        { id: asst2, data: assistantBlob("era 2 reply") },
        { id: era1, data: realShapedRoot([userA, asst1]) },
        { id: latest, data: realShapedRoot([userB, asst2], [era1]) },
      ],
      { latestRootBlobId: latest },
    );
    assert.ok(parsed.conversationEntries.length > 0, "complete real-shaped chain must not fall back");
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "first prompt"],
        ["assistant", "era 1 reply"],
        ["user", "later prompt"],
        ["assistant", "era 2 reply"],
      ],
    );
  });

  it("falls back (does not ship a partial transcript) when the field-13 chain exceeds MAX_CHECKPOINTS", () => {
    // A field-13 chain longer than the cap makes the walk report truncated; the
    // safety contract is to drop to users-then-assistants rather than store the
    // visited prefix as the whole conversation. seqId gives distinct 32-byte ids
    // (blobId only varies a single fill byte, so it maxes out at 256).
    const seqId = (n: number): string => {
      const b = Buffer.alloc(32);
      b.writeUInt32BE(n, 0);
      return b.toString("hex");
    };
    const userA = seqId(1_000_001);
    const asst = seqId(1_000_002);
    const rows: Array<{ id: string; data: Buffer }> = [
      { id: userA, data: userBlob("first prompt", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
      { id: asst, data: assistantBlob("ok") },
    ];
    // Roots 0..MAX_CHECKPOINTS-1 chained via field-13; the head carries the turns.
    // root_(cap-1) points at seqId(cap), which is absent — but the cap check fires
    // at that entry before any map lookup, so truncated (not missing-prior) trips.
    for (let i = 0; i < MAX_CHECKPOINTS; i++) {
      rows.push({ id: seqId(i), data: rootBlob(i === 0 ? [userA, asst] : [], [seqId(i + 1)]) });
    }
    const parsed = parseCliBlobs(rows, { latestRootBlobId: seqId(0) });
    assert.equal(parsed.conversationEntries.length, 0, "a truncated walk must not build an on-chain transcript");
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "first prompt"],
        ["assistant", "ok"],
      ],
    );
  });

  it("falls back when a field-13 prior ref is present but not 32 bytes (format drift)", () => {
    // Concrete drift: field-13 carries a 16-byte value instead of a 32-byte SHA.
    // It is present, so it is not a "missing prior" — the width gate must still
    // count it malformed so the chain is not treated as complete and the prior
    // era it named is not silently dropped.
    const userA = blobId(1);
    const asst1 = blobId(2);
    const userB = blobId(3);
    const asst2 = blobId(4);
    const era1 = blobId(8);
    const latest = blobId(9);
    const badLatest = Buffer.from([
      ...shaField(1, userB),
      ...shaField(1, asst2),
      ...lField(13, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), // 16-byte, not 32
    ]);
    const parsed = parseCliBlobs(
      [
        { id: userA, data: userBlob("first prompt", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
        { id: asst1, data: assistantBlob("era 1 reply") },
        { id: userB, data: userBlob("later prompt", "Wednesday, Jul 8, 2026, 8:00 PM (UTC+0)") },
        { id: asst2, data: assistantBlob("era 2 reply") },
        { id: era1, data: rootBlob([userA, asst1]) },
        { id: latest, data: badLatest },
      ],
      { latestRootBlobId: latest },
    );
    assert.equal(parsed.conversationEntries.length, 0, "a wrong-width prior ref must force the bunched fallback");
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "first prompt"],
        ["user", "later prompt"],
        ["assistant", "era 1 reply"],
        ["assistant", "era 2 reply"],
      ],
    );
  });

  it("falls back when a field-1 child ref on the root is not 32 bytes (format drift)", () => {
    // Same drift on the other walk call site: a wrong-width child ref on the
    // emitted root must also mark the chain incomplete, not be quietly skipped.
    const userA = blobId(1);
    const asst = blobId(2);
    const latest = blobId(9);
    const badRoot = Buffer.from([
      ...shaField(1, userA),
      ...lField(1, [1, 2, 3, 4, 5, 6, 7, 8]), // 8-byte, not 32
      ...shaField(1, asst),
    ]);
    const parsed = parseCliBlobs(
      [
        { id: userA, data: userBlob("first prompt", "Wednesday, Jul 8, 2026, 7:00 PM (UTC+0)") },
        { id: asst, data: assistantBlob("ok") },
        { id: latest, data: badRoot },
      ],
      { latestRootBlobId: latest },
    );
    assert.equal(parsed.conversationEntries.length, 0, "a wrong-width child ref must force the bunched fallback");
    const prompts = buildPrompts(parsed, undefined);
    assert.deepEqual(
      prompts.map((p) => [p.role, p.content]),
      [
        ["user", "first prompt"],
        ["assistant", "ok"],
      ],
    );
  });
});
