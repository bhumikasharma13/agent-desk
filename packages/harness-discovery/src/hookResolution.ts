// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Agent-agnostic hook-command resolution, shared by the Claude, Codex and Cursor
 * asset readers (cross-cutting hook logic lives here, like hookAssetName.ts, so no
 * reader imports another). A hook manifest entry — Claude's settings.json or
 * Cursor's hooks.json — carries a shell `command`; these helpers turn that command
 * into either the script file it runs (reported like any asset) or, when it names
 * no in-scope script, an inline body.
 *
 * Pure fs / string only (no network).
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, basename, relative, resolve, isAbsolute, sep } from "node:path";
import { realpathSync } from "node:fs";
import { readBody } from "./scanShared";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

// Interpreter/wrapper tokens to skip when finding the script in a hook command
// (`bash foo.sh`, `/usr/bin/env python x.py`); the real artifact is the script.
export const HOOK_INTERPRETERS = new Set([
  "sh", "bash", "zsh", "dash", "env", "node", "nodejs", "deno", "bun",
  "python", "python3", "ruby", "perl", "pwsh", "powershell",
]);

/**
 * Expand the vars a hook command realistically uses: `$CLAUDE_PROJECT_DIR`
 * (the repo root Claude Code injects), a leading `~`, and plain `$VAR`/`${VAR}`
 * from the environment. Best-effort — an unset var expands to '' so the path
 * simply fails to resolve (→ treated as inline) rather than throwing. Cursor
 * commands are plain relative paths, so this is a no-op for them.
 */
export function expandHookVars(token: string, projectDir: string): string {
  let t = token.replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, projectDir);
  if (t === "~" || t.startsWith("~/")) t = join(homedir(), t.slice(1));
  t = t.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name: string) => process.env[name] ?? "");
  return t;
}

/**
 * Split a command into shell words, honoring single/double quotes so a script
 * path with spaces (`bash "My Scripts/hook.sh"`) stays one token. Adjacent
 * quoted and unquoted runs with no whitespace between them form ONE word, as a
 * shell joins them — so `"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh` is a single
 * path token (which then expands and resolves to the real file), not a quote
 * fragment plus a bogus `/.claude/...` that resolves to nothing. Quotes
 * are stripped; their contents, spaces included, stay in the word. Not a full
 * shell parser — just enough to find the script argument robustly.
 */
export function tokenizeCommand(cmd: string): string[] {
  return tokenSpans(cmd).map((t) => t.word);
}

/** {@link tokenizeCommand}, with the offset just past each word in `cmd`. */
function tokenSpans(cmd: string): Array<{ word: string; end: number }> {
  const out: Array<{ word: string; end: number }> = [];
  let word = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  let i = 0;
  for (const ch of cmd) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch; // a quote opens a word even when its content is empty (`""`)
      inWord = true;
    } else if (/\s/.test(ch)) {
      if (inWord) out.push({ word, end: i });
      word = "";
      inWord = false;
    } else {
      word += ch;
      inWord = true;
    }
    i += ch.length;
  }
  if (inWord) {
    // An unterminated quote is a malformed command; the real shell would error.
    // Best-effort: don't let the unclosed run swallow the whitespace that should
    // still separate tokens, so the caller can find a path arg past it.
    if (quote !== null) for (const w of word.split(/\s+/)) { if (w) out.push({ word: w, end: cmd.length }); }
    else out.push({ word, end: cmd.length });
  }
  return out;
}

/** Path-shaped candidate tokens in a hook command, expanded against `projectDir`,
 *  in order — the tokens that COULD be the script (skipping leading `FOO=1`
 *  env-assignments, flags, and interpreter wrappers). Pure (no fs). The single
 *  source of "which token looks like a script", shared by resolveHookScript /
 *  resolveHookScriptPath / commandNamesAScript so the file-backed-vs-inline
 *  decision has one definition. */
export function scriptCandidateTokens(command: string, projectDir: string): string[] {
  return scriptCandidates(command, projectDir).map((c) => c.expanded);
}

/** {@link scriptCandidateTokens} with each candidate's position among the command's tokens. */
function scriptCandidates(command: string, projectDir: string): Array<{ expanded: string; end: number }> {
  const out: Array<{ expanded: string; end: number }> = [];
  const cmd = command.trim();
  if (!cmd) return out;
  let leadingPrefix = true;
  for (const { word: tok, end } of tokenSpans(cmd)) {
    if (!tok) continue;
    if (leadingPrefix && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue; // env-assignment
    leadingPrefix = false;
    if (tok.startsWith("-")) continue; // flag
    if (HOOK_INTERPRETERS.has(basename(tok).toLowerCase())) continue; // wrapper
    const expanded = expandHookVars(tok, projectDir);
    if (expanded && (expanded.includes("/") || /\.(sh|zsh|bash|js|ts|py|rb|pl|mjs|cjs)$/i.test(expanded))) out.push({ expanded, end });
  }
  return out;
}

/**
 * The absolute, symlink-resolved path of the script a hook `command` runs, IF it
 * resolves to a real file INSIDE `scopeRoot` — else null (inline one-liner, or a
 * script that is missing / outside the scope). SYNCHRONOUS, so a caller outside
 * the async scan can classify a hook exactly as the
 * inventory does (via resolveHookScript): the same file-backed-vs-inline
 * decision and the same resolved basename.
 *
 * SECURITY: a hook command in a (possibly untrusted) manifest can name any path;
 * `scopeRoot` containment, checked on the REAL path (symlinks resolved), is what
 * stops an arbitrary file (`/etc/passwd`, `~/.ssh/id_rsa`) being treated as a hook.
 */
export function resolveHookScriptPath(command: string, projectDir: string, scopeRoot: string): string | null {
  return resolveHookScriptToken(command, projectDir, scopeRoot)?.real ?? null;
}

/** {@link resolveHookScriptPath}, with the offset just past the script word in the trimmed command. */
function resolveHookScriptToken(command: string, projectDir: string, scopeRoot: string): { real: string; end: number } | null {
  let root: string;
  try {
    root = realpathSync(resolve(scopeRoot));
  } catch {
    root = resolve(scopeRoot);
  }
  for (const { expanded, end } of scriptCandidates(command, projectDir)) {
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(projectDir || homedir(), expanded);
    let real: string;
    try {
      real = realpathSync(abs); // resolves symlinks so a link can't smuggle a target out of scope
    } catch {
      continue; // missing — maybe a later token is the real script
    }
    const rel = relative(root, real);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue; // outside scopeRoot
    return { real, end };
  }
  return null;
}

/**
 * Resolve a hook `command` to the script file it runs (path + content), so the
 * asset is that file rather than the manifest entry. The path decision is
 * {@link resolveHookScriptPath}; this adds the body read. A command with no in-scope script (inline `jq …`) returns null; the caller
 * treats the command string itself as the (harmless) body.
 *
 * `argsHash` is the first 6 hex characters of the SHA-256 of the text after the script, as
 * written, or "" when nothing follows it. `written` is the command as the file spells it,
 * when `command` is a rewrite of it that differs only up to the script word (Codex's
 * `$(git rev-parse --show-toplevel)`), so a checkout path never reaches the hash.
 */
export async function resolveHookScript(
  command: string,
  projectDir: string,
  scopeRoot: string,
  written = command,
): Promise<{ absPath: string; hash: string; argsHash: string } | null> {
  const hit = resolveHookScriptToken(command, projectDir, scopeRoot);
  if (hit === null) return null;
  const body = await readBody(hit.real);
  const [cmd, raw] = [command.trim(), written.trim()];
  let same = 0;
  while (same < cmd.length && cmd[same] === raw[same]) same++;
  // Before the first difference the two share offsets; past it, only the tail is shared.
  const tail = (hit.end <= same ? raw.slice(hit.end) : cmd.slice(hit.end)).replace(/^\s+/, "");
  const argsHash = tail === "" ? "" : sha256(tail).slice(0, 6);
  return body !== null ? { absPath: hit.real, hash: body.hash, argsHash } : null;
}

/**
 * Canonical matcher value for hook identity. An absent or non-string matcher —
 * legitimate for matcher-less events (UserPromptSubmit, Stop, SessionStart, …) —
 * normalizes to "". Hook identity keys on this, so a matcher-less group is one
 * stable, dedupable identity wherever a hook is read.
 */
export const normalizeMatcher = (matcher: unknown): string => (typeof matcher === "string" ? matcher : "");

/** An inline hook's identity sub-key within its manifest (matcher + command). */
export const inlineHookSubKey = (matcher: string, command: string): string => sha256(`${matcher}:${command}`);

/**
 * A wired hook's key: event + matcher + command. What a live hook is matched by against
 * the committed hooks — keyed on the EVENT too, so a committed command moved to a different
 * event locally does not read as committed.
 */
export const wiredHookKey = (eventType: string, matcher: string, command: string): string =>
  `${eventType}\u0000${inlineHookSubKey(matcher, command)}`;

/**
 * Whether a hook command names a script file (path-shaped token), regardless of
 * whether that file currently resolves — a command whose script is deleted/
 * out-of-scope is still file-backed, not a genuine inline one-liner.
 */
export function commandNamesAScript(command: string): boolean {
  return scriptCandidateTokens(command, "").length > 0;
}
