// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Strip ANSI escape sequences and control characters from a string.
 * Prevents malicious skill names from injecting terminal formatting.
 */
export function stripTerminalEscapes(str: string): string {
  return str
    .replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, '') // DCS, SOS, PM and APC strings (7- or 8-bit), to ST or the end
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '') // CSI (ESC [ or U+009B), with private and intermediate bytes
    // OSC sequences terminated by BEL or ST on their line. One left open there is kept, to the
    // end of its line, for the next step: no intro after it on that line is closed either, and
    // retrying from each of them made a line of open intros quadratic.
    .replace(/(?:\x1b\]|\x9d)(?:(?!\x07|\x1b\\|\x9c).)*(\x07|\x1b\\|\x9c)?/g, (seq: string, st?: string) => (st === undefined ? seq : ''))
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*/g, '')        // Unterminated OSC sequences (strip to end)
    .replace(/\x07/g, '')                               // Standalone BEL character
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '') // Other C0 controls (except \t \n \r), DEL and C1
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ''); // Bidirectional marks, overrides and isolates
}

/**
 * Show control characters (C0, DEL, C1) as `\xNN`, and bidirectional controls and lone
 * surrogates as `\uNNNN`, so the text cannot drive a terminal and two strings that differ
 * only in such a character stay different. `keepLines` leaves tab, newline and carriage
 * return as they are.
 */
export function escapeControls(str: string, keepLines = false): string {
  return str
    .replace(keepLines ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g : /[\x00-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
