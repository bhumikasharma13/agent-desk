// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { boundAssetName } from "./hookAssetName";
import { harnessAssetId } from "./identity";
import { reportProblem } from "./log";
import { escapeControls } from "./sanitize";
import type { CollectedAsset } from "./types";

/**
 * One collection pass for one tool. `push` escapes an asset's name and description, bounds
 * the name at 256 characters, and hands it to the sink once per identity. `scannedKeys`
 * records the roots (project keys) the collect call read: a caller keeping its own store
 * replaces that tool's stored assets for those roots with the run's result, and keeps the
 * stored assets of a root that is not in the set.
 */
export interface CollectSession {
  readonly seenIds: Set<string>;
  readonly scannedKeys: Set<string>;
  push(asset: CollectedAsset): Promise<void>;
}

export function createCollectSession(
  sink: (asset: CollectedAsset) => void,
  seenIds: Set<string> = new Set(),
  scannedKeys: Set<string> = new Set(),
): CollectSession {
  // The first writer per id, to report a duplicate that is not identical.
  const kept = new Map<string, { filePath: string; contentHash: string; wiring: string }>();
  const wiringOf = (a: CollectedAsset): string =>
    a.type === "hook" ? JSON.stringify([a.payload.hook_command ?? a.payload.inline_body ?? "", a.payload.hook_config ?? null]) : "";
  return {
    seenIds,
    scannedKeys,
    async push(asset: CollectedAsset): Promise<void> {
      // Escaped, not deleted, so names that differ only in a control or bidi character stay
      // different. A description keeps its tabs and line breaks.
      asset.name = boundAssetName(escapeControls(asset.name));
      if (asset.payload.description) {
        asset.payload.description = escapeControls(asset.payload.description, true);
      }
      const id = harnessAssetId(asset);
      // First writer of an id wins the scan. Repo winners are collected before
      // their sibling checkouts, so a file SHARED across checkouts is claimed by
      // the winning checkout here and the sibling's duplicate is skipped, while a
      // file unique to a sibling is still collected (its id is unclaimed).
      if (seenIds.has(id)) {
        const first = kept.get(id);
        if (first && first.contentHash !== asset.contentHash) {
          reportProblem({
            severity: "warning",
            path: asset.filePath,
            message: `differs from ${first.filePath}, the copy reported for this asset; not reported`,
          });
        } else if (first && first.wiring !== wiringOf(asset)) {
          reportProblem({
            severity: "warning",
            path: asset.filePath,
            message: "is wired again with a different command or config; only the first wiring is reported",
          });
        }
        return;
      }
      seenIds.add(id);
      kept.set(id, { filePath: asset.filePath, contentHash: asset.contentHash, wiring: wiringOf(asset) });
      sink(asset);
    },
  };
}
