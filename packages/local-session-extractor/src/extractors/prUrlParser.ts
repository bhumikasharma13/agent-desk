// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * parsePRUrl parses a PR/MR URL into its (repo, number) pair. Host-agnostic —
 * supports GitHub ("pull"), GitLab ("-/merge_requests"), Bitbucket
 * ("pull-requests"), and self-hosted variants (github.example.com,
 * gitlab.example.com, etc.).
 *
 * GitLab subgroups are preserved in the repo path: a URL like
 *   https://gitlab.com/group/subgroup/project/-/merge_requests/42
 * parses to { pr_repository: "group/subgroup/project", pr_number: 42 }.
 *
 * Returns null when the URL is malformed or doesn't look like a PR/MR URL.
 */
export function parsePRUrl(
  url: string,
): { pr_url: string; pr_number: number; pr_repository: string } | null {
  if (typeof url !== "string" || url.length === 0) return null;
  // Match by VCS shape so a deeper path that merely contains `/pull/N` (e.g.
  // .../tree/main/pull/5) can't be mistaken for a PR and over-capture the repo:
  //  - GitLab MR: repo is everything before the `/-/` sentinel (subgroups kept).
  //    The repo capture forbids an interior `/-/` so a file route like
  //    .../proj/-/blob/main/-/merge_requests/42 doesn't capture `proj/-/blob/main`
  //    — `/-/merge_requests/` must be the repo delimiter, not a path segment.
  //  - Bitbucket Server (self-hosted): /projects/<KEY>/repos/<NAME>/pull-requests/N.
  //  - GitHub / Bitbucket Cloud: repo is EXACTLY two segments before the keyword.
  const m =
    url.match(/^https?:\/\/[^/\s]+\/((?:(?!\/-\/)[^\s])+)\/-\/merge_requests\/(\d+)(?:[/?#]|$)/) ??
    url.match(/^https?:\/\/[^/\s]+\/(projects\/[^/\s]+\/repos\/[^/\s]+)\/pull-requests\/(\d+)(?:[/?#]|$)/) ??
    url.match(/^https?:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/(?:pull|pull-requests)\/(\d+)(?:[/?#]|$)/);
  if (!m) return null;
  let repo = m[1]!;
  const num = parseInt(m[2]!, 10);
  if (!repo || isNaN(num) || num <= 0 || num > 9_999_999) return null;
  // Bitbucket Server: projects/<KEY>/repos/<NAME> -> <KEY>/<NAME>, the
  // git-remote last-2 form the rest of attribution compares against. A generic
  // last-2 would wrongly yield "repos/<NAME>", so extract KEY and NAME.
  const bbServer = repo.match(/^projects\/([^/\s]+)\/repos\/([^/\s]+)$/);
  if (bbServer) repo = `${bbServer[1]}/${bbServer[2]}`;
  return { pr_url: url, pr_number: num, pr_repository: repo };
}

/**
 * findPRUrlInText scans free-form text for the first PR/MR URL that `parsePRUrl`
 * accepts and returns the parsed reference. Used when consuming shell-command
 * output (gh pr create, MCP tool results) where the URL appears inline.
 *
 * It iterates the scan hits rather than parsing only the first: the scan is
 * intentionally looser than `parsePRUrl` (it tolerates up to 24 path segments),
 * so a deep non-PR URL like .../tree/main/pull/5 can be the first hit — taking
 * only that one would mask a real PR URL appearing later in the same text.
 */
export function findPRUrlInText(
  text: string,
): { pr_url: string; pr_number: number; pr_repository: string } | null {
  // Single source for the scan lives in findAllPRUrlsInText; take its first hit.
  return findAllPRUrlsInText(text)[0] ?? null;
}

/**
 * Returns EVERY distinct PR/MR URL in the text (deduped by URL, first-seen
 * order). `findPRUrlInText` is the take-first-hit convenience over this. Used
 * for output that can create several PRs in one shot — a shell loop running
 * `gh pr create` per ticket, or a batch MCP call.
 */
export function findAllPRUrlsInText(
  text: string,
): Array<{ pr_url: string; pr_number: number; pr_repository: string }> {
  if (typeof text !== "string" || text.length === 0) return [];
  // Per-segment `[^/\s]+` with a bounded `{1,24}` repetition (not a lazy `\S+?`
  // run that can span slashes) keeps the scan linear — a `\S+?` run-to-anchor
  // backtracks O(n) at every `https://` start, which on a large command-output
  // blob (many `https://x/` fragments, no PR keyword) is O(n²) and blocks the
  // event loop for tens of seconds. The cap is 24 so it spans GitLab's deepest
  // namespace nesting — a group + up to 20 subgroups + the project + the `/-/`
  // sentinel — plus a margin of 2.
  const pat = /https?:\/\/[^/\s]+(?:\/[^/\s]+){1,24}?\/(?:pull|pull-requests|-\/merge_requests)\/\d+/g;
  const hits = text.match(pat);
  if (!hits) return [];
  const out: Array<{ pr_url: string; pr_number: number; pr_repository: string }> = [];
  const seen = new Set<string>();
  for (const candidate of hits) {
    const parsed = parsePRUrl(candidate);
    if (parsed && !seen.has(parsed.pr_url)) {
      seen.add(parsed.pr_url);
      out.push(parsed);
    }
  }
  return out;
}
