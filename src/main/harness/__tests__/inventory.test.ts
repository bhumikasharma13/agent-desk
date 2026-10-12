// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeCrossAgentDuplicates } from "../inventory";
import type { HarnessAsset } from "../../../shared/harnessTypes";

// The same on-disk artifact read by two agents (e.g. a repo AGENTS.md seen by
// both Claude Code and Cursor) must render as ONE row with the agent list
// unioned — while same-named files at different paths, different content, or
// different scopes stay separate.

function asset(over: Partial<HarnessAsset>): HarnessAsset {
  return {
    id: over.id ?? "id-" + Math.abs(JSON.stringify(over).split("").reduce((a, c) => a + c.charCodeAt(0), 0)),
    ideType: "claude-code",
    name: "AGENTS.md",
    type: "agents_md",
    scope: "repo-committed",
    source: "shop",
    filePath: "/repo/AGENTS.md",
    sourcePath: "AGENTS.md",
    contentHash: "abc123",
    operationalState: "enabled",
    lastSeenAt: "2026-07-07T00:00:00Z",
    projectPath: "/repo",
    activeInAgents: ["Claude Code"],
    ...over,
  } as HarnessAsset;
}

describe("mergeCrossAgentDuplicates", () => {
  it("merges the identical file read by two agents, unioning the agent list", () => {
    const merged = mergeCrossAgentDuplicates([
      asset({ id: "a", ideType: "claude-code", activeInAgents: ["Claude Code"] }),
      asset({ id: "b", ideType: "cursor", activeInAgents: ["Cursor"] }),
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0]!.activeInAgents, ["Claude Code", "Cursor"]);
  });

  it("clubs a NAMED artifact defined per-agent in different files (Claude .md + Codex .toml)", () => {
    const merged = mergeCrossAgentDuplicates([
      asset({
        id: "cc", type: "agent", name: "frontend-engineer", ideType: "claude-code",
        filePath: "/repo/.claude/agents/frontend-engineer.md", contentHash: "md1", activeInAgents: ["Claude Code"],
      }),
      asset({
        id: "cx", type: "agent", name: "frontend-engineer", ideType: "codex",
        filePath: "/repo/.codex/agents/frontend-engineer.toml", contentHash: "toml1", activeInAgents: ["Codex"],
      }),
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0]!.activeInAgents, ["Claude Code", "Codex"]);
  });

  it("does NOT club non-agent types that only share a display name (skills/commands/hooks are physical-keyed)", () => {
    const merged = mergeCrossAgentDuplicates([
      // two skills, same display name, different invocation + file (e.g. /review vs /refactor)
      asset({ id: "sk1", type: "skill", name: "Review", scope: "repo-committed", filePath: "/repo/.claude/skills/review/SKILL.md", contentHash: "h1", invocation: "/review" }),
      asset({ id: "sk2", type: "skill", name: "Review", scope: "repo-committed", filePath: "/repo/.claude/skills/refactor/SKILL.md", contentHash: "h2", invocation: "/refactor" }),
      // two file-backed hooks, same event+basename, different dirs
      asset({ id: "hk1", type: "hook", name: "PreToolUse: guard.sh", scope: "repo-committed", filePath: "/repo/.codex/hooks/a/guard.sh", contentHash: "h3" }),
      asset({ id: "hk2", type: "hook", name: "PreToolUse: guard.sh", scope: "repo-committed", filePath: "/repo/.codex/hooks/b/guard.sh", contentHash: "h4" }),
    ]);
    assert.equal(merged.length, 4, "distinct same-named skills/hooks stay separate — only agents club by name");
  });

  it("clubs an agent across IDEs but keeps two plugins' same-name agents distinct", () => {
    const merged = mergeCrossAgentDuplicates([
      // same agent authored per-IDE (no plugin) → clubs
      asset({ id: "a1", type: "agent", name: "foo", scope: "repo-committed", ideType: "claude-code", filePath: "/repo/.claude/agents/foo.md", contentHash: "m1", activeInAgents: ["Claude Code"] }),
      asset({ id: "a2", type: "agent", name: "foo", scope: "repo-committed", ideType: "codex", filePath: "/repo/.codex/agents/foo.toml", contentHash: "t1", activeInAgents: ["Codex"] }),
      // a same-name agent from a different plugin → distinct row (plugin in the key)
      asset({ id: "a3", type: "agent", name: "foo", scope: "user", projectPath: "", filePath: "/home/.claude/plugins/x/agents/foo.md", contentHash: "p1", pluginName: "plugin-x", activeInAgents: ["Claude Code"] }),
    ]);
    assert.equal(merged.length, 2, "the two cross-IDE copies club; the plugin agent stays separate");
    const club = merged.find((m) => m.pluginName === undefined)!;
    assert.deepEqual(club.activeInAgents, ["Claude Code", "Codex"]);
  });

  it("does NOT merge instruction files with the same name at different paths (root vs nested)", () => {
    const merged = mergeCrossAgentDuplicates([
      asset({ filePath: "/repo/AGENTS.md" }),
      asset({ filePath: "/repo/sub/AGENTS.md" }),
    ]);
    assert.equal(merged.length, 2);
  });

  it("does NOT merge when content hashes differ (mid-write divergence)", () => {
    const merged = mergeCrossAgentDuplicates([
      asset({ contentHash: "abc123" }),
      asset({ ideType: "cursor", contentHash: "def456" }),
    ]);
    assert.equal(merged.length, 2);
  });

  it("does NOT merge across scopes or projects", () => {
    const merged = mergeCrossAgentDuplicates([
      asset({ scope: "repo-committed" }),
      asset({ scope: "repo-local" }),
      asset({ projectPath: "/other", filePath: "/repo/AGENTS.md" }),
    ]);
    assert.equal(merged.length, 3);
  });

  it("deduplicates the agent union (no repeated agent names)", () => {
    const merged = mergeCrossAgentDuplicates([
      asset({ activeInAgents: ["Claude Code", "Cursor"] }),
      asset({ ideType: "cursor", activeInAgents: ["Cursor"] }),
    ]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0]!.activeInAgents, ["Claude Code", "Cursor"]);
  });

  it("leaves file-less rows untouched (defensive)", () => {
    const merged = mergeCrossAgentDuplicates([
      asset({ filePath: "" }),
      asset({ filePath: "" }),
    ]);
    assert.equal(merged.length, 2);
  });

  it("does not mutate the input rows when unioning", () => {
    const first = asset({ activeInAgents: ["Claude Code"] });
    mergeCrossAgentDuplicates([first, asset({ ideType: "cursor", activeInAgents: ["Cursor"] })]);
    assert.deepEqual(first.activeInAgents, ["Claude Code"]);
  });
});
