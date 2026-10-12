// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isAllowedExternalUrl, SETTINGS_DEEP_LINK_PREFIX } from "../externalUrl";

describe("isAllowedExternalUrl", () => {
  it("allows the macOS System Settings deep link", () => {
    assert.equal(isAllowedExternalUrl(`${SETTINGS_DEEP_LINK_PREFIX}com.apple.preference.security`), true);
  });

  it("refuses every web URL, https included", () => {
    assert.equal(isAllowedExternalUrl("https://example.com"), false);
    assert.equal(isAllowedExternalUrl("http://localhost:8080"), false);
    assert.equal(isAllowedExternalUrl("http://localhost:@evil.com"), false);
  });

  it("refuses a scheme that only starts like the deep link", () => {
    assert.equal(SETTINGS_DEEP_LINK_PREFIX, "x-apple.systempreferences:");
    assert.equal(isAllowedExternalUrl("x-apple.systempreferencesfoo:x"), false);
    assert.equal(isAllowedExternalUrl("x-apple.systempreferences.evil:x"), false);
  });

  it("refuses other schemes", () => {
    assert.equal(isAllowedExternalUrl("file:///etc/passwd"), false);
    assert.equal(isAllowedExternalUrl("javascript:alert(1)"), false);
    assert.equal(isAllowedExternalUrl(`https://evil.com/?${SETTINGS_DEEP_LINK_PREFIX}`), false);
  });

  it("refuses non-string input", () => {
    assert.equal(isAllowedExternalUrl(undefined), false);
    assert.equal(isAllowedExternalUrl(42), false);
  });
});
