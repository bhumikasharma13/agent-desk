// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The extractors' records over both committed corpora equal the golden, row for
 * row and field for field. A deliberate change to what an extractor records
 * regenerates the golden (`pnpm capture-golden`), reviews that diff, and bumps
 * that source's extractor code version and golden hash.
 */
import { after, it } from "node:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import assert from "node:assert/strict";
import { captureGolden, conversationLines, isolateHome, readConversationGolden, readGolden } from "../../scripts/golden";
import { EXTRACTOR_CODE_VERSION, EXTRACTOR_GOLDEN_SHA256 } from "../capabilities";

// Before any scan, so no default location resolves under the real home.
const home = isolateHome();
after(() => rmSync(home, { recursive: true, force: true }));

it("records every corpus session exactly as the golden does", async () => {
  const { lines } = await captureGolden(home);
  const golden = readGolden();
  assert.equal(lines.length, golden.length, "row count");
  for (let i = 0; i < golden.length; i++) {
    const want = JSON.parse(golden[i]!) as { ide_type: string; session_id: string };
    assert.deepEqual(JSON.parse(lines[i]!), want, `${want.ide_type}/${want.session_id}`);
  }
});

it("pins each source's golden rows to its extractor code version", () => {
  const bySource = new Map<string, string[]>();
  for (const line of readGolden()) {
    const source = (JSON.parse(line) as { ide_type: string }).ide_type;
    bySource.set(source, [...(bySource.get(source) ?? []), line]);
  }
  for (const [source, version] of Object.entries(EXTRACTOR_CODE_VERSION)) {
    const sha256 = createHash("sha256").update((bySource.get(source) ?? []).join("\n")).digest("hex");
    assert.equal(
      sha256,
      EXTRACTOR_GOLDEN_SHA256[source as keyof typeof EXTRACTOR_GOLDEN_SHA256],
      `${source}'s golden rows changed at code version ${version}: bump EXTRACTOR_CODE_VERSION["${source}"] and set EXTRACTOR_GOLDEN_SHA256["${source}"] to ${sha256}`,
    );
  }
});

it("holds the conversation golden to the row golden, converted", () => {
  assert.deepEqual(readConversationGolden(), conversationLines(readGolden()), "run pnpm capture-golden");
});
