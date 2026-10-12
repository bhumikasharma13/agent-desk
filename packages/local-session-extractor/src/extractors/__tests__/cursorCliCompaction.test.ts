// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCliBlobs } from "../../internal";

// Field-5 protobuf wire encoders — the same layout the saturation test validates against a
// real captured store.db blob (segment = {1:id, 3:tokens, 4:chars}; composition = 5 → 3 → 3[]).
// The end-to-end behaviour was also checked against real ~/.cursor/chats store.db data;
// this fixture pins the same path portably.
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
function segment(id: string, tokens: number): number[] {
  const body = [
    ...lenDelim(1, [...Buffer.from(id, "utf8")]),
    (3 << 3) | 0, ...encodeVarint(tokens), // field 3: tokens (absent → 0)
    (4 << 3) | 0, ...encodeVarint(tokens * 4), // field 4: chars (arbitrary)
  ];
  return lenDelim(3, body);
}
/** One per-turn field-5 snapshot: total (distinct, so dedup keeps it), window ≥ 1000,
 *  refs = chronological order key, and the summarized_conversation category at `summarized`. */
function turnBlob(total: number, refs: number, summarized: number): { id: string; data: Buffer } {
  const parts: number[] = [];
  for (let i = 0; i < refs; i++) parts.push(...lenDelim(1, [i & 0xff]));
  const inner = [
    (1 << 3) | 0, ...encodeVarint(total),
    (2 << 3) | 0, ...encodeVarint(200000),
    ...segment("conversation", total),
    ...segment("summarized_conversation", summarized),
  ];
  const comp = [
    (1 << 3) | 0, ...encodeVarint(total),
    (2 << 3) | 0, ...encodeVarint(200000),
    ...lenDelim(3, inner),
  ];
  parts.push(...lenDelim(5, comp));
  return { id: `blob-${refs}`, data: Buffer.from(parts) };
}

describe("parseCliBlobs — compaction count", () => {
  it("counts each 0→non-zero summarized_conversation transition as one compaction", () => {
    // summarized series over turns: 0, 0, 1990, 1990, 0, 500
    //   → two introductions of summarized history (turn 3 and turn 6) = 2 compactions.
    const blobs = [
      turnBlob(1000, 1, 0),
      turnBlob(2000, 2, 0),
      turnBlob(3000, 3, 1990),
      turnBlob(4000, 4, 1990),
      turnBlob(5000, 5, 0),
      turnBlob(6000, 6, 500),
    ];
    const parsed = parseCliBlobs(blobs);
    assert.equal(parsed.compactionCount, 2, "two distinct 0→non-zero summarized transitions");
  });

  it("counts 0 compactions when summarized_conversation never becomes non-zero", () => {
    const blobs = [turnBlob(1000, 1, 0), turnBlob(2000, 2, 0), turnBlob(3000, 3, 0)];
    const parsed = parseCliBlobs(blobs);
    assert.equal(parsed.compactionCount, 0);
  });

  it("counts a compaction that begins on the very first turn", () => {
    const blobs = [turnBlob(1000, 1, 500), turnBlob(2000, 2, 500)];
    const parsed = parseCliBlobs(blobs);
    assert.equal(parsed.compactionCount, 1, "summarized non-zero from turn 1 (prev inits 0) → one compaction");
  });

  it("ignores a 0-total (emitted-but-empty) checkpoint between two summarized turns", () => {
    // A 0-total snapshot reads summarized=0; without the total>0 guard it would reset the
    // run and mis-count the second 1990 as a fresh compaction. The summary is ongoing → 1.
    const blobs = [turnBlob(3000, 1, 1990), turnBlob(0, 2, 0), turnBlob(4000, 3, 1990)];
    const parsed = parseCliBlobs(blobs);
    assert.equal(parsed.compactionCount, 1, "the interspersed 0-total checkpoint must not restart the run");
  });
});
