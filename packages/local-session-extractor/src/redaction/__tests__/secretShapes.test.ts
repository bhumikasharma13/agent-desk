// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Secret shapes the README says are masked, each written bare, with no
 * `KEY=` context that a broader pattern could catch instead.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../secrets";

const M = "████████";

describe("redactSecrets — shapes written bare", () => {
  const cases: Array<[string, string, string]> = [
    ["an OpenAI project key", "key sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_abcDEFghiJKLmnoPQRstuVWXyz", `key ${M}`],
    ["an OpenAI service-account key", "sk-svcacct-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 here", `${M} here`],
    ["an OpenAI admin key", "sk-admin-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 here", `${M} here`],
    ["a JSON password", '{"password": "correcthorsebatterystaple"}', `{"${M}"}`],
    ["a JSON api_key", '{"api_key": "abcdefghijklmnopqrstuvwxyz"}', `{"${M}"}`],
    ["a JSON GITHUB_TOKEN", '{"GITHUB_TOKEN":"abcdefghijklmnopqrstuvwxyzabcd"}', `{"GITHUB_${M}"}`],
    ["a one-letter email local part", "mail j@example.com please", `mail ${M} please`],
    ["a non-ASCII email local part", "mail jané@example.com please", `mail ${M} please`],
    ["a GitHub user-to-server token", "t ghu_abcdefghijklmnopqrstuvwxyz0123456789", `t ${M}`],
    ["a lower-case bearer scheme", "Authorization: bearer abcdefghijklmnopqrstuvwxyz012345", `Authorization: ${M}`],
    [
      "an encrypted PEM block",
      "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgkqhkiG9w0BBQ0wQTApBgkqhkiG9w0BBQwwHAQI\n-----END ENCRYPTED PRIVATE KEY----- done", // fake credential, test fixture. gitleaks:allow
      `${M} done`,
    ],
    ["an encrypted PEM block cut before its END line", "x -----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFHDBOBgkqhkiG9w0BBQ0w", `x ${M}`],
    ["a TLS Redis URL", "rediss://default:hunter2pass@localhost:6379", M],
    ["a SQLAlchemy driver URL", "postgresql+asyncpg://app:hunter2pass@localhost:5432/db", M],
    ["a ClickHouse URL", "clickhouse://u:hunter2pass@localhost:9000", M],
    ["a SQL Server URL with a dotless host", "sqlserver://bob:hunter2pass@db", M],
    ["a short env password", "DB_PASSWORD=hunter2", M],
    ["a short JSON api_key", '"api_key": "short1"', `"${M}"`],
    ["a one-character secret value", "TOKEN=x", M],
    ["a short bearer token", "Authorization: Bearer abcdefghij012345678", `Authorization: ${M}`],
    ["an 8-character bearer token", "Authorization: Bearer abcd1234", `Authorization: ${M}`],
    ["an email with a non-ASCII domain", "mail jane@exämple.com now", `mail ${M} now`],
    ["an email whose local part runs past 64 characters, whole", `${"x".repeat(70)}@example.com`, M],
  ];
  for (const [name, input, want] of cases) {
    it(`masks ${name}`, () => assert.equal(redactSecrets(input), want));
  }

  it("leaves a bearer word shorter than 8 characters alone", () => {
    assert.equal(redactSecrets("Bearer abc123x"), "Bearer abc123x");
  });

  it("leaves a scheme-less user:pass@host alone", () => {
    assert.equal(redactSecrets("ssh bob:pw@host"), "ssh bob:pw@host");
  });

  it("leaves a two-word email-looking phrase with no domain dot alone", () => {
    assert.equal(redactSecrets("ping j@localhost"), "ping j@localhost");
  });

  it("merges two spans that touch into one placeholder", () => {
    // The bearer token ends exactly where the `?token=` query parameter begins.
    assert.equal(redactSecrets("Bearer abcdefghijklmnopqrstuvwxyz?token=secretvalue end"), `${M} end`);
  });
});

describe("redactSecrets — connection strings", () => {
  const cases: Array<[string, string, string]> = [
    ["a quote in the password", "postgres://bob:pa'ss123@h/db", M],
    ["an @ inside the password", "postgres://bob:Pa@ss@localhost/db", M],
    ["a backtick in the password", "postgres://bob:pa`ss@h", M],
    ["a 2-character password", "mysql://bob:pw@h", M],
    ["a 3-character password", "mysql://bob:pwd@h", M],
    ["a 7-character password", "mysql://bob:pw12345@h", M],
    ["an 8-character password", "mysql://bob:pw123456@h", M],
    ["no user and a 7-character password", "redis://:abcdefg@h", M],
    ["no user and a 1-character password", "redis://:x@h", M],
    ["an upper-case scheme", "POSTGRES://u:p@h", M],
    ["a scheme with a dot", "a.b://u:pw@h", M],
    ["a scheme with a dash", "x-y://u:pw@h", M],
  ];
  for (const [name, input, want] of cases) {
    it(`masks ${name}`, () => assert.equal(redactSecrets(`url ${input} end`), `url ${want} end`));
  }
});

describe("redactSecrets — a very long email local part", () => {
  it("masks an address with a 256-character local part whole", () => {
    assert.equal(redactSecrets(`${"x".repeat(256)}@example.com`), M);
  });

  it("masks the domain and the last 256 characters of a 257-character local part", () => {
    assert.equal(redactSecrets(`${"x".repeat(257)}@example.com`), `x${M}`);
  });
});

describe("redactSecrets — connection strings, every shape", () => {
  const masked: Array<[string, string]> = [
    ["a `/` in the password", "DATABASE_URL is postgres://app:Zx9/kQ2+abcd@db:5432/app ok"],
    ["a `#` in the password", "use postgres://app:hunter2#1@db/app ok"],
    ["a `?` in the password", "use postgres://app:hun?ter@db/app ok"],
    ["a 66-letter scheme", `use ${"a".repeat(66)}://u:pw@h ok`],
    ["a 9-character user", "use mysql://abcdefghi:pw@h ok"],
    ["a 1025-character password", `use mysql://u:${"p".repeat(1025)}@h ok`],
    ["an IPv6 host", "use postgres://u:pw@[::1]:5432/db ok"],
    ["an @ in the path after the host", "use https://u:pw@h/a@b ok"],
    ["an @ in the query after the host", "use https://u:pw@h/a?x=c@d ok"],
    ["a scheme after a digit", "use 1postgres://u:pw@h/db ok"],
    ["a port and an @ in the path, with no user (over-masked, the safe direction)", "use https://h:8080/a@b ok"],
  ];
  for (const [name, input] of masked) {
    it(`masks ${name}`, () => {
      const out = redactSecrets(input);
      assert.ok(!/pw|kQ2|hunter2|hun\?ter|ppp|8080/.test(out.slice(4, -3)), out);
      assert.ok(out.includes(M), out);
    });
  }

  it("masks a 100 KB password in under two seconds", () => {
    const start = performance.now();
    assert.equal(redactSecrets(`mysql://u:${"p".repeat(100 * 1024)}@h`), M);
    assert.ok(performance.now() - start < 2000);
  });

  // Pinned as they are today.
  it("masks a colon-less token user only when it reads as an email address", () => {
    assert.equal(redactSecrets("x https://x-access-token@github.com/org/app y"), `x https://${M}/org/app y`);
    assert.equal(redactSecrets("x https://abcdef123456@gitserver/repo y"), "x https://abcdef123456@gitserver/repo y");
  });

  it("masks git@github.com as an email address, keeping the repo path", () => {
    assert.equal(redactSecrets("git@github.com:org/repo.git"), `${M}:org/repo.git`);
  });

  it("leaves a URL with an @ in its path but no userinfo alone", () => {
    assert.equal(redactSecrets("see https://example.com/u/a@b now"), "see https://example.com/u/a@b now");
  });

  it("leaves a user with no password before a port alone", () => {
    assert.equal(redactSecrets("x postgres://app@db:5432/x y"), "x postgres://app@db:5432/x y");
  });

  it("leaves prose user:pass@x with no scheme alone", () => {
    assert.equal(redactSecrets("use user:pass@x here"), "use user:pass@x here");
  });
});

describe("redactSecrets — connection strings with an empty or socket host", () => {
  const cases: Array<[string, string, string]> = [
    ["a libpq Unix-socket URL", "DATABASE_URL=postgresql://app:S3cretPassw0rd@/appdb?host=/tmp", `DATABASE_URL=${M}`],
    ["an empty host before a port", "postgresql://app:S3cretPassw0rd@:5433/appdb", M],
    ["a host starting with `_`", "postgres://u:hunter2pass@_db/x", M],
    ["a URL ending at its `@`", "tail postgres://u:hunter2pass@", `tail ${M}`],
    ["an Azure user holding an `@`", "postgres://myadmin@mydemoserver:S3cretPassw0rd@db:5432/postgres", M],
    ["a quoted URL ending at its `@`", '{"url":"postgres://u:pw@"}', `{"url":"${M}"}`],
    ["a quoted URL, up to its closing quote only", '"postgres://u:pw@h/db","next":"x"', `"${M}","next":"x"`],
  ];
  for (const [name, input, want] of cases) {
    it(`masks ${name}`, () => assert.equal(redactSecrets(input), want));
  }
});

describe("redactSecrets — the re-check's four connection strings", () => {
  for (const input of [
    "postgres://app:Zx9/kQ2+abcd@db:5432/app",
    "postgres://app:hunter2/@db.internal/app",
    "postgres://app:hunter2#1@db/app",
    "amqp://svc:p?w=1@mq/vhost",
  ]) {
    it(`masks ${input}`, () => assert.equal(redactSecrets(`url ${input} end`), `url ${M} end`));
  }
});
