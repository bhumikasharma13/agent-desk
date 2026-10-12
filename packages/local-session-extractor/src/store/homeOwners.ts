// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The owners of the homes a store's scans read, kept in its `meta` table so a
 * later export, in a process with no home root, still hashes their names.
 */
import { homeOwnerName } from "../redaction/anonymizer";
import type { SessionSink } from "../types/store";

/** A JSON list of owner names; the name only, never the home's path. */
export const SCANNED_HOME_OWNERS_KEY = "scanned_home_owners";

type MetaStore = Pick<SessionSink, "getMeta" | "setMeta">;

/** The recorded owner names; a missing or malformed value is none. */
export function readHomeOwners(store: Pick<SessionSink, "getMeta">): string[] {
  const raw = store.getMeta(SCANNED_HOME_OWNERS_KEY);
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string" && n.length > 0) : [];
  } catch {
    return [];
  }
}

/** Adds the owner of `home` when it is shaped like a home directory. */
export function recordHomeOwner(store: MetaStore, home: string): void {
  const name = homeOwnerName(home);
  if (name === undefined) return;
  const owners = readHomeOwners(store);
  if (owners.includes(name)) return;
  store.setMeta(SCANNED_HOME_OWNERS_KEY, JSON.stringify([...owners, name].sort()));
}
