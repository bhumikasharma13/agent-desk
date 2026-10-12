// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRootPathFromCursorValue, parseRootPathFromLayout } from "../../internal";

// Parser parity: locks the exact behavior callers relied on before
// the parser was extracted to this shared module.
describe("parseRootPathFromLayout", () => {
  it("reads rootPath from an object layout", () => {
    assert.equal(parseRootPathFromLayout({ rootPath: "/home/u/repo" }), "/home/u/repo");
  });

  it("reads rootPath from a stringified-JSON layout (older Cursor)", () => {
    assert.equal(parseRootPathFromLayout(JSON.stringify({ rootPath: "/home/u/repo" })), "/home/u/repo");
  });

  it("returns undefined for empty / malformed / missing rootPath", () => {
    assert.equal(parseRootPathFromLayout({}), undefined);
    assert.equal(parseRootPathFromLayout({ rootPath: "" }), undefined);
    assert.equal(parseRootPathFromLayout("not json"), undefined);
    assert.equal(parseRootPathFromLayout(null), undefined);
    assert.equal(parseRootPathFromLayout(42), undefined);
  });
});

describe("parseRootPathFromCursorValue", () => {
  it("reads the first projectLayouts rootPath", () => {
    const raw = JSON.stringify({ projectLayouts: [{ rootPath: "/home/u/repo" }] });
    assert.equal(parseRootPathFromCursorValue(raw), "/home/u/repo");
  });

  it("reads rootPath from a stringified projectLayouts entry (recent Cursor)", () => {
    // The regression the extraction reader hit: recent Cursor stores each layout
    // as a stringified-JSON blob, so `projectLayouts[0].rootPath` was undefined and
    // the session's only project signal was dropped.
    const raw = JSON.stringify({ projectLayouts: [JSON.stringify({ rootPath: "gamma", content: {} })] });
    assert.equal(parseRootPathFromCursorValue(raw), "gamma");
  });

  it("returns undefined for non-JSON, empty layouts, or wrong shape", () => {
    assert.equal(parseRootPathFromCursorValue("{"), undefined);
    assert.equal(parseRootPathFromCursorValue(JSON.stringify({ projectLayouts: [] })), undefined);
    assert.equal(parseRootPathFromCursorValue(JSON.stringify({ other: 1 })), undefined);
  });
});
