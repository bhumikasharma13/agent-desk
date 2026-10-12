// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodexMcpServers } from "../../internal";

const tmp = mkdtempSync(join(tmpdir(), "lse-codex-mcp-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function serversIn(toml: string): string[] {
  const path = join(tmp, `config-${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(path, toml);
  return readCodexMcpServers(path);
}

describe("readCodexMcpServers", () => {
  it("reads Codex's [mcp_servers.<name>] tables", () => {
    assert.deepEqual(serversIn('[mcp_servers.docs]\ncommand = "npx"\n\n[mcp_servers."my server"]\nurl = "http://127.0.0.1:9"\n'), ["docs", "my server"]);
  });

  it("reads the older [mcpServers.<name>] spelling", () => {
    assert.deepEqual(serversIn("[mcpServers.docs]\ncommand = \"npx\"\n"), ["docs"]);
  });

  it("does not read a nested table as another server, and lists each server once", () => {
    assert.deepEqual(serversIn("[mcp_servers.docs]\n[mcp_servers.docs.env]\nTOKEN = \"x\"\n[mcpServers.docs]\n"), ["docs"]);
  });

  it("returns none for a missing file or a config with no server tables", () => {
    assert.deepEqual(readCodexMcpServers(join(tmp, "absent.toml")), []);
    assert.deepEqual(serversIn('model = "o4-mini"\n[profiles.fast]\n'), []);
  });
});
