// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { closeForQuit, makeQuitter, quitThen } from "../quit";

test("quitting closes the session store only after the read and the worker have finished", async () => {
  const order: string[] = [];
  let finishRead!: () => void;
  const quitting = closeForQuit(
    {
      scheduler: {
        stopAndWait: (ms) => {
          order.push(`stop and wait ${ms}`);
          return new Promise<void>((resolve) => (finishRead = () => (order.push("read finished"), resolve())));
        },
      },
      workerHost: { shutdown: async () => void order.push("worker exited") },
      store: { close: () => void order.push("store closed") },
    },
    5000,
  );
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ["stop and wait 5000"], "nothing closes while the read runs");
  finishRead();
  await quitting;
  assert.deepEqual(order, ["stop and wait 5000", "read finished", "worker exited", "store closed"]);
});

test("a second quit while the first waits reuses it: the store closes once, after the worker", async () => {
  const order: string[] = [];
  // Every shutdown waits for the one worker exit, so a quitter that closed afresh per call
  // would settle too, and show as two closes rather than a hang.
  const exits: (() => void)[] = [];
  const workerExit = () => exits.splice(0).forEach((exit) => exit());
  let closes = 0;
  const quit = makeQuitter(
    () => ({
      scheduler: { stopAndWait: async () => void order.push("stop") },
      workerHost: { shutdown: () => new Promise<void>((resolve) => exits.push(() => (order.push("worker exited"), resolve()))) },
      store: { close: () => (closes++, void order.push("store closed")) },
    }),
    5000,
  );
  const first = quit();
  await new Promise((r) => setImmediate(r));
  const second = quit(); // another Cmd+Q
  assert.equal(second, first);
  await new Promise((r) => setImmediate(r));
  assert.ok(!order.includes("store closed"), "not closed before the worker exits");
  workerExit();
  await Promise.all([first, second]);
  assert.equal(closes, 1, "the store closes exactly once");
  assert.deepEqual(order, ["stop", "worker exited", "store closed"]);
});

test("a quit sequence that fails still lets the app quit", async () => {
  let quitAllowed = false;
  await quitThen(() => Promise.reject(new Error("store close threw")), () => (quitAllowed = true));
  assert.equal(quitAllowed, true);
});
