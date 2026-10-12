// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Builds Antigravity state databases for tests: the trajectory-summary protobuf the
 * offline path reads, written into an `ItemTable` like the vendor's.
 */
import { DatabaseSync } from "node:sqlite";

// ── Minimal protobuf encoder, mirroring the parser in antigravityExtractor.ts ──
// Builds the exact double-base64-wrapped structure readTrajectorySummaries/
// parseSummaryInner expect: outer protobuf -> field 1 (repeated Entry) ->
// Entry.field1 (id string) + Entry.field2[0].field1 (inner base64 STRING,
// itself protobuf-encoded) -> SummaryInner fields (1=title, 2=stepCount,
// 3/7=nested {1: seconds} for updatedAt/createdAt, 9=nested {1: uri}).

function writeVarint(n: number): Buffer {
  const bytes: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0);
  return Buffer.from(bytes);
}

function writeTag(fieldNum: number, wireType: number): Buffer {
  return writeVarint((fieldNum << 3) | wireType);
}

function writeVarintField(fieldNum: number, value: number): Buffer {
  return Buffer.concat([writeTag(fieldNum, 0), writeVarint(value)]);
}

function writeLenDelimited(fieldNum: number, payload: Buffer): Buffer {
  return Buffer.concat([writeTag(fieldNum, 2), writeVarint(payload.length), payload]);
}

function writeStringField(fieldNum: number, value: string): Buffer {
  return writeLenDelimited(fieldNum, Buffer.from(value, "utf8"));
}

export function encodeSummaryInner(opts: {
  title: string;
  stepCount?: number;
  updatedAtSecs?: number;
  createdAtSecs?: number;
  workspaceUri?: string;
}): Buffer {
  const parts: Buffer[] = [writeStringField(1, opts.title)];
  if (opts.stepCount !== undefined) parts.push(writeVarintField(2, opts.stepCount));
  if (opts.updatedAtSecs !== undefined) {
    parts.push(writeLenDelimited(3, writeVarintField(1, opts.updatedAtSecs)));
  }
  if (opts.createdAtSecs !== undefined) {
    parts.push(writeLenDelimited(7, writeVarintField(1, opts.createdAtSecs)));
  }
  if (opts.workspaceUri !== undefined) {
    parts.push(writeLenDelimited(9, writeStringField(1, opts.workspaceUri)));
  }
  return Buffer.concat(parts);
}

export function encodeTrajectorySummariesValue(entries: { id: string; inner: Buffer }[]): string {
  const entryBufs = entries.map(({ id, inner }) => {
    const innerBase64 = inner.toString("base64");
    const blobMessage = writeStringField(1, innerBase64);
    return Buffer.concat([writeStringField(1, id), writeLenDelimited(2, blobMessage)]);
  });
  const outer = Buffer.concat(entryBufs.map((e) => writeLenDelimited(1, e)));
  return outer.toString("base64");
}

/** Writes a state database at `path` holding `entries` as its trajectory summaries. */
export function writeAntigravityStateDb(path: string, entries: { id: string; inner: Buffer }[]): void {
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)`);
  raw.prepare(`INSERT INTO ItemTable (key, value) VALUES (?, ?)`).run("antigravityUnifiedStateSync.trajectorySummaries", encodeTrajectorySummariesValue(entries));
  raw.close();
}
