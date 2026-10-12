// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// What docs/using-the-app.md says the pages show: the Projects groups and their "No folder"
// row, the agent marks, the read state words, the sessions pane's labels and collapsed messages, the
// Source labels and the tab every agent-file type sits in.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtractionStats } from "../../shared/extractionTypes";
import type { HarnessAssetType } from "../../shared/harnessTypes";
import { agentMark, buildIdeGroups, emptyProjectsText, readStatusLabel } from "../components/projectsModel";
import { TYPE_TABS, showsReadError, sourceLabel, tabForType } from "../components/harnessModel";
import {
  COLLAPSE_AT, afterLoadMore, appendPage, countLabel, dateGroup, fitChips, groupRows, durationLabel, headerCount, ideTypeOfKey, listKeyApplies, messageParts, projectRowLabel, sessionTitle, splitToolMarkers, timeLabel, tokenLabel, toolLabel,
  visibleText,
} from "../components/sessionsModel";
import { IDE_TYPES } from "../../shared/sessionTypes";

const none = { claudeCode: [], cursor: [], copilot: [], antigravity: [], codex: [], kiro: [] };
function stats(over: Partial<ExtractionStats> = {}): ExtractionStats {
  return {
    status: "idle",
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastError: null,
    problems: [],
    progress: null,
    counts: { claudeCode: 0, cursor: 0, copilot: 0, antigravity: 0, codex: 0, kiro: 0, total: 0 },
    folders: { ...none },
    ...over,
  };
}

describe("the Projects page", () => {
  it("lists only tools with sessions, and a session with no folder under No folder, last", () => {
    const groups = buildIdeGroups(
      stats({ folders: { ...none, claudeCode: [{ path: null, count: 5 }, { path: "/w/shop", count: 1 }] } }),
    );
    assert.deepEqual(groups.map((g) => g.label), ["Claude Code"]);
    assert.deepEqual(groups[0]!.rows.map((r) => [r.name, r.count]), [["shop", 1], ["No folder", 5]]);
    assert.equal(groups[0]!.sessions, 6);
  });

  it("marks each agent with two letters, never punctuation", () => {
    const marks = ["Agents (shared)", "GitHub Copilot", "Claude Code", "Kiro", "Cursor (rules)", "  ", ""].map(agentMark);
    assert.deepEqual(marks, ["AS", "GC", "CC", "KI", "CR", "", ""]);
  });

  it("says Not read since launch before this run's first read, never Up to date or No sessions", () => {
    const before = stats({ lastRunAt: null });
    assert.equal(readStatusLabel(before, null), "Not read since launch");
    assert.equal(emptyProjectsText(before, null), "Not read since launch.");
    assert.equal(readStatusLabel(stats(), null), "Up to date");
    assert.equal(emptyProjectsText(stats(), null), "No sessions detected yet.");
    assert.equal(readStatusLabel(stats({ status: "running" }), null), "Reading…");
    assert.equal(readStatusLabel(null, "boom"), "Error");
    assert.equal(emptyProjectsText(stats({ status: "error", lastError: "x" }), null), "Sessions could not be read.");
  });
});

describe("the Projects page's sessions pane", () => {
  it("names each tool as the Projects page does, and every tool has a name", () => {
    assert.deepEqual(IDE_TYPES.map(toolLabel), ["Claude Code", "Cursor", "GitHub Copilot", "Antigravity", "Codex", "Kiro"]);
  });

  it("titles a session on one line, or Untitled session", () => {
    assert.equal(sessionTitle({ title: "Fix\n  the  total " }), "Fix the total");
    assert.equal(sessionTitle({ title: null }), "Untitled session");
    assert.equal(sessionTitle({ title: "  " }), "Untitled session");
  });

  it("labels counts, durations, tokens and times", () => {
    assert.equal(countLabel({ userMessages: 1, assistantMessages: 0 }), "1 message");
    assert.equal(countLabel({ userMessages: 2, assistantMessages: 3 }), "5 messages");
    assert.deepEqual([null, 0.4, 7.4, 65].map(durationLabel), [null, "under a minute", "7 min", "1 h 5 min"]);
    assert.equal(durationLabel(-5), null, "a last message before the first is no duration");
    assert.equal(tokenLabel({ inputTokens: 120, outputTokens: 40 }), "120 in · 40 out");
    assert.equal(tokenLabel({ inputTokens: null, outputTokens: null }), null);
    assert.equal(timeLabel("not a time"), null);
    assert.equal(timeLabel(null), null);
  });

  it("collapses a long message to its first part until expanded", () => {
    const long = "a".repeat(COLLAPSE_AT + 1);
    assert.equal(visibleText(long, false), `${"a".repeat(COLLAPSE_AT)}…`);
    assert.equal(visibleText(long, true), long);
    assert.equal(visibleText("short", false), "short");
    assert.equal(visibleText(`${"a".repeat(COLLAPSE_AT - 1)}😀 more`, false), `${"a".repeat(COLLAPSE_AT - 1)}…`, "never half an emoji");
  });

  it("splits tool-call markers out of the text", () => {
    assert.deepEqual(splitToolMarkers("Reading.\n[Tool: Read]\n[Tool: edit_file target_file=a.ts] done"), [
      { text: "Reading.\n", tool: false },
      { text: "Tool: Read", tool: true },
      { text: "\n", tool: false },
      { text: "Tool: edit_file target_file=a.ts", tool: true },
      { text: " done", tool: false },
    ]);
    assert.deepEqual(splitToolMarkers("no tools [here]"), [{ text: "no tools [here]", tool: false }]);
    assert.deepEqual(splitToolMarkers("[Tool: a\nb]"), [{ text: "[Tool: a\nb]", tool: false }], "a marker never spans lines");
  });

  it("groups sessions under Today, Yesterday, Previous 7 and 30 days, then months, at local midnight", () => {
    const now = new Date(2026, 9, 7, 0, 30); // 7 Oct 2026, 00:30 local
    const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();
    assert.equal(dateGroup(new Date(2026, 9, 7, 0, 0).getTime(), now), "Today", "just after midnight");
    assert.equal(dateGroup(new Date(2026, 9, 6, 23, 59).getTime(), now), "Yesterday", "a minute before midnight");
    assert.equal(dateGroup(at(2026, 9, 5), now), "Previous 7 days");
    assert.equal(dateGroup(at(2026, 9, 1), now), "Previous 7 days", "six days back");
    assert.equal(dateGroup(at(2026, 8, 30), now), "Previous 30 days", "seven days back, across a month");
    assert.equal(dateGroup(at(2026, 8, 8), now), "Previous 30 days");
    assert.equal(dateGroup(at(2026, 8, 7), now), "September 2026", "thirty days back");
    assert.equal(dateGroup(at(2025, 11, 31), now), "December 2025");
    assert.equal(dateGroup(at(2026, 9, 9), now), "Today", "a clock ahead of this one");
    assert.equal(dateGroup(0, now), "No date");
    const rows = [at(2026, 9, 7, 0), at(2026, 9, 6), at(2026, 9, 6, 1), at(2026, 6, 1), 0].map((ms, i) => ({ key: String(i), lastActivityMs: ms }));
    assert.deepEqual(groupRows(rows, now).map((g) => [g.label, g.rows.map((r) => r.key)]), [
      ["Today", ["0"]], ["Yesterday", ["1", "2"]], ["July 2026", ["3"]], ["No date", ["4"]],
    ]);
  });

  it("drops a Load more page when the list was read again meanwhile", () => {
    const k = (key: string) => ({ key }) as never;
    const base = { rows: [k("a")], total: 2, error: null };
    const next = { rows: [k("b")], total: 2, error: null };
    assert.deepEqual(afterLoadMore(base, base, next), { rows: [k("a"), k("b")], total: 2, error: null });
    const reread = { rows: [k("x")], total: 1, error: null };
    assert.equal(afterLoadMore(reread, base, next), reread, "a filter change or a finished read wins");
    assert.equal(afterLoadMore(null, base, next), null);
    assert.equal(afterLoadMore(base, base, { rows: [], total: 0, error: "boom" })!.total, 2, "a failed page keeps the total");
  });

  it("adds a page after the loaded rows, never a row already loaded", () => {
    const k = (key: string) => ({ key });
    assert.deepEqual(appendPage([k("a"), k("b")], [k("b"), k("c")]), [k("a"), k("b"), k("c")]);
  });

  it("labels tool calls in an assistant's text only, never in what the user typed", () => {
    assert.deepEqual(messageParts("user", "see [Tool: x]"), [{ text: "see [Tool: x]", tool: false }]);
    assert.deepEqual(messageParts("assistant", "[Tool: x]"), [{ text: "Tool: x", tool: true }]);
  });

  it("leaves Escape to whatever handled it, a text field or a dialog", () => {
    const at = (inside: boolean) => ({ closest: () => (inside ? {} : null) });
    assert.equal(listKeyApplies(false, at(false)), true);
    assert.equal(listKeyApplies(false, null), true);
    assert.equal(listKeyApplies(true, at(false)), false, "something already took this Escape");
    assert.equal(listKeyApplies(false, at(true)), false);
  });

  it("counts the whole project in the sessions header, falling back to the list when that read fails", () => {
    const list = { total: 7, error: null };
    assert.equal(headerCount(12, list, true), 12, "the project's own total, even during a search");
    assert.equal(headerCount(null, list, false), 7, "the count read failed: the list's total, with no search");
    assert.equal(headerCount(null, list, true), null, "during a search the list counts the matches only");
    assert.equal(headerCount(null, { total: 0, error: "the store is closed" }, false), null);
    assert.equal(headerCount(null, null, false), null);
  });

  it("keeps a row's stack chips to one line: what fits, then room for +N", () => {
    // Measured widths; 6 px between chips; "+N" 30 px wide.
    assert.equal(fitChips([40, 40, 40], 132, 30), 3, "all three fit exactly: no +N needed");
    assert.equal(fitChips([40, 40, 40], 2000, 30), 3);
    // Two chips fit the 100 px alone (86 px), but not with the +N after them (122 px): one does.
    assert.equal(fitChips([40, 40, 40], 100, 30), 1, "the +N's room is kept");
    assert.equal(fitChips([40, 40, 40], 131, 30), 2, "one pixel short of all three: two and +N");
    assert.equal(fitChips([200], 100, 30), 0, "nothing fits: only +N");
    assert.equal(fitChips([], 100, 30), 0);
    for (const width of [50, 100, 131, 160, 400]) {
      const widths = [55, 32, 48, 61, 40];
      const n = fitChips(widths, width, 30);
      const shown = widths.slice(0, n).reduce((sum, w) => sum + w + 6, 0);
      assert.ok(n === widths.length || shown + 30 <= width, `width ${width}: the shown chips and +N fit`);
    }
  });

  it("names each Projects row by folder, tool and count, and maps each group to its tool", () => {
    assert.equal(projectRowLabel("shop", "Claude Code", 1), "shop, Claude Code, 1 session");
    assert.equal(projectRowLabel("No folder", "Codex", 3), "No folder, Codex, 3 sessions");
    const groups = buildIdeGroups(stats({ folders: { ...none, claudeCode: [{ path: "/w/a", count: 1 }], kiro: [{ path: null, count: 2 }] } }));
    assert.deepEqual(groups.map((g) => ideTypeOfKey(g.key)), ["claude-code", "kiro"]);
    assert.throws(() => ideTypeOfKey("vim"), /no tool/);
  });
});

describe("the Harness page", () => {
  it("labels where a file lives as in the Source column", () => {
    assert.equal(sourceLabel({ scope: "repo-committed", source: "shop" }), "shop · committed");
    assert.equal(sourceLabel({ scope: "repo-local", source: "shop" }), "shop · local");
    assert.equal(sourceLabel({ scope: "user", source: "~/.claude" }), "User");
  });

  it("puts every agent-file type in exactly one tab", () => {
    const types: HarnessAssetType[] = ["rule", "claude_md", "agents_md", "prompt_template", "skill", "agent", "command", "plugin", "hook"];
    for (const t of types) {
      assert.equal(TYPE_TABS.filter((tab) => tab.types.includes(t)).length, 1, t);
    }
    assert.equal(tabForType("agents_md")?.label, "Context / Rules");
    assert.equal(tabForType("agent")?.label, "Subagents");
  });

  it("shows a read's error whenever there is one, a recorded scan failure or not", () => {
    assert.equal(showsReadError("worker exited mid-cycle (code=9)"), true);
    assert.equal(showsReadError(null), false);
    assert.equal(showsReadError(""), false);
  });
});
