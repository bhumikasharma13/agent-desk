// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * User names in the forms the text pass must hash: Cursor's `Users-<name>`
 * project folders, a non-ASCII name, and the shortest name hashed in prose.
 * Also pins the order `redactText` applies its two passes in.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { anonymizePath, anonymizeText, hashUsername, setRunningUsernameForTests, withHomeOwners } from "../anonymizer";
import { redactText } from "../index";

function asUser<T>(name: string, fn: () => T): T {
  const restore = setRunningUsernameForTests(name);
  try {
    return fn();
  } finally {
    restore();
  }
}

describe("anonymizeText — Cursor's Users-<name> folder form", () => {
  it("hashes a scanned home owner's name after a slash", () => {
    const out = withHomeOwners(["alice"], () => anonymizeText("ls ~/.cursor/projects/Users-alice-app/x"));
    assert.equal(out, `ls ~/.cursor/projects/Users-${hashUsername("alice")}-app/x`);
  });

  it("hashes a short running user's name in that form", () => {
    const out = asUser("bob", () => anonymizeText("ls ~/.cursor/projects/Users-bob-app/x"));
    assert.equal(out, `ls ~/.cursor/projects/Users-${hashUsername("bob")}-app/x`);
  });

  it("leaves Users-<name> inside a longer word alone", () => {
    assert.equal(withHomeOwners(["alice"], () => anonymizeText("myUsers-alice-app")), "myUsers-alice-app");
  });
});

describe("anonymizeText — the bare name", () => {
  it("hashes a non-ASCII name as a word", () => {
    const out = asUser("José", () => anonymizeText("hi José, signed José."));
    const h = hashUsername("José");
    assert.equal(out, `hi ${h}, signed ${h}.`);
  });

  it("leaves a non-ASCII name that continues into a longer word", () => {
    assert.equal(asUser("José", () => anonymizeText("Joséfina")), "Joséfina");
  });

  it("hashes a 4-character name in prose", () => {
    const out = asUser("jdoe", () => anonymizeText("ask jdoe about it"));
    assert.equal(out, `ask ${hashUsername("jdoe")} about it`);
  });
});

describe("redactText — pass order", () => {
  it("anonymizes before it scrubs secrets", () => {
    // Anonymizing first leaves "aliceTOKEN" (a longer name) alone, then the key is masked.
    // Scrubbing first would leave `alice` ending its segment, and hash it.
    assert.equal(asUser("alice", () => redactText("/Users/aliceTOKEN=abc")), "/Users/alice████████");
  });
});

describe("anonymizeText — URL-encoded paths", () => {
  it("hashes the name in a %2F-separated path", () => {
    const out = asUser("alice", () => anonymizeText("open %2FUsers%2Falice%2Fapp"));
    assert.equal(out, `open %2FUsers%2F${hashUsername("alice")}%2Fapp`);
  });
});

describe("anonymizePath — a home that is not the leading segment", () => {
  it("hashes the name under a volume prefix", () => {
    const out = asUser("alice", () => anonymizePath("/System/Volumes/Data/Users/alice/app"));
    assert.equal(out, `/System/Volumes/Data/Users/${hashUsername("alice")}/app`);
  });

  it("hashes the name in another letter case on macOS", { skip: process.platform !== "darwin" }, () => {
    const out = asUser("alice", () => anonymizePath("/Users/Alice/app"));
    assert.equal(out, `/Users/${hashUsername("alice")}/app`);
  });

  it("leaves a longer name alone", () => {
    assert.equal(asUser("alice", () => anonymizePath("/Users/alicex/app")), "/Users/alicex/app");
  });
});

describe("anonymizeText — other path encodings and longer names", () => {
  it("hashes the name in a lower-case %2f path", () => {
    assert.equal(asUser("alice", () => anonymizeText("open %2fUsers%2falice%2fapp")), `open %2fUsers%2f${hashUsername("alice")}%2fapp`);
  });

  it("hashes the name in a double-encoded %252F path", () => {
    assert.equal(asUser("alice", () => anonymizeText("open %252FUsers%252Falice%252Fapp")), `open %252FUsers%252F${hashUsername("alice")}%252Fapp`);
  });

  it("leaves /Users/alice2 alone, in text and in a path", () => {
    assert.equal(asUser("alice", () => anonymizeText("cd /Users/alice2/app")), "cd /Users/alice2/app");
    assert.equal(asUser("alice", () => anonymizePath("/Users/alice2/app")), "/Users/alice2/app");
  });

  it("hashes /Users/alice inside a longer path", () => {
    assert.equal(asUser("alice", () => anonymizeText("see /tmp/x/Users/alice/app")), `see /tmp/x/Users/${hashUsername("alice")}/app`);
  });
});
