// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// The macOS System Settings deep-link scheme. The folder-access banner's "Open
// System Settings" button is the one thing the app opens outside itself.
export const SETTINGS_DEEP_LINK_PREFIX = "x-apple.systempreferences:";

// The allowlist for the renderer-facing shell:openExternal IPC handler: the
// System Settings deep link and nothing else, so a compromised page cannot use
// the handler to open a web page, a file or another app.
export function isAllowedExternalUrl(url: unknown): boolean {
  return typeof url === "string" && url.startsWith(SETTINGS_DEEP_LINK_PREFIX);
}
