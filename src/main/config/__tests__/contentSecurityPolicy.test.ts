// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentSecurityPolicy } from "../contentSecurityPolicy";

const directive = (policy: string, name: string): string | undefined =>
  policy.split("; ").find((d) => d.startsWith(`${name} `));

describe("contentSecurityPolicy", () => {
  it("lets the built page fetch nothing, not even a file:// URL", () => {
    assert.equal(directive(contentSecurityPolicy(undefined), "connect-src"), "connect-src 'none'");
  });

  it("allows no eval or inline script in the built page", () => {
    const policy = contentSecurityPolicy(undefined);
    assert.equal(directive(policy, "script-src"), "script-src 'self'");
    assert.doesNotMatch(policy, /unsafe-eval/);
  });

  // The built app run unpackaged (the acceptance test, the examples) gets the
  // built page's policy too: only the Vite dev server needs the looser one.
  it("loosens only for the Vite dev server", () => {
    const dev = contentSecurityPolicy("http://localhost:5173");
    assert.match(directive(dev, "script-src") ?? "", /'unsafe-eval'/);
    assert.equal(directive(dev, "connect-src"), "connect-src 'self' ws://localhost:*");
  });
});
