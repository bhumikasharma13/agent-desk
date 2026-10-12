// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The full-JWT and private-key scanners find exactly the spans the regexes they
 * replaced found, which are kept here as the oracle: on hand-picked edges, and on
 * seeded random text built from each pattern's own pieces.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectJwtSpans, collectPrivateKeySpans, redactSecrets, type Span } from "../secrets";

// A PEM header built at runtime, so the source itself holds no private-key header.
const BEGIN = `${"-".repeat(5)}BEGIN `;

const M = "████████";

const OLD_JWT = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g;
const OLD_PEM = [
  /-----BEGIN (?:ENCRYPTED |RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:ENCRYPTED |RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  /-----BEGIN (?:ENCRYPTED |RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----(?![\s\S]*?-----END (?:ENCRYPTED |RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----)[\s\S]*/g,
];

function regexSpans(patterns: RegExp[], text: string): Span[] {
  const spans: Span[] = [];
  for (const re of patterns) for (const m of text.matchAll(re)) spans.push({ start: m.index, end: m.index + m[0].length });
  return sorted(spans);
}

function sorted(spans: Span[]): Span[] {
  return [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** mulberry32: a small seeded generator, so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(next: () => number, from: readonly T[]): T {
  return from[Math.floor(next() * from.length)]!;
}

/** Up to 16 of the pieces, end to end. */
function randomPemText(next: () => number, pieces: readonly string[]): string {
  let out = "";
  const n = Math.floor(next() * 16);
  for (let i = 0; i < n; i++) out += pick(next, pieces);
  return out;
}

/**
 * Up to 9 runs of class characters, half led by `eyJ`, each 6 to 23 pieces long (around
 * the 10 and 20 thresholds) and closed by a `.` or a character that ends a run.
 */
function randomJwtText(next: () => number): string {
  let out = "";
  const runs = Math.floor(next() * 10);
  for (let i = 0; i < runs; i++) {
    if (next() < 0.5) out += "eyJ";
    const len = 6 + Math.floor(next() * 18);
    for (let j = 0; j < len; j++) out += pick(next, ["a", "Z", "9", "_", "-", "e", "eyJ"]);
    out += pick(next, [".", ".", ".", " ", "é", "+"]);
  }
  return out;
}

const JWT_HEADER = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"; // fake credential, test fixture. gitleaks:allow
const JWT = `${JWT_HEADER}.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fw`; // fake credential, test fixture. gitleaks:allow

const JWT_CASES = [
  "",
  JWT,
  `token${JWT}`,
  `a.${JWT}.b`,
  `eyJeyJeyJ${JWT.slice(3)}`,
  `${"eyJ".repeat(10)}.${"x".repeat(20)}.${"y".repeat(10)}`,
  `${"eyJ".repeat(7)}.${"x".repeat(20)}.${"y".repeat(10)}`,
  `eyJ${"a".repeat(19)}.${"b".repeat(20)}.${"c".repeat(10)}`,
  `eyJ${"a".repeat(20)}.${"b".repeat(19)}.${"c".repeat(10)}`,
  `eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(9)}`,
  `eyJ${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(9)}.eyJ${"d".repeat(20)}.${"e".repeat(20)}.${"f".repeat(10)}`,
  `eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.eyJ${"c".repeat(20)}.${"d".repeat(10)}`,
  `${JWT} ${JWT}`,
  `${JWT}.${JWT}`,
];

const PEM_CASES = [
  "",
  `${BEGIN}PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----`,
  `${BEGIN}RSA PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY----- tail`,
  `x ${BEGIN}ENCRYPTED PRIVATE KEY-----\nabc`,
  `${BEGIN}PRIVATE KEY-----END PRIVATE KEY-----`,
  `${BEGIN}PRIVATE KEY-----X${BEGIN}PRIVATE KEY-----END PRIVATE KEY-----`,
  `${BEGIN}PRIVATE KEY-----a-----END PRIVATE KEY-----b${BEGIN}DSA PRIVATE KEY-----c`,
  `${BEGIN}PRIVATE KEY-----a${BEGIN}PRIVATE KEY-----b-----END PRIVATE KEY-----c-----END PRIVATE KEY-----`,
  `-${BEGIN}PRIVATE KEY-----a-----END  PRIVATE KEY----------END PRIVATE KEY-----`,
  `${BEGIN}PUBLIC KEY-----a-----END PUBLIC KEY-----`,
  `${BEGIN}RSA EC PRIVATE KEY-----a-----END PRIVATE KEY-----`,
  `-----END PRIVATE KEY-----${BEGIN}OPENSSH PRIVATE KEY-----`,
];

describe("collectJwtSpans — the full-JWT regex's spans", () => {
  it("matches the regex on each edge case", () => {
    for (const text of JWT_CASES) assert.deepEqual(sorted(collectJwtSpans(text)), regexSpans([OLD_JWT], text), text);
  });

  it("matches the regex on 20 000 seeded random texts", () => {
    const next = rng(0x5eed);
    let found = 0;
    for (let i = 0; i < 20_000; i++) {
      const text = randomJwtText(next);
      const want = regexSpans([OLD_JWT], text);
      assert.deepEqual(sorted(collectJwtSpans(text)), want, JSON.stringify(text));
      found += want.length;
    }
    assert.ok(found > 1000, `the texts held ${found} JWTs`);
  });
});

describe("collectPrivateKeySpans — the two PEM regexes' spans", () => {
  it("matches the regexes on each edge case", () => {
    for (const text of PEM_CASES) assert.deepEqual(sorted(collectPrivateKeySpans(text)), regexSpans(OLD_PEM, text), text);
  });

  it("matches the regexes on 20 000 seeded random texts", () => {
    const next = rng(0xbe9);
    const pieces = [
      BEGIN, "-----END ", "PRIVATE KEY-----", "RSA ", "EC ", "DSA ", "OPENSSH ", "ENCRYPTED ", "-----", "-",
      `${BEGIN}PRIVATE KEY-----`, "-----END PRIVATE KEY-----", `${BEGIN}RSA PRIVATE KEY-----`, "-----END EC PRIVATE KEY-----",
      "\n", "abc", " ", "KEY",
    ];
    let found = 0;
    for (let i = 0; i < 20_000; i++) {
      const text = randomPemText(next, pieces);
      const want = regexSpans(OLD_PEM, text);
      assert.deepEqual(sorted(collectPrivateKeySpans(text)), want, JSON.stringify(text));
      found += want.length;
    }
    assert.ok(found > 5000, `the texts held ${found} keys`);
  });
});

describe("redactSecrets — the same JWTs and keys are masked", () => {
  it("masks a full JWT right after a word character", () => {
    assert.equal(redactSecrets(`token${JWT} end`), `token${M} end`);
  });

  it("masks a JWT that a run of `eyJ` leads into", () => {
    assert.equal(redactSecrets(`x eyJeyJ${JWT.slice(3)} y`), `x ${M} y`);
  });

  it("masks a key's header that runs into its own END line", () => {
    assert.equal(redactSecrets(`a ${BEGIN}PRIVATE KEY-----END PRIVATE KEY----- b`), `a ${M}`);
  });

  it("masks a closed block and a later block cut before its END line", () => {
    assert.equal(
      redactSecrets(`a ${BEGIN}PRIVATE KEY-----\nk1\n-----END PRIVATE KEY----- b ${BEGIN}EC PRIVATE KEY-----\nk2`),
      `a ${M} b ${M}`,
    );
  });
});
