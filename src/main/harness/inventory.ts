// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * The Harness page's inventory: the last `harness-discovery` scan, kept as JSON
 * in userData, and its mapping to the page's shapes.
 *
 * The extraction worker writes the stored scan after each cycle; the main
 * process reads it on demand (no live filesystem scan on page open). The plugin
 * list and the summary counts are derived here.
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isPathWithinBase } from "../permissions/pathWithin";
import type { ScanProblem, ScanResult, ScannedAsset } from "harness-discovery";
import {
  defaultHarnessInventory,
  type HarnessAsset,
  type HarnessAssetType,
  type HarnessInventory,
  type HarnessPlugin,
} from "../../shared/harnessTypes";

/** One stored scan: the library's result plus when it was taken. */
export interface StoredScan {
  scannedAt: string;
  result: ScanResult;
}

/**
 * Writes the stored scan atomically (temp file + rename), readable by the
 * owner only, so a reader never sees a half-written file.
 */
export function writeStoredScan(path: string, scan: StoredScan): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(scan), { mode: 0o600 });
  renameSync(tmp, path);
}

/** A scan that failed after the stored scan was taken: when, and why. */
export interface ScanFailure {
  at: string;
  message: string;
}

/** Where a failed scan is recorded: beside the stored scan, removed by the next good scan. */
export function scanFailurePath(inventoryPath: string): string {
  return inventoryPath.replace(/\.json$/, "") + "-failure.json";
}

/** Records a failed scan beside the stored scan, which stays as it was. */
export function writeScanFailure(inventoryPath: string, failure: ScanFailure): void {
  writeFileSync(scanFailurePath(inventoryPath), JSON.stringify(failure), { mode: 0o600 });
}

/** Clears the failure record after a good scan. */
export function clearScanFailure(inventoryPath: string): void {
  rmSync(scanFailurePath(inventoryPath), { force: true });
}

/** The recorded failure, or null when the last scan succeeded or none ran. An unreadable record reads as null. */
export function readScanFailure(inventoryPath: string): ScanFailure | null {
  try {
    const parsed = JSON.parse(readFileSync(scanFailurePath(inventoryPath), "utf-8")) as ScanFailure;
    return typeof parsed?.at === "string" && typeof parsed?.message === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The Harness page's inventory from the files on disk. A stored scan that cannot
 * be read shows as an error, never as an empty inventory.
 */
export function readInventory(inventoryPath: string, collecting: boolean): HarnessInventory {
  try {
    const inventory = toInventory(readStoredScan(inventoryPath));
    inventory.collecting = collecting;
    inventory.lastScanFailure = readScanFailure(inventoryPath);
    return inventory;
  } catch (err) {
    const inventory = defaultHarnessInventory();
    inventory.status = "error";
    inventory.lastError = err instanceof Error ? err.message : String(err);
    return inventory;
  }
}

/** Reads the stored scan; null when no scan has been stored yet. Throws on an unreadable or corrupt file. */
export function readStoredScan(path: string): StoredScan | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as StoredScan;
  if (typeof parsed?.scannedAt !== "string" || !Array.isArray(parsed?.result?.assets)) {
    throw new Error("the stored harness scan is not in the expected format");
  }
  return parsed;
}

function toAsset(a: ScannedAsset, scannedAt: string): HarnessAsset {
  const p = a.payload;
  return {
    id: a.id,
    ideType: a.ideType,
    name: a.name,
    type: a.type,
    scope: a.scope,
    source: p.source,
    filePath: a.filePath,
    sourcePath: a.sourcePath,
    contentHash: a.contentHash,
    operationalState: p.operational_state,
    lastSeenAt: scannedAt,
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.version !== undefined ? { version: p.version } : {}),
    ...(p.plugin_name !== undefined ? { pluginName: p.plugin_name } : {}),
    ...(p.marketplace !== undefined ? { marketplace: p.marketplace } : {}),
    ...(a.projectPath !== "" ? { projectPath: a.projectPath } : {}),
    ...(p.baseline_content_hash !== undefined ? { baselineContentHash: p.baseline_content_hash } : {}),
    activeInAgents: p.active_in_agents ?? [],
    ...(p.invocation !== undefined ? { invocation: p.invocation } : {}),
    ...(p.source_url !== undefined ? { sourceUrl: p.source_url } : {}),
    ...(p.inline_body !== undefined ? { inlineBody: p.inline_body } : {}),
    ...(p.hook_config !== undefined ? { hookConfig: p.hook_config } : {}),
    ...(p.files !== undefined ? { files: p.files } : {}),
  };
}

function toPlugin(a: ScannedAsset): HarnessPlugin {
  const p = a.payload;
  return {
    id: a.name,
    name: a.name,
    marketplace: p.marketplace ?? "unknown",
    ...(p.source_url !== undefined ? { sourceUrl: p.source_url } : {}),
    version: p.version ?? "unknown",
    installPath: p.plugin_install_path ?? a.filePath,
    enabled: p.operational_state === "enabled",
    assetCounts: p.plugin_asset_counts ?? { skills: 0, commands: 0, rules: 0, hooks: 0, agents: 0 },
  };
}

// Code-unit order, so the listing does not shift with the machine's locale.
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function problemText(p: ScanProblem): string {
  const where = p.path ?? p.root ?? p.ide;
  return where ? `${where}: ${p.message}` : p.message;
}

/** The page's inventory from a stored scan (null: nothing scanned yet). */
export function toInventory(stored: StoredScan | null): HarnessInventory {
  const inventory = defaultHarnessInventory();
  if (!stored) return inventory;
  const byTypeThenName = (x: ScannedAsset, y: ScannedAsset): number =>
    byteOrder(x.type, y.type) || byteOrder(x.name, y.name);
  const scanned = [...stored.result.assets].sort(byTypeThenName);
  const assets = mergeCrossAgentDuplicates(scanned.map((a) => toAsset(a, stored.scannedAt)));
  inventory.assets = assets;
  inventory.plugins = scanned
    .filter((a) => a.type === "plugin")
    .sort((x, y) => byteOrder(x.name, y.name))
    .map(toPlugin);
  inventory.lastScannedAt = stored.scannedAt;
  inventory.warnings = stored.result.warnings.map(problemText);
  inventory.errors = stored.result.errors.map(problemText);
  inventory.summary.totalAssets = assets.length;
  for (const asset of assets) {
    inventory.summary.byType[asset.type] = (inventory.summary.byType[asset.type] ?? 0) + 1;
    inventory.summary.byScope[asset.scope] = (inventory.summary.byScope[asset.scope] ?? 0) + 1;
  }
  return inventory;
}

/**
 * Every file the detail view may read: the stored scan's file paths, minus
 * inline hooks (their `filePath` is the enclosing settings file, which may hold
 * unrelated config; only their command is shown), and minus anything inside a
 * protected folder the user has not granted now (`skipRoots`), whatever the
 * stored scan once listed.
 */
export function viewableFilePaths(stored: StoredScan | null, skipRoots: readonly string[] = []): string[] {
  if (!stored) return [];
  const paths = new Set<string>();
  for (const a of stored.result.assets) {
    if (a.filePath === "" || a.payload.inline_body !== undefined) continue;
    if (skipRoots.some((root) => isPathWithinBase(a.filePath, root))) continue;
    paths.add(a.filePath);
  }
  return [...paths];
}

/**
 * Where a viewable file may lead once its links are followed: the home folder and
 * every repo the stored scan read, the same bounds harness-discovery keeps at scan
 * time. A listed file swapped for a link out of these after the scan is not opened.
 */
export function viewableRoots(stored: StoredScan | null, home: string = homedir()): string[] {
  const roots = new Set<string>([home]);
  for (const a of stored?.result.assets ?? []) {
    if (a.projectPath) roots.add(a.projectPath);
  }
  return [...roots];
}

// Only AGENTS club across IDEs by logical name. A subagent's name is a stable,
// unique identity, and the SAME agent is legitimately authored per-IDE
// (.claude/agents/foo.md + .codex/agents/foo.toml → one row, both chips). Every
// other type keeps the full physical key, because they collide by display name
// across DISTINCT installs and merging them would drop a real artifact: two
// plugins' `/deploy` command; two skills sharing a display name but invoked as
// `/review` vs `/refactor`; two hooks sharing an event+script basename in
// different dirs; and AGENTS.md/CLAUDE.md repeated at different depths. (A
// byte-identical file read by two IDEs still clubs via the physical key.)
const CROSS_IDE_CLUBBABLE: ReadonlySet<HarnessAssetType> = new Set(["agent"]);

/**
 * Collapse the SAME logical artifact surfaced by multiple agents into one
 * display row, stacking the agent icons. An `agent` clubs on its logical
 * identity (type + name + scope + project + plugin), so the same agent authored
 * per-IDE (`.claude/agents/foo.md` + `.codex/agents/foo.toml`) is one row with a
 * chip per surfacing IDE. Every other type keeps the full physical key (path +
 * hash), so distinct same-named artifacts (see CROSS_IDE_CLUBBABLE) stay separate
 * and only a byte-identical read by two IDEs clubs. The survivor keeps the first
 * row's fields (its file backs the row's "View"); a different repo/scope/plugin
 * always stays separate.
 */
export function mergeCrossAgentDuplicates(assets: HarnessAsset[]): HarnessAsset[] {
  const byKey = new Map<string, HarnessAsset>();
  const out: HarnessAsset[] = [];
  for (const a of assets) {
    // A row without a real file (defensive) can't prove physical identity.
    if (a.filePath === "") {
      out.push(a);
      continue;
    }
    const base = `${a.type}\0${a.name}\0${a.scope}\0${a.projectPath ?? ""}\0${a.pluginName ?? ""}\0${a.marketplace ?? ""}`;
    const key = CROSS_IDE_CLUBBABLE.has(a.type) ? base : `${base}\0${a.filePath}\0${a.contentHash}`;
    const existing = byKey.get(key);
    if (!existing) {
      // Copy so the union below never mutates the caller's row.
      const merged = { ...a, activeInAgents: [...a.activeInAgents] };
      byKey.set(key, merged);
      out.push(merged);
      continue;
    }
    for (const agent of a.activeInAgents) {
      if (!existing.activeInAgents.includes(agent)) existing.activeInAgents.push(agent);
    }
  }
  return out;
}
