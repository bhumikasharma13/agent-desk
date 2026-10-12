// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { requireConsumedField, requireConsumedShape } from "../knownRecordKinds";
import { parseRolloutContent } from "../codexExtractor";
import { parseIdeMessages } from "../kiroIdeExtractor";
import { setMetricsSink, type CounterTags } from "../../seams/metrics";
import { runInScanScope } from "../../seams/scanScope";
import { setLogger } from "../../seams/logger";

/**
 * The second half of the vendor-drift tripwire: a field RENAMED inside a
 * still-recognized record kind. The kind stays recognized, so `noteUnknownRecordKind`
 * says nothing — the parser reads the renamed field as absent, silently emits zero
 * tokens / drops the turn, and nothing counts it. `requireConsumedField` closes that
 * by firing the SAME drift counter on a missing critical field.
 *
 * These assert three things the design turns on:
 *   (a) a recognized record MISSING a guarded critical field increments the counter,
 *   (b) the happy path (field present) fires nothing,
 *   (c) a legitimately-absent OPTIONAL field is NOT guarded, so it never cries wolf.
 * (a)/(b) are exercised end-to-end through the real Codex and Kiro extractors, so a
 * future refactor that drops the guard at the call site is caught, not just the helper.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXROOT = join(HERE, "../../../fixtures/turn-telemetry");

/** Every counter increment since the last reset, captured through the metrics seam. */
const counted: { name: string; tags: CounterTags; by: number }[] = [];
setMetricsSink({ inc: (name, tags = {}, by = 1) => counted.push({ name, tags, by }), observe: () => {} });
const _resetForTests = (): void => {
  counted.length = 0;
};

/** Net increments on the shared drift counter for one provider, then reset. */
function driftCount(component: string): number {
  const n = counted
    .filter((c) => c.name === "unknown_record_kinds" && c.tags.component === component)
    .reduce((sum, c) => sum + c.by, 0);
  _resetForTests();
  return n;
}

const codexBootZeroToken = (): string =>
  readFileSync(join(FIXROOT, "codex", "boot-zero-token", "rollout-boot-zero-token.jsonl"), "utf8");

/** The messages.jsonl lines for a Kiro fixture case. */
function kiroMessageLines(caseName: string): string[] {
  const caseDir = join(FIXROOT, "kiro", caseName);
  const sessDir = readdirSync(caseDir).find((n) => n.startsWith("sess_"));
  assert.ok(sessDir, `no session dir in ${caseDir}`);
  return readFileSync(join(caseDir, sessDir, "messages.jsonl"), "utf8").split("\n").filter((l) => l.trim());
}

/** Rewrite the first line matching `pick`, applying `mutate` to its parsed object. */
/** A transcript record: a `type` and a `payload` object, as every record here has. */
interface TranscriptRecord {
  type?: unknown;
  payload: Record<string, unknown> & { type?: unknown };
}

function mutateFirst(
  lines: string[],
  pick: (o: TranscriptRecord) => boolean,
  mutate: (o: TranscriptRecord) => void,
): string[] {
  const out = [...lines];
  for (let i = 0; i < out.length; i++) {
    let o: TranscriptRecord;
    try {
      o = JSON.parse(out[i]!);
    } catch {
      continue;
    }
    if (pick(o)) {
      mutate(o);
      out[i] = JSON.stringify(o);
      return out;
    }
  }
  assert.fail("no line matched the picker — fixture shape drifted");
}

describe("requireConsumedField helper", () => {
  beforeEach(() => _resetForTests());

  // Presence is the test, not truthiness: an empty string / empty array / 0 is a
  // real value (a zero-token turn is data, not drift) and must NOT fire.
  const present: [string, unknown][] = [
    ["empty string", ""],
    ["empty array", []],
    ["zero", 0],
    ["object", { input_tokens: 0 }],
    ["false", false],
  ];
  for (const [label, value] of present) {
    it(`a present value (${label}) fires nothing and is returned unchanged`, () => {
      const returned = requireConsumedField("claude-code", "assistant", "message.usage", value);
      assert.equal(returned, value);
      assert.equal(driftCount("extraction.claude_code"), 0);
    });
  }

  const absent: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
  ];
  for (const [label, value] of absent) {
    it(`a missing value (${label}) fires the drift counter for the provider`, () => {
      const returned = requireConsumedField("claude-code", "assistant", "message.usage", value);
      assert.equal(returned, value);
      assert.equal(driftCount("extraction.claude_code"), 1);
    });
  }

  it("labels the counter by the provider component", () => {
    requireConsumedField("kiro", "user", "payload.content", undefined);
    assert.equal(driftCount("extraction.kiro"), 1);
    assert.equal(driftCount("extraction.claude_code"), 0);
  });

  it("is a no-op on an UNrecognized kind — that record is noteUnknownRecordKind's to count", () => {
    requireConsumedField("codex", "__not_a_real_kind__", "payload.message", undefined);
    assert.equal(driftCount("extraction.codex"), 0);
  });
});

/**
 * Pins that the shape guard fires the SAME drift counter on a present-but-wrong-shape
 * field, still fires on absence, and stays silent on the one expected shape. See
 * `requireConsumedShape`'s doc comment for the bug class it guards.
 */
describe("requireConsumedShape helper", () => {
  beforeEach(() => _resetForTests());

  it("a value of the expected shape fires nothing and is returned unchanged", () => {
    const returned = requireConsumedShape("codex", "event_msg/user_message", "payload.message", "hi", "string");
    assert.equal(returned, "hi");
    assert.equal(driftCount("extraction.codex"), 0);
  });

  // The bug class: the field is PRESENT (so the presence guard would pass) but in the
  // wrong shape, so the parser reads it as empty and silently drops the turn.
  const wrongShape: [string, "string" | "object" | "array", unknown][] = [
    ["a content-block array where a string is read", "string", [{ type: "text", text: "hi" }]],
    ["an object where a string is read", "string", { text: "hi" }],
    ["a scalar where a token object is read", "object", 0],
    ["an array where a plain object is read", "object", [{ input_tokens: 1 }]],
  ];
  for (const [label, shape, value] of wrongShape) {
    it(`present-but-wrong-shape (${label}) fires the drift counter and returns the value unchanged`, () => {
      const returned = requireConsumedShape("codex", "event_msg/user_message", "payload.message", value, shape);
      assert.equal(returned, value);
      assert.equal(driftCount("extraction.codex"), 1);
    });
  }

  // An empty string / empty array / 0 of the RIGHT shape is a real value, not drift.
  const rightShapeButEmpty: [string, "string" | "object" | "array", unknown][] = [
    ["empty string", "string", ""],
    ["empty array", "array", []],
    ["empty object", "object", {}],
  ];
  for (const [label, shape, value] of rightShapeButEmpty) {
    it(`an empty value of the right shape (${label}) fires nothing`, () => {
      requireConsumedShape("codex", "event_msg/user_message", "payload.message", value, shape);
      assert.equal(driftCount("extraction.codex"), 0);
    });
  }

  const absent: [string, unknown][] = [
    ["undefined", undefined],
    ["null", null],
  ];
  for (const [label, value] of absent) {
    it(`a missing value (${label}) fires the drift counter, same as the presence guard`, () => {
      requireConsumedShape("codex", "event_msg/user_message", "payload.message", value, "string");
      assert.equal(driftCount("extraction.codex"), 1);
    });
  }

  it("is a no-op on an UNrecognized kind — even when the shape is wrong", () => {
    requireConsumedShape("codex", "__not_a_real_kind__", "payload.message", [{ text: "hi" }], "string");
    assert.equal(driftCount("extraction.codex"), 0);
  });

  it("logs each distinct failure mode once per scan — absent then wrong-shape is two lines, a repeat none, a new scan logs again", () => {
    // The log line is deduped per (field, failure mode), keyed on `detail.got`, so a
    // field seen absent and later in a wrong shape logs twice; a repeat of the same
    // wrong shape logs nothing within the scan, and the next scan's logger sees it again.
    const FIELD = "payload.__log_dedup_probe__";
    const scanWarns = (calls: () => void): string[] => {
      const warned: string[] = [];
      const log = (): void => {};
      runInScanScope(
        {
          source: "codex",
          logger: { info: log, error: log, debug: log, warn: (_c, event, data) => warned.push(`${event} ${String(data?.["got"] ?? "absent")}`) },
          metrics: undefined,
          home: undefined,
          paths: new Map(),
          errors: [],
          unknownRecordKinds: new Map(),
          sourceFailed: false,
          loggedOnce: new Set(),
        },
        calls,
      );
      return warned;
    };
    const drift = (): void => {
      requireConsumedShape("codex", "event_msg/user_message", FIELD, undefined, "string");
      requireConsumedShape("codex", "event_msg/user_message", FIELD, [{ type: "text" }], "string");
      requireConsumedShape("codex", "event_msg/user_message", FIELD, [{ type: "text" }], "string");
    };
    const expected = ["missing_consumed_field absent", "missing_consumed_field array"];
    assert.deepEqual(scanWarns(drift), expected, "absent and wrong-shape are distinct lines; a repeat mode is deduped");
    assert.deepEqual(scanWarns(drift), expected, "a second scan logs the same drift to its own logger");
  });

  it("outside a scan, logs each failure mode once per process", () => {
    const FIELD = "payload.__log_dedup_outside_scan_probe__";
    const warned: string[] = [];
    const log = (): void => {};
    setLogger({ info: log, error: log, debug: log, warn: (_c, event, data) => warned.push(`${event} ${String(data?.["got"] ?? "absent")}`) });
    try {
      for (let i = 0; i < 2; i++) {
        requireConsumedShape("codex", "event_msg/user_message", FIELD, undefined, "string");
        requireConsumedShape("codex", "event_msg/user_message", FIELD, [{ type: "text" }], "string");
      }
    } finally {
      setLogger(null);
    }
    assert.deepEqual(warned, ["missing_consumed_field absent", "missing_consumed_field array"]);
  });
});

describe("Codex missing-consumed-field drift (end-to-end)", () => {
  beforeEach(() => _resetForTests());

  it("a user_message that lost its `message` trips the counter for extraction.codex", () => {
    const drifted = mutateFirst(
      codexBootZeroToken().split("\n").filter((l) => l.trim()),
      (o) => o?.type === "event_msg" && o?.payload?.type === "user_message",
      (o) => {
        delete o.payload.message;
      },
    ).join("\n");
    parseRolloutContent(drifted, "t");
    assert.ok(driftCount("extraction.codex") >= 1, "the renamed token/message field must be counted");
  });

  it("a user_message whose `message` is a content-block ARRAY (present, wrong shape) trips the counter", () => {
    // The field is PRESENT (so a presence guard alone passes) but the parser reads
    // `message` only as a string — a content-block array reads as empty and the human
    // turn silently vanishes. The shape guard must catch it.
    const drifted = mutateFirst(
      codexBootZeroToken().split("\n").filter((l) => l.trim()),
      (o) => o?.type === "event_msg" && o?.payload?.type === "user_message",
      (o) => {
        o.payload.message = [{ type: "text", text: "hi" }];
      },
    ).join("\n");
    parseRolloutContent(drifted, "t");
    assert.ok(driftCount("extraction.codex") >= 1, "a present-but-wrong-shape message must be counted");
  });

  it("the unmutated rollout fires nothing — happy path, and its absent token_count is not cried over", () => {
    // boot-zero-token carries a user_message (message present) and NO token_count at
    // all: the token field is legitimately absent, and it is deliberately unguarded —
    // so a clean session must produce zero drift. This is both (b) and (c) for Codex.
    parseRolloutContent(codexBootZeroToken(), "t");
    assert.equal(driftCount("extraction.codex"), 0);
  });
});

describe("Kiro missing-consumed-field drift (end-to-end)", () => {
  beforeEach(() => _resetForTests());

  it("a user record that lost its `content` trips the counter for extraction.kiro", () => {
    const drifted = mutateFirst(
      kiroMessageLines("per-turn-credits"),
      (o) => o?.payload?.type === "user",
      (o) => {
        delete o.payload.content;
      },
    );
    parseIdeMessages(drifted);
    assert.ok(driftCount("extraction.kiro") >= 1, "the renamed content field must be counted");
  });

  it("the unmutated session fires nothing — happy path", () => {
    parseIdeMessages(kiroMessageLines("per-turn-credits"));
    assert.equal(driftCount("extraction.kiro"), 0);
  });

  it("an un-metered usage_summary (its optional `usage` absent) is NOT guarded — no false fire", () => {
    // The `promptTurnSummaries[].usage` credit field is legitimately absent on an
    // un-metered turn (the extractor's `sawUsage` path), so it is deliberately NOT
    // guarded. Feed a usage_summary carrying a summary WITHOUT `usage` and assert the
    // token field's absence never trips the tripwire. This is (c) for Kiro's token field.
    const lines = [
      JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", payload: { type: "user", content: "hi" } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:01Z", payload: { type: "turn_start", executionId: "e1" } }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:02Z", payload: { type: "assistant", content: "ok", executionId: "e1" } }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:03Z",
        payload: { type: "usage_summary", executionId: "e1", promptTurnSummaries: [{ unit: "credit", usedTools: [] }] },
      }),
      JSON.stringify({ timestamp: "2026-01-01T00:00:04Z", payload: { type: "turn_end", executionId: "e1" } }),
    ];
    parseIdeMessages(lines);
    assert.equal(driftCount("extraction.kiro"), 0);
  });

  it("a user `content` that is a content-block ARRAY does not throw and trips the counter", () => {
    // Regression guard: `.trim()` on a non-string content throws, and the caller's
    // per-session catch would turn that into the WHOLE session dropped, not one empty turn.
    // The record must parse (no throw), the turn degrade to empty, and the drift fire.
    // The array shape is synthetic — no real Kiro capture shows a non-string `content`
    // locally — but the surrounding record is the real fixture's, mutated in place.
    const drifted = mutateFirst(
      kiroMessageLines("per-turn-credits"),
      (o) => o?.payload?.type === "user",
      (o) => {
        o.payload.content = [{ type: "text", text: "hi" }];
      },
    );
    assert.doesNotThrow(() => parseIdeMessages(drifted));
    assert.ok(driftCount("extraction.kiro") >= 1, "a present-but-wrong-shape content must be counted");
  });
});
