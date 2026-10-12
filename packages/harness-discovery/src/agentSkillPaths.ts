// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

/**
 * Where each known AI coding agent keeps its user-level skills, so a skill's
 * `active_in_agents` can name every agent that carries a skill of the same name.
 * Every `name` is a tool's name, since it becomes an entry of `active_in_agents`; a tool
 * that reads more than one folder has a row per folder and is listed once.
 */

import os from "os";
import path from "path";

// Known agents and the user-level config directories they read skills from, relative to HOME.
const AGENT_PROBES: Array<{ name: string; configDir: string; skillsSubdir?: string }> = [
  // Primary agents
  {
    name: "Claude Code",
    configDir: path.join(".claude"),
  },
  {
    name: "Cursor",
    configDir: path.join(".cursor"),
    skillsSubdir: "skills-cursor",
  },
  {
    name: "Windsurf",
    configDir: path.join(".codeium", "windsurf"),
  },
  {
    name: "Kiro",
    configDir: path.join(".kiro"),
  },
  {
    name: "Cursor",
    configDir: path.join(".cursor", "rules"),
  },
  {
    name: "Copilot",
    configDir: path.join(".config", "github-copilot"),
    skillsSubdir: path.join("..", "..", ".github", "skills"),
  },
  // Other agents whose user-level skills folder is checked for a skill of the same name.
  {
    name: "Cline",
    configDir: path.join(".cline"),
  },
  {
    name: "Codex",
    configDir: path.join(".codex"),
  },
  {
    name: "Continue",
    configDir: path.join(".continue"),
  },
  {
    name: "Amp",
    configDir: path.join(".amp"),
  },
  {
    name: "Zed",
    configDir: path.join(".zed"),
  },
  {
    name: "Aider",
    configDir: path.join(".aider"),
  },
  {
    name: "Void",
    configDir: path.join(".void"),
  },
  {
    name: "Roo",
    configDir: path.join(".roo"),
  },
  {
    name: "Trae",
    configDir: path.join(".trae"),
  },
  {
    // The cross-tool skills folder. Of the tools this package reads, Codex reads it
    // (codex.ts collects user skills from ~/.agents/skills).
    name: "Codex",
    configDir: path.join(".agents"),
  },
];

/**
 * [agent name, user-level skills directory under `home`] pairs, in AGENT_PROBES order (default
 * home: the current HOME, read at call time so each scan uses its own). A name can repeat.
 */
export function agentSkillPaths(home: string = os.homedir()): Array<[agent: string, dir: string]> {
  return AGENT_PROBES.map((p) => [p.name, path.join(home, p.configDir, p.skillsSubdir ?? "skills")]);
}
