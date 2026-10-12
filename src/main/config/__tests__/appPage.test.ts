// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { isAppPageUrl } from "../appPage";

const page = "/Applications/Agent Desk.app/Contents/Resources/app.asar/.vite/renderer/main_window/index.html";
const own = pathToFileURL(page).href;

describe("isAppPageUrl", () => {
  it("accepts the packaged page, with any hash or query", () => {
    assert.equal(isAppPageUrl(own, undefined, page), true);
    assert.equal(isAppPageUrl(`${own}#/harness`, undefined, page), true);
    assert.equal(isAppPageUrl(`${own}?x=1`, undefined, page), true);
  });

  it("refuses every other page in production", () => {
    for (const url of ["https://example.com/", "file:///etc/hosts", pathToFileURL(page.replace("index.html", "other.html")).href, "javascript:alert(1)", "not a url"]) {
      assert.equal(isAppPageUrl(url, undefined, page), false, url);
    }
  });

  it("accepts only the dev server's origin while developing", () => {
    const dev = "http://localhost:5173";
    assert.equal(isAppPageUrl("http://localhost:5173/#/projects", dev, page), true);
    assert.equal(isAppPageUrl("http://localhost:5174/", dev, page), false);
    assert.equal(isAppPageUrl(own, dev, page), false);
  });
});
