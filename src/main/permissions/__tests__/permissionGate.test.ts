// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { askFolders, computeNeeded, realClock, type AskClock } from "../permissionGate";
import { classifyProbeError, type ProbeResult } from "../folderAccess";
import { PROTECTED_FOLDER_KEYS, isPathWithinBase } from "../protectedFolders";
import type { ProtectedFolderKey } from "../../../shared/permissionTypes";

// A clock that moves only when the code under test sleeps.
const fakeClock = (): AskClock & { t: number } => {
  const c = { t: 0, now: () => c.t, sleep: async (ms: number) => void (c.t += ms) };
  return c;
};

const askedSet = (...keys: ProtectedFolderKey[]) => {
  const set = new Set(keys);
  return (k: ProtectedFolderKey) => set.has(k);
};

describe("computeNeeded", () => {
  it("non-macOS is a no-op — nothing needed", () => {
    assert.deepEqual(computeNeeded(askedSet(), false), []);
  });

  it("first run lists every registry folder with a label", () => {
    const needed = computeNeeded(askedSet(), true);
    assert.deepEqual(
      needed.map((f) => f.key).sort(),
      [...PROTECTED_FOLDER_KEYS].sort(),
    );
    for (const f of needed) {
      assert.ok(f.label.length > 0, "label present");
    }
  });

  it("already-asked folders are skipped (remember the choice)", () => {
    const keys = computeNeeded(askedSet("desktop", "documents"), true).map((f) => f.key);
    // Order-independent: assert membership, not registry iteration order.
    assert.ok(!keys.includes("desktop"));
    assert.ok(!keys.includes("documents"));
    assert.ok(keys.includes("downloads"));
  });

  it("all-asked yields nothing to show", () => {
    const needed = computeNeeded(askedSet(...PROTECTED_FOLDER_KEYS), true);
    assert.deepEqual(needed, []);
  });
});

describe("isPathWithinBase", () => {
  const base = "/Users/x/Documents";

  it("matches the base folder itself", () => {
    assert.equal(isPathWithinBase(base, base), true);
  });

  it("matches a descendant", () => {
    assert.equal(isPathWithinBase("/Users/x/Documents/proj/src", base), true);
  });

  it("does NOT match a sibling that merely shares the prefix", () => {
    // The bug the `+ path.sep` guard exists to prevent.
    assert.equal(isPathWithinBase("/Users/x/Documents-old/proj", base), false);
  });

  it("does NOT match an unrelated path", () => {
    assert.equal(isPathWithinBase("/Users/x/Developer/proj", base), false);
  });

  it("treats the root folder as holding every path", () => {
    assert.equal(isPathWithinBase("/Users/x", "/"), true);
    assert.equal(isPathWithinBase("/", "/"), true);
  });

  it("normalizes '..' segments before comparing", () => {
    assert.equal(isPathWithinBase("/Users/x/Documents/a/../b", base), true);
    assert.equal(isPathWithinBase("/Users/x/Documents/../Developer", base), false);
  });

  it("on macOS, matches a path spelled in another case or Unicode form", { skip: process.platform !== "darwin" }, () => {
    assert.equal(isPathWithinBase("/Users/x/documents/proj", base), true);
    assert.equal(isPathWithinBase("/USERS/X/DOCUMENTS", base), true);
    const composed = "/Users/jos\u00e9/Documents";
    assert.equal(isPathWithinBase("/Users/jose\u0301/Documents/proj", composed), true);
    assert.equal(isPathWithinBase("/Users/x/documents-old/proj", base), false, "a sibling still does not match");
  });
});

describe("classifyProbeError", () => {
  it("treats permission errors as blocked", () => {
    assert.equal(classifyProbeError("EPERM"), "blocked");
    assert.equal(classifyProbeError("EACCES"), "blocked");
  });

  it("stays indeterminate on non-permission errors (not persisted as asked)", () => {
    assert.equal(classifyProbeError("ENOENT"), "indeterminate");
    assert.equal(classifyProbeError(undefined), "indeterminate");
  });
});

describe("askFolders", () => {
  it("remembers granted and denied folders, never an indeterminate or failed probe", async () => {
    const results: Record<string, ProbeResult | Error> = {
      desktop: "granted",
      documents: "indeterminate",
      downloads: new Error("EIO"),
    };
    const marked: string[] = [];
    await askFolders(
      ["desktop", "documents", "downloads"],
      async (key) => {
        const r = results[key]!;
        if (r instanceof Error) throw r;
        return r;
      },
      (key) => marked.push(key),
      { clock: fakeClock() },
    );
    assert.deepEqual(marked, ["desktop"]);
    marked.length = 0;
    await askFolders(["documents"], async () => "blocked", (key) => marked.push(key), { clock: fakeClock() });
    assert.deepEqual(marked, ["documents"], "a denial is remembered");
  });

  it("a folder that reads as blocked while its prompt is open ends as granted once the user allows it", async () => {
    // macOS answers the first read at once with EPERM; the user's Allow applies to later reads.
    const clock = fakeClock();
    const reads: Record<string, number> = {};
    const logged: [string, Record<string, unknown>][] = [];
    const marked: string[] = [];
    const outcomes = await askFolders(
      ["desktop", "documents"],
      async (key) => {
        reads[key] = (reads[key] ?? 0) + 1;
        if (key === "desktop") return reads[key]! < 4 ? "blocked" : "granted"; // allowed after ~1.5 s
        return "granted";
      },
      (key) => marked.push(key),
      { clock, log: (event, data) => logged.push([event, data]) },
    );
    assert.deepEqual(outcomes, { desktop: "granted", documents: "granted" });
    assert.deepEqual(
      logged.map(([e, d]) => `${e} ${d["folder"]}`),
      ["folder_access_granted documents", "folder_access_granted desktop"],
    );
    assert.equal(logged[1]![1]["waitedMs"], 1500);
    assert.deepEqual(marked, ["documents", "desktop"], "each is remembered when its answer comes");
  });

  it("a folder that stays blocked ends as declined after the bound, re-probed until then", async () => {
    const clock = fakeClock();
    let reads = 0;
    const logged: string[] = [];
    const outcomes = await askFolders(
      ["downloads"],
      async () => {
        reads++;
        return "blocked";
      },
      () => {},
      { clock, intervalMs: 500, boundMs: 60_000, log: (event) => logged.push(event) },
    );
    assert.deepEqual(outcomes, { downloads: "declined" });
    assert.deepEqual(logged, ["folder_access_declined"]);
    assert.equal(clock.t, 60_000);
    assert.equal(reads, 1 + 120, "the first ask, then every 500 ms for 60 s");
  });

  it("an Allow at 59 s counts; one at 61 s is past the bound and the folder is declined", async () => {
    for (const [allowAt, expected] of [[59_000, "granted"], [61_000, "declined"]] as const) {
      const clock = fakeClock();
      const outcomes = await askFolders(["desktop"], async () => (clock.t >= allowAt ? "granted" : "blocked"), () => {}, { clock, log: () => {} });
      assert.deepEqual(outcomes, { desktop: expected }, `allowed at ${allowAt} ms`);
    }
  });

  it("follows each answer as it comes: one folder granted while another keeps waiting", async () => {
    const clock = fakeClock();
    const changes: string[] = [];
    const outcomes = await askFolders(
      ["desktop", "documents"],
      async (key) => (key === "desktop" && clock.t >= 2000 ? "granted" : "blocked"),
      () => {},
      {
        clock,
        log: () => {},
        onChange: ({ key, state }) => changes.push([state, key, `at ${clock.t}`].filter(Boolean).join(" ")),
      },
    );
    assert.deepEqual(changes, ["asked at 0", "granted desktop at 2000"], "the follow-ups run once for the granted folder, at once");
    assert.deepEqual(outcomes, { desktop: "granted", documents: "declined" });
    assert.equal(clock.t, 60_000, "the other folder kept waiting to the bound");
  });

  it("at quit it stops at once: nothing more is logged or called", async () => {
    const clock = fakeClock();
    const quit = new AbortController();
    const logged: string[] = [];
    const changes: string[] = [];
    const outcomes = await askFolders(
      ["downloads"],
      async () => {
        if (clock.t >= 1000) quit.abort();
        return "blocked";
      },
      () => {},
      { clock, signal: quit.signal, log: (event) => logged.push(event), onChange: ({ state }) => changes.push(state) },
    );
    assert.deepEqual(outcomes, {}, "no outcome for the folder still waiting");
    assert.deepEqual(logged, [], "no declined log");
    assert.deepEqual(changes, ["asked"], "no follow-up after the quit");
    assert.equal(clock.t, 1000);
  });

  it("remembers a folder as asked only on a decision, never when a quit cuts the wait short", async () => {
    const clock = fakeClock();
    const quit = new AbortController();
    const marked: string[] = [];
    await askFolders(
      ["desktop", "documents"],
      async (key) => {
        if (clock.t >= 1000) quit.abort();
        return key === "documents" ? "granted" : "blocked";
      },
      (key) => marked.push(key),
      { clock, signal: quit.signal, log: () => {} },
    );
    assert.deepEqual(marked, ["documents"], "the granted folder is remembered, the one still waiting is not");
  });

  it("a quit during a wait probes nothing more", async () => {
    const clock = fakeClock();
    const quit = new AbortController();
    const sleeping: AskClock = {
      now: clock.now,
      sleep: async (ms) => {
        await clock.sleep(ms);
        if (clock.t >= 1500) quit.abort(); // quit while waiting for the next probe
      },
    };
    let probes = 0;
    await askFolders(["desktop"], async () => (probes++, "blocked"), () => {}, { clock: sleeping, signal: quit.signal, log: () => {} });
    assert.equal(probes, 1 + 2, "the first ask and the re-probes at 500 and 1000 ms, none after the quit at 1500 ms");
  });

  it("the real clock's wait ends as soon as the quit signal aborts, so no timer outlives the quit", async () => {
    const quit = new AbortController();
    const started = Date.now();
    setTimeout(() => quit.abort(), 20);
    await realClock.sleep(10_000, quit.signal);
    assert.ok(Date.now() - started < 1000, "woke at the abort, not after 10 s");
  });

  it("re-probes every 500 ms for 60 s by default (no options)", async () => {
    mock.timers.enable({ apis: ["setTimeout", "Date"] });
    try {
      let probes = 0;
      let done = false;
      const asking = askFolders(["desktop"], async () => {
        probes++;
        return "blocked";
      }, () => {}).then((o) => {
        done = true;
        return o;
      });
      const flush = () => new Promise((r) => setImmediate(r));
      await flush();
      for (let elapsed = 0; elapsed < 59_500; elapsed += 500) {
        mock.timers.tick(500);
        await flush();
      }
      assert.equal(done, false, "still waiting at 59.5 s");
      mock.timers.tick(500);
      await flush();
      assert.deepEqual(await asking, { desktop: "declined" });
      assert.equal(probes, 1 + 120);
    } finally {
      mock.timers.reset();
    }
  });
});
