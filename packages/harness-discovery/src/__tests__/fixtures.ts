// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// Shared fixtures: a throwaway root per test file holding a fixture HOME and fixture repos.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const sha256 = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

export function write(path: string, body: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

export function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: ["ignore", "ignore", "pipe"], // stderr lands in the error when a fixture command fails
  });
}

export const SKILL = (name: string, description = "A skill that is long enough to be the description."): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`;

/** A fixture area: `root` (canonical), `home` inside it, and HOME pointed there. */
export class Fixture {
  readonly root = realpathSync(mkdtempSync(join(tmpdir(), "hd-test-")));
  readonly home = join(this.root, "home");

  constructor() {
    mkdirSync(this.home, { recursive: true });
    process.env.HOME = this.home;
  }

  /** A fresh git repo (branch main) under the root. */
  repo(name: string): string {
    const r = join(this.root, name);
    mkdirSync(r, { recursive: true });
    git(r, "init", "-q", "-b", "main");
    return r;
  }

  commitAll(repo: string): void {
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "commit");
  }

  /** Empty HOME again, so one test's user-scope files do not leak into the next. */
  resetHome(): void {
    rmSync(this.home, { recursive: true, force: true });
    mkdirSync(this.home, { recursive: true });
    process.env.HOME = this.home;
  }

  cleanup(): void {
    rmSync(this.root, { recursive: true, force: true });
  }
}
