// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// A tool whose reader throws is reported in `errors`, and the other tools still run.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Fixture, write } from "./fixtures";

vi.mock("../codex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../codex")>()),
  collectCodexAssets: async () => {
    throw new Error("reader broke");
  },
}));

let fx: Fixture;
beforeAll(() => {
  fx = new Fixture();
});
afterAll(() => fx.cleanup());

describe("a reader that fails", () => {
  it("is listed in errors with its tool, and the other tools' assets are still reported", async () => {
    const { scan } = await import("../scan");
    const repo = fx.repo("reader-failure");
    write(join(repo, "AGENTS.md"), "# agents\n");
    const r = await scan({ repos: [repo] });
    expect(r.errors).toEqual([{ ide: "codex", message: "reader broke" }]);
    expect(r.assets.map((a) => a.ideType).sort()).toEqual(["claude-code", "cursor"]);
  });
});
