// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  notifyPermissionMissing,
  __resetNotifierForTests,
  type NotifierDeps,
} from "../permissionNotifier";

const noop = () => {};

describe("notifyPermissionMissing", () => {
  beforeEach(() => __resetNotifierForTests());

  it("shows at most once per launch", () => {
    let shown = 0;
    const deps: NotifierDeps = { isSupported: () => true, show: () => { shown++; } };
    assert.equal(notifyPermissionMissing(noop, deps), true);
    assert.equal(notifyPermissionMissing(noop, deps), false);
    assert.equal(notifyPermissionMissing(noop, deps), false);
    assert.equal(shown, 1);
  });

  it("does nothing when notifications are unsupported", () => {
    let shown = 0;
    const deps: NotifierDeps = { isSupported: () => false, show: () => { shown++; } };
    assert.equal(notifyPermissionMissing(noop, deps), false);
    assert.equal(shown, 0);
  });

  it("passes the onClick through to show()", () => {
    let received: (() => void) | null = null;
    const deps: NotifierDeps = { isSupported: () => true, show: (cb) => { received = cb; } };
    const onClick = () => {};
    notifyPermissionMissing(onClick, deps);
    assert.equal(received, onClick);
  });
});
