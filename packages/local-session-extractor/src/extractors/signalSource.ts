// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * How a branch or PR reference was obtained.
 *
 * A downstream matcher reads this to decide whether a signal may support an attribution
 * or may only narrow a search: a value the session itself produced can attribute,
 * while one the workspace merely held cannot. A signal that arrives unstamped is
 * indistinguishable from an ambient scrape, so it can only ever scope — which is
 * why stamping at the point of capture is the whole job of this module.
 *
 * The string values are stable enum names that consumers parse; renaming one
 * silently downgrades every signal it labels to unclassified.
 */
export const SIGNAL_SOURCE = {
  /** The session ran a command and we captured its output. */
  SESSION_COMMAND: "SIGNAL_SOURCE_SESSION_COMMAND",
  /**
   * The IDE recorded it against this session. No extractor in this package
   * produces it; the rank below places it so that a producer reading a vendor's
   * own field can use it.
   */
  VENDOR_FIELD: "SIGNAL_SOURCE_VENDOR_FIELD",
  /** The agent's own turn-final narration. Repo-gated: prose quotes PRs it only read about. */
  SESSION_PROSE: "SIGNAL_SOURCE_SESSION_PROSE",
  /** Found near the session in the local checkout, not produced by it. */
  LOCAL_GIT_WINDOWED: "SIGNAL_SOURCE_LOCAL_GIT_WINDOWED",
  /**
   * No class recorded. Named so a value written before stamping existed can be
   * carried explicitly rather than as an absent field — "we never classified this"
   * is a different statement from "this was ambient", and only the first is true of
   * a row written without a class. It ranks last, so anything classified supersedes it and it can
   * never supersede anything.
   */
  UNSPECIFIED: "SIGNAL_SOURCE_UNSPECIFIED",
} as const;

export type SignalSource = (typeof SIGNAL_SOURCE)[keyof typeof SIGNAL_SOURCE];

/**
 * Strongest-first rank: a session's own
 * record outranks the workspace's.
 *
 * Used when two classes name the SAME branch or PR — the entry keeps the highest,
 * so a scrape can never shadow a command receipt. Deliberately not the
 * declaration order of anything: a mechanical source (the local git read) feels
 * stronger than prose and ranks below it, because prose is the session's own
 * account of its work while the checkout is the workspace's.
 */
const SOURCE_RANK: Record<string, number> = {
  [SIGNAL_SOURCE.SESSION_COMMAND]: 4,
  [SIGNAL_SOURCE.VENDOR_FIELD]: 3,
  [SIGNAL_SOURCE.SESSION_PROSE]: 2,
  [SIGNAL_SOURCE.LOCAL_GIT_WINDOWED]: 1,
  [SIGNAL_SOURCE.UNSPECIFIED]: 0,
};

/**
 * True when `candidate` is strictly stronger evidence than `existing`.
 *
 * `existing` is a loose string rather than a SignalSource because it may have
 * been written by an older app version, or be absent: both rank last, which is
 * the correct reading — an unclassified value cannot be told apart from an
 * ambient one, so anything classified supersedes it.
 */
export function outranksSource(candidate: SignalSource, existing: string | undefined): boolean {
  // Both sides rank through the same lookup, so the contract holds symmetrically:
  // a value in neither the map nor recognised — an empty string, or one written by
  // a newer build the user has since downgraded from — ranks last on whichever side
  // it appears, and so can neither raise nor be raised past.
  const rank = (s: string | undefined): number => (s ? (SOURCE_RANK[s] ?? 0) : 0);
  return rank(candidate) > rank(existing);
}

/** A branch observed during the session, with how it was obtained. */
export interface BranchSignal {
  name: string;
  source: SignalSource;
}
