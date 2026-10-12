// Portions copyright (c) 2025 Banodoco (Dataclaw, MIT); see NOTICE.
// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Secret detection & redaction.
 *
 * Ordered regex patterns (most-specific → least-specific). The secret-detection
 * patterns are adapted from Dataclaw (MIT); see NOTICE. Scanning collects match
 * spans, merges the overlapping ones, then replaces them in one pass.
 */

// ── Replacement placeholder ──────────────────────────────────────────────────

const REDACTED = "████████";

// ── Patterns ─────────────────────────────────────────────────────────────────
// Order matters: more-specific patterns must come first so they win when
// spans overlap (e.g. a full JWT beats the partial JWT prefix).

/**
 * `<key>=<value>`, with a value of any length, for the given key alternation, unless the key sits in a URL
 * query (`?key=` / `&key=`, left to the query-parameter pattern). A quote may
 * close the key, so JSON's `"key": "value"` matches too. The lookahead gates
 * the lookbehind on a real key followed by `=` or `:`, and the lookbehind
 * scans back at most 256 characters, so a long run of word characters is
 * scanned in linear time; an unbounded lookbehind made it quadratic.
 */
function keyAssignment(keys: string): RegExp {
  return new RegExp(`(?=(?:${keys})["']?\\s*[=:])(?<![?&][\\w-]{0,256})(?:${keys})["']?\\s*[=:]\\s*['"]?[^\\s'"]+`, "gi");
}

const SECRET_PATTERNS: RegExp[] = [
  // 1. Full JWT (header.payload.signature): see collectJwtSpans.
  // 2. Partial JWT (just the header, catches truncated tokens)
  /eyJ[A-Za-z0-9_-]{15,}/g,
  // 3. Google OAuth client secrets (GOCSPX- prefix)
  /GOCSPX-[A-Za-z0-9_-]{20,}/g,
  // 4. Google API keys (AIza prefix)
  /AIza[0-9A-Za-z\-_]{35}/g,
  // 5. Google OAuth access tokens (ya29. prefix)
  /ya29\.[0-9A-Za-z\-_]{20,}/g,
  // 6. Stripe live/test/restricted keys
  /(?:sk|rk)_(?:live|test)_[0-9a-zA-Z]{20,}/g,
  // 7. SendGrid API keys
  /SG\.[a-zA-Z0-9_-]{20,}/g,
  // 8. Twilio API key SIDs (SK + 32 lowercase hex)
  /SK[a-z0-9]{32}/g,
  // 9. Connection strings with a password: see collectConnectionStringSpans.
  // 10. Anthropic API keys
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // 11. OpenAI API keys: project, service-account and admin keys, then the legacy form
  /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9]{40,}/g,
  // 12. HuggingFace tokens
  /hf_[A-Za-z0-9]{20,}/g,
  // 13. GitHub tokens (ghp, gho, ghu, ghs, ghr) + fine-grained PATs (github_pat_)
  /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/g,
  // 14. PyPI tokens
  /pypi-[A-Za-z0-9_-]{50,}/g,
  // 15. NPM tokens
  /npm_[A-Za-z0-9]{30,}/g,
  // 16. AWS access key IDs (long-term AKIA + temporary/STS ASIA)
  /(?:AKIA|ASIA)[0-9A-Z]{16}/g,
  // 17. AWS secret access keys (in config/env assignments)
  /(?:aws_secret_access_key|secret_key)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}/gi,
  // 18. Slack tokens (bot/user/legacy + xoxe refresh + xapp app-level)
  /(?:xox[bpsa]|xoxe|xapp)-[A-Za-z0-9-]{20,}/g,
  // 19. Discord webhook URLs
  /https?:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/g,
  // 20. Private keys (PEM blocks), and 20b. a block with no END line: see collectPrivateKeySpans.
  // 21. Bearer tokens (the HTTP scheme name is case-insensitive)
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // 22. Env variable assignments for sensitive keys
  // URL query params are handled by pattern 25, so exclude ?key= / &key=
  // forms here and let assignment values keep literal ampersands.
  // The lookbehind blocks when preceded by ?<word> or &<word> (URL query keys)
  // but allows compound env vars like GOOGLE_SECRET= or OAUTH_TOKEN=.
  keyAssignment("SECRET|PASSWORD|PASSWD|PWD|TOKEN|API_KEY|AUTH_KEY|ACCESS_KEY|SERVICE_KEY|DB_PASSWORD|SUPABASE_KEY|PRIVATE_KEY|CLIENT_SECRET|REFRESH_TOKEN|SIGNING_KEY|WEBHOOK_SECRET|SESSION_SECRET|ENCRYPTION_KEY|APP_SECRET|MASTER_KEY"),
  // 23. Generic secret key-value patterns (covers space/underscore/hyphen separators in key names)
  keyAssignment("secret[_-]?key|api[\\s_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token|client[_-]?secret|refresh[_-]?token|webhook[_-]?secret|signing[_-]?key|session[_-]?secret|encryption[_-]?key|passwd|pwd"),
  // 24. Space-separated credential pairs (log lines, config dumps)
  // e.g. "username foo password bar" or "DSN: host=localhost password secret123"
  /(?<![?&])\b(?:password|passwd|pwd|pass)\s+(?!(?:is|was|has|to|for|in|on|at|by|of|the|a|an|from|with|this|that|these|those|it|its)\b)[^\s'"]{8,}/gi,
  // 25. URL auth query parameters
  /[?&](?:key|token|secret|password|apikey|api_key|access_token|auth|client_secret|refresh_token|client_id)=[^&\s]+/gi,
  // 26. Email addresses, with letters of any script in the local part and the domain.
  // The local part is capped at 256 characters so a long run of address characters is
  // scanned in linear time. A longer local part has its last 256 characters masked with
  // the domain; the domain run is already scanned once per `@`.
  /[\p{L}\p{N}._%+-]{1,256}@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu,
];

// ── Entropy-based detection ──────────────────────────────────────────────────

/** Shannon entropy of a string (bits per character). */
function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) {
    freq.set(c, (freq.get(c) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** True if the string contains at least 3 of: uppercase, lowercase, digits, special chars. */
function hasMixedCharTypes(s: string): boolean {
  let types = 0;
  if (/[A-Z]/.test(s)) types++;
  if (/[a-z]/.test(s)) types++;
  if (/[0-9]/.test(s)) types++;
  if (/[^A-Za-z0-9]/.test(s)) types++;
  return types >= 3;
}

/**
 * Obvious code/SQL snippets that should not be treated as quoted secrets.
 * Keep this narrow: whole-phrase cues are safer than blocking common words.
 */
const CODE_SNIPPET_RE =
  /\bSELECT\b[\s\S]{0,120}\bFROM\b|\b(?:INSERT INTO|UPDATE\s+\w+\s+SET|DELETE FROM|CREATE TABLE|ALTER TABLE|DROP TABLE)\b|\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|\bfunction\s+[A-Za-z_$][\w$]*\s*\(|\b(?:if|for|while|switch)\s*\(|\bimport\s+[\s\S]{0,80}\s+from\b|\bexport\s+(?:default|const|function|class)\b/i;

/**
 * Matches high-entropy strings inside quotes that look like secrets.
 * Each quote type gets its own pattern so that an apostrophe inside a
 * double-quoted string (or vice-versa) does not terminate the match.
 * The single-quote pattern uses lookbehind/lookahead to skip English
 * contractions (I've, it's, don't, user's) — those always have a word
 * character adjacent to the apostrophe.
 *
 * Criteria for redaction:
 *   - 16+ chars long
 *   - Shannon entropy > 3.5
 *   - Mixed character types (at least 3 of upper, lower, digit, other)
 */
const QUOTED_STRING_PATTERNS: RegExp[] = [
  /"([^"]{16,})"/g,
  /(?<!\w)'([^']{16,})'(?!\w)/g,
  /`([^`]{16,})`/g,
];

// ── Match span ───────────────────────────────────────────────────────────────

export interface Span {
  start: number;
  end: number;
}

// ── Contextual AWS secret key (in prose) ─────────────────────────────────────
// AWS secret keys have no fixed prefix, so the assignment-anchored rule
// (pattern 17) misses one pasted in prose. Redact a standalone 40-char base64
// token when a cue sits within AWS_CUE_WINDOW chars, with two cue strengths: an
// adjacent AKIA/ASIA access-key id is authoritative — redact regardless of char
// mix (a genuine secret can be letters-only); a weaker whole-word aws/secret/
// credential cue additionally requires mixed char types, so a lowercase-hex git
// SHA (2 types) is not redacted merely for sitting near a common word. Word
// boundaries avoid "jaws"/"secretary". A cue-less secret, or a non-AWS
// prefixless form (GCP/Azure), is out of scope.
const AWS_SECRET_CANDIDATE_RE = /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g;
const AWS_KEYID_CUE_RE = /(?:AKIA|ASIA)[0-9A-Z]{16}/;
const AWS_WORD_CUE_RE = /\b(?:aws|secrets?|credentials?)\b/i;
const AWS_CUE_WINDOW = 80;

function collectAwsSecretSpans(text: string): Span[] {
  const spans: Span[] = [];
  AWS_SECRET_CANDIDATE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = AWS_SECRET_CANDIDATE_RE.exec(text)) !== null) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    // Check the windows before and after separately, never concatenated, so the
    // join can't fabricate a cue from unrelated text on either side.
    const before = text.slice(Math.max(0, start - AWS_CUE_WINDOW), start);
    const after = text.slice(end, end + AWS_CUE_WINDOW);
    const keyIdNearby = AWS_KEYID_CUE_RE.test(before) || AWS_KEYID_CUE_RE.test(after);
    const wordCueNearby = AWS_WORD_CUE_RE.test(before) || AWS_WORD_CUE_RE.test(after);
    if (keyIdNearby || (wordCueNearby && hasMixedCharTypes(token))) {
      spans.push({ start, end });
    }
  }
  return spans;
}

// ── Connection strings with a password ───────────────────────────────────────
// `scheme://user:password@host…` for any scheme `[A-Za-z][A-Za-z0-9+.-]*`. The host starts
// after the last `@` in the run of non-space text, whatever follows it, so an empty host
// (`@/db?host=/tmp`, `@:5433`, `@"`) counts. The user part runs to the first
// whitespace, `/`, `?`, `#` or `:`, so it may hold `@` (`user@server:password@host`). The
// password is anything from that `:` to the host `@`, so it may hold `/`, `#`, `?`, quotes
// and `@`. The span runs from the scheme through the host and the rest of the URL, to the
// next whitespace or quote. An `@` later in the path, or a `host:port/…@…` with no user, is
// masked too: the safe direction. A `user@host:port` with no later `@` is left alone. A
// scanner rather than a regex, linear in the text: each run's host `@` and URL end are
// found once, and the `://` inside a span already pushed are skipped.
const SCHEME_CHAR = /[A-Za-z0-9+.-]/;
const SCHEME_START = /[A-Za-z]/;
const URL_END = /[\s"'`]/;
const USER_END = /[\s/?#:]/;

function collectConnectionStringSpans(text: string): Span[] {
  const spans: Span[] = [];
  let runStart = 0;
  let runEnd = -1;
  let lastHostAt = -1;
  let urlEnd = -1;
  for (let sep = text.indexOf("://"); sep !== -1; sep = text.indexOf("://", sep + 1)) {
    if (sep >= runEnd) {
      // The run of non-space text holding this `://`, its host `@` and where its URL ends.
      runStart = sep;
      while (runStart > 0 && !/\s/.test(text[runStart - 1]!)) runStart--;
      runEnd = sep;
      while (runEnd < text.length && !/\s/.test(text[runEnd]!)) runEnd++;
      lastHostAt = -1;
      for (let k = runEnd - 1; k > sep; k--) {
        if (text[k] === "@") {
          lastHostAt = k;
          break;
        }
      }
      urlEnd = lastHostAt + 1;
      while (lastHostAt !== -1 && urlEnd < text.length && !URL_END.test(text[urlEnd]!)) urlEnd++;
    }
    if (lastHostAt <= sep) continue;
    let start = sep;
    while (start > runStart && SCHEME_CHAR.test(text[start - 1]!)) start--;
    while (start < sep && !SCHEME_START.test(text[start]!)) start++;
    if (start === sep) continue;
    let colon = sep + 3;
    while (colon < runEnd && !USER_END.test(text[colon]!)) colon++;
    if (text[colon] !== ":" || colon >= lastHostAt) continue;
    spans.push({ start, end: urlEnd });
    // Every later `://` before the host `@` gives a span inside this one.
    sep = lastHostAt;
  }
  return spans;
}

// ── Full JWTs ────────────────────────────────────────────────────────────────
// The spans of `/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g`, found in
// linear time. `.` is outside the class, so each segment is its whole run of class
// characters and a match is fixed by where it starts. Every `eyJ` inside one run shares
// that run's end, so when the first fails the later ones fail too (only their first
// segment is shorter) and the scan resumes at the run's end. The regex retried at each
// `eyJ`, rescanning the run: quadratic in a run of them.
const JWT_RUN = /[A-Za-z0-9_-]*/y;

function jwtRunEnd(text: string, from: number): number {
  JWT_RUN.lastIndex = from;
  JWT_RUN.exec(text);
  return JWT_RUN.lastIndex;
}

/** Full-JWT spans, as the regex above finds them. Exported for the equivalence test. */
export function collectJwtSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (let at = text.indexOf("eyJ"); at !== -1; ) {
    const header = jwtRunEnd(text, at + 3);
    let resume = header;
    if (header - (at + 3) >= 20 && text[header] === ".") {
      const payload = jwtRunEnd(text, header + 1);
      if (payload - (header + 1) >= 20 && text[payload] === ".") {
        const signature = jwtRunEnd(text, payload + 1);
        if (signature - (payload + 1) >= 10) {
          spans.push({ start: at, end: signature });
          resume = signature;
        }
      }
    }
    at = text.indexOf("eyJ", resume);
  }
  return spans;
}

// ── Private keys (PEM blocks) ────────────────────────────────────────────────
// The spans of the two regexes
//   /-----BEGIN (?:KINDS)?PRIVATE KEY-----[\s\S]*?-----END (?:KINDS)?PRIVATE KEY-----/g
//   /-----BEGIN (?:KINDS)?PRIVATE KEY-----(?![\s\S]*?-----END (?:KINDS)?PRIVATE KEY-----)[\s\S]*/g
// found in linear time: each BEGIN line to the first END line after it, and the first
// BEGIN line with no END line anywhere after it (text cut inside the key) to the end of
// the text. Each BEGIN line ends after the one before it, so once one has no END line
// after it none later does. The regexes looked ahead to the end of the text from every
// BEGIN line: quadratic in a run of them.
const PEM_KINDS = ["ENCRYPTED ", "RSA ", "EC ", "DSA ", "OPENSSH ", ""];
const PEM_BEGIN = "-----BEGIN ";
const PEM_END = "-----END ";
const PEM_TAIL = "PRIVATE KEY-----";

/** Where the `opener … PRIVATE KEY-----` line starting at `at` ends, or -1 when there is none. */
function pemLineEnd(text: string, at: number, opener: string): number {
  if (!text.startsWith(opener, at)) return -1;
  const kindAt = at + opener.length;
  for (const kind of PEM_KINDS) {
    if (text.startsWith(kind, kindAt) && text.startsWith(PEM_TAIL, kindAt + kind.length)) {
      return kindAt + kind.length + PEM_TAIL.length;
    }
  }
  return -1;
}

/** The first `opener` line starting at or after `from`. */
function nextPemLine(text: string, from: number, opener: string): Span | undefined {
  for (let at = text.indexOf(opener, from); at !== -1; at = text.indexOf(opener, at + 1)) {
    const end = pemLineEnd(text, at, opener);
    if (end !== -1) return { start: at, end };
  }
  return undefined;
}

/** Where the last END line starts, or -1 when there is none. */
function lastPemEndStart(text: string): number {
  for (let at = text.lastIndexOf(PEM_END); at !== -1; at = at === 0 ? -1 : text.lastIndexOf(PEM_END, at - 1)) {
    if (pemLineEnd(text, at, PEM_END) !== -1) return at;
  }
  return -1;
}

/** Private-key spans, as the two regexes above find them. Exported for the equivalence test. */
export function collectPrivateKeySpans(text: string): Span[] {
  const spans: Span[] = [];
  for (let begin = nextPemLine(text, 0, PEM_BEGIN); begin; ) {
    const end = nextPemLine(text, begin.end, PEM_END);
    if (!end) break;
    spans.push({ start: begin.start, end: end.end });
    begin = nextPemLine(text, end.end, PEM_BEGIN);
  }
  const lastEnd = lastPemEndStart(text);
  for (let begin = nextPemLine(text, 0, PEM_BEGIN); begin; begin = nextPemLine(text, begin.start + 1, PEM_BEGIN)) {
    if (lastEnd < begin.end) {
      spans.push({ start: begin.start, end: text.length });
      break;
    }
  }
  return spans;
}

/**
 * Collect all match spans from the regex patterns.
 */
function collectSpans(text: string): Span[] {
  const spans: Span[] = [];

  // Regex-based patterns
  for (const pattern of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  // Entropy-based detection (quoted strings)
  for (const pattern of QUOTED_STRING_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const inner = match[1]!;
      if (shannonEntropy(inner) > 3.5 && hasMixedCharTypes(inner) && !CODE_SNIPPET_RE.test(inner)) {
        // Redact the inner content (not the quotes)
        const innerStart = match.index + match[0].indexOf(inner);
        spans.push({ start: innerStart, end: innerStart + inner.length });
      }
    }
  }

  // Contextual AWS secret keys pasted in prose (no fixed prefix).
  spans.push(...collectAwsSecretSpans(text));
  spans.push(...collectConnectionStringSpans(text));
  spans.push(...collectJwtSpans(text));
  spans.push(...collectPrivateKeySpans(text));

  return spans;
}

/**
 * Merge overlapping spans into non-overlapping ones.
 */
function mergeSpans(spans: Span[]): Span[] {
  if (spans.length === 0) return [];

  spans.sort((a, b) => a.start - b.start || b.end - a.end);

  const merged: Span[] = [spans[0]!];
  for (let i = 1; i < spans.length; i++) {
    const current = spans[i]!;
    const last = merged[merged.length - 1]!;

    if (current.start <= last.end) {
      // Overlapping — extend
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

// ── Public API ───────────────────────────────────────────────────────────────

/** The merged, non-overlapping spans `redactSecrets` replaces, in text order. */
export function secretSpans(text: string): Span[] {
  return mergeSpans(collectSpans(text));
}

/**
 * Scans text for secrets and replaces them with a redaction placeholder.
 * Returns the redacted text. The result is built from slices in one pass, so
 * the cost grows with the text, not with the text times the number of matches.
 */
export function redactSecrets(text: string): string {
  if (text.length === 0) return text;

  const spans = secretSpans(text);
  if (spans.length === 0) return text;

  const parts: string[] = [];
  let at = 0;
  for (const span of spans) {
    parts.push(text.slice(at, span.start), REDACTED);
    at = span.end;
  }
  parts.push(text.slice(at));
  return parts.join("");
}
