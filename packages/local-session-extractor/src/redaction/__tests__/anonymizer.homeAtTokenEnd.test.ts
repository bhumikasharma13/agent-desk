// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A home path in free text is hashed wherever the owner's name ends its path
 * segment — before a `/`, at the end of the text, or before whitespace, a quote
 * or punctuation — for every identity, including the names the bare-word pass
 * skips (short names, generic account names, scanned and recorded owners).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { anonymizeText, hashUsername, setRunningUsernameForTests, withHomeOwners } from "../anonymizer";

describe("anonymizeText — a home path that ends its token", () => {
  const cases: Array<{ name: string; user: string; owners: string[]; text: string; secret: string }> = [
    { name: "short running user at end of text", user: "bob", owners: [], text: "cd /Users/bob", secret: "bob" },
    { name: "short running user before a period", user: "bob", owners: [], text: "path is /Users/bob. done", secret: "bob" },
    { name: "generic running user in quotes", user: "admin", owners: [], text: 'cwd "/home/admin"', secret: "/home/admin\"" },
    { name: "recorded owner before whitespace", user: "janedoe", owners: ["jdoe"], text: "cd /Users/jdoe && ls", secret: "jdoe" },
    { name: "recorded owner in parentheses", user: "janedoe", owners: ["jdoe"], text: "(see /home/jdoe)", secret: "jdoe" },
    { name: "recorded owner with a dot in the name", user: "janedoe", owners: ["jane.doe"], text: "cd /Users/jane.doe", secret: "jane.doe" },
  ];
  for (const c of cases) {
    it(`hashes the ${c.name}`, () => {
      const restore = setRunningUsernameForTests(c.user);
      try {
        const out = withHomeOwners(c.owners, () => anonymizeText(c.text));
        assert.ok(!out.includes(c.secret), `${c.text} -> ${out}`);
        const hashed = c.owners.length > 0 ? hashUsername(c.owners[0]!) : hashUsername(c.user);
        assert.ok(out.includes(hashed), `${c.text} -> ${out}`);
      } finally {
        restore();
      }
    });
  }

  it("does not hash a different, longer name that starts with the owner's", () => {
    const restore = setRunningUsernameForTests("janedoe");
    try {
      assert.equal(withHomeOwners(["jdoe"], () => anonymizeText("cd /Users/jdoe2 && cd /Users/jdoe.old/x")), "cd /Users/jdoe2 && cd /Users/jdoe.old/x");
    } finally {
      restore();
    }
  });
});
