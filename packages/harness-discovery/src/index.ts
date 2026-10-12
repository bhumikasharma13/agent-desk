// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

export * from "./types";
export { scan, IDES, type Ide, type ScanOptions, type ScanResult, type ScannedAsset, type ScanProblem } from "./scan";
export { harnessAssetId, deriveSourcePath, assetSourcePath } from "./identity";
export { createCollectSession, type CollectSession } from "./session";
export type { CollectOptions } from "./collectOptions";
export { setLogger, type Logger } from "./log";
export { CLAUDE_CODE_IDE, collectClaudeCodeAssets, collectClaudeCodeRepoAssets } from "./claudeCode";
export { CODEX_IDE, collectCodexAssets, collectCodexRepoAssets } from "./codex";
export { CURSOR_IDE, collectCursorAssets, collectCursorRepoAssets } from "./cursor";
export { KIRO_IDE, collectKiroAssets, collectKiroRepoAssets } from "./kiro";
