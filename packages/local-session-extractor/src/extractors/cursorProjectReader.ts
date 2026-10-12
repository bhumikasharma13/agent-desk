// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import path from "node:path";
import fs from "node:fs";

export interface CursorProjectSignals {
  // Sub-agent transcripts: count of .jsonl files in agent-transcripts/sub-agents/
  sub_agent_count?: number;
  // Agent transcripts: count of .txt files in agent-transcripts/
  agent_transcript_count?: number;
  // Tool outputs: count of .txt files in agent-tools/
  tool_output_count?: number;
  // Terminal sessions: count of .txt files in terminals/
  terminal_session_count?: number;
  // Per-project MCP servers: names from mcps/<server>/ directories
  project_mcp_server_names?: string[];
}

/**
 * Reads Cursor 3+ per-project signals from a workspace's project directory.
 * Uses probe-and-skip: checks directory existence before reading.
 * Returns null if the project directory doesn't exist (Cursor 2.x).
 *
 * @param projectDir - Path to ~/.cursor/projects/<workspace-hash>/
 */
/**
 * Counts files matching an extension in a directory. Returns 0 if dir
 * doesn't exist or read fails (probe-and-skip).
 */
function countFiles(dir: string, ext: string): number {
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(ext)).length;
  } catch {
    return 0;
  }
}

export function readCursorProjectSignals(projectDir: string): CursorProjectSignals | null {
  if (!fs.existsSync(projectDir)) return null;

  const signals: CursorProjectSignals = {};

  const subAgents = countFiles(path.join(projectDir, "agent-transcripts", "sub-agents"), ".jsonl");
  if (subAgents > 0) signals.sub_agent_count = subAgents;

  const transcripts = countFiles(path.join(projectDir, "agent-transcripts"), ".txt");
  if (transcripts > 0) signals.agent_transcript_count = transcripts;

  const toolOutputs = countFiles(path.join(projectDir, "agent-tools"), ".txt");
  if (toolOutputs > 0) signals.tool_output_count = toolOutputs;

  const terminals = countFiles(path.join(projectDir, "terminals"), ".txt");
  if (terminals > 0) signals.terminal_session_count = terminals;

  // Per-project MCP servers (directory names under mcps/)
  const mcpsDir = path.join(projectDir, "mcps");
  if (fs.existsSync(mcpsDir)) {
    try {
      const entries = fs.readdirSync(mcpsDir, { withFileTypes: true });
      const serverNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      if (serverNames.length > 0) signals.project_mcp_server_names = serverNames;
    } catch { /* skip */ }
  }

  return Object.keys(signals).length > 0 ? signals : null;
}

/**
 * Scans all subdirectories under ~/.cursor/projects/ and aggregates
 * Cursor 3+ per-project signals across all workspaces.
 * Returns null if the projects directory doesn't exist (Cursor 2.x).
 *
 * @param cursorDir - Path to ~/.cursor/
 */
export function readAllCursorProjectSignals(cursorDir: string): CursorProjectSignals | null {
  const projectsDir = path.join(cursorDir, "projects");
  if (!fs.existsSync(projectsDir)) return null;

  let entries: string[];
  try {
    entries = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }

  const aggregated: CursorProjectSignals = {};

  for (const entry of entries) {
    const projectDir = path.join(projectsDir, entry);
    try {
      const stat = fs.statSync(projectDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const signals = readCursorProjectSignals(projectDir);
    if (!signals) continue;

    // Aggregate counts
    if (signals.sub_agent_count) {
      aggregated.sub_agent_count = (aggregated.sub_agent_count ?? 0) + signals.sub_agent_count;
    }
    if (signals.agent_transcript_count) {
      aggregated.agent_transcript_count =
        (aggregated.agent_transcript_count ?? 0) + signals.agent_transcript_count;
    }
    if (signals.tool_output_count) {
      aggregated.tool_output_count =
        (aggregated.tool_output_count ?? 0) + signals.tool_output_count;
    }
    if (signals.terminal_session_count) {
      aggregated.terminal_session_count =
        (aggregated.terminal_session_count ?? 0) + signals.terminal_session_count;
    }

    // Merge MCP server names (deduplicate)
    if (signals.project_mcp_server_names) {
      const existing = new Set(aggregated.project_mcp_server_names ?? []);
      for (const name of signals.project_mcp_server_names) {
        existing.add(name);
      }
      aggregated.project_mcp_server_names = Array.from(existing);
    }
  }

  return Object.keys(aggregated).length > 0 ? aggregated : null;
}
