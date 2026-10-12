// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * sanitizeSessionMeta redacts a key it does not classify, the members of the
 * MCP name arrays, and a token in a PR URL's query.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashUsername, setRunningUsernameForTests } from "../anonymizer";
import { sanitizeSessionMeta } from "../index";
import type { SessionMetaPayload } from "../../types/session";

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

describe("sanitizeSessionMeta — fields outside the classification", () => {
  it("redacts every string leaf of an unknown key", () => {
    const restore = setRunningUsernameForTests("alice");
    try {
      const out = sanitizeSessionMeta({ future_field: { note: `${TOKEN} /Users/alice/x` } } as unknown as SessionMetaPayload) as Record<string, unknown>;
      assert.deepEqual(out["future_field"], { note: `████████ /Users/${hashUsername("alice")}/x` });
    } finally {
      restore();
    }
  });

  it("redacts paths inside the MCP name arrays, and a token in pr_url's query", () => {
    const restore = setRunningUsernameForTests("alice");
    try {
      const out = sanitizeSessionMeta({
        mcp_server_names: ["github", "/Users/alice/mcp"],
        project_mcp_server_names: ["/Users/alice/p"],
        pr_url: `https://github.com/org/app/pull/1?token=${TOKEN}`,
      });
      const h = hashUsername("alice");
      assert.deepEqual(out.mcp_server_names, ["github", `/Users/${h}/mcp`]);
      assert.deepEqual(out.project_mcp_server_names, [`/Users/${h}/p`]);
      assert.equal(out.pr_url, "https://github.com/org/app/pull/1████████");
    } finally {
      restore();
    }
  });
});
