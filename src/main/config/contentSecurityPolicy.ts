// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

// The Content-Security-Policy header for the app's page. The built page loads its
// scripts, styles and fonts from its own folder and fetches nothing: the data
// comes over IPC, so `connect-src 'none'` also keeps a script in the page from
// reading files through file:// URLs. Only the Vite dev server (`pnpm start`)
// needs eval, inline scripts and its websocket; the built app gets the built
// page's policy whether it is packaged or not, so the tests run it.
export function contentSecurityPolicy(devServerUrl: string | undefined): string {
  if (devServerUrl) {
    return [
      "default-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' ws://localhost:*",
      "img-src 'self' data:",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'none'",
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
