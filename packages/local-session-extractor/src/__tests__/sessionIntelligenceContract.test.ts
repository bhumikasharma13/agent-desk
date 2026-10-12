// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Every session the fixtures hold, converted by `toConversation`, is a valid
 * Session Intelligence `Conversation` under strict protojson: no unknown field, no
 * unknown enum name, every key the proto's JSON name. The proto is the descriptor
 * set in `contract/session-intelligence/`, built from Session Intelligence's own
 * `conversation.proto`.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ScalarType, type DescEnum, type DescField, type DescMessage } from "@bufbuild/protobuf";
import { stageHomes } from "../../scripts/golden";
import { exportRecord } from "../export";
import { encodeSummaryInner, writeAntigravityStateDb } from "../extractors/__tests__/antigravityFixture";
import { openStore, readAll, type ScanOptions } from "../index";
import {
  COLUMNS,
  DIRECT_FIELDS,
  PROMPT_METADATA_FIELDS,
  SESSION_META_FIELDS,
  shapeOf,
  toConversation,
  type Shape,
} from "../sessionIntelligence";
import { readHomeOwners } from "../store/homeOwners";
import type { ConversationRow } from "../types/session";
import type { Conversation } from "../types/sessionIntelligence";
import { CONVERSATION, assertConversation, registry } from "./sessionIntelligenceDescriptor";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..", "..");

interface Converted {
  home: string;
  row: ConversationRow;
  conversation: Conversation;
}

const work = mkdtempSync(join(tmpdir(), "lse-si-contract-"));
const converted: Converted[] = [];

/** Scans `home` into a store of its own and converts every row, as `exportSessions` does. */
async function scanAndConvert(name: string, home: string, opts: ScanOptions = {}): Promise<void> {
  const store = openStore(join(work, `${name}.db`));
  try {
    await readAll(store, { home, ...opts });
    const owners = readHomeOwners(store);
    for (const row of store.raw().prepare("SELECT * FROM conversations").all() as unknown as ConversationRow[]) {
      const conversation = JSON.parse(JSON.stringify(toConversation(exportRecord(row, new Set(), owners)))) as Conversation;
      converted.push({ home: name, row, conversation });
    }
  } finally {
    store.close();
  }
}

/** The `testdata/home` of every example under `root`. */
function exampleHomes(root: string): Array<[string, string]> {
  return readdirSync(root)
    .map((name): [string, string] => [name, join(root, name, "testdata", "home")])
    .filter(([, home]) => existsSync(home));
}

/**
 * No committed corpus yields an Antigravity row, so one is built: the offline
 * store's trajectory summary and its brain summary, read with no server.
 */
function antigravityHome(): { home: string; db: string } {
  const home = join(work, "antigravity-home");
  const db = join(work, "antigravity", "state.vscdb");
  mkdirSync(join(work, "antigravity"), { recursive: true });
  const id = "traj-contract-001";
  writeAntigravityStateDb(db, [
    {
      id,
      inner: encodeSummaryInner({
        title: "Add pagination to the orders endpoint",
        stepCount: 4,
        createdAtSecs: 1_767_225_600,
        updatedAtSecs: 1_767_225_900,
        workspaceUri: "file:///Users/you/src/shop",
      }),
    },
  ]);
  const brain = join(home, ".gemini", "antigravity", "brain", id);
  mkdirSync(brain, { recursive: true });
  writeFileSync(join(brain, "task.md.metadata.json"), JSON.stringify({ summary: "Added cursor pagination to GET /orders." }));
  return { home, db };
}

before(async () => {
  const staged = stageHomes(join(work, "staged"));
  await scanAndConvert("staged", staged.home, { captureLineage: true });
  await scanAndConvert("staged-codex-sqlite", staged.codexSqliteHome, { sources: ["codex"] });
  for (const [name, home] of exampleHomes(join(PACKAGE_ROOT, "examples"))) await scanAndConvert(`package-example-${name}`, home);
  for (const [name, home] of exampleHomes(join(PACKAGE_ROOT, "..", "..", "examples"))) await scanAndConvert(`app-example-${name}`, home);
  const ag = antigravityHome();
  await scanAndConvert("antigravity", ag.home, { sources: ["antigravity"], paths: { ANTIGRAVITY_DB_PATH: ag.db } });
});

after(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

describe("toConversation against Session Intelligence's conversation.proto", () => {
  it("converts every fixture session into a Conversation that parses strictly", () => {
    assert.ok(converted.length >= 40, `expected the fixture corpora's sessions, got ${converted.length}`);
    const failures: string[] = [];
    for (const { home, row, conversation } of converted) {
      try {
        assertConversation(conversation, "Conversation");
      } catch (err) {
        failures.push(`${home} ${row.ide_type}/${row.session_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  it("covers all six sources, each with its IDE type and its prompts", () => {
    const want = {
      "claude-code": "IDE_TYPE_CLAUDE_CODE",
      cursor: "IDE_TYPE_CURSOR",
      copilot: "IDE_TYPE_COPILOT",
      antigravity: "IDE_TYPE_ANTIGRAVITY",
      codex: "IDE_TYPE_CODEX",
      kiro: "IDE_TYPE_KIRO",
    } as const;
    for (const [source, ideType] of Object.entries(want)) {
      const rows = converted.filter((c) => c.row.ide_type === source);
      assert.ok(rows.length > 0, `no ${source} session in the fixtures`);
      for (const { conversation } of rows) assert.equal(conversation.ideType, ideType);
      assert.ok(rows.some((c) => c.conversation.prompts.length > 0), `no ${source} session has prompts`);
    }
  });

  it("keeps one prompt per stored message, so an event's promptOrdinal still points at its prompt", () => {
    for (const { row, conversation } of converted) {
      assert.equal(conversation.prompts.length, (JSON.parse(row.conversation) as unknown[]).length, `${row.ide_type}/${row.session_id}`);
    }
  });

  it("maps the lineage enums to the proto's names", () => {
    const lineages = converted.map((c) => c.conversation.sessionMeta?.lineage).filter((l) => l !== undefined);
    assert.ok(lineages.some((l) => l.relationType === "CONVERSATION_TYPE_SUBAGENT"), "no sub-agent lineage in the fixtures");
    for (const l of lineages) {
      assert.match(l.relationType ?? "", /^CONVERSATION_TYPE_/);
      assert.equal("parentRecordKey" in l, false);
    }
  });

  it("classifies every session_meta and prompt metadata key the fixtures hold", () => {
    const unclassified = new Set<string>();
    for (const { row } of converted) {
      for (const key of Object.keys(row.session_meta === null ? {} : (JSON.parse(row.session_meta) as object))) {
        if (!Object.hasOwn(SESSION_META_FIELDS, key)) unclassified.add(`session_meta.${key}`);
      }
      for (const prompt of JSON.parse(row.conversation) as Array<{ metadata?: object }>) {
        for (const key of Object.keys(prompt.metadata ?? {})) {
          if (!Object.hasOwn(PROMPT_METADATA_FIELDS, key)) unclassified.add(`metadata.${key}`);
        }
      }
    }
    assert.deepEqual([...unclassified], []);
  });

  it("rejects the stored row shape, so a mismatch cannot pass unseen", () => {
    const { row } = converted.find((c) => c.row.ide_type === "codex")!;
    const record = JSON.parse(JSON.stringify(exportRecord(row, new Set()))) as unknown;
    assert.throws(() => assertConversation(record, "row"));
  });
});

describe("duration, as Session Intelligence derives it", () => {
  const meta = (row: ConversationRow): Record<string, unknown> => JSON.parse(row.session_meta ?? "{}") as Record<string, unknown>;

  it("keeps a Kiro session's duration_minutes as the extractor wrote it, seconds over 60, and drops the seconds", () => {
    const kiro = converted.filter((c) => c.row.ide_type === "kiro");
    assert.ok(kiro.length > 0);
    for (const { row, conversation } of kiro) {
      const seconds = meta(row)["session_duration_seconds"] as number;
      assert.ok(seconds > 0, `${row.session_id} has no duration`);
      assert.equal(conversation.sessionMeta?.durationMinutes, seconds / 60);
      assert.equal("sessionDurationSeconds" in (conversation.sessionMeta ?? {}), false);
    }
  });

  it("gives a Cursor session both timestamps, whose difference is the extractor's seconds", () => {
    const cursor = converted.filter((c) => c.row.ide_type === "cursor");
    assert.ok(cursor.length > 0);
    for (const { row, conversation } of cursor) {
      const seconds = meta(row)["session_duration_seconds"] as number;
      assert.equal(typeof seconds, "number");
      const sm = conversation.sessionMeta ?? {};
      assert.equal("durationMinutes" in sm, false);
      assert.equal("sessionDurationSeconds" in sm, false);
      const span = (Date.parse(conversation.lastUpdatedAt!) - Date.parse(conversation.conversationStartedAt!)) / 1000;
      assert.ok(Math.abs(span - seconds) <= 1, `${row.session_id}: timestamps span ${span}s, extractor says ${seconds}s`);
    }
  });
});

/** What one proto slot holds: a field itself, or the element or value of a list or map field. */
type Slot = { kind: "scalar"; scalar: ScalarType } | { kind: "enum"; enum: DescEnum } | { kind: "message"; message: DescMessage };

function slotOf(field: DescField): { container: "single" | "list" | "map"; slot: Slot } {
  const container = field.fieldKind === "list" ? "list" : field.fieldKind === "map" ? "map" : "single";
  const kind = field.fieldKind === "list" ? field.listKind : field.fieldKind === "map" ? field.mapKind : field.fieldKind;
  if (kind === "enum") return { container, slot: { kind, enum: field.enum! } };
  if (kind === "message") return { container, slot: { kind, message: field.message! } };
  return { container, slot: { kind: "scalar", scalar: field.scalar! } };
}

const SCALARS: Record<string, ScalarType> = {
  string: ScalarType.STRING,
  bool: ScalarType.BOOL,
  double: ScalarType.DOUBLE,
  int32: ScalarType.INT32,
  int64: ScalarType.INT64,
};

/**
 * Checks every table entry the converter keeps against the descriptor, whether or
 * not any fixture holds a value for it: the JSON name is a field of the message,
 * the field has the converter's type, and every enum value is one of its names.
 */
function checkField(message: DescMessage, to: string, shape: Shape, path: string, problems: string[], visited: string[]): void {
  const at = `${path}.${to}`;
  visited.push(at);
  const field = message.fields.find((f) => f.jsonName === to);
  if (field === undefined) {
    problems.push(`${at} is not a JSON field name of ${message.typeName}`);
    return;
  }
  const { container, slot } = slotOf(field);
  const inner = shape.kind === "list" || shape.kind === "map" ? shape.of : shape;
  const want = shape.kind === "list" || shape.kind === "map" ? shape.kind : "single";
  if (container !== want) {
    problems.push(`${at} is a ${container} field, the converter writes a ${want}`);
    return;
  }
  checkSlot(slot, inner, at, problems, visited);
}

function checkSlot(slot: Slot, shape: Shape, at: string, problems: string[], visited: string[]): void {
  switch (shape.kind) {
    case "scalar":
      if (slot.kind !== "scalar" || slot.scalar !== SCALARS[shape.type]) problems.push(`${at} is not a ${shape.type} in the proto`);
      return;
    case "timestamp":
      if (slot.kind !== "message" || slot.message.typeName !== "google.protobuf.Timestamp") problems.push(`${at} is not a Timestamp in the proto`);
      return;
    case "enum": {
      if (slot.kind !== "enum") {
        problems.push(`${at} is not an enum in the proto`);
        return;
      }
      const names = new Set(slot.enum.values.map((v) => v.name));
      for (const name of shape.names) if (!names.has(name)) problems.push(`${at}: ${name} is not a value of ${slot.enum.typeName}`);
      return;
    }
    case "message":
      if (slot.kind !== "message") {
        problems.push(`${at} is not a message in the proto`);
        return;
      }
      for (const [key, entry] of Object.entries(shape.fields)) {
        if ("to" in entry) checkField(slot.message, entry.to, shapeOf(entry.convert), `${at}{${key}}`, problems, visited);
      }
      return;
    default:
      problems.push(`${at}: a ${shape.kind} cannot nest directly in a list or map`);
  }
}

describe("the converter's tables against the descriptor, with no fixture data", () => {
  const problems: string[] = [];
  const visited: string[] = [];
  const PROMPT = registry.getMessage("sessionintelligence.v1.Prompt")!;
  for (const [message, to, convert] of DIRECT_FIELDS) {
    checkField(message === "Conversation" ? CONVERSATION : PROMPT, to, shapeOf(convert), message, problems, visited);
  }
  for (const [, to, convert] of COLUMNS) checkField(CONVERSATION, to, shapeOf(convert), "Conversation", problems, visited);

  it("names every kept field as a JSON field of its message, with the proto's type and enum value names", () => {
    assert.deepEqual(problems, []);
  });

  it("walks every table, the entries no fixture holds a value for among them", () => {
    for (const unfixtured of ["cursor_team_role", "subscription_created_at", "tracking_start_time"]) {
      assert.ok(visited.some((p) => p.endsWith(`{${unfixtured}}.${unfixtured.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())}`)), unfixtured);
    }
    assert.ok(visited.length > 200, `checked ${visited.length} fields`);
  });
});
