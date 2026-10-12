// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Recovers PR references and head branches for a Kiro session from the session's
 * own authoring evidence — the shell commands it ran, their output, and the
 * agent's per-turn closing prose.
 *
 * Why Kiro needs its own collector rather than reusing `collectCursorAttribution`:
 *
 *  1. **Multi-valued branches.** Cursor returns a single best branch. `git_branches`
 *     is a repeated field and a branch matcher iterates every entry, so a session that
 *     moved master → feat/x should offer both. Kiro returns the whole set.
 *  2. **"Last assistant message" is not Kiro's closing summary.** Cursor emits one
 *     assistant bubble per turn; Kiro emits many per turn (each `Say`), so its final
 *     assistant event is mid-task narration. The caller marks which events end a
 *     turn, and only those are parsed as summaries.
 *
 * The parsing itself is shared with Cursor (`cursorAttributionSignals`) so the two
 * surfaces cannot drift on what counts as a branch or an authoring command.
 */

import {
  isAuthoringPRCommand,
  parseCreateBranch,
  parsePushBranch,
  parseSummaryBranch,
  type PRRef,
} from "./cursorAttributionSignals";
import { findPRUrlInText } from "./prUrlParser";
import { commandCreatesBranch, commandPushesToGit, executableShellText } from "./kiroExtractor";
import { SIGNAL_SOURCE, outranksSource, type BranchSignal, type SignalSource } from "./signalSource";

/** One event from a Kiro transcript, reduced to what attribution needs. */
export interface KiroAttributionEvent {
  /** Assistant prose. Only read when `isTurnFinal`. */
  text?: string;
  /** A shell command the session ran (`execute_bash` [IDE] / `shell` [CLI]). */
  command?: string;
  /** That command's captured stdout. */
  output?: string;
  /** True only when the tool reported success — a failed push published nothing. */
  ok?: boolean;
  /** True when this is the last assistant message of a completed turn. */
  isTurnFinal?: boolean;
}

export interface KiroAttribution {
  prReferences: PRRef[];
  /**
   * Every distinct branch recovered, in first-seen order, each carrying how it
   * was obtained. The source is what lets a downstream matcher tell a branch the session
   * proved it was on from one the workspace merely held.
   */
  branchSignals: BranchSignal[];
  /**
   * The same branches as bare names, for the field that predates provenance.
   * Derived from `branchSignals` rather than accumulated separately, so the two
   * cannot disagree about which branches the session touched.
   */
  branches: string[];
}

/**
 * Folds reflog-recovered branches into what the transcript already proved.
 *
 * The walk CONTRIBUTES; it never replaces. A branch the session pushed carries
 * command evidence and must keep it — the walk's own reading is
 * `LOCAL_GIT_WINDOWED`, three ranks below, so on a session that proved its branch
 * by running `git push` the walk adds nothing, which is the correct outcome. What
 * it adds is the case the transcript cannot cover: a session that switched branches
 * without ever narrating or pushing one.
 *
 * Ranking the walk BELOW prose is deliberate and is the tempting error to avoid: a
 * reflog read feels more mechanical and therefore stronger, but prose is the
 * session's own account of its work while the reflog is the workspace's, and this
 * design's whole distinction is that the session's record outranks the workspace's.
 */
export function mergeWindowedBranches(
  recovered: KiroAttribution,
  windowed: string[],
): KiroAttribution {
  if (windowed.length === 0) return recovered;
  const signals = recovered.branchSignals.map((b) => ({ ...b }));
  const at = new Map<string, number>();
  signals.forEach((b, i) => at.set(b.name, i));
  for (const name of windowed) {
    if (!name) continue;
    const seen = at.get(name);
    if (seen === undefined) {
      at.set(name, signals.length);
      signals.push({ name, source: SIGNAL_SOURCE.LOCAL_GIT_WINDOWED });
      continue;
    }
    const existing = signals[seen]!;
    if (outranksSource(SIGNAL_SOURCE.LOCAL_GIT_WINDOWED, existing.source)) {
      existing.source = SIGNAL_SOURCE.LOCAL_GIT_WINDOWED;
    }
  }
  return {
    prReferences: recovered.prReferences,
    branchSignals: signals,
    branches: signals.map((b) => b.name),
  };
}

/**
 * True when the command was asked to simulate rather than act.
 *
 * A dry run creates nothing, so a PR URL in its output is a preview — usually the
 * body text echoed back. Treating that as a command receipt is the strongest
 * provenance the system has, attached to a PR that does not exist yet or that the
 * body merely cited, which is the one direction this stamping must not fail in.
 */
function isSimulatedRun(shell: string): boolean {
  // `shell` is already executableShellText(command), which replaces every quoted
  // span with a space — so a `--dry-run` inside a quoted --title has been erased
  // before we see it, and a bare flag is all that can remain. Re-stripping quotes
  // here would be dead and would reintroduce the unterminated-quote hole that
  // executableShellText exists to close; the guarantee lives in that one unit.
  return /\s(?:--dry-run|--dryrun)\b/.test(shell);
}

/**
 * The PR the command actually created, from its output.
 *
 * A create command prints the new PR's URL on a line of its own; a URL sitting
 * inside prose is the body being echoed back, and that body routinely cites a
 * different PR ("supersedes …", "context: …"). So a bare-URL line is preferred
 * over the first URL anywhere in the text.
 *
 * The fallback is deliberate rather than a refusal: only the GitHub CLI's output
 * contract is known here, and vendors that wrap or prefix the line would
 * otherwise lose a real receipt — a weaker read of a real create beats no read.
 */
function createdPRUrl(output: string): PRRef | null {
  for (const line of output.split("\n")) {
    const bare = line.trim();
    if (!bare || /\s/.test(bare)) continue;
    const ref = findPRUrlInText(bare);
    if (ref) return ref;
  }
  return findPRUrlInText(output);
}

/**
 * Recovers this session's PR references and head branches from its own authoring
 * evidence (commands it ran, their output, its closing prose).
 *
 * @param repoName `owner/repo` from the git remote. Gates PR refs recovered from
 *   PROSE — an agent can name a PR it merely read about, so a summary ref is kept
 *   only when it belongs to this session's repo, and dropped entirely when the
 *   repo is unknown. Refs from an authoring command's own output are
 *   authoritative and are kept even when repoName is unknown.
 */
export function collectKiroAttribution(
  events: KiroAttributionEvent[],
  repoName: string | undefined,
): KiroAttribution {
  const prReferences: PRRef[] = [];
  const refIndex = new Map<string, number>();
  const branchSignals: BranchSignal[] = [];
  const branchIndex = new Map<string, number>();

  // On a repeat, keep the stronger source rather than the first one seen. A
  // session that both pushed a branch and later mentioned it in prose has
  // command evidence for it, and dropping to the prose reading would understate
  // what we actually know.
  const addRef = (ref: PRRef | null, source: SignalSource, gateOnRepo: boolean): void => {
    if (!ref) return;
    // An unknown repo cannot clear the gate: without it, prose naming any PR
    // would be accepted, which is exactly what the gate exists to prevent.
    if (gateOnRepo && (!repoName || ref.pr_repository !== repoName)) return;
    const key = `${ref.pr_repository}#${ref.pr_number}`;
    const at = refIndex.get(key);
    if (at !== undefined) {
      const existing = prReferences[at]!;
      if (!existing.source || outranksSource(source, existing.source)) existing.source = source;
      return;
    }
    refIndex.set(key, prReferences.length);
    prReferences.push({ ...ref, source });
  };

  const addBranch = (name: string | null, source: SignalSource): void => {
    if (!name) return;
    const at = branchIndex.get(name);
    if (at !== undefined) {
      const existing = branchSignals[at]!;
      if (outranksSource(source, existing.source)) existing.source = source;
      return;
    }
    branchIndex.set(name, branchSignals.length);
    branchSignals.push({ name, source });
  };

  for (const ev of events) {
    // Evidence from a command the session actually ran. A failed command proves
    // nothing was published, so only successful ones count.
    if (ev.command && ev.ok) {
      // The same executable-only view `commandPushesToGit` uses, for the same
      // reason: a branch named inside a quoted string or a heredoc — `echo "git
      // push origin other-branch"`, a generated script — was never checked out.
      // Recovering it would attribute a branch the session never used, and a
      // matcher cannot tell that apart from a real one.
      // Two gates, not one. Stripping data spans is not enough on its own: the
      // parsers match a bare `git push` anywhere, so `echo git push origin other`
      // — unquoted, so nothing to strip — still yielded a branch the session
      // never used, and a matcher cannot tell that from a real checkout. The
      // command-position test is what decides the words are a command; the
      // parsers only extract the branch out of them. The gate lives here, not in
      // the shared parsers, so Cursor's attribution is unchanged.
      const shell = executableShellText(ev.command);
      if (commandPushesToGit(ev.command)) {
        addBranch(parsePushBranch(shell), SIGNAL_SOURCE.SESSION_COMMAND);
      }
      if (commandCreatesBranch(ev.command)) {
        addBranch(parseCreateBranch(shell), SIGNAL_SOURCE.SESSION_COMMAND);
      }
      // A PR-create command's own output is the authoritative reference: the
      // session ran the create, so no repo gate is needed. That exemption is only
      // sound if the create really executed — read from `shell` for the same
      // reason the branches above do, since a `gh pr create` merely echoed or
      // written into a script would otherwise let any PR URL in that command's
      // stdout bypass the gate and become a direct PR reference.
      if (ev.output && isAuthoringPRCommand(shell) && !isSimulatedRun(shell)) {
        addRef(createdPRUrl(ev.output), SIGNAL_SOURCE.SESSION_COMMAND, false);
      }
    }

    // Prose evidence, from turn-final messages only. Mid-turn narration routinely
    // quotes PRs and branches the session is merely reading about.
    if (ev.isTurnFinal && ev.text) {
      addBranch(parseSummaryBranch(ev.text), SIGNAL_SOURCE.SESSION_PROSE);
      if (ev.text.includes("http")) {
        addRef(findPRUrlInText(ev.text), SIGNAL_SOURCE.SESSION_PROSE, true);
      }
    }
  }

  return { prReferences, branchSignals, branches: branchSignals.map((b) => b.name) };
}
