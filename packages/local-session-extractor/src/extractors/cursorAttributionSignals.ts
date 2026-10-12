// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
// Recovers PR references and the head branch for a Cursor session from the
// session's own authoring evidence — the tool calls it ran and the agent's
// closing summary. Pure functions over a minimal event shape so they unit-test
// without SQLite.

import { findPRUrlInText } from "./prUrlParser";

export type PRRef = {
  pr_url: string;
  pr_number: number;
  pr_repository: string;
  /**
   * How this reference was obtained. Optional because a producer that predates
   * stamping omits it, and an absent value must read as unclassified rather than
   * as a claim the reference was ambient — those are different statements.
   */
  source?: string;
};

// One agent-mode bubble, reduced to the fields attribution cares about.
export interface AttributionEvent {
  role: "user" | "assistant";
  // The assistant's prose for this bubble (used for the closing-summary source).
  text: string;
  // For a terminal/PR-create tool call: the command string and its captured stdout.
  command?: string;
  output?: string;
  // Cursor tool-completion status; only "completed" tool calls are evidence.
  status?: string;
}

// Bare tokens that are never a feature/PR head on their own: trunk branches,
// `HEAD`, and common remote names (which appear in `git push` argument position).
const NON_FEATURE = new Set([
  "master", "main", "develop", "dev", "release", "staging", "HEAD",
  "origin", "upstream", "fork",
]);
// Remote names only — used for the slash-prefix check. A trunk *word* as a path
// prefix (`release/1.2`, `dev/alice`) IS a real feature head, so only a
// remote-qualified ref (`origin/master`, `upstream/dev`) is rejected by prefix.
const REMOTES = new Set(["origin", "upstream", "fork"]);

/**
 * Validates a branch token taken from a COMMAND, where the token is already the
 * bare branch: `git push <remote> <refspec>` and `git checkout -b <name>` both
 * put the branch in a position where a remote prefix is not a qualifier but part
 * of the name. A repo really can have a branch called `upstream/sync-deps`, so
 * stripping here would report `sync-deps` — confidently wrong — where returning
 * null merely says "unknown". A remote-qualified token in this position is
 * therefore rejected, not repaired.
 */
// Exported so the reflog walk applies the SAME admissibility as every other
// producer. A walk with its own looser
// rule would put entries into the branch set under a different contract from its
// siblings, which the merge rank then compares against each other.
export function validateBranch(name: string): string | null {
  if (!name || NON_FEATURE.has(name)) return null;
  const slash = name.indexOf("/");
  if (slash > 0 && REMOTES.has(name.slice(0, slash))) return null; // origin/…, upstream/…
  return name;
}

/**
 * Normalizes a branch named in PROSE, where a remote prefix IS a qualifier —
 * an agent writing "pushed to `origin/feat/x`" means the head `feat/x`, and
 * rejecting the whole token loses a real branch. Only safe here because prose
 * names the ref the way a human reads it, unlike a command's refspec position
 * (see validateBranch). `origin/master` still reduces to `master` and is still
 * rejected, so the trunk guard survives the strip.
 */
// Only the remotes whose name is an implausible branch prefix. `fork/` is
// excluded deliberately: `fork/redesign` is as likely a literal branch name as a
// remote-qualified ref, and guessing wrong here is the confidently-wrong failure
// validateBranch exists to avoid.
const PROSE_STRIPPABLE_REMOTES = new Set(["origin", "upstream"]);

export function normalizeBranch(name: string): string | null {
  if (!name) return null;
  const slash = name.indexOf("/");
  const stripped = slash > 0 && PROSE_STRIPPABLE_REMOTES.has(name.slice(0, slash))
    ? name.slice(slash + 1)
    : name;
  return validateBranch(stripped);
}

// requestIsPOST reports whether a raw HTTP command writes rather than reads.
//
// The signal is client-agnostic: an explicit method token (`curl -X POST`, httpie
// `http POST <url>`) OR a curl data flag, which implies POST. POST cannot be
// inferred from a bare URL — that would also match a GET list — so an un-flagged
// request reads as a non-authoring read.
function requestIsPOST(command: string): boolean {
  return (
    /(?:-X\s*POST|--request\s+POST|\b(?:https?|httpie)\s+POST\b|\s-d\b|--data\b|--data-raw\b|--data-binary\b|--json\b)/.test(
      command,
    ) && !/\s-G\b|--get\b/.test(command)
  );
}

// isAuthoringPRCommand is vendor-shaped: GitHub/GitLab expose a CLI; Bitbucket has
// none, so a PR is raised by POSTing the REST API. Viewing commands
// (gh pr view/diff, a GET list, a /comments POST) are excluded — they are not authoring.
//
// Bitbucket's two deployments take different REST paths, Cloud's and Server's, and
// both are matched. Each arm requires a POST to the pull-requests
// *collection* and excludes a sub-resource (`/<n>/comments`, `/merge`, `/approve`,
// `/decline`), which are actions on an existing PR rather than a create.
export function isAuthoringPRCommand(command: string): boolean {
  if (/\bgh\s+pr\s+(?:create|merge)\b/.test(command)) return true;
  if (/\bglab\s+mr\s+create\b/.test(command)) return true;
  // Bitbucket Cloud: /2.0/repositories/<workspace>/<repo>/pullrequests
  if (
    /\/repositories\/[^\s'"]+?\/pullrequests(?:[?'"\s]|$)/.test(command) &&
    !/\/pullrequests\/\d+/.test(command) &&
    requestIsPOST(command)
  ) {
    return true;
  }
  // Bitbucket Server / Data Center: /rest/api/1.0/projects/<KEY>/repos/<NAME>/pull-requests
  // (hyphenated, and nested under projects/repos — neither shape the Cloud arm matches).
  if (
    /\/projects\/[^\s'"/]+\/repos\/[^\s'"/]+\/pull-requests(?:[?'"\s]|$)/.test(command) &&
    !/\/pull-requests\/\d+/.test(command) &&
    requestIsPOST(command)
  ) {
    return true;
  }
  return false;
}

/**
 * The `git` invocation before a subcommand: `git`, optionally with `-C <dir>` or
 * `-c <key=value>` options, which each take one argument. Shared by every
 * push/create matcher so none of them misses `git -C repo push`.
 */
export const GIT_INVOCATION = String.raw`git(?:\s+-[Cc]\s+\S+)*\s+`;

/** The branch-creating subcommand forms: `checkout -b|-B`, `switch -c|-C|--create|--force-create`. */
export const GIT_CREATE_BRANCH = String.raw`(?:checkout\s+-[bB]|switch\s+(?:-[cC]|--create|--force-create))`;

/** A refspec's destination as a branch name: no force `+`, no `refs/heads/` prefix. */
function refspecBranch(ref: string): string {
  return ref.replace(/^\+/, "").replace(/^refs\/heads\//, "");
}

// parsePushBranch extracts the pushed branch from a `git push` command — the
// authoritative PR head. Parses the refspec (branch = <dst> if `src:dst`, else
// <src>); a bare `git push`, `git push origin`, or `git push -u origin HEAD`
// carries no branch and yields null (never captures `origin`/`HEAD`).
export function parsePushBranch(command: string): string | null {
  const m = command.match(new RegExp(String.raw`\b${GIT_INVOCATION}push\b([^\n;&|]*)`));
  if (!m) return null;
  const tokens = m[1]!.trim().split(/\s+/).filter((t) => t.length > 0);
  // A delete push (`--delete`/`-d`/`--prune`/`:branch`) carries no feature head.
  if (tokens.some((t) => t === "--delete" || t === "-d" || t === "--prune")) return null;
  // Grammar: git push [flags] [<remote> [<refspec>…]]. The branch is the FIRST
  // refspec, which sits after the remote — so a lone positional is the remote (no
  // branch), and we must not treat a non-`origin` remote name as the branch.
  // Drop flags AND the value consumed by a value-taking option (e.g. `-o ci.skip`),
  // else the value is misread as the remote and the real branch is lost.
  const VALUE_OPTS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.startsWith("-")) {
      if (VALUE_OPTS.has(t)) i++; // skip this option's value too
      continue;
    }
    positionals.push(t);
  }
  if (positionals.length < 2) return null;
  const refspec = positionals[1]!;
  if (refspec.startsWith(":")) return null; // `:branch` = delete remote branch
  const branch = refspecBranch(refspec.includes(":") ? refspec.split(":").pop()! : refspec);
  return validateBranch(branch);
}

// parseCreateBranch extracts a branch-creation name (`git checkout -b|-B` / `git
// switch -c|-C|--create`). Plain `git checkout X` is excluded — ambiguous (may jump
// to an existing branch / trunk).
export function parseCreateBranch(command: string): string | null {
  const m = command.match(new RegExp(String.raw`\b${GIT_INVOCATION}${GIT_CREATE_BRANCH}\s+([A-Za-z0-9._\-/]+)`));
  return m ? validateBranch(m[1]!) : null;
}

// parseSummaryBranch extracts a branch the agent names in its summary, but ONLY
// in a structured form — an echoed git command, or a back-tick-quoted name next
// to a branch keyword. A bare prose name has no distinguishing shape and is not
// extractable.
export function parseSummaryBranch(text: string): string | null {
  const fromCmd = parsePushBranch(text) ?? parseCreateBranch(text);
  if (fromCmd) return fromCmd;
  const m = text.match(/\b(?:branch|pushed(?:\s+to)?|head)\b[^`\n]{0,40}`([A-Za-z0-9._\-/]+)`/i);
  return m ? normalizeBranch(m[1]!) : null;
}

const refKey = (r: PRRef): string => `${r.pr_repository}#${r.pr_number}`;

/**
 * Recovers PR references and the single best head branch for a session.
 *
 * PR refs: from PR-create tool-call output (authoritative — the
 * session ran the create) and from the agent's closing summary (accepted only if
 * its repo matches the session repo, since summary text could mention a viewed
 * PR). Deduped by repo#number; a wrong ref self-drops at a consumer merged-set gate.
 *
 * Branch: single best by precedence — pushed branch > created
 * branch > structured summary branch.
 *
 * `repoName` (owner/repo, from the git remote) is the precision gate for the
 * summary PR source; when undefined, summary PR refs are skipped (no gate), but
 * authoritative tool-output refs are still kept.
 */
export function collectCursorAttribution(
  events: AttributionEvent[],
  repoName: string | undefined
): { prReferences: PRRef[]; branch: string | null } {
  const refs: PRRef[] = [];
  const seen = new Set<string>();
  // Repo-scope gate: when the session's repo is known, a recovered ref must be for
  // that repo (a multi-repo session could otherwise attribute a PR it merely touched).
  // When repoName is unknown, accept (a consumer merged-set gate is the backstop).
  const add = (ref: PRRef | null): void => {
    if (!ref) return;
    if (repoName && ref.pr_repository !== repoName) return;
    const key = refKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };

  let pushBranch: string | null = null;
  let createBranch: string | null = null;
  let lastSummaryText = ""; // closing-summary candidate (the final assistant prose)

  for (const ev of events) {
    // PR ref from a completed PR-create command's output (authoritative).
    if (ev.status === "completed" && ev.command && ev.output && isAuthoringPRCommand(ev.command)) {
      add(findPRUrlInText(ev.output));
    }

    // Branch from a *completed* command the session ran (pushed > created) — a
    // cancelled/errored push or checkout is not evidence the branch was published.
    if (ev.command && ev.status === "completed") {
      pushBranch = pushBranch ?? parsePushBranch(ev.command);
      createBranch = createBranch ?? parseCreateBranch(ev.command);
    }

    // Track the latest assistant prose; only the closing summary is parsed (below).
    if (ev.role === "assistant" && ev.text) lastSummaryText = ev.text;
  }

  // PR ref + branch from the agent's *closing summary only* (the final assistant
  // bubble) — not arbitrary mid-conversation prose, which could mention a PR the
  // session merely viewed/discussed. Summary URLs require a known repo to gate on
  // (unlike tool output, which add() keeps even without repoName).
  let summaryBranch: string | null = null;
  if (lastSummaryText) {
    if (repoName && lastSummaryText.includes("http")) add(findPRUrlInText(lastSummaryText));
    summaryBranch = parseSummaryBranch(lastSummaryText);
  }

  const branch = pushBranch ?? createBranch ?? summaryBranch;
  return { prReferences: refs, branch };
}
