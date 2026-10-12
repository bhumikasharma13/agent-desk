// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// Output order must not depend on the order the filesystem lists a directory in: readdir is
// stubbed here to return every listing reversed.
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Fixture, SKILL, write } from "./fixtures";

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const readdir = (async (...args: Parameters<typeof real.readdir>) => {
    const entries = (await real.readdir(...args)) as unknown[];
    return entries.reverse();
  }) as typeof real.readdir;
  return { ...real, default: { ...real, readdir }, readdir };
});

let fx: Fixture;
beforeAll(() => {
  fx = new Fixture();
});
afterAll(() => fx.cleanup());

describe("listing order", () => {
  it("reports assets in name order whatever order readdir returns", async () => {
    const { scan } = await import("../scan");
    const repo = fx.repo("order");
    for (const n of ["a", "b", "c"]) write(join(repo, ".cursor", "rules", `${n}.mdc`), `Rule ${n}.\n`);
    const dir = join(repo, ".claude", "skills", "s");
    write(join(dir, "SKILL.md"), SKILL("s"));
    for (const n of ["x.md", "y.md", "z.md"]) write(join(dir, n), `# ${n}\n`);
    const r = await scan({ repos: [repo], ides: ["claude-code", "cursor"] });
    expect(r.assets.filter((a) => a.type === "rule").map((a) => a.sourcePath)).toEqual([
      ".cursor/rules/a.mdc",
      ".cursor/rules/b.mdc",
      ".cursor/rules/c.mdc",
    ]);
    expect(r.assets.find((a) => a.type === "skill")!.payload.files!.map((f) => f.relativePath)).toEqual(["SKILL.md", "x.md", "y.md", "z.md"]);
  });
});
