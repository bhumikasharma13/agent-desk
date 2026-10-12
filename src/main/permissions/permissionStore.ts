// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * PermissionStore
 *
 * Remembers which protected folders have had a decision (granted, or declined at
 * the end of the re-probing), so the primer does not ask for them again. Persisted
 * at <userData>/permission-grants.json as the folder keys and the app version that
 * wrote them; a record from another version, or one that cannot be read, is
 * cleared and rewritten at launch.
 *
 * Synchronous fs is intentional: the store is tiny (at most one entry per
 * protected folder) and sync writes keep the handler simple.
 */

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { ProtectedFolderKey } from "../../shared/permissionTypes";
import { isProtectedFolderKey } from "./protectedFolders";
import { logger } from "../logging/logger";

const STORE_FILENAME = "permission-grants.json";

interface StoreShape {
  asked: ProtectedFolderKey[];
  /** The app version that wrote the record. */
  version?: string;
}

export class PermissionStore {
  private static instance: PermissionStore;
  private filePath: string;
  private version: string;
  private asked: Set<ProtectedFolderKey>;

  private constructor() {
    this.filePath = path.join(app.getPath("userData"), STORE_FILENAME);
    this.version = app.getVersion();
    this.asked = this.readFromDisk();
  }

  static getInstance(): PermissionStore {
    if (!PermissionStore.instance) PermissionStore.instance = new PermissionStore();
    return PermissionStore.instance;
  }

  isAsked(key: ProtectedFolderKey): boolean {
    return this.asked.has(key);
  }

  markAsked(key: ProtectedFolderKey): void {
    if (this.asked.has(key)) return;
    this.asked.add(key);
    this.persist();
  }

  private readFromDisk(): Set<ProtectedFolderKey> {
    const out = new Set<ProtectedFolderKey>();
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf-8");
    } catch {
      return out; // no record yet: start empty, nothing written
    }
    let record: Partial<StoreShape> | null = null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) record = parsed as Partial<StoreShape>;
    } catch {
      record = null; // corrupt
    }
    // Only a record from this version is kept. One from another version is forgotten, so the
    // primer explains again before macOS asks: an ad hoc signature changes with every release,
    // and macOS may not carry the earlier answers over. A corrupt one is forgotten too. Either
    // way the file is rewritten for this version.
    if (record && Array.isArray(record.asked) && record.version === this.version) {
      // Guard each key against the known set so a hand-edited file can't inject unknown keys.
      for (const k of record.asked) {
        if (isProtectedFolderKey(k)) out.add(k);
      }
      return out;
    }
    if (Array.isArray(record?.asked) && record.asked.length > 0) {
      logger.info("permissions", "folder_access_record_cleared", { from: String(record.version ?? "none"), to: this.version });
    }
    this.asked = out;
    this.persist();
    return out;
  }

  private persist(): void {
    const data: StoreShape = { asked: Array.from(this.asked), version: this.version };
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err: unknown) {
      logger.warn("permissions", "store_persist_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Test-only: reset singleton. Do NOT call from production code.
  static __resetForTests(): void {
    PermissionStore.instance = undefined as unknown as PermissionStore;
  }
}
