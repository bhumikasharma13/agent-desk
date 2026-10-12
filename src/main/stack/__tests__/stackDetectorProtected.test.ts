// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// The stack detector never reads inside a protected folder the user has not granted: not a
// project there, and not a subfolder of a project elsewhere (a home folder used as a project).
// Every node:fs/promises call the detector makes is recorded.

import { describe, it, after, mock } from "node:test";
import assert from "node:assert/strict";
import * as realFs from "node:fs/promises";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

const calls: string[] = [];
const ops: string[] = [];
const traced = <A extends unknown[], R>(op: string, fn: (p: unknown, ...rest: A) => R) =>
  (p: unknown, ...rest: A): R => {
    calls.push(String(p));
    ops.push(op);
    return fn(p, ...rest);
  };
mock.module("node:fs/promises", {
  namedExports: {
    ...realFs,
    readdir: traced("readdir", realFs.readdir as never),
    stat: traced("stat", realFs.stat as never),
    lstat: traced("lstat", realFs.lstat as never),
    readlink: traced("readlink", realFs.readlink as never),
    readFile: traced("readFile", realFs.readFile as never),
    realpath: traced("realpath", realFs.realpath as never),
    access: traced("access", realFs.access as never),
  },
});
const { StackDetector } = await import("../stackDetector");

// HOME sits in a temp folder of its own, so its parent (a project in one case) is never the
// system temp folder, even if the home-folder check broke.
const root = realpathSync(mkdtempSync(join(tmpdir(), "stack-home-")));
const home = join(root, "home");
const documents = join(home, "Documents");
after(() => rmSync(root, { recursive: true, force: true }));
for (const [rel, body] of [
  ["Documents/go.mod", "module example.com/secret\n"],
  ["Documents/secret/Cargo.toml", "[package]\nname = \"secret\"\n"],
  ["Documents/proj/package.json", "{}\n"],
  ["web/package.json", "{}\n"],
  ["dev/.keep", ""],
] as const) {
  mkdirSync(join(home, rel, ".."), { recursive: true });
  writeFileSync(join(home, rel), body);
}
// Symlinks from outside into Documents, and out of it, for the resolution cases.
symlinkSync(join(home, "Documents", "proj"), join(home, "dev", "into-documents"));
symlinkSync(join(home, "web"), join(home, "dev", "to-web"));
symlinkSync("loop-b", join(home, "dev", "loop-a"));
symlinkSync("loop-a", join(home, "dev", "loop-b"));

// What a traced call really touches: lstat and readlink look at the link itself, in its
// folder; every other call follows it. A path that does not exist counts as spelled.
const target = (op: string, p: string): string => {
  try {
    return op === "lstat" || op === "readlink" ? join(realpathSync(dirname(p)), basename(p)) : realpathSync(p);
  } catch {
    return p;
  }
};
// macOS reaches Documents in any case or Unicode form, so the check folds both sides.
const fold = (p: string) => p.normalize("NFC").toLowerCase();
const isUnder = (p: string, dir: string, inclusive: boolean) =>
  (inclusive && fold(p) === fold(dir)) || fold(p).startsWith(fold(dir) + sep);
const readsUnder = (dir: string, inclusive = true) =>
  calls.filter((c, i) => isUnder(c, dir, inclusive) || isUnder(target(ops[i]!, c), dir, inclusive));
const readsUnderDocuments = () => readsUnder(documents);

describe("stack detection and folders not granted", () => {
  const detector = StackDetector.getInstance();
  detector.setSkipRootsProvider(async () => [documents]);

  it("reads nothing inside a folder not granted when the project contains it", async () => {
    calls.length = 0;
    detector.setProjectsProvider(() => [{ path: home, lastSeenAt: new Date() }]);
    const [project] = await detector.rescan();
    assert.deepEqual(readsUnderDocuments(), []);
    assert.ok(calls.length > 0, "the rest of the project was read");
    assert.ok(project, "the project is listed");
    assert.ok(!project.stackTags.includes("go") && !project.stackTags.includes("rust"), `tags: ${project.stackTags}`);
    assert.ok(project.stackTags.includes("typescript"), "a subfolder outside it is still tagged");
    assert.ok(!project.subprojects?.some((s) => s.relativePath === "Documents"));
  });

  it("skips a project inside a folder not granted without reading it", async () => {
    calls.length = 0;
    detector.setProjectsProvider(() => [{ path: join(documents, "proj"), lastSeenAt: new Date() }]);
    assert.deepEqual(await detector.rescan(), []);
    assert.deepEqual(readsUnderDocuments(), []);
  });

  it("treats a session folder spelled in another case as the same folder", { skip: process.platform !== "darwin" }, async () => {
    calls.length = 0;
    detector.setProjectsProvider(() => [{ path: join(home, "documents", "proj"), lastSeenAt: new Date() }]);
    assert.deepEqual(await detector.rescan(), []);
    assert.deepEqual(readsUnderDocuments(), []);
  });

  it("treats a session folder in the other Unicode form as the same folder", { skip: process.platform !== "darwin" }, async () => {
    const accented = join(home, "Caf\u00e9");
    mkdirSync(join(accented, "proj"), { recursive: true });
    writeFileSync(join(accented, "proj", "package.json"), "{}\n");
    detector.setSkipRootsProvider(async () => [documents, accented]);
    try {
      calls.length = 0;
      detector.setProjectsProvider(() => [{ path: join(home, "Cafe\u0301", "proj"), lastSeenAt: new Date() }]);
      assert.deepEqual(await detector.rescan(), []);
      assert.deepEqual(readsUnder(accented), []);
    } finally {
      detector.setSkipRootsProvider(async () => [documents]);
    }
  });

  it("never walks the home folder, or a folder that holds it", async () => {
    const realHome = process.env.HOME;
    process.env.HOME = home; // os.homedir() reads it
    try {
      for (const rel of ["Library/Mobile Documents/com~apple~CloudDocs/notes/go.mod", "Pictures/Photos Library.photoslibrary/originals/Cargo.toml"]) {
        mkdirSync(join(home, rel, ".."), { recursive: true });
        writeFileSync(join(home, rel), "");
      }
      for (const project of [home, root, "/"]) {
        calls.length = 0;
        detector.setProjectsProvider(() => [{ path: project, lastSeenAt: new Date() }]);
        assert.deepEqual(await detector.rescan(), [], project);
        assert.deepEqual(readsUnder(home, false), [], `nothing below ${home} is read`);
      }
    } finally {
      process.env.HOME = realHome;
    }
  });

  it("reads nothing when the folders not granted cannot be worked out, and keeps the last result", async () => {
    detector.setProjectsProvider(() => [{ path: join(home, "web"), lastSeenAt: new Date() }]);
    const before = await detector.rescan();
    detector.setSkipRootsProvider(async () => {
      throw new Error("permission store unreadable");
    });
    try {
      calls.length = 0;
      assert.deepEqual(await detector.rescan(), before);
      assert.deepEqual(calls, [], "no file is read");
    } finally {
      detector.setSkipRootsProvider(async () => [documents]);
    }
  });

  it("follows a symlink before reading: one into a folder not granted is skipped", async () => {
    for (const spelled of [join(home, "dev", "into-documents"), `${home}/dev/into-documents/../secret`]) {
      calls.length = 0;
      ops.length = 0;
      detector.setProjectsProvider(() => [{ path: spelled, lastSeenAt: new Date() }]);
      assert.deepEqual(await detector.rescan(), [], spelled);
      assert.deepEqual(readsUnderDocuments(), [], `nothing under Documents is read for ${spelled}`);
    }
  });

  it("skips a folder not granted that is spelled through a symlinked folder above it", async () => {
    const alias = `${home}-alias`;
    symlinkSync(home, alias);
    detector.setSkipRootsProvider(async () => [join(alias, "Documents")]);
    try {
      calls.length = 0;
      ops.length = 0;
      detector.setProjectsProvider(() => [{ path: join(documents, "proj"), lastSeenAt: new Date() }]);
      assert.deepEqual(await detector.rescan(), []);
      assert.deepEqual(readsUnderDocuments(), []);
    } finally {
      detector.setSkipRootsProvider(async () => [documents]);
      rmSync(alias);
    }
  });

  it("gives up on a symlink loop without reading", async () => {
    calls.length = 0;
    ops.length = 0;
    detector.setProjectsProvider(() => [{ path: join(home, "dev", "loop-a"), lastSeenAt: new Date() }]);
    // Raced against a clock, so an endless walk fails here instead of hanging the run.
    let timer: NodeJS.Timeout | undefined;
    const stuck = new Promise((resolve) => (timer = setTimeout(() => resolve("still walking after 5 s"), 5000)));
    const result = await Promise.race([detector.rescan(), stuck]);
    clearTimeout(timer);
    assert.deepEqual(result, []);
    assert.deepEqual(ops.filter((op) => op !== "lstat" && op !== "readlink"), [], "only the links themselves are looked at");
  });

  it("follows a symlink to an allowed folder and tags the project there, reading it where it is", async () => {
    const spelled = join(home, "dev", "to-web");
    calls.length = 0;
    ops.length = 0;
    detector.setProjectsProvider(() => [{ path: spelled, lastSeenAt: new Date() }]);
    const [project] = await detector.rescan();
    assert.equal(project?.path, spelled, "the row keeps the session's spelling");
    assert.deepEqual(project?.stackTags, ["typescript"]);
    assert.deepEqual(calls.filter((c) => c.startsWith(spelled + sep)), [], "every read goes to the folder the link leads to");
  });

  it("steps back from where a link points, not from its spelling", async () => {
    const spelled = `${home}/dev/to-web/../web`;
    detector.setProjectsProvider(() => [{ path: spelled, lastSeenAt: new Date() }]);
    const [project] = await detector.rescan();
    assert.equal(project?.path, spelled);
    assert.deepEqual(project?.stackTags, ["typescript"]);
  });

  it("gives up at a missing part, so a later \"..\" and link cannot lead into a folder not granted", async () => {
    calls.length = 0;
    ops.length = 0;
    detector.setProjectsProvider(() => [{ path: `${home}/dev/nope/../into-documents`, lastSeenAt: new Date() }]);
    assert.deepEqual(await detector.rescan(), []);
    assert.deepEqual(readsUnderDocuments(), []);
  });

  it("never follows a symlinked manifest, config or folder into a folder not granted", async () => {
    const p2 = join(root, "p2");
    mkdirSync(p2);
    mkdirSync(join(documents, "gh", "workflows"), { recursive: true });
    writeFileSync(join(documents, "gh", "workflows", "ci.yml"), "on: push\n");
    symlinkSync(join(documents, "proj", "package.json"), join(p2, "package.json"));
    symlinkSync(join(documents, "proj", "package.json"), join(p2, "vite.config.js"));
    symlinkSync(join(documents, "gh"), join(p2, ".github"));
    writeFileSync(join(p2, "Cargo.toml"), "[package]\nname = \"p2\"\n");
    calls.length = 0;
    ops.length = 0;
    detector.setProjectsProvider(() => [{ path: p2, lastSeenAt: new Date() }]);
    const [project] = await detector.rescan();
    assert.deepEqual(readsUnderDocuments(), []);
    assert.deepEqual(project?.stackTags, ["rust"], "the linked package.json, vite config and .github count as absent");
  });
});
