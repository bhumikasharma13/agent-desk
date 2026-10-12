// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Logical line count of written text, matching how git and unified-diff patches
 * count lines: a trailing newline terminates the final line rather than starting
 * an empty one, and empty content is zero lines. So `"a\n"` is 1 line (not the 2
 * a naive `split("\n").length` reports), `"a\nb"` is 2, and `""` is 0. Use this
 * for per-message LOC so it reconciles with patch and git line counts.
 */
export function writtenLineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}
