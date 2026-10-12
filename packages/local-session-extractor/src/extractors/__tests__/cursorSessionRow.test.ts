// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { userInfo } from "node:os";
import type { SessionMetaPayload, SessionLineagePayload } from "../../index";
import { buildCursorSessionRow, type CursorSessionRowInput } from "../../internal";

// Minimal valid input: a single user prompt, a stat, source. Everything else omitted.
function baseInput(over: Partial<CursorSessionRowInput> = {}): CursorSessionRowInput {
  return {
    source: "cli",
    sessionId: "1f945d50-2e19-43ee-8979-ab54f2b37df6",
    prompts: [{ role: "user", content: "explain this file" }],
    lastMtimeMs: 1_720_000_000_000,
    lastSize: 20_480,
    ...over,
  };
}

function meta(row: ReturnType<typeof buildCursorSessionRow>): SessionMetaPayload {
  assert.ok(row.sessionMeta, "sessionMeta JSON should be present");
  return JSON.parse(row.sessionMeta) as SessionMetaPayload;
}

describe("buildCursorSessionRow", () => {
  it("sets ide_type=cursor, the raw session id, and passes the stat through", () => {
    const row = buildCursorSessionRow(baseInput());
    assert.equal(row.ideType, "cursor");
    assert.equal(row.sessionId, "1f945d50-2e19-43ee-8979-ab54f2b37df6");
    assert.equal(row.lastMtimeMs, 1_720_000_000_000);
    assert.equal(row.lastSize, 20_480);
    assert.equal(row.lastOffset, 0); // defaulted when the reader omits it
  });

  it("stamps the source discriminator onto SessionMeta", () => {
    assert.equal(meta(buildCursorSessionRow(baseInput({ source: "cli" }))).source, "cli");
    assert.equal(meta(buildCursorSessionRow(baseInput({ source: "agent" }))).source, "agent");
  });

  // The single most important invariant: CLI/Agent surfaces log no tokens or
  // cost, so the row must carry NONE — unset, never 0. A 0 reads as a measured
  // zero cost, while unset says the cost is unknown.
  it("leaves every token/cost field UNSET (never 0) — cost-unknown", () => {
    const row = buildCursorSessionRow(
      baseInput({
        // Even with rich signal, nothing here should manufacture a token/cost field.
        toolCounts: { read_file: 3 },
        prompts: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello" },
        ],
      })
    );
    // No cost/token key anywhere on the upsert row.
    assert.equal("aiAttribution" in row ? row.aiAttribution : undefined, undefined);
    assert.equal("statsCache" in row ? row.statsCache : undefined, undefined);

    const m = meta(row);
    // Kiro-style token totals exist on the type — they must stay absent, not 0.
    assert.equal(m.total_input_tokens, undefined);
    assert.equal(m.total_output_tokens, undefined);

    // Per-prompt token metadata must not be fabricated: a prompt that arrived
    // without tokens leaves without tokens.
    for (const p of row.conversation) {
      assert.equal(p.metadata?.inputTokens, undefined);
      assert.equal(p.metadata?.outputTokens, undefined);
    }
  });

  it("omits lineage when the reader supplies none (a primary session)", () => {
    assert.equal(meta(buildCursorSessionRow(baseInput())).lineage, undefined);
  });

  it("emits the SessionLineage shape unchanged when supplied", () => {
    const lineage: SessionLineagePayload = {
      relation_type: "SUBAGENT",
      parent_record_key: "parent-key-abc",
      linkage_confidence: "STRONG",
    };
    assert.deepEqual(meta(buildCursorSessionRow(baseInput({ lineage }))).lineage, lineage);
  });

  it("redacts the project path and prompt content before persisting", () => {
    const username = userInfo().username;
    // Skip the assertion body only if the runner has no resolvable username
    // (redaction is a no-op then) — the wiring is still exercised.
    const row = buildCursorSessionRow(
      baseInput({
        projectPath: `/Users/${username}/src/project`,
        prompts: [{ role: "user", content: `look at /Users/${username}/secret/file.go` }],
      })
    );
    if (username && username.length > 0) {
      assert.ok(
        !row.projectPath?.includes(`/${username}/`),
        "raw username must not survive in project_path"
      );
      assert.ok(
        !row.conversation[0]!.content.includes(`/${username}/`),
        "raw username must not survive in prompt content"
      );
      assert.match(row.projectPath ?? "", /user_[0-9a-f]{8}/); // hashed form
    }
  });

  it("derives message_hours and user_response_times from real timestamps", () => {
    // Two user messages 90s apart.
    const t0 = "2026-07-08T13:04:00.000Z";
    const t1 = "2026-07-08T13:05:30.000Z";
    const m = meta(buildCursorSessionRow(baseInput({ userMessageTimestamps: [t0, t1] })));
    assert.deepEqual(m.user_message_timestamps, [t0, t1]);
    assert.equal(m.message_hours?.length, 2);
    assert.deepEqual(m.user_response_times, [90]);
  });

  it("drops an unparseable timestamp without dropping the session", () => {
    const good = "2026-07-08T13:04:00.000Z";
    const m = meta(buildCursorSessionRow(baseInput({ userMessageTimestamps: ["not-a-date", good] })));
    assert.deepEqual(m.user_message_timestamps, [good]);
    // Single surviving timestamp → no response-time gaps.
    assert.equal(m.user_response_times, undefined);
  });

  it("maps title, languages, tool counts, and PR refs (with back-compat scalars)", () => {
    const m = meta(
      buildCursorSessionRow(
        baseInput({
          sessionTitle: "Bitbucket pull request creation",
          languages: { Go: 3, TypeScript: 1 },
          toolCounts: { read_file: 2, run_terminal_cmd: 1 },
          gitBranches: ["master", "feat/cli-reader"],
          prReferences: [
            { pr_url: "https://github.com/org/repo/pull/7", pr_number: 7, pr_repository: "org/repo" },
          ],
        })
      )
    );
    assert.equal(m.session_title, "Bitbucket pull request creation");
    assert.deepEqual(m.languages, { Go: 3, TypeScript: 1 });
    assert.deepEqual(m.tool_counts, { read_file: 2, run_terminal_cmd: 1 });
    // last non-trunk branch wins as the scalar
    assert.equal(m.git_branch, "feat/cli-reader");
    assert.deepEqual(m.git_branches, ["master", "feat/cli-reader"]);
    assert.equal(m.pr_number, 7);
    assert.equal(m.pr_url, "https://github.com/org/repo/pull/7");
    assert.equal(m.pr_repository, "org/repo");
  });

  it("omits empty maps/arrays rather than emitting {} or []", () => {
    const m = meta(
      buildCursorSessionRow(baseInput({ toolCounts: {}, languages: {}, trackedFilePaths: [] }))
    );
    assert.equal(m.tool_counts, undefined);
    assert.equal(m.languages, undefined);
    assert.equal(m.tracked_file_paths, undefined);
  });
});
