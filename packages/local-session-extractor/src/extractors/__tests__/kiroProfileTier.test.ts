// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A Kiro CLI profile with no name says nothing about the plan: it is "unknown",
 * unless an AWS profile ARN marks it as account-provisioned (enterprise).
 */
import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { detectKiroPlanTier } from "../../internal";
import { setPathOverrides } from "../pathResolver";

const tmp = mkdtempSync(join(tmpdir(), "lse-kiro-profile-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function tierFor(name: string, profile: Record<string, unknown>): string | undefined {
  const path = join(tmp, `${name}.sqlite3`);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB)");
  db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value BLOB)");
  db.prepare("INSERT INTO state (key, value) VALUES (?, ?)").run("api.codewhisperer.profile", JSON.stringify(profile));
  db.close();
  setPathOverrides({ KIRO_CLI_DB_PATH: path });
  return detectKiroPlanTier()?.plan_tier;
}

describe("detectKiroPlanTier — the CLI profile name", () => {
  afterEach(() => setPathOverrides({ KIRO_CLI_DB_PATH: undefined }));

  it("reads a profile with no name and no ARN as unknown", () => {
    assert.equal(tierFor("no-name", {}), "unknown");
    assert.equal(tierFor("empty-name", { profile_name: "" }), "unknown");
  });

  it("reads an ARN-bound profile as enterprise", () => {
    assert.equal(tierFor("arn", { arn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/EXAMPLE" }), "enterprise");
  });

  it("maps the known standalone names", () => {
    assert.equal(tierFor("pro", { profile_name: "Q_DEVELOPER_STANDALONE_PRO" }), "pro");
  });
});
