// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT

import { fileURLToPath } from "node:url";

/**
 * Whether `url` is the app's own page, the only place its window may navigate: the dev
 * server's origin while developing, else exactly the packaged page file (any hash or query).
 */
export function isAppPageUrl(url: string, devServerUrl: string | undefined, pageFile: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (devServerUrl) return target.origin === new URL(devServerUrl).origin;
  if (target.protocol !== "file:") return false;
  target.hash = "";
  target.search = "";
  return fileURLToPath(target) === pageFile;
}
