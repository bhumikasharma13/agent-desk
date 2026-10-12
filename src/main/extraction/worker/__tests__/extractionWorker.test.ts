// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// extractionWorker.ts registers `process.parentPort.on(...)` at the top level
// (Electron utilityProcess wiring), which does not exist in a plain
// electron-as-node test process, so it is stubbed BEFORE the module is
// imported. The two libraries are module-mocked so a cycle never reads this
// machine's real sessions or harness config (`--experimental-test-module-mocks`
// is set on the `test` script).
const handlers: Record<string, (event: { data: unknown }) => void> = {};
const sent: Array<{ type: string; [k: string]: unknown }> = [];
(
  process as unknown as {
    parentPort: {
      on: (e: string, cb: (event: { data: unknown }) => void) => void;
      postMessage: (m: unknown) => void;
    };
  }
).parentPort = {
  on(event, cb) {
    handlers[event] = cb;
  },
  postMessage(msg) {
    sent.push(msg as { type: string });
  },
};

type Progress = { source: string; state: "start" } | { source: string; state: "done"; count: number };
interface FakeScan {
  counts: Record<string, number>;
  errors: { source: string; scope: "session" | "source"; message: string }[];
}
let sessionScan: FakeScan = { counts: {}, errors: [] };
let harnessResult: unknown = { schemaVersion: 1, assets: [], warnings: [], errors: [] };
let harnessThrows: Error | null = null;
const scannedRepos: string[][] = [];
const sessionReads: string[][] = [];
const sessionReadOptions: Record<string, unknown>[] = [];
// The project folders the store lists exist on disk: a folder that does not is never scanned.
const W = realpathSync(mkdtempSync(join(tmpdir(), "worker-paths-")));
const at = (p: string): string => W + p;
for (const d of ["/work/shop", "/Users/jane/Documents/notes", "/Users/jane/Documents-old/app", "/Users/jose\u0301/Documents/notes"]) {
  mkdirSync(at(d), { recursive: true });
}
after(() => rmSync(W, { recursive: true, force: true }));
let projects = [at("/work/shop")];

const fakeStore = {
  countByIde: () => ({ claudeCode: 1, cursor: 0, copilot: 0, antigravity: 0, codex: 0, kiro: 0, total: 1 }),
  countByIdeAndProject: () => [],
  listDetectedProjects: () => projects.map((project_path) => ({ project_path, last_seen_ms: 1 })),
  close: () => {},
};

mock.module("local-session-extractor", {
  namedExports: {
    openStore: () => fakeStore,
    unredactPath: (p: string) => p,
    readAll: async (_store: unknown, opts: { sources: string[]; onProgress: (e: Progress) => void }) => {
      sessionReads.push(opts.sources);
      sessionReadOptions.push(opts as unknown as Record<string, unknown>);
      for (const source of opts.sources) {
        opts.onProgress({ source, state: "start" });
        opts.onProgress({ source, state: "done", count: sessionScan.counts[source] ?? 0 });
      }
      return {
        counts: {},
        durationMs: 1,
        errors: sessionScan.errors.filter((e) => opts.sources.includes(e.source)),
        unknownRecordKinds: {},
        partial: {},
      };
    },
  },
});
mock.module("local-session-extractor/host", { namedExports: { setLogger: () => {} } });
mock.module("harness-discovery", {
  namedExports: {
    setLogger: () => {},
    scan: async (opts: { repos: string[] }) => {
      scannedRepos.push(opts.repos);
      if (harnessThrows) throw harnessThrows;
      return harnessResult;
    },
  },
});

await import("../extractionWorker");
const { readScanFailure } = await import("../../../harness/inventory");

const dir = mkdtempSync(join(tmpdir(), "worker-test-"));
const inventoryPath = join(dir, "harness-inventory.json");
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

function message(data: unknown): void {
  handlers["message"]!({ data });
}

async function runCycle(skipRoots: string[] = []): Promise<Array<{ type: string; [k: string]: unknown }>> {
  sent.length = 0;
  message({ type: "run", config: { sources: ["claude-code", "copilot", "antigravity", "codex", "kiro", "cursor"], skipRoots } });
  for (let i = 0; i < 50 && !sent.some((m) => m.type === "done" || m.type === "error"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return [...sent];
}

test("init opens the store and acks ready", () => {
  message({ type: "init", init: { userDataPath: dir, storePath: join(dir, "sessions.db"), inventoryPath } });
  assert.deepEqual(sent.at(-1), { type: "ready" });
});

test("a cycle reads the sources, scans the store's projects, stores the scan, and reports in run order", async () => {
  sessionScan = { counts: { "claude-code": 1 }, errors: [] };
  harnessResult = { schemaVersion: 1, assets: [{ id: "a" }], warnings: [], errors: [] };
  const msgs = await runCycle();
  const order = msgs.filter((m) => m.type === "progress" && m.state === "done").map((m) => m.id);
  assert.deepEqual(order, ["claude-code", "copilot", "antigravity", "codex", "kiro", "harness-assets", "cursor"]);
  const withRows = msgs.find((m) => m.type === "progress" && m.id === "claude-code" && m.state === "done");
  assert.ok(withRows?.aggregates, "a source that wrote rows ships the worker-computed aggregates");
  const done = msgs.find((m) => m.type === "done");
  assert.ok(done);
  assert.equal((done.counts as Record<string, number>).claudeCode, 1);
  assert.deepEqual(done.moduleCounts, { "harness-assets": 1 });
  assert.deepEqual(done.problems, []);
  assert.deepEqual(scannedRepos.at(-1), [at("/work/shop")]);
  // Sessions are read as the user's own tools wrote them: no `home`, so the session library runs
  // git in each session's folder (docs/before-you-rely-on-it.md). Adding `home` changes what the
  // pages show (CODEX_HOME, Antigravity's live server, Cursor's agent logs) and must be deliberate.
  assert.equal("home" in sessionReadOptions.at(-1)!, false);
  const stored = JSON.parse(readFileSync(inventoryPath, "utf-8")) as { scannedAt: string; result: unknown };
  assert.deepEqual(stored.result, harnessResult);
});

test("a source that failed, skipped sessions and a failed harness scan are reported, and the stored scan is kept", async () => {
  sessionScan = {
    counts: { "claude-code": 2 },
    errors: [
      { source: "cursor", scope: "source", message: "state.vscdb is locked" },
      { source: "codex", scope: "session", message: "bad line" },
      { source: "codex", scope: "session", message: "bad line" },
    ],
  };
  const before = readFileSync(inventoryPath, "utf-8");
  harnessThrows = new Error("disk gone");
  try {
    const msgs = await runCycle();
    const done = msgs.find((m) => m.type === "done");
    assert.ok(done, "the cycle still completes");
    assert.deepEqual(done.problems, [
      "codex: 2 sessions could not be read",
      "The harness scan failed: disk gone",
      "cursor could not be read: state.vscdb is locked",
    ]);
    assert.equal((done.counts as Record<string, number>).claudeCode, 2, "the tools that could be read still count");
    assert.equal(readFileSync(inventoryPath, "utf-8"), before, "a failed scan leaves the previous stored scan");
    assert.equal(readScanFailure(inventoryPath)?.message, "disk gone", "the failure is recorded beside it");
  } finally {
    harnessThrows = null;
  }
  await runCycle();
  assert.equal(readScanFailure(inventoryPath), null, "the next good scan clears the failure");
});

test("the harness scan skips every repo under a folder main says is not granted; their sessions still count", async () => {
  sessionScan = { counts: { "claude-code": 1 }, errors: [] };
  projects = [at("/work/shop"), at("/Users/jane/Documents/notes"), at("/Users/jane/Documents"), at("/Users/jane/Documents-old/app")];
  try {
    sessionReads.length = 0;
    const msgs = await runCycle([at("/Users/jane/Documents")]);
    assert.deepEqual(scannedRepos.at(-1), [at("/work/shop"), at("/Users/jane/Documents-old/app")]);
    assert.deepEqual(sessionReads.flat().sort(), ["antigravity", "claude-code", "codex", "copilot", "cursor", "kiro"], "every source is still read");
    const done = msgs.find((m) => m.type === "done");
    assert.equal((done?.counts as Record<string, number>).claudeCode, 1, "and counted");
    // macOS reaches the same folder in another case or Unicode form.
    projects = [at("/work/shop"), at("/Users/jane/documents/notes"), at("/Users/jose\u0301/Documents/notes")];
    await runCycle([at("/Users/jane/Documents"), at("/Users/jos\u00e9/Documents")]);
    assert.deepEqual(scannedRepos.at(-1), [at("/work/shop")], "case and Unicode variants are skipped too");
  } finally {
    projects = [at("/work/shop")];
  }
});

test("the harness scan follows symlinks before it decides, and gets the folder they lead to", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worker-links-")));
  const documents = join(root, "Documents");
  mkdirSync(join(documents, "proj"), { recursive: true });
  mkdirSync(join(documents, "secret"), { recursive: true });
  mkdirSync(join(root, "web"), { recursive: true });
  mkdirSync(join(root, "dev"), { recursive: true });
  symlinkSync(join(documents, "proj"), join(root, "dev", "into-documents"));
  symlinkSync(join(root, "web"), join(root, "dev", "to-web"));
  projects = [
    join(root, "dev", "into-documents"),
    `${root}/dev/into-documents/../secret`,
    `${root}/dev/nope/../into-documents`,
    join(root, "dev", "to-web"),
  ];
  try {
    await runCycle([documents]);
    assert.deepEqual(scannedRepos.at(-1), [join(root, "web")], "only the link to an allowed folder, resolved");
  } finally {
    projects = [at("/work/shop")];
    rmSync(root, { recursive: true, force: true });
  }
});

test("the harness scan never gets the home folder's parents", async () => {
  const realHome = process.env.HOME;
  process.env.HOME = at("/Users/jane"); // os.homedir() reads it
  projects = ["/", at("/Users"), at("/work/shop")];
  try {
    await runCycle([]);
    assert.deepEqual(scannedRepos.at(-1), [at("/work/shop")]);
  } finally {
    process.env.HOME = realHome;
    projects = [at("/work/shop")];
  }
});
