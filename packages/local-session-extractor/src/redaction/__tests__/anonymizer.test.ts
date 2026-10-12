// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import {
  anonymizePath,
  anonymizeText,
  deanonymizePath,
  hashUsername,
  setRunningUsernameForTests,
  withHomeOwners,
} from "../anonymizer";

describe("hashUsername", () => {
  it("returns deterministic hash with user_ prefix", () => {
    const hash1 = hashUsername("janedoe");
    const hash2 = hashUsername("janedoe");
    assert.equal(hash1, hash2);
    assert.ok(hash1.startsWith("user_"));
    assert.equal(hash1.length, "user_".length + 8);
  });

  it("produces different hashes for different usernames", () => {
    assert.notEqual(hashUsername("alice"), hashUsername("bob"));
  });
});

describe("anonymizePath", () => {
  // Note: anonymizePath uses the current OS username (os.userInfo().username).
  // In CI or different machines the username will differ, so we test the
  // function indirectly by verifying the real username is absent from the output.

  it("returns non-home paths unchanged", () => {
    assert.equal(anonymizePath("/tmp/foo/bar"), "/tmp/foo/bar");
    assert.equal(anonymizePath("/var/log/app.log"), "/var/log/app.log");
  });

  it("returns relative paths unchanged", () => {
    assert.equal(anonymizePath("src/main/index.ts"), "src/main/index.ts");
  });

  it("anonymizes macOS home paths for the current user", () => {
    const username = userInfo().username as string;
    if (!username) return; // skip if no username

    const input = `/Users/${username}/projects/my-app`;
    const result = anonymizePath(input);

    assert.ok(result.startsWith("/Users/user_"), `Expected /Users/user_ prefix, got: ${result}`);
    assert.ok(!result.includes(username), `Expected username to be removed: ${result}`);
    assert.ok(result.endsWith("/projects/my-app"));
  });

  it("anonymizes Linux home paths for the current user", () => {
    const username = userInfo().username as string;
    if (!username) return;

    const input = `/home/${username}/.config/app`;
    const result = anonymizePath(input);

    assert.ok(result.startsWith("/home/user_"), `Expected /home/user_ prefix, got: ${result}`);
    assert.ok(!result.includes(username));
    assert.ok(result.endsWith("/.config/app"));
  });

  it("does not anonymize other users' paths", () => {
    const path = "/Users/someotheruser/Documents/file.txt";
    // Unless "someotheruser" happens to be the current user, this should pass through
    const username = userInfo().username as string;
    if (username === "someotheruser") return;

    assert.equal(anonymizePath(path), path);
  });

  it("hashes a home encoded into a later segment (Claude Code and Cursor project dirs)", () => {
    const username = userInfo().username as string;
    assert.ok(username, "need an OS username to exercise anonymizePath");
    const hash = hashUsername(username);
    const cases: [string, string][] = [
      [
        `/Users/${username}/.claude/projects/-Users-${username}-src-x/abc.jsonl`,
        `/Users/${hash}/.claude/projects/-Users-${hash}-src-x/abc.jsonl`,
      ],
      [
        `/Users/${username}/.cursor/projects/Users-${username}-src-x/t.txt`,
        `/Users/${hash}/.cursor/projects/Users-${hash}-src-x/t.txt`,
      ],
      [`/home/${username}/.claude/projects/-home-${username}-repo`, `/home/${hash}/.claude/projects/-home-${hash}-repo`],
      [`/tmp/home-${username}-x/Users-${username}`, `/tmp/home-${hash}-x/Users-${hash}`],
    ];
    for (const [input, want] of cases) assert.equal(anonymizePath(input), want);
  });

  it("leaves a dash form that is not a whole name at a segment boundary", () => {
    const username = userInfo().username as string;
    assert.ok(username, "need an OS username to exercise anonymizePath");
    for (const path of [`/tmp/Users-${username}x-repo`, `/tmp/myhome-${username}-repo`]) {
      assert.equal(anonymizePath(path), path);
    }
  });
});

describe("anonymizeText", () => {
  it("returns empty string unchanged", () => {
    assert.equal(anonymizeText(""), "");
  });

  it("anonymizes forward-slash macOS paths in text", () => {
    const username = userInfo().username as string;
    if (!username) return;

    const text = `Reading file /Users/${username}/projects/app/src/index.ts`;
    const result = anonymizeText(text);

    assert.ok(!result.includes(`/Users/${username}/`), `Username should be anonymized: ${result}`);
    assert.ok(result.includes("/Users/user_"));
    assert.ok(result.includes("projects/app/src/index.ts"));
  });

  it("anonymizes hyphen-encoded paths (Claude Code project dirs)", () => {
    const username = userInfo().username as string;
    if (!username) return;

    const text = `Session: -Users-${username}-projects-myapp`;
    const result = anonymizeText(text);

    assert.ok(!result.includes(`-Users-${username}-`), `Hyphen path should be anonymized: ${result}`);
    assert.ok(result.includes("-Users-user_"));
  });

  it("anonymizes bare username in text (if ≥ 4 chars)", () => {
    const username = "janedoe";
    const restore = setRunningUsernameForTests(username);
    try {
      const text = `User ${username} ran the command`;
      const result = anonymizeText(text);

      assert.ok(!result.includes(username), `Bare username should be anonymized: ${result}`);
      assert.ok(result.includes("user_"));
    } finally {
      restore();
    }
  });

  it("handles multiple occurrences in the same text", () => {
    const username = userInfo().username as string;
    if (!username) return;

    const text = [
      `cwd: /Users/${username}/project-a`,
      `file: /Users/${username}/project-b/src/main.ts`,
    ].join("\n");

    const result = anonymizeText(text);
    // Count occurrences of the real username — should be zero
    const matches = result.match(new RegExp(username, "g"));
    assert.equal(matches, null, `Username should not appear in result: ${result}`);
  });

  it("preserves text without the current username", () => {
    const text = "This is normal text about /tmp/builds and /var/log";
    assert.equal(anonymizeText(text), text);
  });
});

describe("deanonymizePath — inverse of anonymizePath", () => {
  // deanonymizePath reconstructs the real on-disk path a local caller must scan
  // from a project_path stored redacted. The load-bearing property is a clean
  // round-trip on this machine's own home paths.
  const username = userInfo().username as string;

  it("round-trips a macOS home path (redact → unredact === original)", () => {
    if (!username) return;
    const original = `/Users/${username}/src/example-org/example-repo`;
    assert.equal(deanonymizePath(anonymizePath(original)), original);
  });

  it("round-trips a Linux home path", () => {
    if (!username) return;
    const original = `/home/${username}/Work/go-infra`;
    assert.equal(deanonymizePath(anonymizePath(original)), original);
  });

  it("round-trips the bare home path (no trailing segment)", () => {
    if (!username) return;
    const original = `/Users/${username}`;
    assert.equal(deanonymizePath(anonymizePath(original)), original);
  });

  it("round-trips a path whose later segment encodes the home", () => {
    assert.ok(username, "need an OS username to exercise deanonymizePath");
    for (const original of [
      `/Users/${username}/.claude/projects/-Users-${username}-src-x/abc.jsonl`,
      `/Users/${username}/.cursor/projects/Users-${username}-src-x`,
    ]) {
      assert.equal(deanonymizePath(anonymizePath(original)), original);
    }
  });

  it("leaves a non-home path unchanged", () => {
    assert.equal(deanonymizePath("/tmp/foo/bar"), "/tmp/foo/bar");
    assert.equal(deanonymizePath("/opt/app"), "/opt/app");
  });

  it("leaves a path hashed for a different user unchanged", () => {
    // A hash that is not THIS machine's username hash must not be rewritten.
    const foreign = `/Users/${hashUsername("someone-else")}/repo`;
    assert.equal(deanonymizePath(foreign), foreign);
  });
});

describe("anonymizeText — bare username", () => {
  const username = "janedoe";
  let restore: () => void;
  before(() => {
    restore = setRunningUsernameForTests(username);
  });
  after(() => restore());

  it("hashes the name after a literal newline escape, as captured command output stores it", () => {
    const out = anonymizeText(`PID USER\\n${username} 36636 node`);
    assert.ok(!out.includes(username), `Expected username to be removed: ${out}`);
  });

  it("hashes the name in any letter case", () => {
    const mixed = username.charAt(0).toUpperCase() + username.slice(1);
    const out = anonymizeText(`git push origin ${mixed}/feature`);
    assert.ok(!out.toLowerCase().includes(username.toLowerCase()), `Expected username to be removed: ${out}`);
  });

  it("leaves a longer word that merely contains the name", () => {
    const out = anonymizeText(`see ${username}13/repo`);
    assert.ok(out.includes(`${username}13`), `Expected the longer word to stay: ${out}`);
  });
});

describe("names outside [A-Za-z0-9] in dash-encoded paths", () => {
  for (const name of ["first.last", "first_last"]) {
    it(`hashes ${name} in Claude Code's encoding, where every such character is a dash`, () => {
      const restore = setRunningUsernameForTests(name);
      try {
        const hash = hashUsername(name);
        assert.equal(
          anonymizePath(`/Users/${name}/.claude/projects/-Users-first-last-src-x/a.jsonl`),
          `/Users/${hash}/.claude/projects/-Users-${hash}-src-x/a.jsonl`,
        );
        assert.equal(anonymizeText("cd ~/.claude/projects/-Users-first-last-src-x"), `cd ~/.claude/projects/-Users-${hash}-src-x`);
        assert.equal(deanonymizePath(anonymizePath("/tmp/-Users-first-last-repo")), "/tmp/-Users-first-last-repo");
      } finally {
        restore();
      }
    });
  }

  it("hashes a name that ends its segment, before :: or at the end", () => {
    const restore = setRunningUsernameForTests("alice");
    try {
      const hash = hashUsername("alice");
      assert.equal(anonymizeText("-Users-alice::0b1c-uuid"), `-Users-${hash}::0b1c-uuid`);
      assert.equal(anonymizeText("in -Users-alice"), `in -Users-${hash}`);
      assert.equal(anonymizePath("/x/-Users-alice"), `/x/-Users-${hash}`);
      assert.equal(anonymizeText("-Users-alicex::id"), "-Users-alicex::id");
    } finally {
      restore();
    }
  });

  it("is idempotent for a user named like the hash prefix", () => {
    const restore = setRunningUsernameForTests("user");
    try {
      const once = anonymizePath("/Users/user/.claude/projects/-Users-user-repo");
      assert.equal(anonymizePath(once), once);
      assert.equal(anonymizeText(once), once);
    } finally {
      restore();
    }
  });
});

describe("generic account names", () => {
  it("does not hash node as a bare word, and still hashes its paths", () => {
    const restore = setRunningUsernameForTests("node");
    try {
      const hash = hashUsername("node");
      assert.equal(anonymizeText("Node.js runs node scripts"), "Node.js runs node scripts");
      assert.equal(anonymizeText("see /home/node/app and -home-node-app"), `see /home/${hash}/app and -home-${hash}-app`);
    } finally {
      restore();
    }
  });

  it("still hashes any other name as a bare word, in any case", () => {
    const restore = setRunningUsernameForTests("janedoe");
    try {
      assert.equal(anonymizeText("Janedoe pushed"), `${hashUsername("janedoe")} pushed`);
    } finally {
      restore();
    }
  });
});

describe("withHomeOwners", () => {
  it("hashes an earlier scan's owner in paths only, for the call", () => {
    const restore = setRunningUsernameForTests("runner-x");
    try {
      const hash = hashUsername("alice");
      const text = "alice opened /Users/alice/repo from -Users-alice-repo::id";
      assert.equal(withHomeOwners(["alice"], () => anonymizeText(text)), `alice opened /Users/${hash}/repo from -Users-${hash}-repo::id`);
      assert.equal(anonymizeText(text), text, "the owners apply inside the call only");
    } finally {
      restore();
    }
  });
});
