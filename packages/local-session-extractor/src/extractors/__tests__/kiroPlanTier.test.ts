// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * The Kiro CLI plan-tier read. Its database mirrors a real kiro-cli
 * `data.sqlite3`: a `state(key, value BLOB)` table holding JSON-encoded values
 * and an `auth_kv(key, value TEXT)` table holding the social-login token.
 */
import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { detectKiroPlanTier } from "../planTierDetector";
import { setPathOverrides } from "../pathResolver";

function jwt(claims: Record<string, unknown>): string {
  const part = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.sig`;
}

function kiroCliDb(dir: string, name: string, state: Record<string, unknown>, accessToken?: string): string {
  const path = join(dir, name);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB)");
  db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  const put = db.prepare("INSERT INTO state VALUES (?, ?)");
  for (const [key, value] of Object.entries(state)) put.run(key, JSON.stringify(value));
  if (accessToken !== undefined) {
    db.prepare("INSERT INTO auth_kv VALUES (?, ?)").run("kirocli:social:token", JSON.stringify({ access_token: accessToken }));
  }
  db.close();
  return path;
}

describe("detectKiroPlanTier — CLI database", () => {
  let dir = "";
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "kiro-plan-tier-"));
    // No desktop state.vscdb: the free-trial cross-check reads nothing.
    setPathOverrides({ KIRO_DB_PATH: join(dir, "no-global-storage") });
  });
  afterEach(() => setPathOverrides({ KIRO_CLI_DB_PATH: undefined }));
  after(() => {
    setPathOverrides({ KIRO_DB_PATH: undefined });
    rmSync(dir, { recursive: true, force: true });
  });

  const profile = { arn: "arn:aws:codewhisperer:us-east-1:000000000000:profile/EXAMPLE", profile_name: "Q_DEVELOPER_STANDALONE_PRO" };

  it("reads the tier, version and device id in their real shapes", () => {
    setPathOverrides({
      KIRO_CLI_DB_PATH: kiroCliDb(dir, "ok.sqlite3", {
        "api.codewhisperer.profile": profile,
        "desktop.versionAtPreviousLaunch": "0.9.2",
        telemetryClientId: "00000000-1111-4222-8333-444444444444",
      }, "opaque-token-value"),
    });
    const meta = detectKiroPlanTier();
    assert.equal(meta?.plan_tier, "pro");
    assert.equal(meta?.plan_tier_source, "kiro_cli_profile");
    assert.equal(meta?.ide_version, "0.9.2");
    assert.equal(meta?.device_id, "00000000-1111-4222-8333-444444444444");
    assert.equal(meta?.login_email, undefined, "an opaque access token carries no email");
  });

  it("reads the email claim of a JWT access token, and keeps no part of the token", () => {
    const token = jwt({ email: "someone@example.com" });
    setPathOverrides({
      KIRO_CLI_DB_PATH: kiroCliDb(dir, "jwt.sqlite3", { "api.codewhisperer.profile": profile }, token),
    });
    const meta = detectKiroPlanTier();
    assert.equal(meta?.login_email, "someone@example.com");
    for (const part of token.split(".")) assert.ok(!JSON.stringify(meta).includes(part), "no token segment is kept");
  });

  it("drops values in any other shape rather than storing them", () => {
    setPathOverrides({
      KIRO_CLI_DB_PATH: kiroCliDb(dir, "odd.sqlite3", {
        "api.codewhisperer.profile": profile,
        "desktop.versionAtPreviousLaunch": { nested: "object" },
        telemetryClientId: "/Users/example-user/secret-path",
      }, jwt({ email: "not an email" })),
    });
    const meta = detectKiroPlanTier();
    assert.equal(meta?.plan_tier, "pro", "the recognised tier still reports");
    for (const key of ["ide_version", "device_id", "login_email"] as const) {
      assert.equal(meta?.[key], undefined, `${key} must be absent`);
    }
  });
});
