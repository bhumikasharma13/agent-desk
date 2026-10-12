// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { utilityProcess } from "electron";

// workerHost resolves the worker script beside its own bundle; the path is never opened here.
(globalThis as unknown as { __dirname: string }).__dirname = "/nonexistent";

// The host waits 10 s for the worker's ready ack and 5 s before a respawn; shorten those two
// timers so the cases run in milliseconds. Every other delay keeps its value.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn: () => void, ms?: number) =>
  realSetTimeout(fn, ms === 10_000 ? 250 : ms === 5000 ? 10 : ms)) as typeof setTimeout;

type Listener = (arg: unknown) => void;
interface FakeChild {
  on(e: string, l: Listener): void;
  once(e: string, l: Listener): void;
  emit(e: string, a: unknown): void;
  postMessage(m: unknown): void;
  kill(): boolean;
  killed: boolean;
}

/** A utility process that emits "spawn" on the next turn and answers the init message with `reply`. */
function fakeChild(reply?: (child: FakeChild) => void): FakeChild {
  const listeners: Record<string, Listener[]> = {};
  const child: FakeChild = {
    killed: false,
    on(e, l) {
      (listeners[e] ??= []).push(l);
    },
    once(e, l) {
      (listeners[e] ??= []).push(l);
      if (e === "spawn") setImmediate(() => l(undefined));
    },
    emit(e, a) {
      for (const l of listeners[e] ?? []) l(a);
    },
    postMessage() {
      if (reply) setImmediate(() => reply(child));
    },
    kill() {
      child.killed = true;
      return true;
    },
  };
  return child;
}

function useFork(make: () => FakeChild): { forks: () => number; children: FakeChild[] } {
  const children: FakeChild[] = [];
  (utilityProcess as unknown as { fork: () => FakeChild }).fork = () => {
    const c = make();
    children.push(c);
    return c;
  };
  return { forks: () => children.length, children };
}

const { WorkerHost } = await import("../workerHost");
const init = { userDataPath: "/x", storePath: "/x/sessions.db", inventoryPath: "/x/inventory.json" };

describe("WorkerHost spawn", () => {
  afterEach(() => {
    (utilityProcess as unknown as { fork: unknown }).fork = () => fakeChild();
  });

  it("resolves once the worker acks ready", async () => {
    useFork(() => fakeChild((c) => c.emit("message", { type: "ready" })));
    const host = new WorkerHost(init);
    await host.spawn();
    assert.equal(host.isReady(), true);
  });

  it("after a spawn that timed out, the next spawn starts a fresh worker", async () => {
    const fork = useFork(() => fakeChild()); // never acks ready
    const host = new WorkerHost(init);
    await assert.rejects(host.spawn(), /spawn timeout/);
    await assert.rejects(host.spawn(), /spawn timeout/, "a second spawn must not report success without a ready worker");
    assert.equal(fork.forks(), 2, "the second spawn must fork a new worker");
    assert.equal(fork.children[0]!.killed, true, "the worker that never became ready is stopped");
  });

  it("the worker stopped after a timed-out spawn is not counted as a crash or respawned", async () => {
    const fork = useFork(() => fakeChild());
    const host = new WorkerHost(init);
    await assert.rejects(host.spawn(), /spawn timeout/);
    fork.children[0]!.emit("exit", null); // the kill lands
    await new Promise((r) => realSetTimeout(r, 60)); // past the (shortened) respawn backoff
    assert.equal(fork.forks(), 1, "no respawn of a worker the host stopped on purpose");
    assert.equal(host.isDead(), false);
  });

  it("a spawn that timed out leaves no timer or poll running", async () => {
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const live = new Set<unknown>();
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      const id = realSetInterval(fn, ms);
      live.add(id);
      return id;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id: unknown) => {
      live.delete(id);
      realClearInterval(id as ReturnType<typeof setInterval>);
    }) as typeof clearInterval;
    try {
      useFork(() => fakeChild());
      const host = new WorkerHost(init);
      await assert.rejects(host.spawn(), /spawn timeout/);
      const leaked = live.size;
      for (const id of live) realClearInterval(id as ReturnType<typeof setInterval>);
      assert.equal(leaked, 0, "no interval may outlive a spawn that gave up");
    } finally {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    }
  });

  it("a worker that reports an init error fails the spawn with that error, without waiting out the timeout", async () => {
    useFork(() =>
      fakeChild((c) => c.emit("message", { type: "error", message: "sessions.db is not a local-session-extractor store" })),
    );
    const host = new WorkerHost(init);
    const started = Date.now();
    await assert.rejects(host.spawn(), /not a local-session-extractor store/);
    assert.ok(Date.now() - started < 1000, "the error must not wait for the spawn timeout");
    assert.equal(host.isReady(), false);
  });

  it("concurrent spawn calls share one worker", async () => {
    const fork = useFork(() => fakeChild((c) => c.emit("message", { type: "ready" })));
    const host = new WorkerHost(init);
    await Promise.all([host.spawn(), host.spawn()]);
    assert.equal(fork.forks(), 1);
  });

  it("the third crash inside a minute marks the host dead, and it stops respawning", async () => {
    const fork = useFork(() => fakeChild((c) => c.emit("message", { type: "ready" })));
    const host = new WorkerHost(init);
    await host.spawn();
    for (let crash = 1; crash <= 3; crash++) {
      fork.children.at(-1)!.emit("exit", 1);
      assert.equal(host.isDead(), crash === 3, `after crash ${crash}`);
      await new Promise((r) => realSetTimeout(r, 60)); // past the (shortened) respawn backoff
    }
    assert.equal(fork.forks(), 3, "no respawn after the host is dead");
  });

  it("a worker that exits cleanly is not respawned", async () => {
    const fork = useFork(() => fakeChild((c) => c.emit("message", { type: "ready" })));
    const host = new WorkerHost(init);
    await host.spawn();
    fork.children[0]!.emit("exit", 0);
    await new Promise((r) => realSetTimeout(r, 60));
    assert.equal(fork.forks(), 1);
    assert.equal(host.isDead(), false);
  });
});
