// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The shape a Claude Code transcript uses for a slash-command turn — one definition,
 * because every reader of it had grown its own and they disagreed.
 *
 * Typing `/loop …` does not store the text you typed. Claude Code stores markup, in
 * either tag order:
 *
 *   <command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>
 *   <command-message>deploy</command-message>\n<command-name>/deploy</command-name>\n<command-args>--dry-run …</command-args>
 *
 * A reader that expects a literal leading `/` therefore sees a turn beginning with `<`
 * and concludes no command was invoked — silently, for every command anyone types.
 */

// Tag readers, unanchored on purpose: they serve label building, where the caller already
// knows the text is a command turn and only wants its parts to display. Whether a turn IS
// an invocation is `invokedCommandName`'s question, and that one anchors.
export const COMMAND_NAME_RE = /<command-name>([^<]+)<\/command-name>/;
export const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * The markup an invocation OPENS with. `<command-message>` may lead or follow, so both
 * orders are admitted, but the run of tags must start the turn.
 */
const COMMAND_TURN_RE = /^\s*(?:<command-message>[^<]*<\/command-message>\s*)?<command-name>([^<]+)<\/command-name>/;

/** A command name: a slug, optionally `plugin:skill`-qualified. */
const COMMAND_NAME_TOKEN_RE = /^[a-z0-9][a-z0-9:_-]*$/;

/** Lower-cases and strips the leading slash so `/Loop`, `loop`, and `/loop` are one identity. */
function normalize(raw: string): string | undefined {
  const name = raw.trim().replace(/^\//, "").trim().toLowerCase();
  return name && COMMAND_NAME_TOKEN_RE.test(name) ? name : undefined;
}

/**
 * Returns the command a user turn invoked, or undefined.
 *
 * Both real shapes are accepted — the stored markup, and a bare `/name` (which is what a
 * command relayed as plain text still looks like).
 *
 * Both are anchored to the start of the turn, and the anchor is load-bearing rather than
 * tidiness. A command *mentioned* is not a command *invoked*, and the markup form is
 * quoted far more often than it is typed — it rides in tool results, pasted transcripts,
 * and prose about commands. Matching a mention would invent declarations wholesale.
 */
export function invokedCommandName(text: string): string | undefined {
  const markup = COMMAND_TURN_RE.exec(text)?.[1];
  if (markup !== undefined) return normalize(markup);

  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return undefined;
  return normalize(trimmed.slice(1).split(/[\s\n]/, 1)[0] ?? "");
}

/**
 * A `<local-command-stdout>` block that OPENS the turn — Claude Code injects a local command's
 * output (including `!`-bash-mode output) as a user turn.
 */
const LOCAL_COMMAND_STDOUT_RE = /^\s*<local-command-stdout>/;

/**
 * A `<task-notification>` envelope that OPENS the turn — the harness injects a background task's
 * completion (often wrapping a sub-agent `<result>`) as a user turn. Main-session and without
 * isMeta, so it reads HUMAN unless caught here; measured as the largest such class in the corpus.
 */
const TASK_NOTIFICATION_RE = /^\s*<task-notification>/;

/**
 * Whether a user turn's text is machine-injected markup that Claude Code does NOT flag with
 * `isMeta`: a slash-command wrapper (`<command-name>` markup) with no user args, a
 * `<local-command-stdout>` block, or a `<task-notification>` envelope. Measured across the local
 * corpus, `isMeta` is set on skill bodies, caveats and hook feedback but never on these — so
 * authorship must catch them from the content, or they read as HUMAN. (isSidechain-tagged injected
 * turns — subagent prompts, hook anchors — are handled separately via isSubAgent.)
 *
 * A command wrapper is fully machine ONLY when the person passed no args: a `<command-args>` value
 * (e.g. `/goal <requirements>`) is user-authored content, so a command turn WITH args is not
 * wholly injected and reads HUMAN (the wrapper markup rides along; a single per-message label
 * cannot split the two). A bare `/model` (empty args) is wholly machine → injected.
 *
 * Every check anchors to the turn's start, so a marker merely MENTIONED in prose is not caught. The
 * command check uses the stored-markup matcher (COMMAND_TURN_RE), NOT invokedCommandName's
 * bare-slash branch: a real command is stored as `<command-name>` markup, so a bare `/word` opening
 * is human prose (`/cc @reviewer`), not an injected wrapper — counting it would erase a human turn.
 */
export function isInjectedUserMarkup(text: string): boolean {
  if (COMMAND_TURN_RE.test(text)) return invokedCommandArgs(text).trim() === "";
  return LOCAL_COMMAND_STDOUT_RE.test(text) || TASK_NOTIFICATION_RE.test(text);
}

/**
 * Returns the ARGUMENTS a user turn passed to the command it invoked, or "".
 *
 * Gated on `invokedCommandName` so the same anchor decides both questions: a turn that merely
 * MENTIONS a command has no arguments to report, and reading them anyway would attribute a
 * quoted example's text to an invocation that never happened.
 *
 * The two real shapes put the arguments in different places — inside `<command-args>` for the
 * stored markup, after the first whitespace for a plain-text `/name`. Both are handled here so
 * no caller has to know which shape it received.
 */
export function invokedCommandArgs(text: string): string {
  if (invokedCommandName(text) === undefined) return "";

  const markupArgs = COMMAND_ARGS_RE.exec(text)?.[1];
  if (markupArgs !== undefined) return markupArgs.trim();
  // A markup turn with no `<command-args>` tag at all took no arguments; falling through to the
  // bare-slash branch would return the whole markup run as if it were an argument string.
  if (COMMAND_TURN_RE.test(text)) return "";

  const trimmed = text.trimStart();
  const firstSpace = trimmed.search(/[\s\n]/);
  return firstSpace < 0 ? "" : trimmed.slice(firstSpace).trim();
}
