// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Rewrites `fixtures/golden.jsonl`, and its Conversation form
 * `fixtures/golden-conversation.jsonl`, from today's extractors over the committed
 * corpora. Run as `pnpm capture-golden` from the package; the parity test fails
 * until a deliberate change's golden diff is reviewed and committed.
 */
import { rmSync } from "node:fs";
import { relative } from "node:path";
import { GOLDEN_CONVERSATION_PATH, GOLDEN_PATH, captureGolden, isolateHome, writeGolden } from "./golden";

const home = isolateHome();
const capture = await captureGolden(home).finally(() => rmSync(home, { recursive: true, force: true }));
writeGolden(capture);
console.log(`wrote ${capture.lines.length} rows to ${relative(process.cwd(), GOLDEN_PATH)} and ${relative(process.cwd(), GOLDEN_CONVERSATION_PATH)}`);
for (const [source, n] of Object.entries(capture.counts)) console.log(`  ${source}: ${n}`);
