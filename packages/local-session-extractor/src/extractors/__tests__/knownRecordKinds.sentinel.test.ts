// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RECOGNIZED_RECORD_KINDS, claudeCodeRecordKind, codexRecordKind, kiroRecordKind, type TurnTelemetryProvider } from "../../internal";

/**
 * The compile-time sentinel: the recognized-kind registry is pinned
 * to the committed fixture corpus in BOTH directions. A kind registered with no
 * fixture exercising it, or a fixture carrying a kind the registry omits, fails here
 * — so teaching the extractor a new kind is structurally gated on first capturing a
 * fixture, and a fixture can never smuggle in an unrecognized kind that would drop
 * silently in production. The derivation helpers are the SAME ones the extractors
 * dispatch through, so the corpus is read exactly as the extractor reads it.
 */

// This test file lives at src/extractors/__tests__/; the corpus is under
// fixtures/ at the repository root. Resolve from this file rather than trusting the cwd.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXROOT = join(HERE, "../../../fixtures/turn-telemetry");
// The extraction corpus's Codex rollouts are read by the Codex extractor tests too,
// so the kinds they carry are part of what the registry must recognize.
const EXTRACTION_CODEX = join(HERE, "../../../fixtures/extraction/codex");

/** Every file under `dir` whose basename passes `keep`. */
function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && keep(e.name))
    .map((e) => join(e.parentPath, e.name));
}

/** The distinct record kinds a set of JSONL files carries, via one derivation. */
function kindsInFiles(files: string[], kindOf: (line: unknown) => string): Set<string> {
  const kinds = new Set<string>();
  for (const file of files) {
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // a non-JSON line is not a record — the extractors skip it too
      }
      kinds.add(kindOf(parsed));
    }
  }
  return kinds;
}

// Per provider: which fixture files to read, and how to derive a record's kind —
// mirroring what each extractor consumes (Claude Code reads every transcript incl.
// subagents; Codex one rollout per case; Kiro the session's messages.jsonl AND
// every sub-executions/<id>.jsonl, which the extractor parses through the same
// parseIdeMessages that runs the unknown-kind check — so a kind appearing only in
// a child file is still gated by this sentinel).
const PROVIDERS: {
  provider: TurnTelemetryProvider;
  keep: (name: string) => boolean;
  kindOf: (line: unknown) => string;
}[] = [
  {
    provider: "claude-code",
    keep: (n) => n.endsWith(".jsonl"),
    kindOf: (line) => claudeCodeRecordKind(line as { type?: unknown; subtype?: unknown }),
  },
  {
    provider: "codex",
    keep: (n) => n.endsWith(".jsonl"),
    kindOf: (line) => codexRecordKind(line as { type?: unknown; payload?: unknown }),
  },
  {
    provider: "kiro",
    // messages.jsonl AND sub-executions/<id>.jsonl — both go through the
    // extractor's parseIdeMessages, so both feed the drift check the sentinel
    // mirrors. session.json is not a JSONL record stream and is excluded.
    keep: (n) => n.endsWith(".jsonl"),
    kindOf: (line) => kiroRecordKind(((line as { payload?: unknown }).payload ?? {}) as { type?: unknown }),
  },
];

describe("known-record-kind registry mirrors the fixture corpus", () => {
  for (const { provider, keep, kindOf } of PROVIDERS) {
    it(`${provider}: registry === kinds present in fixtures`, () => {
      const dir = join(FIXROOT, provider);
      const files = [...filesUnder(dir, keep), ...(provider === "codex" ? filesUnder(EXTRACTION_CODEX, keep) : [])];
      assert.ok(files.length > 0, `no fixture files found for ${provider} under ${dir}`);

      const corpus = kindsInFiles(files, kindOf);
      const registry = RECOGNIZED_RECORD_KINDS[provider];

      const missingFromRegistry = [...corpus].filter((k) => !registry.has(k)).sort();
      const missingFromCorpus = [...registry].filter((k) => !corpus.has(k)).sort();

      assert.deepEqual(
        missingFromRegistry,
        [],
        `fixture kinds not in the registry (a new kind must be registered, or it drops silently): ${missingFromRegistry.join(", ")}`
      );
      assert.deepEqual(
        missingFromCorpus,
        [],
        `registered kinds with no fixture (capture one before handling the kind): ${missingFromCorpus.join(", ")}`
      );
    });
  }
});
