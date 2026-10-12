// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Helpers shared by the Cursor extractors (IDE composer `cursorExtractor.ts`,
 * terminal CLI `cursorCliExtractor.ts`, and the row builder `cursorSessionRow.ts`).
 * One copy of the MCP-config read and of the tool-argument preview, so the
 * surfaces cannot drift apart.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redactText } from "../redaction";
import { homeDir } from "./pathResolver";

const MAX_ARG_PREVIEW_CHARS = 160;

/**
 * A tool argument as its `[Tool: …]` placeholder shows it: the value whole, or past
 * MAX_ARG_PREVIEW_CHARS redacted and then cut, with an ellipsis. Redacting first keeps a
 * token straddling the cut whole for its pattern; cut first, the fragment left is too
 * short to match once the placeholder is redacted. The whole value is redacted, not a
 * prefix: a key block redacted to eight characters could pull a token cut at a prefix's
 * end into the preview.
 */
export function toolArgPreview(value: string): string {
  if (value.length <= MAX_ARG_PREVIEW_CHARS) return value;
  const redacted = redactText(value);
  return redacted.length > MAX_ARG_PREVIEW_CHARS ? redacted.slice(0, MAX_ARG_PREVIEW_CHARS) + "…" : redacted;
}

/**
 * MCP server names from ~/.cursor/mcp.json (shared by the IDE and CLI surfaces).
 * Returns only the server-name keys — never command args or env vars, which can
 * carry secrets.
 */
export function readCursorMcpServerNames(): string[] {
  try {
    const mcpPath = join(homeDir(), ".cursor", "mcp.json");
    if (!existsSync(mcpPath)) return [];
    const config = JSON.parse(readFileSync(mcpPath, "utf-8")) as Record<string, unknown>;
    const servers = config.mcpServers;
    if (typeof servers === "object" && servers !== null && !Array.isArray(servers)) {
      return Object.keys(servers as Record<string, unknown>);
    }
  } catch {
    // mcp.json absent or malformed.
  }
  return [];
}
