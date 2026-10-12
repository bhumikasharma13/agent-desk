// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../store/SessionStore";
import { extractKiroCrew, parseCrewSession } from "../../internal";
import { setPathOverrides } from "../pathResolver";

/**
 * Fixtures mirror real `~/.kiro/crew` output: a `_type: "metadata"` header line
 * followed by role/content/ts messages, plus per-slot metering rows. The token
 * columns are present-but-zero exactly as Kiro writes them — Kiro meters in
 * credits, and a zero there must never be stored as a measured token count.
 */
describe("kiroCrewExtractor", () => {
  let tmpDir: string;
  let crewRoot: string;
  let db: SessionStore;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "kiro-crew-"));
    crewRoot = join(tmpDir, "crew");
    mkdirSync(join(crewRoot, "sessions"), { recursive: true });
    mkdirSync(join(crewRoot, "usage", "tokens"), { recursive: true });
    setPathOverrides({ KIRO_CREW_PATH: crewRoot });

    writeFileSync(
      join(crewRoot, "sessions", "dashboard_chat-3-1786043397.jsonl"),
      [
        JSON.stringify({
          _type: "metadata",
          created_at: "2026-08-06T19:09:57.617787+00:00",
          updated_at: "2026-08-06T19:19:57.617787+00:00",
          title: "Sort helper",
          model: "claude-opus-4.8",
          project: "/tmp/project",
          agent: "default",
          memory_mode: "persistent",
          tab_id: "90296d31c247",
        }),
        JSON.stringify({
          role: "user",
          content: "Write a sort helper.",
          ts: "2026-08-06T19:10:20.422370+00:00",
          source_thread: "slack",
          source_user: "U123",
        }),
        JSON.stringify({
          role: "assistant",
          content: "It queries the data warehouse.",
          ts: "2026-08-06T19:10:33.233938+00:00",
          source_thread: "slack",
          source_user: "U123",
        }),
      ].join("\n"),
    );

    writeFileSync(
      join(crewRoot, "usage", "tokens", "2026-08-06.jsonl"),
      [
        JSON.stringify({
          _type: "tokens", ts: "2026-08-06T12:10:45.075841-07:00", slot: "chat-3-1786043397",
          provider: "acp", model: "claude-opus-4.8",
          input: 0, output: 0, cache_create: 0, cache_read: 0,
          cost: 0.42, credits: 1.262706052703151, turns: 0, duration_ms: 17583,
          surface: "dashboard", agent: "kirocrew", context_used: 80700, context_window: 1000000,
        }),
        JSON.stringify({
          _type: "tokens", ts: "2026-08-06T12:12:45.075841-07:00", slot: "chat-3-1786043397",
          model: "claude-opus-4.8", cost: 0.08, credits: 0.5, duration_ms: 2417,
          context_used: 90000, context_window: 1000000,
        }),
        // A different slot must not leak into this session's totals.
        JSON.stringify({
          _type: "tokens", slot: "chat-9-other", credits: 99, cost: 99, duration_ms: 99,
        }),
        JSON.stringify({ _type: "tokens", slot: "chat-9-unlinked", credits: 2.5, cost: 0 }),
      ].join("\n"),
    );

    // The same slot on two surfaces. Slot numbers are only unique within a
    // surface, so this is the case that decides whether the metering join is
    // keyed by the real identity or collapses the two sessions into one.
    for (const surface of ["dashboard", "slack"]) {
      writeFileSync(
        join(crewRoot, "sessions", `${surface}_chat-7-shared.jsonl`),
        [
          JSON.stringify({ _type: "metadata", model: "claude-opus-4.8", project: `/tmp/${surface}` }),
          JSON.stringify({ role: "user", content: `hello from ${surface}` }),
        ].join("\n"),
      );
    }
    writeFileSync(
      join(crewRoot, "usage", "tokens", "2026-08-07.jsonl"),
      [
        JSON.stringify({ _type: "tokens", slot: "chat-7-shared", surface: "dashboard", credits: 3, cost: 0.3 }),
        JSON.stringify({ _type: "tokens", slot: "chat-7-shared", surface: "slack", credits: 8, cost: 0.8 }),
      ].join("\n"),
    );

    // Same shape, but only the dashboard side is mapped — this is what decides
    // whether a composite session_map key can be reached by the wrong surface.
    for (const surface of ["dashboard", "slack"]) {
      writeFileSync(
        join(crewRoot, "sessions", `${surface}_chat-8-mapped.jsonl`),
        [
          // No `project` in metadata, so project_path can only come from the map.
          JSON.stringify({ _type: "metadata", model: "claude-opus-4.8" }),
          JSON.stringify({ role: "user", content: `hello from ${surface}` }),
        ].join("\n"),
      );
    }

    // Two turns whose context windows differ. The later turn is the larger
    // absolute number but the SMALLER occupancy — maxing the two fields
    // independently would publish 100k/1M and hide the earlier 90% peak.
    writeFileSync(
      join(crewRoot, "sessions", "dashboard_chat-ctx.jsonl"),
      [
        JSON.stringify({ _type: "metadata", model: "claude-opus-4.8", project: "/tmp/ctx" }),
        JSON.stringify({ role: "user", content: "hello" }),
      ].join("\n"),
    );
    writeFileSync(
      join(crewRoot, "usage", "tokens", "2026-08-08.jsonl"),
      [
        JSON.stringify({ _type: "tokens", slot: "chat-ctx", surface: "dashboard", context_used: 90000, context_window: 100000 }),
        JSON.stringify({ _type: "tokens", slot: "chat-ctx", surface: "dashboard", context_used: 100000, context_window: 1000000 }),
      ].join("\n"),
    );

    // Two surfaces neither of which is a recognised platform tag, so both
    // normalize to "other" — the case where a shared slot collides in the row key.
    for (const surface of ["foo", "bar"]) {
      writeFileSync(
        join(crewRoot, "sessions", `${surface}_chat-other.jsonl`),
        [
          JSON.stringify({ _type: "metadata", model: "claude-opus-4.8", project: `/tmp/${surface}` }),
          JSON.stringify({ role: "user", content: `hello from ${surface}` }),
        ].join("\n"),
      );
    }

    // A crew slot with NO CLI session behind it — nothing else counts its spend,
    // so its credits must still be reported.
    writeFileSync(
      join(crewRoot, "sessions", "dashboard_chat-9-unlinked.jsonl"),
      [
        JSON.stringify({ _type: "metadata", created_at: "2026-08-06T20:00:00+00:00", updated_at: "2026-08-06T20:05:00+00:00", title: "Unlinked", model: "claude-opus-4.8" }),
        JSON.stringify({ role: "user", content: "hello", ts: "2026-08-06T20:00:10+00:00", source_thread: "dashboard" }),
      ].join("\n"),
    );

    writeFileSync(
      join(crewRoot, "session_map.json"),
      JSON.stringify({
        "dashboard:chat-3-1786043397": {
          sid: "95186fd1-ef23-48e2-b10b-fe1d71d3024f",
          cwd: "/tmp/project",
          provider: "acp",
        },
        "dashboard:chat-8-mapped": { cwd: "/tmp/dashboard-cwd" },
      }),
    );

    db = new SessionStore(join(tmpDir, "crew.db"));
    extractKiroCrew(db, {});
  });

  after(() => {
    setPathOverrides({ KIRO_CREW_PATH: undefined });
    db.close();
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const PRIMARY_ROW_ID = "kiro-crew:dashboard:chat-3-1786043397";

  const crewRow = (): { session_meta: string; conversation: string; installation_metadata: string } => {
    // Pinned, not "the first kiro-crew row": the fixture set has several, and a
    // positional match silently re-points these assertions at another session.
    const row = db.getPendingConversations(100).find((r) => r.session_id === PRIMARY_ROW_ID);
    assert.ok(row, "expected a crew row");
    return row as never;
  };

  it("extracts a crew session keyed by surface and slot", () => {
    const rows = db.getPendingConversations(100);
    const row = rows.find((r) => r.session_id === PRIMARY_ROW_ID);
    assert.ok(row, "expected the dashboard row, keyed by surface and slot");
    assert.equal(row.ide_type, "kiro");
  });

  it("carries the USD cost, which no other Kiro surface reports", () => {
    const meta = JSON.parse(crewRow().session_meta) as { reported_cost_usd?: number };
    assert.ok(Math.abs((meta.reported_cost_usd ?? 0) - 0.5) < 1e-9);
  });

  it("does not re-report credits already counted by the CLI session it spawned", () => {
    // session_map.json links this slot to a CLI session id, and kiroCliExtractor
    // has always extracted that session — reporting the same credits here would
    // double-count the spend. Verified on real data: a crew slot's credits and
    // its CLI session's summed metering are identical.
    const meta = JSON.parse(crewRow().session_meta) as { billing_credits_used?: number };
    assert.equal(meta.billing_credits_used, undefined);
  });

  it("still reports credits for a slot with no CLI session behind it", () => {
    // No sid in session_map.json means nothing else counted this spend.
    const rows = db.getPendingConversations(100);
    const unlinked = rows.find((r) => r.session_id === "kiro-crew:dashboard:chat-9-unlinked");
    assert.ok(unlinked, "expected the unlinked crew row");
    const meta = JSON.parse(unlinked!.session_meta!) as { billing_credits_used?: number };
    assert.ok(Math.abs((meta.billing_credits_used ?? 0) - 2.5) < 1e-9);
  });

  it("does not let another slot's metering leak in", () => {
    const meta = JSON.parse(crewRow().session_meta) as { billing_credits_used?: number };
    assert.ok((meta.billing_credits_used ?? 0) < 99, "chat-9-other must not contribute");
  });

  it("takes context as a peak occupancy, not a sum", () => {
    const meta = JSON.parse(crewRow().session_meta) as {
      context_tokens_used?: number; context_token_limit?: number;
    };
    // Occupancy is a level: 80700 then 90000 is 90000, never 170700.
    assert.equal(meta.context_tokens_used, 90000);
    assert.equal(meta.context_token_limit, 1000000);
  });

  it("never writes Kiro's zeroed token columns as measured counts", () => {
    const meta = JSON.parse(crewRow().session_meta) as Record<string, unknown>;
    assert.ok(!("total_input_tokens" in meta), "a present-but-zero token column is not a measurement");
    assert.ok(!("total_output_tokens" in meta));
  });

  it("normalizes crew's memory vocabulary onto the existing field", () => {
    const meta = JSON.parse(crewRow().session_meta) as { memory_mode?: string };
    // Crew says "persistent"; the field carries enabled/disabled, so mixing two
    // vocabularies in one column is avoided.
    assert.equal(meta.memory_mode, "enabled");
  });

  it("does not merge two surfaces that share a slot number", () => {
    const rows = db.getPendingConversations(100);
    const creditsFor = (surface: string): number => {
      const row = rows.find((r) => r.session_id === `kiro-crew:${surface}:chat-7-shared`);
      assert.ok(row?.session_meta, `expected a ${surface} row`);
      return (JSON.parse(row.session_meta) as { billing_credits_used?: number }).billing_credits_used ?? 0;
    };
    // Each reads only its own metering — not the 11 credits the two spent between
    // them, which is what a bare-slot join would report for both.
    assert.equal(creditsFor("dashboard"), 3);
    assert.equal(creditsFor("slack"), 8);
  });

  it("does not answer one surface's session-map lookup with another's entry", () => {
    const rows = db.getPendingConversations(100);
    const pathFor = (surface: string): string | undefined => {
      const row = rows.find((r) => r.session_id === `kiro-crew:${surface}:chat-8-mapped`);
      assert.ok(row?.session_meta, `expected a ${surface} row`);
      return (JSON.parse(row.session_meta) as { project_path?: string }).project_path;
    };
    assert.equal(pathFor("dashboard"), "/tmp/dashboard-cwd");
    // Unmapped, so it has no project path at all. A bare-slot alias would hand it
    // the dashboard's cwd — and, on an entry carrying a `sid`, silently suppress
    // its credits as already counted by a CLI session that is not its own.
    assert.equal(pathFor("slack"), undefined);
  });

  it("keeps the context peak as a used/window pair from one turn", () => {
    const row = db.getPendingConversations(100).find((r) => r.session_id === "kiro-crew:dashboard:chat-ctx");
    assert.ok(row?.session_meta, "expected the context row");
    const meta = JSON.parse(row.session_meta) as { context_tokens_used?: number; context_token_limit?: number };
    // The 90% turn, not the mix-and-match 100k-of-1M that never happened.
    assert.equal(meta.context_tokens_used, 90000);
    assert.equal(meta.context_token_limit, 100000);
  });

  it("does not collapse two unrecognised surfaces onto one row", () => {
    const rows = db.getPendingConversations(100).filter((r) => r.session_id.includes(":chat-other"));
    // Both survive: normalization bounds what we store, it must not decide identity.
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((r) => r.session_id)).size, 2);
    for (const r of rows) assert.match(r.session_id, /^kiro-crew:other-[0-9a-f]{8}:chat-other$/);
  });

  it("records the originating surface, which no other extractor exposes", () => {
    const install = JSON.parse(crewRow().installation_metadata) as { entrypoint?: string };
    // The message arrived from Slack, not the dashboard the file is named for.
    assert.equal(install.entrypoint, "kiro-crew:slack");
  });

  it("applies the session model to every prompt", () => {
    const conv = JSON.parse(crewRow().conversation) as { metadata?: { model?: string } }[];
    assert.ok(conv.length > 0);
    assert.ok(conv.every((p) => p.metadata?.model === "claude-opus-4.8"));
  });

  it("skips a transcript with no user message", () => {
    const parsed = parseCrewSession([
      JSON.stringify({ _type: "metadata", title: "empty" }),
      JSON.stringify({ role: "assistant", content: "hello", ts: "2026-08-06T19:10:00Z" }),
    ]);
    assert.equal(parsed.prompts.filter((p) => p.role === "user").length, 0);
  });

  it("is incremental — a second run with no change extracts nothing", () => {
    assert.equal(extractKiroCrew(db, {}), 0);
  });

});
