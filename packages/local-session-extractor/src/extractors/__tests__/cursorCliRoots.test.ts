// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A caller that points the Cursor CLI store elsewhere names one directory, and
 * only that directory is read: the legacy `cli-chats` sibling is part of the
 * default layout, not of an override.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCursorCliChatsRoots, setPathOverrides } from "../pathResolver";

describe("getCursorCliChatsRoots", () => {
  afterEach(() => setPathOverrides({ CURSOR_CLI_CHATS_PATH: undefined }));

  it("reads only the overridden directory, never a sibling of it", () => {
    setPathOverrides({ CURSOR_CLI_CHATS_PATH: "/tmp/fixture/chats" });
    assert.deepEqual(getCursorCliChatsRoots(), ["/tmp/fixture/chats"]);
  });

  it("reads both the current and the legacy root under the default layout", () => {
    assert.deepEqual(getCursorCliChatsRoots(), [join(homedir(), ".cursor", "chats"), join(homedir(), ".cursor", "cli-chats")]);
  });
});
