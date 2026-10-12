// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/** The bounded error vocabulary a seat-tier lookup reports. */
export type SeatTierErrorKind =
  | "AUTH"
  | "RATE_LIMITED"
  | "NETWORK"
  | "TIMEOUT"
  | "PARSE";

/**
 * Outcomes that can be persisted on the cache row. `attempt` is the
 * write-ahead lease and is never returned to a caller.
 */
export type CachedSeatTierOutcome =
  | "attempt"
  | "ok"
  | "enterprise"
  | "not_team"
  | "no_token"
  | "token_expired"
  | "identity_unmatched"
  | "members_truncated"
  | "account_mismatch"
  | "error";

/**
 * Everything one resolution can report. The five that are not persistable are
 * the branches that return before a row is written: they consume no budget and
 * leave no trace, which is why they carry no cache state.
 */
export type SeatTierOutcome =
  | Exclude<CachedSeatTierOutcome, "attempt">
  | "disabled"
  | "not_team_local"
  | "cache_fresh"
  | "lease_held"
  | "circuit_open";

/**
 * The Cursor seat-tier resolver's outcome for a cycle, present exactly when the
 * resolver ran.
 */
export interface SeatTierRunReport {
  outcome: SeatTierOutcome;
  errorKind?: SeatTierErrorKind;
}
