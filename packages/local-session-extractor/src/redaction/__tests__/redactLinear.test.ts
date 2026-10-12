// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Replacing spans is one pass: the output is what replacing them one at a
 * time from the end gives, and 800 KB of addresses redacts well within 2 s.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets, secretSpans } from "../secrets";

// A PEM header built at runtime, so the source itself holds no private-key header.
const BEGIN = `${"-".repeat(5)}BEGIN `;

const M = "████████";

/** The replacement the one-pass version must match: each span, end to start, by concatenation. */
function replaceOneAtATime(text: string): string {
  const spans = secretSpans(text);
  let out = text;
  for (let i = spans.length - 1; i >= 0; i--) out = out.substring(0, spans[i]!.start) + M + out.substring(spans[i]!.end);
  return out;
}

function* stringsIn(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (Array.isArray(value)) for (const v of value) yield* stringsIn(v);
  else if (value !== null && typeof value === "object") for (const v of Object.values(value)) yield* stringsIn(v);
}

function* corpusFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* corpusFiles(p);
    else if (/\.(jsonl?|json)$/.test(name)) yield p;
  }
}

describe("redactSecrets — one-pass replacement", () => {
  it("gives the same output as one-at-a-time replacement over every string in the fixture corpus", () => {
    let checked = 0;
    let masked = 0;
    for (const file of corpusFiles(new URL("../../../fixtures", import.meta.url).pathname)) {
      const content = readFileSync(file, "utf8");
      const texts = [content];
      for (const line of content.split("\n")) {
        try {
          texts.push(...stringsIn(JSON.parse(line)));
        } catch {
          // not a JSON line; the whole-file text above still covers it
        }
      }
      for (const text of texts) {
        const got = redactSecrets(text);
        assert.equal(got, replaceOneAtATime(text), `${file}: ${text.slice(0, 60)}`);
        checked++;
        if (got !== text) masked++;
      }
    }
    assert.ok(checked > 1000 && masked > 10, `checked ${checked}, masked ${masked}`);
  });

  it("redacts 800 KB of email addresses in under 2 s", () => {
    const text = "ab@x.io ".repeat(100_000);
    const t0 = performance.now();
    const out = redactSecrets(text);
    const ms = performance.now() - t0;
    assert.equal(out, `${M} `.repeat(100_000));
    assert.ok(ms < 2000, `took ${Math.round(ms)} ms`);
  });
});

/** Redacts `text`, asserting it takes under `limitMs`, and returns the output. */
function redactWithin(text: string, limitMs: number): string {
  const t0 = performance.now();
  const out = redactSecrets(text);
  const ms = performance.now() - t0;
  assert.ok(ms < limitMs, `took ${Math.round(ms)} ms`);
  return out;
}

describe("redactSecrets — runs of a pattern's prefix are scanned once", () => {
  // Each start of a JWT or a PEM header used to scan to the end of the run or the text.
  it("redacts 120 KB of `eyJ` in under 2 s", () => {
    assert.equal(redactWithin("eyJ".repeat(40_000), 2000), M);
  });

  it("redacts 2.2 MB of PEM headers with no END line in under 3 s", () => {
    assert.equal(redactWithin(`${BEGIN}PRIVATE KEY-----\n`.repeat(80_000), 3000), M);
  });

  it("redacts 2.2 MB of PEM headers closed by one END line in under 3 s", () => {
    assert.equal(redactWithin(`${`${BEGIN}PRIVATE KEY-----\n`.repeat(80_000)}-----END PRIVATE KEY----- after`, 3000), `${M} after`);
  });
});
