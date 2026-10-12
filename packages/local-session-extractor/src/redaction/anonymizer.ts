// Portions copyright (c) 2025 Banodoco (Dataclaw, MIT); see NOTICE.
// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Path anonymization & username hashing.
 *
 * Replaces the real OS username in file paths and free text with a
 * deterministic hash so the same user always maps to the same token
 * across sessions, but the real identity is never stored or exported.
 */

import { createHash } from "node:crypto";
import { userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { homeRootOverride } from "../extractors/pathResolver";

// ── Username detection ───────────────────────────────────────────────────────

let _username: string;
let _usernameHash: string;

try {
  _username = userInfo().username;
} catch {
  // Fallback — shouldn't happen on macOS/Linux but guard anyway.
  _username = "";
}

/** Deterministic hash: "user_" + first 8 hex chars of SHA-256. */
export function hashUsername(username: string): string {
  const hash = createHash("sha256").update(username).digest("hex");
  return "user_" + hash.substring(0, 8);
}

// Pre-compute for the current OS user.
_usernameHash = _username ? hashUsername(_username) : "";

// ── Whose names are hashed ───────────────────────────────────────────────────

interface Identity {
  name: string;
  hash: string;
  /** Whether a bare mention of the name in free text is hashed too. */
  bare: boolean;
}

/**
 * Account names that are also ordinary words or tool names (`node` in
 * "Node.js"). The running user with one of these names is hashed in paths and
 * encoded paths only, never as a bare word.
 */
const GENERIC_ACCOUNT_NAMES: ReadonlySet<string> = new Set([
  "root", "node", "user", "admin", "runner", "ubuntu", "ec2-user", "vagrant", "docker", "nobody",
]);

const ownerHashes = new Map<string, string>();

function cachedHash(name: string): string {
  let hash = ownerHashes.get(name);
  if (hash === undefined) {
    hash = hashUsername(name);
    ownerHashes.set(name, hash);
  }
  return hash;
}

/**
 * The owner's name of a root shaped like a home directory (`…/Users/<name>`
 * or `…/home/<name>`), or undefined for any other root.
 */
export function homeOwnerName(root: string): string | undefined {
  const trimmed = root.replace(/\/+$/, "");
  const parent = basename(dirname(trimmed));
  if (parent !== "Users" && parent !== "home") return undefined;
  return basename(trimmed) || undefined;
}

/**
 * The owner of the scan's home root, when that root is shaped like a home
 * directory: a scan of another home reads that person's paths, which carry
 * their name rather than the running user's. Only their path segments are
 * hashed: a home's last segment can be an ordinary word (`/home/test`), and
 * hashing it in prose would rewrite the prompts.
 */
function scannedHomeIdentity(): (Identity & { root: string }) | undefined {
  const root = homeRootOverride()?.replace(/\/+$/, "");
  if (!root) return undefined;
  const name = homeOwnerName(root);
  if (!name || name === _username) return undefined;
  return { name, hash: cachedHash(name), bare: false, root };
}

/** Owners of homes scanned earlier, hashed in paths inside {@link withHomeOwners}. */
let extraOwners: readonly string[] = [];

/**
 * Runs `fn` with `owners` hashed in path segments and encoded paths, as a
 * scanned home's owner is during that scan: an export in a later process
 * redacts the names a `--home` scan recorded in the store.
 */
export function withHomeOwners<T>(owners: readonly string[], fn: () => T): T {
  const previous = extraOwners;
  extraOwners = owners;
  try {
    return fn();
  } finally {
    extraOwners = previous;
  }
}

/**
 * Replaces the running user's name for a test; returns the restore. Tests use
 * it so an identity's shape does not depend on the machine's real username.
 */
export function setRunningUsernameForTests(name: string): () => void {
  const previous = _username;
  _username = name;
  _usernameHash = name ? hashUsername(name) : "";
  return () => {
    _username = previous;
    _usernameHash = previous ? hashUsername(previous) : "";
  };
}

/** The running user, the scanned home's owner, then earlier scans' owners, each once. */
function identities(): Identity[] {
  const out: Identity[] = [];
  if (_username) out.push({ name: _username, hash: _usernameHash, bare: !GENERIC_ACCOUNT_NAMES.has(_username.toLowerCase()) });
  const scanned = scannedHomeIdentity();
  if (scanned) out.push(scanned);
  for (const name of extraOwners) {
    if (name && !out.some((id) => id.name === name)) out.push({ name, hash: cachedHash(name), bare: false });
  }
  return out;
}

// ── Path anonymization ───────────────────────────────────────────────────────

/**
 * Anonymizes an absolute file path by replacing the real username with
 * its hash. Handles both macOS (`/Users/<user>/`) and Linux (`/home/<user>/`)
 * path prefixes, for the running user and for the owner of a scanned home
 * root, and any path under that root wherever the root itself lives. A home
 * encoded into a later segment (`…/projects/-Users-<user>-repo/…`) is hashed too.
 *
 * Examples:
 *   /Users/jdoe/projects/foo  →  /Users/user_<hash>/projects/foo
 *   /home/jdoe/.config/bar    →  /home/user_<hash>/.config/bar
 */
export function anonymizePath(path: string): string {
  let out = path;
  const scanned = scannedHomeIdentity();
  if (scanned && (out === scanned.root || out.startsWith(`${scanned.root}/`))) {
    out = join(dirname(scanned.root), scanned.hash) + out.substring(scanned.root.length);
  }
  const ids = identities();
  for (const { name, hash } of ids) out = hashSlashHome(out, name, hash);
  for (const { name, hash } of ids) out = out.replace(dashEncodedHome(dashForms(name)), (_m, prefix: string) => prefix + hash);
  return out;
}

/**
 * The spellings of `name` inside a dash-encoded path: Claude Code maps every
 * character outside `[A-Za-z0-9]` to `-` (`first.last` → `first-last`), and the
 * name as written is kept for a tool that encodes only the separators.
 */
function dashForms(name: string): string[] {
  const encoded = name.replace(/[^A-Za-z0-9]/g, "-");
  return encoded === name ? [name] : [encoded, name];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The name where it ends its segment: before a dash, a `/`, `::`, the end of the
 * text or any other character that cannot continue an encoded name. `_` counts
 * as continuing, so a name is never matched inside its own `user_…` hash.
 */
const NAME_END = "(?![A-Za-z0-9_])";

/**
 * A home directory encoded into a single path segment, as the tools name their
 * per-project dirs: Claude Code `-Users-<name>-src-…`, Cursor `Users-<name>-src-…`
 * (and the `home` forms), or a Claude Code session id `-Users-<name>::<uuid>`.
 * These are single path segments, which the slash rule cannot see, so the rewrite never reaches
 * them. Anchored at a segment or dash boundary before and {@link NAME_END} after,
 * so `Users-<name>` inside an unrelated word, or a longer name, is left alone.
 */
function dashEncodedHome(forms: readonly string[]): RegExp {
  return new RegExp(`(?<=^|[-/])((?:Users|home)-)(?:${forms.map(escapeRegExp).join("|")})${NAME_END}`, "g");
}

/**
 * Inverse of `anonymizePath` — swaps the hashed username in the home segment,
 * and in any dash-encoded home segment below it, back to the real one, using
 * this machine's own username/hash. Local-only: it reconstructs a real, on-disk
 * path from a path redacted on this machine (e.g. `conversations.project_path`,
 * stored redacted) so a local consumer can stat/scan it. A
 * path not under this machine's home, or hashed by a different machine, is
 * returned unchanged.
 */
export function deanonymizePath(path: string): string {
  if (!_username) return path;

  const forwardPatterns = [
    `/Users/${_usernameHash}/`,
    `/home/${_usernameHash}/`,
  ];
  const exactPatterns = [
    `/Users/${_usernameHash}`,
    `/home/${_usernameHash}`,
  ];
  let out = path;
  let rewritten = false;
  for (const prefix of forwardPatterns) {
    if (out.startsWith(prefix)) {
      out = prefix.replace(_usernameHash, _username) + out.substring(prefix.length);
      rewritten = true;
      break;
    }
  }
  if (!rewritten) {
    for (const exact of exactPatterns) {
      if (out === exact) return exact.replace(_usernameHash, _username);
    }
  }
  // Claude Code's encoding is the one restored: it is the form the tools write.
  return out.replace(dashEncodedHome([_usernameHash]), (_m, prefix: string) => prefix + dashForms(_username)[0]!);
}

// ── Text anonymization ───────────────────────────────────────────────────────

/**
 * `/Users/<name>` or `/home/<name>` anywhere in the text, where the name ends its
 * path segment. A separator may be written `/`, URL-encoded as `%2F`, or
 * double-encoded as `%252F`. A
 * character that can continue an account name (`[A-Za-z0-9_-]`, or a `.`
 * followed by one) means a different, longer name, which is left alone. On macOS
 * the file system ignores letter case, so the match does too.
 */
function slashHome(name: string): RegExp {
  const sep = "(/|%2[Ff]|%252[Ff])";
  const flags = process.platform === "darwin" ? "gi" : "g";
  return new RegExp(`${sep}(Users|home)${sep}${escapeRegExp(name)}(?![A-Za-z0-9_-])(?!\\.[A-Za-z0-9_-])`, flags);
}

/** {@link slashHome} with the name replaced by `hash`, the separators kept. */
function hashSlashHome(text: string, name: string, hash: string): string {
  return text.replace(slashHome(name), (_m, before: string, base: string, after: string) => `${before}${base}${after}${hash}`);
}

/**
 * Replaces all occurrences of the real username in free text:
 *
 * 1. Forward-slash paths: `/Users/<user>` → `/Users/<hash>`, followed by `/`, the
 *    end of the text, or any character that cannot continue the name
 * 2. Hyphen-encoded paths (Claude Code project dirs and session ids):
 *    `-Users-<user>-` and `-Users-<user>::` → `-Users-<hash>…`, with the name
 *    in its encoded form (every character outside `[A-Za-z0-9]` a dash)
 * 3. Bare username mentions (only if username is ≥ 4 chars to avoid false positives),
 *    for the running user only, and not for a generic account name; a scanned
 *    home's owner is hashed in paths alone
 */
export function anonymizeText(text: string): string {
  if (text.length === 0) return text;

  let result = text;
  for (const { name, hash, bare } of identities()) {
    // 1. Forward-slash home dir paths, wherever the name ends its segment: before
    // a `/`, at the end of the text, or before whitespace, a quote or punctuation.
    result = hashSlashHome(result, name, hash);

    // 2. Hyphen-encoded paths (Claude Code encodes every non-alphanumeric as - in project dir names)
    const forms = dashForms(name).map(escapeRegExp).join("|");
    // Claude Code writes `-Users-<name>`, Cursor `Users-<name>` after a `/`.
    result = result.replace(new RegExp(`(?<=^|[-/])(Users|home)-(?:${forms})${NAME_END}`, "g"), (_m, base: string) => `${base}-${hash}`);

    // 3. Bare username in text (only for usernames ≥ 4 chars to reduce false positives),
    // matched as a whole word in any case. A literal `\n`, `\t` or `\r` escape before
    // it counts as a boundary: captured command output stores newlines that way.
    if (bare && name.length >= 4) {
      const escaped = escapeRegExp(name);
      // Unicode letter and digit lookarounds, so a non-ASCII name has word edges too.
      const bareRe = new RegExp(`(?:(?<=\\\\[ntr])|(?<![\\p{L}\\p{N}_]))${escaped}(?![\\p{L}\\p{N}_])`, "giu");
      result = result.replace(bareRe, hash);
    }
  }

  return result;
}
