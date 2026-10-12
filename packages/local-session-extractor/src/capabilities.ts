// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The capability descriptor: what this build reads, writes and runs on.
 */
import { createRequire } from "node:module";
import { MIGRATIONS } from "./store/migrations";
import { DEFAULT_SOURCES } from "./scan";
import type { IdeType } from "./types/session";
import { EXPORT_FORMATS, type ExportFormat } from "./export";

/**
 * Each extractor's code version. Informational and never written to a row (the
 * row's stamp is the caller's `extractorVersions`). A source's number goes up
 * with any change to what its extractor records, which is any change that
 * regenerates that source's rows in `fixtures/golden.jsonl`; the golden parity
 * test holds it to that through {@link EXTRACTOR_GOLDEN_SHA256}.
 */
export const EXTRACTOR_CODE_VERSION: Readonly<Record<IdeType, number>> = {
  "claude-code": 1,
  cursor: 1,
  copilot: 1,
  antigravity: 1,
  codex: 1,
  kiro: 1,
};

/**
 * The sha256 of each source's lines in `fixtures/golden.jsonl`, joined by
 * newlines, at the version above. Regenerating a source's golden rows fails the
 * parity test until this hash and that source's version are both updated.
 */
export const EXTRACTOR_GOLDEN_SHA256: Readonly<Record<IdeType, string>> = {
  "claude-code": "f6849719f4b63d1fbf348d5b4e855199c028de1ea90f66025675e85d05598c1f",
  cursor: "ecf7d65cb19d6b8c8797d9f7dbc4ad82c90dc9202099d0e22934d4959c846f96",
  copilot: "c60c6dcbaf22255429f87da83d9fa0d0d365b9fddb817936f1e9b54cd583ee67",
  antigravity: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  codex: "cb264cd4b222f533726d6a7780be54f2f7920266dd72918fb34f8a1b547a6a80",
  kiro: "b1fd82c39051e7e73b75bf404aa2f4f2f9fa641365bf2ed6baa70ecbe5aa030f",
};

export interface Capabilities {
  /** Every source this build reads, in the order a scan with no `sources` runs them. */
  sources: readonly IdeType[];
  formats: readonly ExportFormat[];
  /** Only the platforms the fixture suite covers are claimed. */
  platforms: readonly NodeJS.Platform[];
  packageVersion: string;
  /** The store schema version this build migrates to. */
  schemaVersion: number;
  extractorCodeVersion: Readonly<Record<IdeType, number>>;
}

// Both src/ and dist/ sit one level below the package root.
const packageVersion = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export function capabilities(): Capabilities {
  return {
    sources: DEFAULT_SOURCES,
    formats: EXPORT_FORMATS,
    platforms: ["darwin"],
    packageVersion,
    schemaVersion: MIGRATIONS.length,
    extractorCodeVersion: EXTRACTOR_CODE_VERSION,
  };
}
