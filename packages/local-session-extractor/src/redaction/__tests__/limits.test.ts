// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The README's documented redaction limits, each as it behaves today: what
 * passes through, what is masked more than it needs to be, and what
 * `unredactPath` can bring back.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashUsername, setRunningUsernameForTests } from "../anonymizer";
import { redactPath, redactText, sanitizeSessionMeta, unredactPath } from "../index";

function asUser<T>(name: string, fn: () => T): T {
  const restore = setRunningUsernameForTests(name);
  try {
    return fn();
  } finally {
    restore();
  }
}

describe("redaction limits — passes through", () => {
  it("keeps a short vendor-less token that is neither quoted nor named as a secret", () => {
    const text = "the staging code is zq7-Lm2-Xp4";
    // Positive control in the same call: the email beside it is masked.
    assert.equal(redactText(`${text}, ask jane@example.com`), `${text}, ask ████████`);
  });

  it("keeps branch names in the stored row as written, even one holding the user's name", () => {
    const out = asUser("jdoe", () => sanitizeSessionMeta({ git_branches: ["jdoe/fix-login"], project_path: "/Users/jdoe/app" }));
    assert.deepEqual(out.git_branches, ["jdoe/fix-login"]);
    // Positive control: the path beside it is hashed.
    assert.equal(out.project_path, `/Users/${hashUsername("jdoe")}/app`);
  });

});

describe("bridge_session_url", () => {
  it("keeps the host and leading path, and masks the last segment and the query", () => {
    const out = sanitizeSessionMeta({ bridge_session_url: "https://bridge.example.com/code/session_01AbCdEfGhIjKlMnOpQrStUv?k=1" });
    assert.equal(out.bridge_session_url, "https://bridge.example.com/code/████████");
  });
});

describe("redaction limits — masks more than it needs to", () => {
  it("can mask a quoted home path whole, once the name in it is hashed", () => {
    assert.equal(asUser("jdoe", () => redactText('k "/Users/jdoe/q"')), 'k "████████"');
  });
});

describe("redaction limits — unredactPath", () => {
  it("restores a dash-encoded home in Claude Code's encoding only, with every non-alphanumeric a dash", () => {
    asUser("first.last", () => {
      const hidden = redactPath("/tmp/x/-Users-first.last-app");
      assert.equal(hidden, `/tmp/x/-Users-${hashUsername("first.last")}-app`);
      assert.equal(unredactPath(hidden), "/tmp/x/-Users-first-last-app");
    });
  });
});

describe("bridge_session_url with a trailing slash", () => {
  it("masks the last non-empty segment", () => {
    const out = sanitizeSessionMeta({ bridge_session_url: "https://bridge.example.com/code/session_01AbCdEfGhIjKlMn/" });
    assert.equal(out.bridge_session_url, "https://bridge.example.com/code/████████/");
  });
});
