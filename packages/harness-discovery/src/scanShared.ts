// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Agent-agnostic filesystem helpers for the per-agent asset readers
 * (claudeCode.ts, codex.ts, cursor.ts, kiro.ts), so every reader shares one
 * safe-fs and frontmatter toolkit. Pure node imports.
 */

import { readdir, stat, readFile, lstat, readlink, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, dirname, isAbsolute, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { currentContext, runInContext } from "./context";
import { findGitToplevel } from "./git";
import { log, reportProblem } from "./log";
import { lruSet } from "./lru";
import { stripTerminalEscapes } from "./sanitize";
import type { HarnessAssetFile, HarnessAssetScope } from "./types";

const COMPONENT = "scan";

const execFileP = promisify(execFile);

// ─── Frontmatter ─────────────────────────────────────────────────────────────

export interface ParsedFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  firstParagraph?: string;
  raw?: Record<string, string>;
}

/** A value wrapped in one matching quote pair loses the pair, with its escapes decoded (`''`
 *  in single quotes, `\"` and `\\` in double quotes); anything else is kept as is (`'a' or 'b'`
 *  is not one quoted value). */
const unquote = (s: string): string => {
  const m = s.match(/^(["'])(.*)\1$/s);
  if (!m) return s;
  if (m[1] === "'") return /(^|[^'])'(?!')/.test(m[2]!.replace(/''/g, "")) ? s : m[2]!.replace(/''/g, "'");
  return /(^|[^\\])"/.test(m[2]!.replace(/\\\\/g, "")) ? s : m[2]!.replace(/\\(["\\])/g, "$1");
};

/** A value loses a trailing YAML comment: after a quoted value (`"a: b" # note`), or after
 *  whitespace in a plain one (`a # note`, and a comment alone is an empty value). */
const dropComment = (s: string): string => {
  const m = s.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s+#/);
  if (m) return m[1]!;
  if (/^["']/.test(s)) return s;
  // The first `#` at the start or after whitespace, and that whitespace with it. Matching the
  // one character before it keeps this linear: `(^|\s+)#` would rescan a long run of spaces
  // from each of them.
  const at = s.search(/(?:^|\s)#/);
  return at === -1 ? s : s.slice(0, at).trimEnd();
};

/** A YAML block-scalar header: `|` or `>`, with an optional chomping and indent indicator. */
const BLOCK_SCALAR = /^[|>](?:[+-]?[1-9]?|[1-9][+-])$/;

/** `>` folding: lines of one paragraph join with a space; a blank line is a newline. */
function fold(lines: string[]): string {
  let out = "";
  for (const line of lines) {
    if (line === "") out += "\n";
    else out += (out === "" || out.endsWith("\n") ? "" : " ") + line;
  }
  return out;
}

/**
 * The top-level `key: value` pairs of a YAML block, in order. A `|` (literal) or `>`
 * (folded) block scalar takes the indented lines under its key. Not a YAML parser: nested
 * maps, lists and multi-line plain scalars are not read.
 */
function yamlEntries(yaml: string): Array<{ key: string; value: string; block: boolean }> {
  const lines = yaml.split("\n");
  const out: Array<{ key: string; value: string; block: boolean }> = [];
  for (let i = 0; i < lines.length; i++) {
    // The trim below drops the blanks after the colon. Matching them here too, as `[ \t]*(.*)`,
    // would split a long run of them every way before failing on a line separator.
    const m = lines[i]!.match(/^(\w[\w-]*):(.*)$/);
    if (!m) continue;
    const value = dropComment(m[2]!.trim());
    if (!BLOCK_SCALAR.test(value)) {
      if (value !== "") out.push({ key: m[1]!, value, block: false });
      continue;
    }
    const body: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1]!.trim() === "" || /^\s/.test(lines[i + 1]!))) {
      body.push(lines[++i]!.trimEnd());
    }
    while (body.length > 0 && body[body.length - 1] === "") body.pop();
    const indent = body.find((l) => l !== "")?.match(/^\s*/)?.[0].length ?? 0;
    const text = body.map((l) => l.slice(indent));
    out.push({ key: m[1]!, value: (value.startsWith(">") ? fold(text) : text.join("\n")).trim(), block: true });
  }
  return out;
}

/**
 * Parse simple YAML frontmatter from a markdown file: the block between a leading
 * `---` line and the next `---` line (LF or CRLF line endings), its `name`,
 * `description` and `version`, every top-level key in `raw`, and the first paragraph
 * after it.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  content = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = content.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?=\n|$)/);
  if (!match) return {};
  const entries = yamlEntries(match[1]!);
  const result: ParsedFrontmatter = {};

  const first = (key: string) => entries.find((e) => e.key === key);
  // Name and description lose terminal escapes here, and one left empty counts as absent,
  // so the file-name fallback applies. The session then escapes whatever else remains.
  const clean = (e: { value: string; block: boolean } | undefined) => {
    const v = e === undefined ? "" : stripTerminalEscapes(e.block ? e.value : unquote(e.value)).trim();
    return v === "" ? undefined : v;
  };
  const name = clean(first("name"));
  if (name !== undefined) result.name = name;
  const desc = clean(first("description"));
  if (desc !== undefined) result.description = desc;
  const version = first("version");
  if (version) result.version = version.block ? version.value : unquote(version.value);

  // Every top-level key; a later duplicate wins.
  const allFields: Record<string, string> = {};
  for (const e of entries) allFields[e.key] = e.block ? e.value : unquote(e.value);
  result.raw = allFields;

  // Extract first meaningful paragraph after the closing ---
  const afterFrontmatter = content.slice(match[0].length);
  const lines = afterFrontmatter.split("\n");
  const paragraphLines: string[] = [];
  let foundContent = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!foundContent) {
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      foundContent = true;
    }
    if (foundContent && trimmed === "") break;
    if (foundContent && trimmed.startsWith("#")) break;
    paragraphLines.push(trimmed);
  }
  if (paragraphLines.length > 0) {
    const paragraph = paragraphLines.join(" ");
    result.firstParagraph = paragraph.length > 300 ? paragraph.slice(0, 300) : paragraph;
  }

  return result;
}

/**
 * Pick the best available description from frontmatter.
 * Uses firstParagraph as fallback if description is empty or too short (< 20 chars).
 */
export function bestDescription(fm: ParsedFrontmatter): string | undefined {
  if (fm.description && fm.description.length >= 20) return fm.description;
  return fm.firstParagraph ?? fm.description;
}

/**
 * Convert a filename to a readable title-cased name.
 * Strips `.md`, replaces hyphens/underscores with spaces, title-cases each word.
 */
export function fileNameToDisplayName(fileName: string): string {
  return fileName
    .replace(/\.md$/i, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Confined, reported filesystem reads ─────────────────────────────────────

/**
 * Maximum size in bytes for any JSON/text file read across the asset-scan
 * trust boundary. A single exported constant so every reader rejects the same
 * multi-MB pattern.
 */
export const MAX_FILE_SIZE = 1024 * 1024; // 1MB

/**
 * Run `fn` with reads confined to HOME and `dirs` (each with its git top level), unless a
 * scan already set the confinement. Every collector entry point runs through here, so a
 * collector called on its own is confined the same way `scan()` confines it.
 */
export async function withReadRoots<T>(dirs: readonly string[], fn: () => Promise<T>): Promise<T> {
  if ((currentContext()?.readRoots.length ?? 0) > 0) return fn();
  // A collector called outside scan() is a scan of its own, so it gets fresh per-scan caches.
  resetGitBaselineCaches();
  const roots = new Set<string>();
  for (const dir of [homedir(), ...dirs]) {
    for (const p of [dir, findGitToplevel(dir)]) {
      if (p === undefined) continue;
      try {
        roots.add(realpathSync.native(p));
      } catch {
        // a root that does not exist confines nothing
      }
    }
  }
  return runInContext({ readRoots: [...roots] }, fn);
}

/**
 * Whether `path` may be read: its realpath is inside a read root. A path that resolves
 * elsewhere (a symlink out of HOME and the scanned repos) is reported and refused. A path
 * that does not resolve is allowed through, so the read itself fails and is reported.
 */
async function mayRead(path: string): Promise<boolean> {
  const roots = currentContext()?.readRoots ?? [];
  if (roots.length === 0) return true;
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return true;
  }
  if (roots.some((r) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep))) return true;
  reportProblem({ severity: "warning", path, message: "resolves outside HOME and the scanned repos; not read" });
  return false;
}

/** A read failure worth reporting: anything but "there is no such file". */
function reportUnreadable(path: string, err: unknown): void {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return;
  reportProblem({ severity: "warning", path, message: `unreadable (${code ?? String(err)}); not read` });
}

/** A file as the scan reads it: `text` (UTF-8) for parsing and names, and `hash`, the
 *  SHA-256 of its raw bytes, which is what an asset's `contentHash` reports. */
export interface FileBody {
  text: string;
  hash: string;
  /** Size in bytes. */
  size: number;
}

/**
 * Read a file, or null. Null without a report when the file does not exist or is not a
 * regular file; null with a warning when it is over MAX_FILE_SIZE, unreadable, or resolves
 * outside the read roots.
 */
export async function readBody(filePath: string): Promise<FileBody | null> {
  if (!(await mayRead(filePath))) return null;
  let s;
  try {
    s = await stat(filePath);
  } catch (err) {
    // A link whose target is gone was meant to be read, so it is reported, as listEntries does.
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && (await lstat(filePath).then(() => true, () => false))) {
      reportProblem({ severity: "warning", path: filePath, message: "symlink target unreadable (ENOENT); not read" });
    } else reportUnreadable(filePath, err);
    return null;
  }
  if (!s.isFile()) return null;
  if (s.size > MAX_FILE_SIZE) {
    reportProblem({ severity: "warning", path: filePath, message: `larger than ${MAX_FILE_SIZE} bytes; not read` });
    return null;
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(filePath);
  } catch (err) {
    reportUnreadable(filePath, err);
    return null;
  }
  return { text: bytes.toString("utf-8"), hash: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

/** A file's UTF-8 text, or null: {@link readBody} for callers that parse and do not hash. */
export async function safeReadFile(filePath: string): Promise<string | null> {
  return (await readBody(filePath))?.text ?? null;
}

/** A directory entry with symlinks already resolved to their target's kind. */
export interface DirEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

/**
 * The entries of a directory a reader walks. A symlinked entry stands for its target
 * (so a linked skill folder or rule file is read like a real one) when the target is
 * inside the read roots; a link that leaves them, or dangles, is reported and dropped.
 * Dot-named links are passed through unresolved, since every reader skips dot entries.
 */
async function listEntries(dirPath: string): Promise<DirEntry[]> {
  const out: DirEntry[] = [];
  // Sorted by code unit, so output order never depends on the order the filesystem lists in.
  const entries = (await readdir(dirPath, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (!entry.isSymbolicLink() || entry.name.startsWith(".")) {
      out.push(entry);
      continue;
    }
    const linkPath = join(dirPath, entry.name);
    if (!(await mayRead(linkPath))) continue;
    try {
      const target = await stat(linkPath);
      out.push({ name: entry.name, isFile: () => target.isFile(), isDirectory: () => target.isDirectory() });
    } catch (err) {
      reportProblem({
        severity: "warning",
        path: linkPath,
        message: `symlink target unreadable (${(err as NodeJS.ErrnoException).code ?? String(err)}); not read`,
      });
    }
  }
  return out;
}

/** List a directory's entries (see listEntries); [] when it is missing or unreadable (reported). */
export async function safeReaddir(dirPath: string): Promise<DirEntry[]> {
  if (!(await mayRead(dirPath))) return [];
  try {
    return await listEntries(dirPath);
  } catch (err) {
    reportUnreadable(dirPath, err);
    return [];
  }
}

/**
 * The entries of a scanned root, or null when the root cannot be listed. That is an
 * error, not a warning: the root's assets are unknown, so a caller mirroring the
 * inventory must not treat the root as scanned.
 */
export async function readRootEntries(root: string): Promise<DirEntry[] | null> {
  try {
    return await listEntries(root);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = code === "ENOENT" || code === "ENOTDIR" ? "not a directory" : `cannot read directory (${code ?? String(err)})`;
    reportProblem({ severity: "error", root, message });
    return null;
  }
}

export async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(dirPath);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(filePath: string): Promise<boolean> {
  try {
    const s = await stat(filePath);
    return s.isFile();
  } catch {
    return false;
  }
}

/** Parse `raw` as JSON; undefined, with a warning naming `path`, when it is not valid JSON. */
export function parseJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    reportProblem({ severity: "warning", path, message: "not valid JSON; skipped" });
    return undefined;
  }
}

/**
 * A JSON object file (read with the shared size cap), or null. Missing is silent; a file
 * that is not valid JSON, or whose root is not an object, is null with a warning.
 */
export async function loadJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  const raw = await safeReadFile(filePath);
  if (raw === null) return null;
  const parsed = parseJson(raw, filePath);
  if (parsed === undefined) return null;
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  reportProblem({ severity: "warning", path: filePath, message: "not a JSON object; skipped" });
  return null;
}

// A grouping directory is walked for the manifest with these bounds. They exist so a
// skill directory someone parked a build output or a node_modules in cannot turn one
// artifact into an unbounded read — the manifest is a description of a definition, and a
// definition that large is not one.
const MANIFEST_MAX_FILES = 50;
const MANIFEST_MAX_DEPTH = 3;
const MANIFEST_MAX_BYTES = 256 * 1024;

/**
 * The file manifest of a DIRECTORY artifact: its primary plus every helper beside it,
 * relative to the grouping directory.
 *
 * Returns [] when the directory holds nothing but the primary — a single-file artifact's
 * primary IS the whole install, so a one-entry manifest would carry no information the
 * artifact's own content hash does not.
 *
 * Only the directory FORM gets one. A flat `skills/foo.md` is grouped by the shared
 * `skills/` directory, whose other entries are OTHER skills — building a manifest there
 * would fold every sibling skill into each one's definition.
 */
export async function collectArtifactManifest(
  groupingDir: string,
  primaryAbsPath: string,
): Promise<HarnessAssetFile[]> {
  const out: HarnessAssetFile[] = [];

  let truncated = false;
  const primary = await readBody(primaryAbsPath);

  // Real paths: a link inside the folder that points back into it must not list files twice,
  // and the primary must not come back as a helper through such a link.
  const realOf = (p: string): string => {
    try {
      return realpathSync.native(p);
    } catch {
      return p;
    }
  };
  const groupReal = realOf(groupingDir);
  const primaryReal = realOf(primaryAbsPath);
  // Breadth-first, so a folder reached both directly and through a deeper link is walked at
  // its shallower depth. A link to the skill folder or above it would fold in other skills.
  // Note: the listing is bounded by depth only; stop it at the file cap if a skill folder
  // with a huge flat directory ever shows up.
  const walked = new Set<string>([groupReal]);
  const helpers: string[] = [];
  let level = [groupingDir];
  for (let depth = 1; level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      for (const entry of await safeReaddir(dir)) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          const real = realOf(abs);
          if (walked.has(real) || groupReal.startsWith(real + sep)) continue;
          if (depth >= MANIFEST_MAX_DEPTH) {
            truncated = true;
            continue;
          }
          walked.add(real);
          next.push(abs);
        } else if (entry.isFile() && abs !== primaryAbsPath && realOf(abs) !== primaryReal) {
          helpers.push(abs);
        }
      }
    }
    level = next;
  }

  if (primary !== null && primary.size > MANIFEST_MAX_BYTES) {
    // Only worth saying when there are helper files to leave out.
    if (helpers.length > 0) {
      reportProblem({
        severity: "warning",
        path: primaryAbsPath,
        message: `larger than ${MANIFEST_MAX_BYTES} bytes, so its folder's helper files are not listed`,
      });
    }
    return [];
  }
  // The primary is added FIRST, before the cap can be reached, so on a skill large enough to
  // hit the cap truncation degrades to "fewer helpers", not to a manifest with no anchor.
  if (primary !== null) {
    out.push({
      relativePath: relative(groupingDir, primaryAbsPath),
      contentHash: primary.hash,
      absPath: primaryAbsPath,
      isPrimary: true,
    });
  }
  const byPath = helpers.map((abs) => ({ abs, rel: relative(groupingDir, abs) })).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const { abs, rel } of byPath) {
    if (out.length >= MANIFEST_MAX_FILES) {
      truncated = true;
      break;
    }
    const body = await readBody(abs);
    if (body === null) continue;
    if (body.size > MANIFEST_MAX_BYTES) {
      truncated = true;
      continue;
    }
    out.push({ relativePath: rel, contentHash: body.hash, absPath: abs, isPrimary: false });
  }
  if (truncated) {
    reportProblem({
      severity: "warning",
      path: groupingDir,
      message: `helper files listed only up to ${MANIFEST_MAX_FILES} files including SKILL.md, ${MANIFEST_MAX_DEPTH} directory levels and ${MANIFEST_MAX_BYTES} bytes each; the rest are left out`,
    });
  }

  // A manifest has exactly one primary. When the primary is unreadable or oversized, report
  // no manifest rather than a set of helpers with no anchor.
  if (out.length <= 1 || out.filter((f) => f.isPrimary).length !== 1) return [];
  return out;
}

/**
 * Walk a skills directory and invoke `pushSkill` for each SKILL.md found.
 * Handles three layouts: a flat `<name>.md`, a `<name>/SKILL.md` dir, and a
 * grouped `<group>/<name>/SKILL.md`. Agent-agnostic — the caller decides how
 * to record each skill (scope, ide, payload). Shared by every tool's reader.
 */
export async function walkSkillsDir(
  skillsDir: string,
  pushSkill: (
    skillKey: string,
    filePath: string,
    body: FileBody,
    files?: HarnessAssetFile[],
  ) => Promise<void>,
): Promise<void> {
  for (const entry of await safeReaddir(skillsDir)) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = join(skillsDir, entry.name);

    if (entry.isFile() && entry.name.endsWith(".md")) {
      const body = await readBody(entryPath);
      if (body !== null) await pushSkill(entry.name.replace(/\.md$/, ""), entryPath, body);
    } else if (entry.isDirectory()) {
      const skillMdPath = join(entryPath, "SKILL.md");
      // A folder holding a SKILL.md is a skill, even when that file cannot be read (too large,
      // unreadable, linked out, dangling): it is dropped with its warning, never read as a
      // group. A directory named SKILL.md is not that file.
      if (await lstat(skillMdPath).then((st) => !st.isDirectory(), () => false)) {
        const body = await readBody(skillMdPath);
        if (body !== null) await pushSkill(entry.name, skillMdPath, body, await collectArtifactManifest(entryPath, skillMdPath));
      } else {
        // level 2: grouped skills
        for (const subEntry of await safeReaddir(entryPath)) {
          if (subEntry.name.startsWith(".") || !subEntry.isDirectory()) continue;
          const subSkillMdPath = join(entryPath, subEntry.name, "SKILL.md");
          const subBody = await readBody(subSkillMdPath);
          if (subBody !== null) {
            await pushSkill(
              subEntry.name,
              subSkillMdPath,
              subBody,
              await collectArtifactManifest(join(entryPath, subEntry.name), subSkillMdPath),
            );
          }
        }
      }
    }
  }
}

// ─── Git context (per-project, cached per collect run) ──────────────────────

export interface GitContext {
  isRepo: boolean;
  /** Absolute repo root ('' when not a repo). Assets key on this, not the scanned dir. */
  topLevel: string;
  /** Credential-stripped remote origin URL ('' when none). */
  remoteUrl: string;
  /**
   * Git ref the committed baseline is read from — the remote-tracking default
   * branch (e.g. `origin/master`) when a remote exists, else the local default
   * branch for remote-less repos. `''` when undeterminable.
   */
  defaultBranch: string;
  /** Toplevel-relative paths of tracked files, NFC. Empty set when not a repo. */
  tracked: Set<string>;
  /** git listed the repo's files, so `tracked` is the real set, not empty from a failure. */
  listed: boolean;
  /** `tracked` keyed by lower case: the spellings git tracks for each path. */
  trackedByLower: Map<string, string[]>;
  /** The repo has commits but no default-branch ref resolves. */
  noDefaultBranch?: boolean;
}

/** Whether a toplevel-relative path is tracked, whatever Unicode form it is spelled in. */
export function isTracked(git: GitContext, rel: string): boolean {
  return git.tracked.has(rel.normalize("NFC"));
}

const NOT_A_REPO: GitContext = { isRepo: false, topLevel: "", remoteUrl: "", defaultBranch: "", tracked: new Set(), listed: false, trackedByLower: new Map() };

/**
 * A scanned root's git context, as every reader uses it. A root inside a repo whose top
 * level is the home directory (a dotfiles repo) is scanned as a plain folder, with a
 * warning: HOME's own config is the user scope, never a repo's. A repo with commits but no
 * default branch is reported too, since all its files then read as repo-local.
 */
export async function rootGitContext(root: string, quiet = false): Promise<GitContext> {
  const git = await readGitContext(root);
  if (!git.isRepo) return git;
  if (samePathCanonical(git.topLevel, homedir())) {
    if (!quiet) reportProblem({
      severity: "warning",
      root,
      message: "is inside a git repo whose top level is the home directory; scanned as a plain folder",
    });
    return NOT_A_REPO;
  }
  if (git.noDefaultBranch) {
    reportProblem({
      severity: "warning",
      root: git.topLevel,
      message: "no default branch (tried origin/HEAD, origin/main, origin/master, main, master); its files are reported as repo-local",
    });
  }
  return git;
}

/**
 * Strip credentials from a git remote so they never appear in the scan result: a URL's
 * user info, and an http(s) or ftp URL's query string and fragment (`https://token@host/...`,
 * `...?token=...`), and the password of an scp-style remote (`user:secret@host:path`). An
 * scp-style login name alone (`git@host:path`) is the SSH user, not a secret, and stays. In
 * an ssh:// or file:// URL a `#` or `?` is part of the path, so it stays.
 *
 * Mangling beats leaking, so some remotes come out mangled: an invalid URL with an `@` in its
 * path loses everything before it (`https://h.com:99999/o/r@v2.git` -> `https://v2.git`), and
 * an scp-style remote whose password holds a `/` or a second `:` is left as it is
 * (`user:pa/ss@h:o/r`, `h.com:o/r@x:y`); git reads the part before the `:` as the host.
 */
export function stripRemoteCredentials(remote: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    // A password holding an unencoded `#` or `?` would end the URL early and leave part of it.
    // Any `#` or `?` before the first `@` gives the same match, so the first one is taken: trying
    // each of a long run of them would rescan the rest of the run from every one.
    remote = remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@?#]*[?#][^/]*@/i, "$1");
    const web = /^(?:https?|ftp):/i.test(remote);
    try {
      const url = new URL(remote);
      url.username = "";
      url.password = "";
      if (web) {
        url.search = "";
        url.hash = "";
      }
      return url.toString();
    } catch {
      // Not a valid URL (a bad port, say): drop a web URL's query or fragment, then everything
      // up to the last `@`, even past a `/` (a password may hold one).
      return (web ? remote.replace(/[?#].*$/s, "") : remote).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^?#]*@/i, "$1");
    }
  }
  // scp-style `user:secret@host:path`: drop the user and password, up to the last `@`.
  return remote.replace(/^[^@/:]+:[^/]*@([^@:/]+:)/, "$1");
}

// git gets the caller's environment less its GIT_* variables: a scan started from a git hook
// inherits GIT_DIR, GIT_INDEX_FILE and the hook's `-c` config, which would point git at another
// repo, index or config than the one scanned. The three that only choose which config files
// git reads stay, as HOME does. git never prompts. No command run here refreshes the index; one
// that does, such as `status`, would also need `--no-optional-locks`.
const KEPT_GIT_VARS = new Set(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM"]);
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("GIT_") || KEPT_GIT_VARS.has(k)) env[k] = v;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

// Tri-state git result: stdout on success; null when git RAN and exited
// nonzero (a definitive "no" — path not in tree, bad ref); undefined on a
// SPAWN-LEVEL failure (binary missing, timeout/kill, signal) — a transient
// verdict nothing may cache. Nonzero exits carry a numeric `code` on the
// execFile error; spawn failures carry a string code (ENOENT) or a signal.
async function defaultGit(cwd: string, args: string[]): Promise<string | null | undefined> {
  try {
    // A scanned repo's own config must not run commands: `core.fsmonitor` names a program git
    // executes on every index read (`ls-files`), and a repo is scanned without being trusted.
    const { stdout } = await execFileP("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd,
      env: gitEnv(),
      timeout: 10_000,
      // A large repo's `ls-files` list runs past 8 MiB (45,000 long paths, say).
      maxBuffer: (args[0] === "ls-files" ? 512 : 8) * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    return typeof (err as { code?: unknown }).code === "number" ? null : undefined;
  }
}

// Indirection so a test can count/observe git spawns (the caches below promise
// "no git process on an unchanged repo", which is only verifiable by watching
// the runner). Production always uses defaultGit.
type GitRunner = (cwd: string, args: string[]) => Promise<string | null | undefined>;
let gitImpl: GitRunner = defaultGit;
export function __setGitRunnerForTest(runner: GitRunner | null): void {
  gitImpl = runner ?? defaultGit;
}
/** The general-purpose runner: every failure (clean or transient) is null.
 *  Callers that must not cache a transient verdict use gitImpl's tri-state. */
async function git(cwd: string, args: string[]): Promise<string | null> {
  return (await gitImpl(cwd, args)) ?? null;
}

// ── Git-context / drift-baseline caches ──────────────────────────────────────
//
// The collectors call readGitContext + baselineContentHash per project / per
// committed asset on every scan, which would mean thousands of git processes on a machine with many repos.
// Each cache is keyed on a ground-truth git-state fingerprint (the mtimes of
// the repo's index / HEAD / packed-refs / config), so a hit is only served when
// the tracked set, branch state, refs, and remote/config are all unchanged; the
// moment any of them moves, the fingerprint moves and the cache re-derives.

/** mtimes of the git-state paths that gate every cached field: index (tracked
 *  set), HEAD (current branch), packed-refs (ref tips), config (remote url /
 *  branch config), the loose origin/HEAD ref (feeds defaultBranch — a
 *  default-branch rename moves only this file), and the refs/heads +
 *  refs/remotes/origin DIRECTORIES — a loose-ref create/delete (e.g. `git
 *  fetch --prune` after a remote rename) updates only the containing dir's
 *  mtime, none of the files. A missing path → 0. */
const GIT_STATE_PATHS = [
  "index",
  "HEAD",
  "packed-refs",
  "config",
  "refs/remotes/origin/HEAD",
  "refs/remotes/origin",
  "refs/heads",
] as const;

/** null when `.git` is not a directory (a worktree/submodule `.git` FILE has
 *  none of the watched paths, so nothing would ever invalidate a cached entry)
 *  — callers treat null as uncacheable. */
function gitStateFingerprint(topLevel: string): string | null {
  const gitDir = join(topLevel, ".git");
  try {
    if (!statSync(gitDir).isDirectory()) return null;
  } catch {
    return null;
  }
  return GIT_STATE_PATHS.map((f) => {
    try {
      return statSync(join(gitDir, f)).mtimeMs;
    } catch {
      return 0;
    }
  }).join(":");
}

// isRepo:true contexts only — a non-repo dir has no .git to fingerprint and can
// turn into a repo (`git init`) without any file we watch appearing, so those
// are never cached (they re-run the cheap single-spawn resolve on each scan).
const gitContextCache = new Map<string, { fingerprint: string; ctx: GitContext }>();
const MAX_GIT_CONTEXT = 512;

/** Symlink-resolved path equality; an unresolvable side (ENOENT) is never equal. */
function samePathCanonical(a: string, b: string): boolean {
  try {
    // native: the on-disk spelling, so two cases of one path on a case-insensitive disk match.
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return false;
  }
}

/**
 * Resolve a project's git context: remote (credential-stripped), default
 * branch (never a hardcoded origin/master — fails on main/develop repos), and
 * the tracked-file set that splits repo-committed from repo-local scope.
 * Everything degrades to a non-repo context on any git failure.
 */
/**
 * True when `dir` is a linked git worktree — its `.git` is a regular FILE
 * (`gitdir: …`), not a directory. Worktrees mirror the main checkout's config
 * (CLAUDE.md, .claude/rules, …), so the harness readers skip them to avoid
 * counting the same assets once per worktree.
 */
export async function isGitWorktree(dir: string): Promise<boolean> {
  try {
    const s = await stat(`${dir}/.git`);
    return s.isFile();
  } catch {
    return false;
  }
}

export async function readGitContext(projectPath: string): Promise<GitContext> {
  const none: GitContext = {
    isRepo: false,
    topLevel: "",
    remoteUrl: "",
    defaultBranch: "",
    tracked: new Set(),
    listed: false,
    trackedByLower: new Map(),
  };

  // Cache hit: the cached context's repo state (index/HEAD/refs/config) is
  // unchanged, so every field it holds still stands — return it without a single
  // git spawn. `tracked` is treated as immutable (no caller mutates it).
  // The fingerprint proves the CACHED repo is unchanged, not that projectPath
  // still points AT it: a symlinked project dir repointed to another repo
  // leaves the old target's git state untouched. So a hit also re-resolves
  // projectPath's current toplevel with the non-spawning fs walk and compares
  // CANONICALIZED paths — rev-parse resolves symlinks while the walk may not,
  // so a raw comparison would spuriously miss every stable symlinked project.
  // A gone toplevel (.git deleted, realpath ENOENT) is a miss.
  const cached = gitContextCache.get(projectPath);
  if (cached && gitStateFingerprint(cached.ctx.topLevel) === cached.fingerprint) {
    const currentTop = findGitToplevel(projectPath);
    if (currentTop !== undefined && samePathCanonical(currentTop, cached.ctx.topLevel)) {
      return cached.ctx;
    }
  }

  // Repo identity (root + remote) must not depend on the `git` binary — a
  // process started without git on PATH, or a failed `git
  // rev-parse` would collapse a repo subdirectory or a worktree
  // to its own cwd as a phantom standalone project. Fall back to a filesystem
  // resolve that mirrors `rev-parse --show-toplevel`; drift metadata
  // (defaultBranch/tracked) still degrades to empty when git is unavailable.
  const top = await git(projectPath, ["rev-parse", "--show-toplevel"]);
  const topLevel = top?.trim() || (findGitToplevel(projectPath) ?? "");
  if (!topLevel) return none;

  // Fingerprint BEFORE the remote/branch/ls-files reads, not at the cache write:
  // a git mutation (commit/add/checkout) landing DURING those multi-spawn reads
  // must guarantee a mismatch on the next scan. A post-read fingerprint would stamp
  // the post-mutation state onto data read pre-mutation, masking the change
  // until some later unrelated git operation (TOCTOU).
  const fingerprint = gitStateFingerprint(topLevel);

  // Any spawn-level git failure below makes the context uncacheable: the
  // degraded value moves no watched git file, so nothing would ever evict it.
  let transientGitFailure = false;

  // The first url is the one git fetches from; an include could point anywhere on disk.
  const remoteGit = await gitImpl(topLevel, ["config", "--local", "--no-includes", "--get-all", "remote.origin.url"]);
  if (remoteGit === undefined) transientGitFailure = true;
  const remoteRaw = remoteGit?.split("\n")[0] ?? "";
  const remoteUrl = stripRemoteCredentials(remoteRaw.trim());

  // Baseline ref: the remote-tracking default branch (e.g. origin/master), so
  // drift is measured against what's published — NOT the local branch of the
  // same name, which is stale for anyone working off feature branches and
  // yields a false drift. Prefer origin/HEAD (keeping the origin/ prefix),
  // then remote-tracking refs, then local branches for repos with no remote.
  // Every candidate is verified with rev-parse and the first that resolves
  // wins: origin/HEAD is only a pointer and can dangle (e.g. a remote
  // default-branch rename followed by a local prune leaves it pointing at a
  // pruned ref), so an unresolvable one falls through rather than being used
  // blindly and reading an empty baseline.
  // Branch resolution runs on the tri-state runner: a transient spawn failure
  // on the symref read or ANY candidate verify can land an empty — or worse, a
  // wrong-fallback — defaultBranch. Such a context is returned degraded but
  // marked uncacheable below.
  let defaultBranch = "";
  const headRefRaw = await gitImpl(topLevel, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"]);
  if (headRefRaw === undefined) transientGitFailure = true;
  for (const candidate of [headRefRaw?.trim(), "origin/main", "origin/master", "main", "master"]) {
    if (!candidate) continue;
    const verified = await gitImpl(topLevel, ["rev-parse", "--verify", "--quiet", candidate]);
    if (verified === undefined) transientGitFailure = true;
    if (verified !== undefined && verified !== null) {
      defaultBranch = candidate;
      break;
    }
  }

  const lsFiles = await git(topLevel, ["ls-files", "-z"]);
  if (lsFiles === null) {
    // git is missing, refuses the repo (ownership, a corrupt index) or failed: every file
    // would read as repo-local, so the result must say why.
    reportProblem({
      severity: "warning",
      root: topLevel,
      message: "git could not read this repository; its files are reported as repo-local",
    });
  }
  // NFC, like every lookup (isTracked): macOS may spell a name NFD on disk and NFC in git.
  const tracked = new Set<string>(
    (lsFiles ?? "").split("\0").filter((p) => p.length > 0).map((p) => p.normalize("NFC")),
  );

  // A repo with commits but none of the default-branch refs reads every file as repo-local.
  const noDefaultBranch =
    defaultBranch === "" && (await gitImpl(topLevel, ["rev-parse", "--verify", "--quiet", "HEAD"])) != null;
  const trackedByLower = new Map<string, string[]>();
  for (const p of tracked) {
    const key = p.toLowerCase();
    trackedByLower.set(key, [...(trackedByLower.get(key) ?? []), p]);
  }
  const ctx: GitContext = { isRepo: true, topLevel, remoteUrl, defaultBranch, tracked, listed: lsFiles !== null, trackedByLower, noDefaultBranch };
  // Uncacheable cases (the stored fingerprint is the PRE-READ capture above):
  //  - null fingerprint: `.git` is not a directory here (a worktree/submodule
  //    `.git` FILE) — no watched path exists to move, so a cached entry would
  //    be served forever.
  //  - lsFiles === null: `git ls-files` failed (a legit empty repo returns "").
  //    The empty `tracked` is a degraded value the fingerprint cannot see (a
  //    failure moves no git file), so caching it would serve it indefinitely;
  //    returning it uncached retries on the next scan.
  //  - transientGitFailure: the remote read or branch resolution saw a
  //    spawn-level failure, so remoteUrl/defaultBranch may be degraded with
  //    nothing watched to evict them.
  if (fingerprint !== null && lsFiles !== null && !transientGitFailure) {
    lruSet(gitContextCache, projectPath, { fingerprint, ctx }, MAX_GIT_CONTEXT);
  }
  return ctx;
}

/**
 * The repo-relative path whose committed blob is the drift baseline for
 * `relPath`: itself, or — when it is a symlink — the link's in-repo target.
 * Null when this repo holds no baseline for it, which degrades the asset to
 * repo-local rather than inventing a deviation. A null is never cached, so a
 * retryable read failure resolves on a later scan.
 *
 * A symlink's committed blob holds its TARGET PATH, never a file body, while
 * working-copy reads follow the link — so baselining a symlink against its own
 * path compares a body against a filename and marks it deviated forever. The
 * chain is walked with `readlink`, so no file body outside the repo is read;
 * `lstat` still resolves intermediate directory components, so a repo whose
 * subdirectory is itself a link out of the checkout can be stat'd outside it.
 */
async function baselineRelPath(projectPath: string, relPath: string): Promise<string | null> {
  // The repo root in both the form the caller passed and its canonical form: a
  // checkout reached through a symlinked parent yields one, an absolute link
  // target the other, and a lexical compare against a single form would read
  // the second as escaping the repo. Only the ROOT is canonicalized — never a
  // link target, which is what would traverse outside.
  const roots = [projectPath];
  try {
    const real = realpathSync(projectPath);
    if (real !== projectPath) roots.push(real);
  } catch {
    // Unreadable root: the caller's form is all we have to compare against.
  }

  let rel = relPath;
  for (let hop = 0; hop < MAX_LINK_LOOKUPS; hop++) {
    const abs = join(projectPath, rel);
    let link;
    try {
      link = await lstat(abs);
    } catch (err) {
      // Misreading a symlink as a regular file baselines against link text, so
      // only a definitive errno may fall through to the path itself.
      if (definitiveLinkError(err)) return hop === 0 ? rel : null;
      return linkUnreadable(projectPath, relPath, rel, hop, err);
    }
    // A directory (or any non-file) has no body to compare: `git show ref:dir`
    // succeeds and prints a TREE LISTING, which would hash as a baseline no
    // working copy can ever equal.
    if (!link.isSymbolicLink()) return link.isFile() ? rel : null;

    let target;
    try {
      target = await readlink(abs);
    } catch (err) {
      if (definitiveLinkError(err)) return null;
      return linkUnreadable(projectPath, relPath, rel, hop, err);
    }
    // Purely lexical: no syscall ever resolves a path outside the repo.
    const targetAbs = resolve(dirname(abs), target);
    const next = roots.map((root) => relative(root, targetAbs)).find(inRepo);
    // Outside the repo: no committed blob here can be its baseline. (An
    // absolute target in neither root form reads as outside — such a link is
    // machine-specific and already broken on every other checkout, so the
    // asset degrades to repo-local rather than claiming a deviation.)
    if (next === undefined) return null;
    rel = next;
  }
  // Out of lookups: `rel` is still a symlink, so returning it would baseline
  // against link text. A symlink loop exhausts the bound the same way.
  log().warn("baseline_link_chain_unresolved", {
    component: COMPONENT,
    projectPath,
    relPath,
    lookups: MAX_LINK_LOOKUPS,
  });
  return null;
}

/** A path that cannot resolve no matter how often it is retried, as opposed to
 *  a retryable one (EACCES, EMFILE, EIO) — the split that decides whether the
 *  path itself may stand as the baseline or the asset degrades for this scan. */
function definitiveLinkError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "ENAMETOOLONG";
}

/** Retryable link-read failure: no baseline for this scan, never cached, so the
 *  next scan retries. Warns once per path per scan — an EMFILE/EACCES regime
 *  hits every asset of every repo. */
function linkUnreadable(
  projectPath: string,
  relPath: string,
  at: string,
  hop: number,
  err: unknown,
): null {
  const key = `${projectPath}\0${relPath}\0${at}`;
  if (!warnedLinks.has(key)) {
    lruSet(warnedLinks, key, true, MAX_WARNED_LINKS);
    log().warn("baseline_link_unreadable", {
      component: COMPONENT,
      projectPath, // which checkout — `CLAUDE.md` alone repeats across every repo
      relPath,
      at, // the hop that failed; differs from relPath only mid-chain
      hop,
      code: (err as NodeJS.ErrnoException).code ?? String(err),
    });
  }
  return null;
}

/** A `path.relative()` result that stays inside the repo. */
function inRepo(rel: string): boolean {
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * A tracked file's committed body at the default-branch ref (`defaultBranch`,
 * typically `origin/main`) — the drift baseline for repo-committed assets.
 * Null when unavailable (no ref, file not on it, git failure). Its SHA-256 is
 * what {@link baselineContentHash} reports.
 */
export async function baselineContent(
  projectPath: string,
  defaultBranch: string,
  relPath: string,
): Promise<string | null> {
  if (!defaultBranch) return null;
  const rel = await baselineRelPath(projectPath, relPath);
  if (rel === null) return null;
  return (await showAtRef(projectPath, defaultBranch, rel))?.toString("utf-8") ?? null;
}

/** The blob at `<defaultBranch>:<rel>`, as raw bytes (tri-state like defaultGit), so a
 *  baseline hashes the same bytes a working-tree read does. Takes an ALREADY-resolved
 *  baseline path so one resolution backs both a cached hash and the body it hashes. */
async function showAtRef(
  projectPath: string,
  defaultBranch: string,
  rel: string,
): Promise<Buffer | null | undefined> {
  try {
    const { stdout } = await execFileP("git", ["-c", "core.fsmonitor=false", "show", `${defaultBranch}:${rel}`], {
      cwd: projectPath,
      env: gitEnv(),
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "buffer",
    });
    return stdout;
  } catch (err) {
    return typeof (err as { code?: unknown }).code === "number" ? null : undefined;
  }
}

// Default-branch tip SHA, memoized per (topLevel, ref) for the current scan:
// a fetch can advance the default branch without touching any local file we
// could fingerprint, so the tip is re-resolved once per repo per scan (reset
// at collector start) rather than gated on git state. One rev-parse per repo
// per scan instead of per asset.
const tipShaCache = new Map<string, string | null>();

// Baseline hash keyed on (topLevel, relPath, tip). Kept across scans: an
// unchanged tip means an unchanged committed baseline, so the `git show` never
// re-runs. LRU-bounded (repos × committed assets).
const baselineHashCache = new Map<string, string | null>();
const MAX_BASELINE_HASH = 2048;
// A resolved baseline path is deliberately NOT memoized: the module caches live
// as long as the process, so a memo would serve a repointed link's old target
// for as long as the process runs. One lstat per lookup is the cheaper half of
// that trade.
/** Link lookups per baseline resolution: the walk's bound. */
export const MAX_LINK_LOOKUPS = 8;
const warnedLinks = new Map<string, boolean>();
const MAX_WARNED_LINKS = 256;

/**
 * Reset the per-scan git baseline memoization. Called at the start of each scan() and of
 * each collector call made outside one (withReadRoots): the tip SHA and each checkout's git dir are
 * re-derived once per repo per scan (catching a fetched-but-not-checked-out
 * advance, and healing a transiently-failed or later-`git init`ed git-dir
 * resolve), while the tip-keyed hash cache is left intact so an unchanged tip
 * still costs zero `git show`.
 */
export function resetGitBaselineCaches(): void {
  tipShaCache.clear();
  gitDirCache.clear();
  committedLinkCache.clear();
  // Per scan, so a link that keeps failing is reported again on the next scan rather
  // than silenced for the life of the process.
  warnedLinks.clear();
}

async function resolveTipSha(topLevel: string, defaultBranch: string): Promise<string | null> {
  const key = `${topLevel}\0${defaultBranch}`;
  const hit = tipShaCache.get(key);
  if (hit !== undefined) return hit;
  const raw = await gitImpl(topLevel, ["rev-parse", "--verify", "--quiet", defaultBranch]);
  // Transient spawn failure: "no tip" this call, never memoized — a cached
  // transient verdict would null every asset's baseline for the whole scan.
  // A definitive answer (SHA, or a clean no-such-ref null) IS cached per scan.
  if (raw === undefined) return null;
  const tip = raw?.trim() || null;
  tipShaCache.set(key, tip);
  return tip;
}

/** SHA256 of {@link baselineContent}; null when the body is unavailable.
 *  Resolves the default-branch tip once per repo per scan and caches the hash
 *  by that tip, so an unchanged tip spawns no `git show`. */
export async function baselineContentHash(
  projectPath: string,
  defaultBranch: string,
  relPath: string,
): Promise<string | null> {
  if (!defaultBranch) return null;
  const tip = await resolveTipSha(projectPath, defaultBranch);
  if (tip === null) return null;
  // Keyed on the RESOLVED baseline path, not the caller's, and hashed from that
  // same resolution: a symlink repointed mid-scan would otherwise store the new
  // target's body under the old target's key, and the entry outlives the scan.
  const baselineRel = await baselineRelPath(projectPath, relPath);
  if (baselineRel === null) return null;
  const key = `${projectPath}\0${baselineRel}\0${tip}`;
  const hit = baselineHashCache.get(key);
  if (hit !== undefined) return hit;
  const body = await showAtRef(projectPath, defaultBranch, baselineRel);
  // Transient spawn failure: degrade to "no baseline for this scan" WITHOUT
  // caching, so the next call retries. A clean git "no" (null — path not on
  // the ref, the common repo-local case) IS cached per tip: it stays true
  // until the tip moves, and re-asking would reintroduce the per-asset spawn.
  if (body === undefined) return null;
  const hash = body === null ? null : createHash("sha256").update(body).digest("hex");
  lruSet(baselineHashCache, key, hash, MAX_BASELINE_HASH);
  return hash;
}

/**
 * A repo file's scope. repo-committed ⇔ the file is tracked and has a body on the default
 * branch, whose hash is the baseline: drift from the default branch is underivable without
 * one. A tracked file with no default-branch body (added on a feature branch, or no default
 * branch resolvable) is repo-local until it lands there; so is everything outside a git repo.
 */
export async function resolveScope(
  git: GitContext,
  filePath: string,
): Promise<{ scope: HarnessAssetScope; baseline?: string }> {
  if (!git.isRepo) return { scope: "repo-local" };
  const rel = trackedRel(git, filePath) ?? (await trackedPathThroughDirLink(git, relative(git.topLevel, filePath)));
  if (rel !== null) {
    const baseline = await baselineContentHash(git.topLevel, git.defaultBranch, rel);
    if (baseline !== null) return { scope: "repo-committed", baseline };
  }
  return { scope: "repo-local" };
}

/**
 * A file's tracked path, disk first: its spelling on disk when git tracks that, else the one
 * tracked path that differs from it only in letter case and opens the same file (`claude.md`
 * renamed to `CLAUDE.md` on a case-insensitive disk only); else null. When git tracks several
 * case variants, the one on disk wins, so the baseline is the file the disk holds.
 */
function trackedRel(git: GitContext, filePath: string): string | null {
  const asked = relative(git.topLevel, filePath);
  let disk = asked;
  try {
    const real = relative(git.topLevel, realpathSync.native(filePath));
    if (real.toLowerCase() === asked.toLowerCase()) disk = real;
  } catch {
    // A missing file keeps the spelling it was asked by.
  }
  if (isTracked(git, disk)) return disk;
  const variants = (git.trackedByLower.get(disk.normalize("NFC").toLowerCase()) ?? []).filter((v) =>
    samePathCanonical(join(git.topLevel, v), filePath),
  );
  return variants.length === 1 ? variants[0]! : null;
}

/**
 * A file reached through a committed directory link (`.agents/skills -> ../.claude/skills`) is
 * in git's file list only at the link's target. That path decides its scope when the link is
 * tracked, is on the default branch with the same target, and points inside the repo; else
 * null. Only tracked prefixes are looked at, so an ordinary untracked file costs no syscall,
 * and each link's committed target is read once per scan.
 */
async function trackedPathThroughDirLink(git: GitContext, rel: string): Promise<string | null> {
  for (let hop = 0; hop < MAX_LINK_LOOKUPS; hop++) {
    const parts = rel.split(sep);
    let next: string | null = null;
    for (let i = 1; i < parts.length && next === null; i++) {
      const linkRel = parts.slice(0, i).join(sep);
      if (!isTracked(git, linkRel)) continue;
      const abs = join(git.topLevel, linkRel);
      let target: string;
      try {
        if (!(await lstat(abs)).isSymbolicLink()) return null;
        target = await readlink(abs);
      } catch {
        return null;
      }
      if ((await committedLinkTarget(git, linkRel)) !== target) return null;
      // Purely lexical, as in baselineRelPath: a link out of the repo is never followed.
      const targetRel = relative(git.topLevel, resolve(dirname(abs), target));
      if (!inRepo(targetRel)) return null;
      next = join(targetRel, ...parts.slice(i));
    }
    if (next === null) return null;
    if (isTracked(git, next)) return next;
    rel = next;
  }
  return null;
}

/** A link's target text on the default branch, or null when the default branch has no link
 *  (mode 120000) there; memoized per scan. */
async function committedLinkTarget(git: GitContext, linkRel: string): Promise<string | null> {
  if (!git.defaultBranch) return null;
  const key = `${git.topLevel}\0${git.defaultBranch}\0${linkRel}`;
  const hit = committedLinkCache.get(key);
  if (hit !== undefined) return hit;
  const entry = await gitImpl(git.topLevel, ["ls-tree", "-z", git.defaultBranch, "--", linkRel]);
  if (entry === undefined) return null; // a transient failure is not memoized
  const body = entry?.startsWith("120000 ") ? await showAtRef(git.topLevel, git.defaultBranch, linkRel) : null;
  if (body === undefined) return null;
  const text = body === null ? null : body.toString("utf-8");
  lruSet(committedLinkCache, key, text, MAX_COMMITTED_LINKS);
  return text;
}
const committedLinkCache = new Map<string, string | null>();
const MAX_COMMITTED_LINKS = 256;

/** Untracked, not ignored paths under a repo's top level that match `pathspecs` (NFC). One
 *  `git ls-files --others` call; null when git fails. */
export async function untrackedPaths(topLevel: string, pathspecs: string[]): Promise<string[] | null> {
  const out = await git(topLevel, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspecs]);
  return out === null ? null : out.split("\0").filter((p) => p.length > 0).map((p) => p.normalize("NFC"));
}

/**
 * How recently a checkout was worked in: mtime of its git index (touched by
 * checkout/add/commit/status), falling back to the git dir, then the project
 * dir itself. Recency picks ONE owner when two checkouts of the same repo
 * hold the same asset identity.
 */
// Memoize the (spawning) git-dir rev-parse per scan (cleared in
// resetGitBaselineCaches, so a transient failure or a later `git init` heals
// on the next scan) and re-stat fresh each call — recency itself is an mtime that
// must stay live.
const gitDirCache = new Map<string, string | null>();
const MAX_GIT_DIR = 512;

export async function projectRecency(projectPath: string): Promise<number> {
  let gitDir = gitDirCache.get(projectPath);
  if (gitDir === undefined) {
    gitDir = (await git(projectPath, ["rev-parse", "--absolute-git-dir"]))?.trim() ?? null;
    lruSet(gitDirCache, projectPath, gitDir, MAX_GIT_DIR);
  }
  const candidates = gitDir ? [join(gitDir, "index"), gitDir, projectPath] : [projectPath];
  for (const p of candidates) {
    try {
      return (await stat(p)).mtimeMs;
    } catch {
      // try the next candidate
    }
  }
  return 0;
}

/** One scanned checkout, for cross-checkout winner selection. */
export interface OwnershipCandidate {
  /** Credential-stripped remote URL; '' when the checkout has no remote. */
  remoteUrl: string;
  /** git topLevel for a repo, or the scanned dir for a non-repo. */
  projectKey: string;
}

/**
 * The winning checkout per repo remote — the source of truth for files a repo's
 * checkouts SHARE. Two checkouts of one remote holding the same asset file
 * produce the same harnessAssetId at different project paths, and a scan reports
 * each id once, so a shared file must resolve to one checkout. The winner is the
 * latest-active **in-scope** checkout: prefer a checkout the caller's `inScope`
 * accepts (so a shared file is not attributed to a checkout the caller ignores),
 * then most recently active (git-index mtime), then the lexicographically-first
 * key, so repeated scans pick the same winner. A checkout with no remote is always
 * its own winner.
 *
 * The caller collects winners FIRST, then the rest: a non-winning checkout still
 * contributes files unique to it (its ids are unclaimed), but a shared file is
 * already claimed by the winner and skipped — so no checkout is dropped
 * wholesale, and a shared file's owner is fixed before any asset is pushed,
 * independent of scan order.
 */
export async function resolveRepoWinners(
  candidates: OwnershipCandidate[],
  inScope: (projectKey: string) => boolean,
  recencyOf: (projectKey: string) => Promise<number> = projectRecency,
): Promise<Set<string>> {
  const winners = new Set<string>();
  const byRemote = new Map<string, Set<string>>();
  for (const c of candidates) {
    if (c.remoteUrl === "") {
      winners.add(c.projectKey);
      continue;
    }
    const keys = byRemote.get(c.remoteUrl) ?? new Set<string>();
    keys.add(c.projectKey);
    byRemote.set(c.remoteUrl, keys);
  }
  for (const keys of byRemote.values()) {
    const sorted = [...keys].sort();
    let winner = sorted[0]!;
    let winIn = inScope(winner);
    let winRec = await recencyOf(winner);
    for (const key of sorted.slice(1)) {
      const keyIn = inScope(key);
      const keyRec = await recencyOf(key);
      // In-scope beats out-of-scope; among the same scope-status, more recent
      // wins; the sorted order keeps the first key on a recency tie.
      if ((keyIn && !winIn) || (keyIn === winIn && keyRec > winRec)) {
        winner = key;
        winIn = keyIn;
        winRec = keyRec;
      }
    }
    winners.add(winner);
  }
  return winners;
}

/** Whether two paths are the same file on disk, whatever their spelling (case, links). */
export function samePath(a: string, b: string): boolean {
  return a === b || samePathCanonical(a, b);
}

/**
 * Roots as the disk spells them (`realpath.native`), as scan() canonicalises its own: a root
 * typed in another case or Unicode form then matches git's paths and the read roots. A root
 * that does not resolve is kept as given.
 */
export function canonicalRoots<T extends { path: string }>(roots: readonly T[]): T[] {
  return roots.map((r) => {
    try {
      return { ...r, path: realpathSync.native(r.path) };
    } catch {
      return r;
    }
  });
}

/** One directory canonicalised as {@link canonicalRoots} does. */
export function canonicalDir(dir: string): string {
  return canonicalRoots([{ path: dir }])[0]!.path;
}
