// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getParsedTranscript, resetTranscriptCache } from "../../internal";

// The shared transcript parse cache: one readFileSync + JSON.parse per
// (path, mtime, size), shared by the conversation extractor and the usage
// parser within a cycle. Reference-equality of the returned lines array is the
// observable proof of a cache hit (a re-read builds a fresh array).

const LINE_A = JSON.stringify({ type: "user", n: 1 });
const LINE_B = JSON.stringify({ type: "assistant", n: 2 });


describe("transcriptCache", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lse-transcript-cache-"));
    resetTranscriptCache();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

  const write = (name: string, body: string): string => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  it("parses once per (path, mtime, size): second call returns the same lines array", () => {
    const p = write("a.jsonl", `${LINE_A}\n  \nnot json\n${LINE_B}\n`);
    const first = getParsedTranscript(p);
    assert.ok(first);
    assert.deepEqual(first!.lines, [{ type: "user", n: 1 }, { type: "assistant", n: 2 }], "empty + malformed lines skipped");

    const second = getParsedTranscript(p);
    assert.ok(second);
    assert.equal(second!.lines, first!.lines, "unchanged file → cache hit (same array reference)");
  });

  it("resetTranscriptCache forces a re-read", () => {
    const p = write("b.jsonl", `${LINE_A}\n`);
    const first = getParsedTranscript(p);
    resetTranscriptCache();
    const second = getParsedTranscript(p);
    assert.ok(first && second);
    assert.notEqual(second!.lines, first!.lines, "post-reset call re-reads (fresh array)");
    assert.deepEqual(second!.lines, first!.lines, "same content either way");
  });

  it("returns null for a file over the size fuse (sparse file, no real bytes written)", () => {
    const p = join(dir, "huge.jsonl");
    const fd = openSync(p, "w");
    try {
      // Sparse-extend past the 128MB fuse: stat reports the size, no disk used,
      // and the guard must return before ever reading the file.
      ftruncateSync(fd, 128 * 1024 * 1024 + 1);
    } finally {
      closeSync(fd);
    }
    assert.equal(getParsedTranscript(p), null, "pathological file skipped");
  });

  it("evicts the oldest entry past MAX_ENTRIES (256) distinct paths", () => {
    const first = getParsedTranscript(write("f0.jsonl", `${LINE_A}\n`));
    assert.ok(first);
    // 256 more distinct paths push f0 out of the LRU (capacity 256).
    for (let i = 1; i <= 256; i++) {
      assert.ok(getParsedTranscript(write(`f${i}.jsonl`, `${LINE_A}\n`)));
    }
    const again = getParsedTranscript(join(dir, "f0.jsonl"));
    assert.ok(again);
    assert.notEqual(again!.lines, first!.lines, "f0 was evicted, so this is a fresh re-read");
  });
});


