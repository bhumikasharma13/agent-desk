// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The Cursor team-seat plan-tier cache and the resolver that runs around the
 * host's network lookup. The package owns the `meta` row, its time-to-live, the
 * write-ahead attempt lease and the circuit break; the host supplies only the
 * two vendor calls, as a `SeatTierLookup`, and supplies none by default, so the
 * package never calls Cursor on its own.
 *
 * Two commitments govern every branch below:
 *
 *  1. **The credential never leaves the machine through this module.** The
 *     token is read from the local Cursor database, handed to the host's lookup,
 *     and dropped. It is never persisted and never logged; only an account
 *     fingerprint (of the subject, not the token) and the token's issue time are
 *     written, and only a status code and a bounded error kind reach a log line.
 *
 *  2. **At most one network attempt per installation per 24 hours, regardless
 *     of outcome.** The attempt is recorded before the request is sent, so a
 *     crash between the request and the result still counts as the attempt.
 *
 * The resolver maps nothing: it reports the raw vendor strings and a consumer
 * derives the canonical tier. Failure is always fail-open.
 */

import { createHash } from "node:crypto";
import type { InstallationMetadata } from "../types/session";
import type { CachedSeatTierOutcome, SeatTierErrorKind, SeatTierOutcome } from "../types/seatTier";
import { decodeJwtClaims } from "../extractors/jwtClaims";
import { logger } from "./logger";

export type { CachedSeatTierOutcome, SeatTierErrorKind, SeatTierOutcome } from "../types/seatTier";

const COMPONENT = "extraction.cursor_seat_tier";

/**
 * The attempt line's event name, frozen. It is the phrase a host's log query
 * matches on to check commitment 2, so renaming it silently empties that
 * query. The test suite asserts this exact string.
 */
export const SEAT_TIER_ATTEMPT_EVENT = "cursor_seat_tier_attempt";

/**
 * Exported because the Cursor CLI extractor applies the same staleness bound to
 * the row this module owns.
 */
export const SEAT_TIER_LOOKUP_TTL_MS = 24 * 60 * 60 * 1000;

/** The `meta` key holding the single installation-global cache row. */
export const SEAT_TIER_META_KEY = "cursor_seat_tier_lookup";

const BREAK_401_MS = 7 * 24 * 60 * 60 * 1000;
const BREAK_403_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A clearly-dead token suppresses the attempt; a marginally-dead one does not.
 * This is the only check that can stop a request with no network evidence at
 * all, so a fast clock or a seconds-versus-milliseconds slip must not be able
 * to read every token as expired and disable the feature everywhere while
 * reporting nothing but skips.
 */
const TOKEN_EXPIRY_TOLERANCE_SECONDS = 300;

/**
 * Ceiling on the raw vendor strings. A consumer should apply its own ceiling
 * too, because an older or modified client can write whatever it likes; this
 * is a cheap early cut, not the enforcement point.
 *
 * It is headroom, not a measurement: the longest real value
 * (`TEAM_MEMBER_BILLING_TIER_TIER_1000`) is 34 characters. Over-long values are
 * dropped rather than truncated — a truncated string would contradict the
 * field's persisted-verbatim contract and later read as raw evidence.
 */
const MAX_VENDOR_STRING_LENGTH = 128;

/**
 * What the host's lookup reports. It carries raw vendor strings; this module
 * applies the length ceiling before storing or stamping any of them.
 */
export type SeatTierLookupResult =
  | {
      outcome: "error";
      errorKind: SeatTierErrorKind;
      /** Vendor HTTP status, when a response was received at all. */
      status?: number;
      membershipType?: string;
      isYearlyPlan?: boolean;
    }
  | {
      outcome: "not_team" | "enterprise" | "members_truncated" | "identity_unmatched";
      status: number;
      membershipType?: string;
      isYearlyPlan?: boolean;
    }
  | {
      outcome: "ok";
      status: number;
      billingTier?: string;
      membershipType?: string;
      isYearlyPlan?: boolean;
    };

/**
 * The host's network call: given the team id and the developer's Cursor access
 * token, it performs the vendor lookups and reports what Cursor said. It must
 * not throw; a failure is an `error` result. `teamId` is the locally-derived
 * team signal the resolver gated on; a lookup that re-identifies the team from
 * the vendor's own profile may ignore it.
 */
export type SeatTierLookup = (request: { teamId: string; token: string }) => Promise<SeatTierLookupResult>;

export interface SeatTierResolution {
  outcome: SeatTierOutcome;
  errorKind?: SeatTierErrorKind;
  /** Vendor HTTP status, when a response was received at all. */
  status?: number;
  /**
   * The raw keys to merge onto the cycle's `InstallationMetadata`. Empty
   * whenever nothing was observed and nothing reusable was cached.
   */
  stamp: Partial<InstallationMetadata>;
  /**
   * Whether this resolution reached the network. The traffic invariant is
   * stated over *cycles that reach the network*, not raw fetch calls: the happy
   * path legitimately issues two requests inside one attempt.
   */
  attempted: boolean;
}

/** The read half, held alone by the CLI surface (see `readCachedSeatTierStamp`). */
export interface SeatTierMetaReader {
  getMeta(key: string): string | null;
}

/** The `meta` read/write pair this module needs, structurally. */
export interface SeatTierMetaStore extends SeatTierMetaReader {
  setMeta(key: string, value: string): void;
}

export interface ResolveCursorSeatTierOptions {
  /**
   * The kill switch. Anything other than `true` — including an absent field —
   * returns before any cache read, token read or network call.
   */
  enabled: boolean | undefined;
  /**
   * The locally-derived team signal (`InstallationMetadata.cursor_team_id`).
   * Its absence means an individual seat, which this lookup cannot describe
   * further, so such installs make zero calls ever. An enterprise flag
   * deliberately does *not* gate: an Enterprise-contract team seat must reach
   * the lookup, because its definitive `teamMembershipType` is the only signal
   * that can be measured against the local heuristic.
   */
  teamId: string | undefined;
  meta: SeatTierMetaStore;
  /** Reads one key from the already-open Cursor `ItemTable` reader. */
  readVscdbKey: (key: string) => string | null;
  /** The host's network call; absent means the feature is off. */
  lookup: SeatTierLookup | undefined;
  /** Test seam. Defaults to `Date.now`. */
  now?: () => number;
}

/** The persisted row. Written whole, from one process, once per cycle. */
interface SeatTierCacheRow {
  fetchedAt?: string;
  outcome?: CachedSeatTierOutcome;
  billingTier?: string;
  teamMembershipType?: string;
  isYearlyPlan?: boolean;
  attemptStartedAt?: string;
  tokenIssuedAt?: number;
  accountFp?: string;
  breakUntil?: string;
}

// ── Cache row I/O ────────────────────────────────────────────────────────────

function readRow(meta: SeatTierMetaReader): SeatTierCacheRow {
  let raw: string | null;
  try {
    raw = meta.getMeta(SEAT_TIER_META_KEY);
  } catch (err) {
    logger.warn(COMPONENT, "cache_read_failed", { error: errText(err) });
    return {};
  }
  if (raw === null || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as SeatTierCacheRow;
  } catch {
    // An unreadable row is treated as absent rather than as a fresh one: the
    // 24h clock is re-armed by the lease written moments later, so this cannot
    // become a retry loop.
    logger.warn(COMPONENT, "cache_row_unparseable", {});
    return {};
  }
}

function writeRow(meta: SeatTierMetaStore, row: SeatTierCacheRow): void {
  meta.setMeta(SEAT_TIER_META_KEY, JSON.stringify(row));
}

// ── Small helpers ────────────────────────────────────────────────────────────

/**
 * The closed kinds a lookup may report, as a record so a kind added to the type
 * must be added here. Anything else a host returns is recorded as `PARSE`: the
 * host's answer did not have the shape the contract requires.
 */
const SEAT_TIER_ERROR_KINDS: Readonly<Record<SeatTierErrorKind, true>> = {
  AUTH: true,
  RATE_LIMITED: true,
  NETWORK: true,
  TIMEOUT: true,
  PARSE: true,
};

function boundedErrorKind(kind: unknown): SeatTierErrorKind {
  return typeof kind === "string" && Object.hasOwn(SEAT_TIER_ERROR_KINDS, kind) ? (kind as SeatTierErrorKind) : "PARSE";
}

/** A bounded label for a thrown value, safe to log: its built-in class name, never its message. */
function errorClassOf(err: unknown): string {
  if (err instanceof TypeError) return "TypeError";
  if (err instanceof RangeError) return "RangeError";
  if (err instanceof SyntaxError) return "SyntaxError";
  if (err instanceof Error) return "Error";
  return "non_error";
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withinTtl(iso: string | undefined, nowMs: number): boolean {
  if (typeof iso !== "string" || iso.length === 0) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return nowMs - t < SEAT_TIER_LOOKUP_TTL_MS;
}

/**
 * A vendor string short enough to be a plausible enum name. Over-long values
 * are dropped, so the field is simply absent rather than present-but-mangled.
 */
function acceptVendorString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.length > MAX_VENDOR_STRING_LENGTH) return undefined;
  return value;
}

/**
 * A 32-bit SHA-256 prefix of the auth0 subject — the ACCOUNT this row
 * describes, not the credential, so it survives token rotation and can be
 * recomputed without a token at all. Sized for the comparison set it serves,
 * which is the handful of Cursor accounts one machine is signed into; a
 * collision there costs one stale cached tier for one day, bounded by the TTL.
 * A wider digest would buy nothing and put more of a user identifier on disk.
 */
function accountFingerprint(subject: string): string {
  return createHash("sha256").update(subject).digest("hex").slice(0, 8);
}

/**
 * The circuit break an error's status earns. A 401 is the design's one genuine
 * ambiguity: an expired token (benign, self-heals) or a real refusal
 * (systemic). The expiry pre-filter removes the benign cause before a request
 * is made, so a surviving 401 is probably a refusal — which is what makes a
 * break defensible. A 403 is unambiguous and gets the long break. Nothing else
 * breaks: the row is written on every outcome, so the 24h TTL already starts
 * the clock a shorter break would.
 */
function breakFor(status: number | undefined): number | undefined {
  if (status === 401) return BREAK_401_MS;
  if (status === 403) return BREAK_403_MS;
  return undefined;
}

// ── Stamping ─────────────────────────────────────────────────────────────────

/**
 * Builds the stamp from a cache row: raw vendor values only.
 *
 * `plan_tier_source` is deliberately NOT stamped here. This module reports what
 * Cursor said; provenance is derived meaning, and it belongs to the consumer that
 * actually ACCEPTS a vendor tier — the only place the accept / reject decision
 * exists. Claiming it here would overwrite the local origin
 * (Cursor emits several) on every row, including the rows a consumer rejects,
 * leaving no way to say where such a tier came from and laundering an unknown
 * origin into REPORTED.
 */
function stampFromRow(row: SeatTierCacheRow): Partial<InstallationMetadata> {
  const stamp: Partial<InstallationMetadata> = {};
  const billingTier = acceptVendorString(row.billingTier);
  const membershipType = acceptVendorString(row.teamMembershipType);
  if (billingTier !== undefined) stamp.cursor_billing_tier = billingTier;
  if (membershipType !== undefined) stamp.cursor_team_membership_type = membershipType;
  if (typeof row.isYearlyPlan === "boolean") stamp.cursor_is_yearly_plan = row.isYearlyPlan;
  return stamp;
}

/**
 * The read-only consumer of the row this module owns, for a surface that has no
 * token and makes no call: the Cursor CLI extractor. Write ownership is single —
 * the IDE resolver is the only writer and the only invalidator — because a write
 * from here would consume the day's attempt lease, or thrash the row on a machine
 * whose CLI and IDE are different accounts, and this surface holds no token with
 * which to repair either.
 *
 * Three conditions, each load-bearing:
 *
 *  - **`outcome === "ok"`** — a reused `enterprise` or error row carries raw
 *    values a consumer reads as a *membership* signal, and serving them from a
 *    surface that cannot say which account they describe is how a stale seat gets
 *    reported.
 *  - **within the TTL** — not redundant with the resolver's own freshness check.
 *    A developer whose IDE has stopped refreshing would otherwise keep stamping a
 *    tier that aged out days ago, which is exactly the staleness bound the TTL
 *    exists to enforce.
 *  - **the fingerprint matches the account THIS surface is signed into**, taken
 *    from the CLI's own Statsig `userID` rather than from whatever identity the
 *    IDE last resolved. A machine whose CLI and IDE are different Cursor accounts
 *    is the case the fingerprint exists for, and taking the other account's tier
 *    would report the wrong seat while looking correct. The comparison is only
 *    meaningful because the two surfaces name the account in the *same* identity
 *    space: read from a live install, the CLI's `userID` and the IDE token's `sub`
 *    are the byte-identical `auth0|…` subject and hash to the same fingerprint.
 *    Were that ever to diverge, this surface stamps nothing rather than something
 *    wrong.
 *
 * A row with no fingerprint is not a match: unlike the resolver, this surface
 * always has its subject or has nothing at all, so "cannot compute" does not
 * arise here — an absent `accountFp` means the row was written by a client that
 * could not name its account, which is not evidence about this one.
 */
export function readCachedSeatTierStamp(options: {
  meta: SeatTierMetaReader;
  /** The auth0 subject of the account this surface is signed into. */
  accountSubject: string | undefined;
  /** Test seam. Defaults to `Date.now`. */
  now?: () => number;
}): Partial<InstallationMetadata> {
  const { meta, accountSubject } = options;
  if (typeof accountSubject !== "string" || accountSubject.length === 0) return {};
  const row = readRow(meta);
  if (row.outcome !== "ok") return {};
  if (!withinTtl(row.fetchedAt, (options.now ?? Date.now)())) return {};
  if (row.accountFp === undefined || row.accountFp !== accountFingerprint(accountSubject)) {
    return {};
  }
  return stampFromRow(row);
}

// ── The resolver ─────────────────────────────────────────────────────────────

/**
 * Runs at most one lookup cycle. Never throws and never rejects: every failure
 * degrades to a resolution carrying no tier.
 */
export async function resolveCursorSeatTier(
  options: ResolveCursorSeatTierOptions,
): Promise<SeatTierResolution> {
  try {
    return await resolve(options);
  } catch (err) {
    // A resolver defect must cost three absent fields, never the extraction
    // cycle it runs inside.
    logger.error(COMPONENT, "resolver_failed", { errorClass: errorClassOf(err) });
    return { outcome: "error", stamp: {}, attempted: false };
  }
}

async function resolve(
  options: ResolveCursorSeatTierOptions,
): Promise<SeatTierResolution> {
  const { enabled, teamId, meta, readVscdbKey, lookup } = options;
  const nowMs = (options.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();

  // 1. Kill switch. No cache read, no token read, no network. A host that
  //    supplies no lookup has turned the feature off as surely as the flag.
  if (enabled !== true || lookup === undefined) return skip("disabled");

  // 2. Team gate.
  if (typeof teamId !== "string" || teamId.length === 0) return skip("not_team_local");

  // 3. Token and account identity — not yet expiry. An expired token still
  //    carries a readable subject, so identity is available before the token is
  //    known to be usable. This precedes the cache read because the cache's
  //    identity check needs the fingerprint.
  const token = readVscdbKey("cursorAuth/accessToken");
  if (token === null || token.length === 0) {
    recordNoToken(meta, nowMs);
    return { outcome: "no_token", stamp: {}, attempted: false };
  }
  const claims = decodeJwtClaims(token);
  const subject = typeof claims?.["sub"] === "string" ? (claims["sub"] as string) : null;
  const accountFp = subject === null ? null : accountFingerprint(subject);
  const tokenIssuedAt =
    typeof claims?.["time"] === "number" && Number.isFinite(claims["time"] as number)
      ? (claims["time"] as number)
      : undefined;

  // 4. Cache: four states, checked in this order.
  const row = readRow(meta);

  //    (a) A fresh result. The day is spent either way; whether the VALUES may
  //        be reused is the separate question the fingerprint answers.
  if (withinTtl(row.fetchedAt, nowMs)) {
    if (accountFp === null) {
      // "Cannot compute" is a third answer, not "mismatch". Treating an opaque
      // token as a different account would have the fetching cycle stamp and
      // every later cycle that day clear what it just wrote, killing cache
      // reuse silently while every cycle still reported success.
      logger.warn(COMPONENT, "account_fingerprint_uncomputable", {
        row_has_fingerprint: row.accountFp !== undefined,
      });
      return { outcome: "cache_fresh", stamp: stampFromRow(row), attempted: false };
    }
    if (row.accountFp === accountFp) {
      return { outcome: "cache_fresh", stamp: stampFromRow(row), attempted: false };
    }
    // A missing or mismatched fingerprint never licenses a network attempt
    // inside the TTL — the 24-hour clock is `fetchedAt` alone, which needs no
    // token, so the invariant holds even when the payload does not decode.
    // The clear must preserve `fetchedAt`: re-dating it would make the row
    // permanently fresh and a machine that switched accounts permanently dark.
    writeRow(meta, {
      ...row,
      outcome: "account_mismatch",
      billingTier: undefined,
      teamMembershipType: undefined,
      isYearlyPlan: undefined,
      accountFp: undefined,
    });
    return { outcome: "account_mismatch", stamp: {}, attempted: false };
  }

  //    (b) An attempt lease. The lease consumes the day's budget on its own,
  //        whether or not the attempt that wrote it ever finished. This is the
  //        branch that makes the invariant survive a crash.
  if (withinTtl(row.attemptStartedAt, nowMs)) {
    return { outcome: "lease_held", stamp: {}, attempted: false };
  }

  //    (c) A circuit break. Cleared early only on re-authentication, signalled
  //        by the token's own issue time — the same signal as a digest of the
  //        token, semantically meaningful rather than incidental, and leaving no
  //        credential-derived artifact on disk.
  //
  //        Clearing a break never clears a lease: the break governs whether we
  //        would try again at all, the lease whether we have already tried
  //        today. The lease branch above returns first, so a re-authenticated
  //        developer resumes at the next 24-hour boundary, not five minutes
  //        after the failure.
  //
  //        The clear is expressed as "this break no longer blocks", NOT as
  //        erasing `breakUntil` here: the write that follows is a lease, and a
  //        break must never be dropped by a write that does not own it, or a
  //        crash between the lease and the outcome would silently discard a
  //        30-day break. An owning write replaces it: any terminal write that got
  //        a vendor RESPONSE (`ok`, `enterprise`, `not_team`) clears it, because a
  //        response disproves the refusal the break records; the next error class
  //        overwrites it with its own term. A terminal outcome that clears nothing
  //        would let the break outlive the refusal that caused it.
  if (typeof row.breakUntil === "string" && Date.parse(row.breakUntil) > nowMs) {
    const reAuthenticated =
      tokenIssuedAt !== undefined &&
      row.tokenIssuedAt !== undefined &&
      tokenIssuedAt > row.tokenIssuedAt;
    if (!reAuthenticated) {
      return { outcome: "circuit_open", stamp: {}, attempted: false };
    }
  }

  // 5. Expiry gate — network eligibility only, never cached-data eligibility,
  //    which is why it sits after the cache read. Best effort: an undecodable
  //    payload or an absent/non-numeric `exp` skips the check and proceeds, so
  //    the request path never depends on the credential's internal format.
  const exp = claims?.["exp"];
  if (typeof exp === "number" && Number.isFinite(exp)) {
    if (exp + TOKEN_EXPIRY_TOLERANCE_SECONDS < nowMs / 1000) {
      recordTokenExpired(meta, nowMs);
      return { outcome: "token_expired", stamp: {}, attempted: false };
    }
  }

  // The account facts every write carries. Keys are omitted rather than set to
  // undefined so a write that should PRESERVE the fingerprint — every error
  // class does — cannot silently erase it when the token turns out to be opaque.
  const identity: { accountFp?: string; tokenIssuedAt?: number } = {};
  if (accountFp !== null) identity.accountFp = accountFp;
  if (tokenIssuedAt !== undefined) identity.tokenIssuedAt = tokenIssuedAt;

  //    Reserve the attempt BEFORE any network I/O. A break is never dropped by
  //    a write that does not own it, or a crash after the lease would silently
  //    discard a 30-day break.
  writeRow(meta, { ...row, outcome: "attempt", attemptStartedAt: nowIso, ...identity });

  // 6. The host's lookup performs both vendor calls and reports what Cursor
  //    said; every cache write below is this module's.
  const answer = await lookup({ teamId, token });
  const membershipType = acceptVendorString(answer.membershipType);
  const isYearlyPlan = typeof answer.isYearlyPlan === "boolean" ? answer.isYearlyPlan : undefined;

  if (answer.outcome === "error") {
    return finishError(
      meta,
      row,
      identity,
      nowMs,
      { errorKind: boundedErrorKind(answer.errorKind), ...(answer.status === undefined ? {} : { status: answer.status }) },
      membershipType,
      isYearlyPlan,
    );
  }

  if (answer.outcome === "not_team" || answer.outcome === "enterprise") {
    // An Enterprise contract keeps its raw values: a consumer can key on the
    // membership string being present, so clearing them would leave only the one
    // cycle that fetched carrying the enterprise signal. Either way the vendor answered, so this is an owning
    // write that clears any break: a response disproves the refusal the break
    // records, and a contract team never takes the `ok` path, so without the
    // clear its break would outlive that refusal.
    const next: SeatTierCacheRow = {
      ...row,
      outcome: answer.outcome,
      fetchedAt: nowIso,
      billingTier: undefined,
      teamMembershipType: membershipType,
      isYearlyPlan,
      ...identity,
      breakUntil: undefined,
    };
    writeRow(meta, next);
    logAttempt(answer.outcome, undefined, answer.status);
    return {
      outcome: answer.outcome,
      status: answer.status,
      stamp: stampFromRow(next),
      attempted: true,
    };
  }

  if (answer.outcome === "members_truncated" || answer.outcome === "identity_unmatched") {
    return finishTerminal(
      meta,
      row,
      identity,
      nowMs,
      answer.outcome,
      answer.outcome === "members_truncated" ? "PARSE" : undefined,
      answer.status,
      membershipType,
      isYearlyPlan,
    );
  }

  // 7. Stamp. No mapping happens here — the raw string is reported and the
  //    consumer decides what it means, including rejecting a value it does not
  //    recognise. Forwarding an unknown spelling is what makes that rejection
  //    countable at all; dropping it here would silence the single most likely
  //    and most silent vendor breakage.
  const next: SeatTierCacheRow = {
    outcome: "ok",
    fetchedAt: nowIso,
    billingTier: acceptVendorString(answer.outcome === "ok" ? answer.billingTier : undefined),
    teamMembershipType: membershipType,
    isYearlyPlan,
    ...identity,
    attemptStartedAt: undefined,
    breakUntil: undefined,
  };
  writeRow(meta, next);
  logAttempt("ok", undefined, answer.status);
  return {
    outcome: "ok",
    status: answer.status,
    stamp: stampFromRow(next),
    attempted: true,
  };
}

// ── Terminal writes ──────────────────────────────────────────────────────────

function skip(outcome: SeatTierOutcome): SeatTierResolution {
  return { outcome, stamp: {}, attempted: false };
}

/**
 * `no_token` is a read-modify-write that preserves the whole `ok` payload,
 * including its outcome: the token is gone, but the CLI extractor reads this
 * row without needing one at all, and it stamps only from an `ok` row — so
 * overwriting the outcome would cost a tier we can still legitimately serve.
 * `fetchedAt` is left alone, so this records a state without starting a clock.
 */
function recordNoToken(meta: SeatTierMetaStore, nowMs: number): void {
  const row = readRow(meta);
  if (row.outcome === "ok" && withinTtl(row.fetchedAt, nowMs)) return;
  writeRow(meta, { ...row, outcome: "no_token" });
}

/**
 * `token_expired` records a state without overwriting a usable result. A fresh
 * account-matching `ok` row has already returned at the cache branch, so the
 * guard here is the belt to that braces.
 */
function recordTokenExpired(meta: SeatTierMetaStore, nowMs: number): void {
  const row = readRow(meta);
  if (row.outcome === "ok" && withinTtl(row.fetchedAt, nowMs)) return;
  writeRow(meta, { ...row, outcome: "token_expired" });
}

/**
 * An error class sets the outcome, starts the 24-hour clock and applies any
 * break, preserves the account fingerprint, and clears the values — a row that
 * failed must not keep serving a tier it can no longer vouch for.
 */
function finishError(
  meta: SeatTierMetaStore,
  row: SeatTierCacheRow,
  identity: { accountFp?: string; tokenIssuedAt?: number },
  nowMs: number,
  call: { status?: number; errorKind: SeatTierErrorKind },
  membershipType?: string,
  isYearlyPlan?: boolean,
): SeatTierResolution {
  const { errorKind } = call;
  const breakMs = breakFor(call.status);
  const nowIso = new Date(nowMs).toISOString();
  writeRow(meta, {
    ...row,
    outcome: "error",
    fetchedAt: nowIso,
    billingTier: undefined,
    teamMembershipType: membershipType,
    isYearlyPlan,
    ...identity,
    breakUntil:
      breakMs === undefined ? row.breakUntil : new Date(nowMs + breakMs).toISOString(),
  });
  logAttempt("error", errorKind, call.status);
  return {
    outcome: "error",
    errorKind,
    ...(call.status === undefined ? {} : { status: call.status }),
    stamp: {},
    attempted: true,
  };
}

/**
 * A well-formed response that carried no usable tier: a bounded read, or one
 * that does not contain this developer. Neither is a refusal, so neither
 * breaks — but each consumes the day's attempt, because the row is written on
 * every outcome.
 */
function finishTerminal(
  meta: SeatTierMetaStore,
  row: SeatTierCacheRow,
  identity: { accountFp?: string; tokenIssuedAt?: number },
  nowMs: number,
  outcome: Extract<CachedSeatTierOutcome, "identity_unmatched" | "members_truncated">,
  errorKind: SeatTierErrorKind | undefined,
  status: number | undefined,
  membershipType?: string,
  isYearlyPlan?: boolean,
): SeatTierResolution {
  writeRow(meta, {
    ...row,
    outcome,
    fetchedAt: new Date(nowMs).toISOString(),
    billingTier: undefined,
    teamMembershipType: membershipType,
    isYearlyPlan,
    ...identity,
  });
  logAttempt(outcome, errorKind, status);
  return {
    outcome,
    ...(errorKind === undefined ? {} : { errorKind }),
    ...(status === undefined ? {} : { status }),
    stamp: {},
    attempted: true,
  };
}

/**
 * The attempt line, at `info` so a host that drops `debug` still sees it.
 * Emitted once per attempt — so at most once per install per day — and carrying
 * nothing but the outcome, the bounded error kind and the status code. No
 * response content, no request object, no identity.
 */
function logAttempt(
  outcome: SeatTierOutcome,
  errorKind: SeatTierErrorKind | undefined,
  status: number | undefined,
): void {
  logger.info(COMPONENT, SEAT_TIER_ATTEMPT_EVENT, {
    outcome,
    ...(errorKind === undefined ? {} : { error_kind: errorKind }),
    ...(status === undefined ? {} : { status }),
  });
}
