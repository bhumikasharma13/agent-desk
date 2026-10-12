// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * Change-detection key for an external SQLite db: the main file's (mtime, size)
 * PLUS the `-wal` sidecar's. Under WAL mode a committed write lands in the
 * sidecar and need not touch the main file until checkpoint, so a key on the
 * main file alone would serve stale data indefinitely. Missing sidecar (not WAL
 * mode, or checkpointed away) contributes `0:0`. Returns null when the main
 * file itself is missing/unreadable — callers treat that as "no db".
 */
export function sqliteStatKey(dbPath: string): string | null {
  let main: ReturnType<typeof statSync>;
  try {
    main = statSync(dbPath);
  } catch {
    return null;
  }
  let wal = "0:0";
  try {
    const w = statSync(`${dbPath}-wal`);
    wal = `${Math.floor(w.mtimeMs)}:${w.size}`;
  } catch {
    // No -wal sidecar — the db is not in WAL mode or was checkpointed; normal.
  }
  return `${Math.floor(main.mtimeMs)}:${main.size}:${wal}`;
}

/** One prepared statement over a vendor database, returning plain row objects. */
export interface VendorStatement {
  get(...params: SqlParam[]): Record<string, unknown> | undefined;
  all(...params: SqlParam[]): Record<string, unknown>[];
}

/** A read-only connection to a vendor's SQLite file. */
export interface VendorDb {
  prepare(sql: string): VendorStatement;
  close(): void;
}

export type SqlParam = string | number | bigint | null | Uint8Array;

/**
 * Opens a vendor's SQLite file read-only on the built-in binding. A missing file
 * throws, as a read-only open cannot create one. `timeoutMs` is how long a read
 * waits on the vendor process's write lock before failing busy.
 *
 * Rows come back as ordinary objects with every BLOB as a `Buffer` and every
 * INTEGER as a `number`: the built-in binding returns null-prototype rows and
 * `Uint8Array` BLOBs, and throws on an integer beyond 2^53 unless it reads
 * bigints. Readers here decode BLOBs with `Buffer` methods (`toString("utf8")`
 * on a plain `Uint8Array` yields a comma-joined byte list, not text) and treat
 * integers as numbers, so an out-of-range integer degrades to the nearest
 * `number` rather than failing the read.
 */
export function openVendorDb(dbPath: string, timeoutMs: number): VendorDb {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: timeoutMs });
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        get: (...params) => {
          stmt.setReadBigInts(true);
          const row = stmt.get(...params);
          return row === undefined ? undefined : normalizeRow(row);
        },
        all: (...params) => {
          stmt.setReadBigInts(true);
          return stmt.all(...params).map(normalizeRow);
        },
      };
    },
    close: () => db.close(),
  };
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      typeof value === "bigint"
        ? Number(value)
        : value instanceof Uint8Array && !Buffer.isBuffer(value)
          ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
          : value;
  }
  return out;
}

/**
 * Lightweight read-only SQLite wrapper for accessing external databases
 * (e.g., Cursor's state.vscdb). Waits up to three seconds on a lock held by
 * the IDE process.
 */
export class SQLiteReader {
  private db: VendorDb | null = null;

  private readonly dbPath: string;
  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  open(): void {
    if (this.db) return;

    this.db = openVendorDb(this.dbPath, 3000);
  }

  // Parameters are validated by the binding when they are bound.
  query<T>(sql: string, params?: readonly unknown[]): T[] {
    this.ensureOpen();
    const stmt = this.db!.prepare(sql);
    return (params ? stmt.all(...(params as SqlParam[])) : stmt.all()) as T[];
  }

  queryOne<T>(sql: string, params?: readonly unknown[]): T | undefined {
    this.ensureOpen();
    const stmt = this.db!.prepare(sql);
    return (params ? stmt.get(...(params as SqlParam[])) : stmt.get()) as T | undefined;
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private ensureOpen(): void {
    if (!this.db) {
      throw new Error("SQLite database is not open. Call open() first.");
    }
  }
}
