// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Shared types for the Harness page (installed-asset inventory). Served from
 * the last stored `harness-discovery` scan — not a live filesystem scan.
 * Imported by main, preload, and renderer (single source of truth).
 */

import type { HarnessAssetType, HarnessAssetScope, HarnessOperationalState, HarnessAssetFile } from "harness-discovery/types";

export type { HarnessAssetType, HarnessAssetScope, HarnessOperationalState, HarnessAssetFile };

export interface HarnessAsset {
  id: string;
  ideType: string;
  name: string;
  type: HarnessAssetType;
  scope: HarnessAssetScope;
  source: string;
  /** Absolute on-disk path of the asset's defining file. */
  filePath: string;
  /** Repo-relative, or home-relative at user scope. */
  sourcePath: string;
  contentHash: string;
  /** Files of a DIRECTORY asset — a skill's SKILL.md plus every helper beside
   *  it. Absent for a single-file asset. Exactly one entry is primary. */
  files?: HarnessAssetFile[];
  operationalState: HarnessOperationalState;
  /** When the scan that found this asset ran (ISO 8601). */
  lastSeenAt: string;
  description?: string;
  version?: string;
  pluginName?: string;
  marketplace?: string;
  projectPath?: string;
  baselineContentHash?: string;
  activeInAgents: string[];
  invocation?: string;
  sourceUrl?: string;
  /** Inline hooks only: the command string, which is the hook's whole body
   *  (there is no file of its own to read). */
  inlineBody?: string;
  /** Hooks only: the settings.json activation (event, matcher, timeout). */
  hookConfig?: { event: string; matcher: string; timeoutSeconds: number };
}

export interface HarnessPlugin {
  id: string;
  name: string;
  marketplace: string;
  sourceUrl?: string;
  version: string;
  installPath: string;
  enabled: boolean;
  assetCounts: { skills: number; commands: number; rules: number; hooks: number; agents: number };
}

export interface HarnessSummary {
  totalAssets: number;
  byType: Record<HarnessAssetType, number>;
  byScope: Record<HarnessAssetScope, number>;
}

/** Result of the detail-view file read (harness:readAsset). Exactly one of the
 *  two is set: `content` on success, `error` (a user-facing string) otherwise. */
export interface HarnessAssetContent {
  content: string | null;
  error: string | null;
}

/** Flat inventory snapshot (house style — like ExtractionStats). */
export interface HarnessInventory {
  status: "idle" | "running" | "error";
  /** True until the first scan of this app run completes — lets the UI show
   *  "Reading…" instead of a false "no agent files" on first launch. */
  collecting: boolean;
  /** When the stored scan ran, ISO 8601. Null until the first scan. */
  lastScannedAt: string | null;
  /** Set when the stored scan could not be read. */
  lastError: string | null;
  /** Set when the latest scan failed: the page still shows the stored scan, and says so. */
  lastScanFailure: { at: string; message: string } | null;
  /** What the scan read but did not collect (a skipped root, an invalid or
   *  oversized file, a link out of HOME and the repos), one line each. */
  warnings: string[];
  /** Roots or tools that could not be scanned: their inventory is partial. */
  errors: string[];
  assets: HarnessAsset[];
  plugins: HarnessPlugin[];
  summary: HarnessSummary;
}

export function defaultHarnessInventory(): HarnessInventory {
  return {
    status: "idle",
    collecting: false,
    lastScannedAt: null,
    lastError: null,
    lastScanFailure: null,
    warnings: [],
    errors: [],
    assets: [],
    plugins: [],
    summary: {
      totalAssets: 0,
      byType: {
        skill: 0,
        plugin: 0,
        command: 0,
        rule: 0,
        hook: 0,
        agent: 0,
        claude_md: 0,
        agents_md: 0,
        prompt_template: 0,
      },
      byScope: { user: 0, "repo-local": 0, "repo-committed": 0 },
    },
  };
}
