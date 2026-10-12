// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "../secrets";

const R = "████████";

describe("redactSecrets", () => {
  it("returns empty string unchanged", () => {
    assert.equal(redactSecrets(""), "");
  });

  it("returns plain text unchanged", () => {
    const text = "Hello world, this is a normal sentence about coding.";
    assert.equal(redactSecrets(text), text);
  });

  // ── JWT ──────────────────────────────────────────────────────────────────

  it("redacts a full JWT token", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"; // fake credential, test fixture. gitleaks:allow
    const result = redactSecrets(`the jwt is ${jwt} here`);
    assert.ok(!result.includes("eyJ"), "JWT should be redacted");
    assert.ok(result.includes("the jwt is"), "surrounding text preserved");
  });

  it("redacts a partial JWT header", () => {
    const partial = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9extra";
    const result = redactSecrets(`Bearer ${partial}`);
    assert.ok(!result.includes("eyJ"));
  });

  // ── Database connection strings ──────────────────────────────────────────

  it("redacts postgres connection strings", () => {
    const url = "postgres://admin:s3cretP@ss@db.example.com:5432/mydb";
    assert.ok(!redactSecrets(url).includes("s3cretP@ss"));
  });

  it("redacts mongodb+srv connection strings", () => {
    const url = "mongodb+srv://user:password123@cluster.mongodb.net/db";
    assert.ok(!redactSecrets(url).includes("password123"));
  });

  it("redacts password-only Redis connection strings with real secrets", () => {
    const url = "redis://:supersecret99@localhost:6379/0";
    assert.ok(!redactSecrets(url).includes("supersecret99"));
  });

  it("masks a port-like URI with an empty user too, the safe direction", () => {
    assert.equal(redactSecrets("redis://:6379@localhost is malformed"), "████████ is malformed");
  });

  // ── API keys ─────────────────────────────────────────────────────────────

  it("redacts Anthropic API keys", () => {
    const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    assert.ok(!redactSecrets(`key=${key}`).includes("sk-ant"));
  });

  it("redacts OpenAI API keys", () => {
    const key = "sk-" + "a".repeat(48);
    assert.ok(!redactSecrets(`OPENAI_API_KEY=${key}`).includes("sk-"));
  });

  it("redacts HuggingFace tokens", () => {
    const key = "hf_" + "A".repeat(30);
    assert.ok(!redactSecrets(key).includes("hf_"));
  });

  it("redacts GitHub tokens (ghp, gho, ghs, ghr)", () => {
    const ghp = "ghp_" + "a".repeat(36);
    const gho = "gho_" + "c".repeat(36);
    const ghs = "ghs_" + "B".repeat(36);
    const ghr = "ghr_" + "D".repeat(36);
    assert.ok(!redactSecrets(ghp).includes("ghp_"));
    assert.ok(!redactSecrets(gho).includes("gho_"));
    assert.ok(!redactSecrets(ghs).includes("ghs_"));
    assert.ok(!redactSecrets(ghr).includes("ghr_"));
  });

  it("redacts GitHub fine-grained PATs (github_pat_)", () => {
    const pat = "github_pat_" + "A1b2".repeat(10);
    assert.ok(!redactSecrets(`token: ${pat}`).includes("github_pat_"));
  });

  it("redacts NPM tokens", () => {
    const key = "npm_" + "x".repeat(36);
    assert.ok(!redactSecrets(key).includes("npm_"));
  });

  // ── AWS ──────────────────────────────────────────────────────────────────

  it("redacts AWS access key IDs (long-term AKIA + temporary ASIA)", () => {
    assert.ok(!redactSecrets("aws_access_key_id=AKIAIOSFODNN7EXAMPLE").includes("AKIA"));
    assert.ok(!redactSecrets("temp creds: ASIAIOSFODNN7EXAMPLE here").includes("ASIA"));
  });

  it("redacts AWS secret access keys", () => {
    const line = "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY01";
    assert.ok(!redactSecrets(line).includes("wJalr"));
  });

  it("redacts a bare AWS secret key in prose when a cue is nearby", () => {
    const key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"; // 40 chars, mixed types
    assert.ok(!redactSecrets(`here is my secret ${key} ok`).includes("wJalr"));
    assert.ok(!redactSecrets(`AKIAIOSFODNN7EXAMPLE and ${key}`).includes("wJalr"));
    // An adjacent AKIA id is authoritative: redact the 40-char key even when it
    // is letters-only (which the mixed-char-types guard would otherwise veto).
    const lettersKey = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN"; // 40 letters, no digit
    assert.ok(!redactSecrets(`AKIAIOSFODNN7EXAMPLE ${lettersKey}`).includes(lettersKey));
    // A temporary-credential ASIA id is an authoritative cue too (no word cue here).
    assert.ok(!redactSecrets(`ASIAIOSFODNN7EXAMPLE ${key}`).includes("wJalr"));
  });

  it("does NOT redact a 40-char git SHA, even next to a secret/aws cue", () => {
    const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4"; // lowercase hex → 2 char types
    const plain = `the sha is ${sha} here`;
    assert.equal(redactSecrets(plain), plain);
    const withCue = `secret rotation, see commit ${sha} done`;
    assert.equal(redactSecrets(withCue), withCue);
  });

  it("does NOT treat a substring cue (jaws/secretary) as an AWS cue", () => {
    const tok = "Ab3Cd5Ef7Gh9Ij1Kl3Mn5Op7Qr9St1Uv3Wx5Yz7A"; // 40-char mixed-case, not a secret
    const jaws = `the jaws of life ${tok} here`;
    assert.equal(redactSecrets(jaws), jaws);
    const sec = `my secretary noted ${tok} today`;
    assert.equal(redactSecrets(sec), sec);
  });

  // ── Slack / Discord ──────────────────────────────────────────────────────

  it("redacts Slack tokens (xoxb/xoxe/xapp)", () => {
    const xoxb = "xoxb-" + "1234567890-".repeat(3) + "abcdef";
    const xoxe = "xoxe-" + "1234567890-".repeat(3) + "abcdef";
    const xapp = "xapp-" + "1234567890-".repeat(3) + "abcdef";
    assert.ok(!redactSecrets(xoxb).includes("xoxb"));
    assert.ok(!redactSecrets(xoxe).includes("xoxe"));
    assert.ok(!redactSecrets(xapp).includes("xapp"));
  });

  it("redacts Discord webhook URLs", () => {
    const url =
      "https://discord.com/api/webhooks/123456789/abcdefghijklmnopqrstuvwxyz";
    assert.ok(!redactSecrets(url).includes("webhooks"));
  });

  // ── Private keys ─────────────────────────────────────────────────────────

  it("redacts PEM private keys", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIBogIBAAJBALRiMLAH...base64data...
-----END RSA PRIVATE KEY-----`;
    const result = redactSecrets(pem);
    assert.ok(!result.includes("MIIBog"));
  });

  // ── Bearer tokens ────────────────────────────────────────────────────────

  it("redacts Bearer tokens", () => {
    const line = "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";
    assert.ok(!redactSecrets(line).includes("eyJ"));
  });

  // ── Env variable assignments ─────────────────────────────────────────────

  it("redacts SECRET= assignments", () => {
    const line = "SECRET=my_super_secret_value_here";
    assert.ok(!redactSecrets(line).includes("my_super_secret"));
  });

  it("redacts API_KEY= assignments", () => {
    const line = "API_KEY=abcdef123456789"; // fake credential, test fixture. gitleaks:allow
    assert.ok(!redactSecrets(line).includes("abcdef123456789"));
  });

  // ── Compound env variable assignments (PREFIX_KEYWORD=value) ────────────

  it("redacts GOOGLE_SECRET= (compound prefix)", () => {
    assert.ok(!redactSecrets("GOOGLE_SECRET=supersecretvalue").includes("supersecretvalue"));
  });

  it("redacts OAUTH_TOKEN= (compound prefix)", () => {
    assert.ok(!redactSecrets("OAUTH_TOKEN=abc12345678xyz").includes("abc12345678xyz")); // fake credential, test fixture. gitleaks:allow
  });

  it("redacts MY_DB_PASSWORD= (compound prefix)", () => {
    assert.ok(!redactSecrets("MY_DB_PASSWORD=hunter2hunter2").includes("hunter2hunter2"));
  });

  it("redacts APP_SECRET_KEY= (compound prefix)", () => {
    assert.ok(!redactSecrets("APP_SECRET_KEY=xyzxyzxyzxyz").includes("xyzxyzxyzxyz"));
  });

  it("redacts exported compound env vars", () => {
    assert.ok(!redactSecrets("export GOOGLE_SECRET=supersecretvalue").includes("supersecretvalue"));
  });

  // ── Generic secret patterns ──────────────────────────────────────────────

  it("redacts generic secret_key assignments", () => {
    const line = 'secret_key = "very-secret-value-12345"';
    assert.ok(!redactSecrets(line).includes("very-secret"));
  });

  // ── URL auth parameters ──────────────────────────────────────────────────

  it("redacts URL auth query params", () => {
    const url = "https://api.example.com/data?api_key=sk_live_abc123xyz789&format=json";
    const result = redactSecrets(url);
    assert.ok(!result.includes("sk_live_abc123xyz789")); // fake credential, test fixture. gitleaks:allow
  });

  // ── Email addresses ──────────────────────────────────────────────────────

  it("redacts email addresses", () => {
    const text = "Contact jane.doe@example.com for details";
    assert.ok(!redactSecrets(text).includes("jane.doe@example.com"));
  });

  it("does not redact non-email @ mentions", () => {
    // Single character before @ is too short for the pattern
    const text = "see @user for details";
    assert.equal(redactSecrets(text), text);
  });

  // ── Entropy detection ────────────────────────────────────────────────────

  it("redacts high-entropy quoted strings", () => {
    // This is a base64-like high-entropy string in quotes
    const text = 'config: "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9d"';
    const result = redactSecrets(text);
    assert.ok(!result.includes("aB3dE5fG7h"));
  });

  it("preserves low-entropy quoted strings", () => {
    const text = 'message: "aaaaaaaaaaaaaaaaaaaaaa"';
    // Repeating chars → low entropy → should NOT be redacted
    assert.equal(redactSecrets(text), text);
  });

  // ── Multiple secrets in one text ─────────────────────────────────────────

  it("redacts multiple secrets in the same text", () => {
    const text = [
      "API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "DB_URL=postgres://admin:pass@db.example.com/mydb",
      "Contact: admin@example.com",
    ].join("\n");
    const result = redactSecrets(text);
    assert.ok(!result.includes("sk-ant"));
    assert.ok(!result.includes("admin:pass"));
    assert.ok(!result.includes("admin@example.com"));
  });

  // ── Google credentials ───────────────────────────────────────────────────

  it("redacts Google OAuth client secrets (GOCSPX- prefix)", () => {
    const line = "GOOGLE_CLIENT_SECRET=GOCSPX-" + "-FakeFixtureValue0123456789";
    const result = redactSecrets(line);
    assert.ok(!result.includes("GOCSPX"), "GOCSPX value should be redacted");
  });

  it("redacts standalone GOCSPX- tokens not in key=value form", () => {
    const text = "client secret: GOCSPX-" + "FakeFixtureValue0123456789";
    assert.ok(!redactSecrets(text).includes("GOCSPX"));
  });

  it("redacts Google API keys (AIza prefix)", () => {
    const key = "AIza" + "SyFAKEFIXTUREabcdefghijklmnopqrstuv";
    assert.ok(!redactSecrets(`google_api_key=${key}`).includes("AIza"));
  });

  it("redacts Google OAuth access tokens (ya29. prefix)", () => {
    const token = "ya29.a0AfH6SMBxValidTokenHereAbcDefGhi123456789";
    assert.ok(!redactSecrets(`Authorization: Bearer ${token}`).includes("ya29."));
  });

  // ── Stripe ───────────────────────────────────────────────────────────────

  it("redacts Stripe live secret keys (sk_live_)", () => {
    const key = "sk_" + "live_abcdefghij1234567890ABCDEFGHIJ";
    assert.ok(!redactSecrets(`STRIPE_KEY=${key}`).includes("sk_live_"));
  });

  it("redacts Stripe test secret keys (sk_test_)", () => {
    const key = "sk_" + "test_abcdefghij1234567890ABCDEFGHIJ";
    assert.ok(!redactSecrets(key).includes("sk_test_"));
  });

  it("redacts Stripe restricted keys (rk_live_)", () => {
    const key = "rk_" + "live_abcdefghij1234567890ABCDEFGHIJ";
    assert.ok(!redactSecrets(key).includes("rk_live_"));
  });

  it("redacts Stripe restricted test keys (rk_test_)", () => {
    const key = "rk_test_abcdefghij1234567890ABCDEFGHIJ"; // fake credential, test fixture. gitleaks:allow
    assert.ok(!redactSecrets(key).includes("rk_test_"));
  });

  // ── SendGrid ─────────────────────────────────────────────────────────────

  it("redacts SendGrid API keys (SG. prefix)", () => {
    const key =
      "SG." + "abcdefghijklmnopqrstuvwxyz12345678901234567890abcdefghijklmnopqr";
    assert.ok(!redactSecrets(`SENDGRID_API_KEY=${key}`).includes("SG."));
  });

  // ── Twilio ───────────────────────────────────────────────────────────────

  it("redacts Twilio API key SIDs (SK + 32 hex)", () => {
    const key = "SKabc123def456ghi789jkl012mno345pqr0"; // fake credential, test fixture. gitleaks:allow
    assert.ok(!redactSecrets(`twilio_key=${key}`).includes("SKabc123"));
  });

  // ── Space-separated credentials ─────────────────────────────────────────

  it("redacts password in space-separated log/config format", () => {
    const line =
      "Service: username app_data_user password SuperSecret123!";
    const result = redactSecrets(line);
    assert.ok(
      !result.includes("SuperSecret123!"),
      "password value should be redacted"
    );
    assert.ok(result.includes("username"), "non-secret parts preserved");
  });

  it("redacts passwd in space-separated format", () => {
    const line = "DSN: host=localhost port=5432 dbname=mydb passwd S3cr3tP@ssword!";
    const result = redactSecrets(line);
    assert.ok(!result.includes("S3cr3tP@ssword!"));
  });

  it("does not redact common phrase 'password is required'", () => {
    const text = "Error: password is required";
    assert.equal(redactSecrets(text), text);
  });

  it("does not redact 'password expired' (short word after password)", () => {
    const text = "Your password expired last week";
    assert.equal(redactSecrets(text), text);
  });

  it("does not redact 'password has been reset'", () => {
    const text = "password has been reset successfully";
    assert.equal(redactSecrets(text), text);
  });

  // ── HTTP basic auth URLs ─────────────────────────────────────────────────

  it("redacts HTTP basic auth credentials in URLs", () => {
    const url = "https://admin:MySecret123@api.example.com/v1/data";
    const result = redactSecrets(url);
    assert.ok(!result.includes("MySecret123"), "password should be redacted");
    assert.ok(!result.includes("admin:"), "user:pass should be redacted");
  });

  it("redacts MySQL connection strings", () => {
    const url = "mysql://reporter:VerySecret123@db.internal:3306/app";
    assert.ok(!redactSecrets(url).includes("VerySecret123"));
  });

  it("redacts postgresql connection strings", () => {
    const url = "postgresql://reporter:VerySecret123@db.internal:5432/app";
    assert.ok(!redactSecrets(url).includes("VerySecret123"));
  });

  // ── Redis / AMQP URIs ────────────────────────────────────────────────────

  it("redacts Redis URIs with passwords", () => {
    const url = "redis://:MyRedisPassword@localhost:6379";
    assert.ok(!redactSecrets(url).includes("MyRedisPassword"));
  });

  it("redacts AMQP URIs with credentials", () => {
    const url = "amqp://app_user:StrongPassword123@rabbitmq.host/vhost";
    const result = redactSecrets(url);
    assert.ok(!result.includes("StrongPassword123"));
    assert.ok(!result.includes("app_user:"));
  });

  it("redacts AMQPS URIs with credentials", () => {
    const url = "amqps://app_user:StrongPassword123@rabbitmq.host/vhost";
    const result = redactSecrets(url);
    assert.ok(!result.includes("StrongPassword123"));
    assert.ok(!result.includes("app_user:"));
  });

  // ── New Pattern 22 keywords ──────────────────────────────────────────────

  it("redacts CLIENT_SECRET= assignments", () => {
    const line = "CLIENT_SECRET=GOCSPX-" + "-FakeFixtureValue0123456789";
    assert.ok(!redactSecrets(line).includes("GOCSPX"));
  });

  it("redacts REFRESH_TOKEN= assignments", () => {
    const line = "REFRESH_TOKEN=1//0gAbCdEfGhIjKlMnOpQrStUvWxYz1234567890";
    assert.ok(!redactSecrets(line).includes("1//0gAbCdEf"));
  });

  it("redacts WEBHOOK_SECRET= assignments", () => {
    const line = "WEBHOOK_SECRET=whsec_abcdefghij1234567890ABCDEFGHabcdefghij"; // fake credential, test fixture. gitleaks:allow
    assert.ok(!redactSecrets(line).includes("whsec_"));
  });

  it("redacts SIGNING_KEY= assignments", () => {
    const line = "SIGNING_KEY=HS256secretkeyabcdefghijklmnop"; // fake credential, test fixture. gitleaks:allow
    assert.ok(!redactSecrets(line).includes("HS256secretkey"));
  });

  it("redacts SESSION_SECRET= assignments", () => {
    const line = "SESSION_SECRET=s3cr3tsessionkeyabcdefghijklmnop";
    assert.ok(!redactSecrets(line).includes("s3cr3tsession"));
  });

  it("redacts ENCRYPTION_KEY= assignments", () => {
    const line = "ENCRYPTION_KEY=aes256keyabcdefghijklmnopqrstuv"; // fake credential, test fixture. gitleaks:allow
    assert.ok(!redactSecrets(line).includes("aes256key"));
  });

  // ── New Pattern 23 generic keywords ─────────────────────────────────────

  it("redacts client_secret: assignments", () => {
    const line = 'client_secret: "GOCSPX-' + '-FakeFixtureValue0123456789"';
    assert.ok(!redactSecrets(line).includes("GOCSPX"));
  });

  it("redacts refresh_token: assignments", () => {
    const line = 'refresh_token: "1//0gAbCdEfGhIjKlMnOpQrStUvWxYz1234567890"';
    assert.ok(!redactSecrets(line).includes("1//0gAbCdEf"));
  });

  it("redacts webhook_secret= assignments", () => {
    const line = "webhook_secret=whsec_abcdefghij1234567890ABCDEFGH"; // fake credential, test fixture. gitleaks:allow
    assert.ok(!redactSecrets(line).includes("whsec_"));
  });

  it("redacts signing_key= assignments", () => {
    const line = "signing_key=hs256secretkeyabcdefghijklmnop"; // fake credential, test fixture. gitleaks:allow
    assert.ok(!redactSecrets(line).includes("hs256secretkey"));
  });

  // ── New URL query param keywords ─────────────────────────────────────────

  it("redacts client_secret in URL query params", () => {
    const url =
      "https://oauth.example.com/callback?client_secret=abc123def456ghi789&code=xyz";
    const result = redactSecrets(url);
    assert.ok(!result.includes("abc123def456ghi789"));
    assert.ok(result.includes("code=xyz"), "other params preserved");
  });

  it("redacts PASSWORD= values that contain ampersands", () => {
    const line = "PASSWORD=abc&defghi";
    assert.ok(!redactSecrets(line).includes("abc&defghi"));
  });

  it("redacts PASSWORD= values containing query-like substrings", () => {
    const line = "PASSWORD=abc12345&mode=debugX";
    const result = redactSecrets(line);
    assert.ok(!result.includes("abc12345&mode=debugX"));
    assert.ok(!result.includes("&mode=debugX"));
  });

  it("redacts PASSWORD= values with multiple query-like segments", () => {
    const line = "PASSWORD=alpha1234&mode=debugX&scope=writeY";
    const result = redactSecrets(line);
    assert.ok(!result.includes("alpha1234&mode=debugX&scope=writeY"));
    assert.ok(!result.includes("&mode=debugX"));
    assert.ok(!result.includes("&scope=writeY"));
  });

  it("redacts CLIENT_SECRET= values that contain ampersands", () => {
    const line = "CLIENT_SECRET=foo&barbazqux";
    assert.ok(!redactSecrets(line).includes("foo&barbazqux"));
  });

  it("redacts CLIENT_SECRET= values containing query-like substrings", () => {
    const line = "CLIENT_SECRET=topsecret&scope=readwriteZ";
    const result = redactSecrets(line);
    assert.ok(!result.includes("topsecret&scope=readwriteZ"));
    assert.ok(!result.includes("&scope=readwriteZ"));
  });

  it("redacts quoted client_secret values containing query-like substrings", () => {
    const line = 'client_secret: "abc12345&def=ghiXYZ"';
    const result = redactSecrets(line);
    assert.ok(!result.includes("abc12345&def=ghiXYZ"));
    assert.ok(!result.includes("&def=ghiXYZ"));
  });

  it("redacts single-quoted client_secret values containing query-like substrings", () => {
    const line = "client_secret: 'abc12345&def=ghiXYZ'";
    const result = redactSecrets(line);
    assert.ok(!result.includes("abc12345&def=ghiXYZ"));
    assert.ok(!result.includes("&def=ghiXYZ"));
  });

  it("redacts space-separated password values that contain ampersands", () => {
    const line = "password secret123&more";
    assert.ok(!redactSecrets(line).includes("secret123&more"));
  });

  it("redacts space-separated password values containing query-like substrings", () => {
    const line = "password hunter2xx&user=adminzz";
    const result = redactSecrets(line);
    assert.ok(!result.includes("hunter2xx&user=adminzz"));
    assert.ok(!result.includes("&user=adminzz"));
  });

  it("redacts pwd= values containing query-like substrings", () => {
    const line = "pwd=abc12345&next=rotateMe";
    const result = redactSecrets(line);
    assert.ok(!result.includes("abc12345&next=rotateMe"));
    assert.ok(!result.includes("&next=rotateMe"));
  });

  it("still preserves real URL query params after redaction", () => {
    const url =
      "https://auth.example.com/callback?password=abc12345def67890&state=keepme&code=xyz";
    const result = redactSecrets(url);
    assert.ok(!result.includes("abc12345def67890"));
    assert.ok(result.includes("state=keepme"), "unrelated query params preserved");
    assert.ok(result.includes("code=xyz"), "later query params preserved");
  });

  it("redacts refresh_token in URL query params", () => {
    const url =
      "https://auth.example.com/token?refresh_token=abc123def456ghi789jkl"; // fake credential, test fixture. gitleaks:allow
    assert.ok(!redactSecrets(url).includes("abc123def456ghi789jkl"));
  });

  it("redacts auth params appearing later in a query string", () => {
    const url =
      "https://api.example.com/data?page=1&client_secret=abc123def456ghi789&sort=desc";
    const result = redactSecrets(url);
    assert.ok(!result.includes("abc123def456ghi789"));
    assert.ok(result.includes("page=1"));
    assert.ok(result.includes("sort=desc"));
  });

  // ── Backtick-quoted entropy detection ────────────────────────────────────

  it("redacts high-entropy backtick-quoted strings", () => {
    const text = "const token = `aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW`"; // fake credential, test fixture. gitleaks:allow
    const result = redactSecrets(text);
    assert.ok(
      !result.includes("aB3dE5fG7h"),
      "backtick string should be redacted"
    );
  });

  it("preserves low-entropy backtick strings", () => {
    const text = "const sql = `SELECT * FROM users WHERE id = 1`";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves quoted const assignment snippets", () => {
    const text = 'value = "const foo = bar.baz(qux)"';
    assert.equal(redactSecrets(text), text);
  });

  it("preserves quoted function declaration snippets", () => {
    const text = 'value = "function loadConfig(path) { return path; }"';
    assert.equal(redactSecrets(text), text);
  });

  it("preserves quoted control-flow snippets", () => {
    const text = 'value = "if (ready) { return nextStep; }"';
    assert.equal(redactSecrets(text), text);
  });

  it("preserves quoted import snippets", () => {
    const text = 'value = "import config from \\"./config\\";"';
    assert.equal(redactSecrets(text), text);
  });

  it("preserves quoted export snippets", () => {
    const text = 'value = "export default function build() { return true; }"';
    assert.equal(redactSecrets(text), text);
  });

  // ── Contraction / apostrophe handling ─────────────────────
  // The entropy-based quoted string detector must not treat apostrophes in
  // contractions (I've, it's, don't, user's) as string delimiters.

  it("preserves text between I've and it's containing a URL", () => {
    const text = "I've configured the REDIS_URL=redis://localhost:6379 and it's working now";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves text between possessives containing a file path", () => {
    const text = "The user's API key configuration at /etc/app/config.yml needs the admin's approval";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves text between Here's and I'll containing config values", () => {
    const text = "Here's my plan: first I'll update the Dockerfile, configure PORT=3000, and rebuild";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves text with don't and user's in a normal sentence", () => {
    const text = "I don't think we should change the user's password policy right now";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves text with can't and here's — the 'creds' case", () => {
    const text = "I can't find the right creds format - here's what I tried: export DB_HOST=localhost";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves text with That's, can't, Let's, user's chained", () => {
    const text = "That's weird, I can't reproduce the bug. Let's check the user's session logs";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves won't, shouldn't, can't with API path", () => {
    const text = "The system won't start because it shouldn't load when the daemon can't reach the API endpoint at /v2/health";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves isn't, doesn't around env variable names", () => {
    const text = "The server isn't reading NODE_ENV=production correctly, and it doesn't fall back to defaults";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves wasn't, haven't near IP:port address", () => {
    const text = "The deploy wasn't targeting 10.0.1.42:8080 and we haven't updated the load balancer";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves possessives with config file paths", () => {
    const text = "Check the server's /etc/nginx/nginx.conf and the app's src/config/database.yml for mismatches";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves It's, that's around KAFKA_BROKER env var", () => {
    const text = "It's KAFKA_BROKER=kafka:9092 that needs changing, and that's the only config";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves possessives with mixed-case identifiers", () => {
    const text = "The module's BuildConfig.DEBUG flag and the app's R.string.api_url are both wrong";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves contraction at start of text", () => {
    const text = "It's important to set DATABASE_URL=postgres://host/db before starting the server";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves text ending mid-contraction", () => {
    const text = "The CORS_ORIGIN=https://example.com config is fine if you're asking what I've set up, isn't it? Yes it's";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves rapid consecutive contractions", () => {
    const text = "I've can't won't shouldn't wouldn't don't isn't";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves possessive with em-dash separator", () => {
    const text = "Use the user\u2019s config at /etc/app.yml \u2014 that\u2019s the one";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves we're, they'll with container references", () => {
    const text = "We're deploying container k8s-worker:v2.4.1 and they'll migrate the pod to node-pool-3";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves you've, I'd with database references", () => {
    const text = "If you've run ALTER TABLE users ADD COLUMN role VARCHAR(50), I'd say the migration's done";
    assert.equal(redactSecrets(text), text);
  });

  // ── Real-world prompt excerpts ────────────

  it("preserves realistic prompt: auth debugging with contractions", () => {
    const text = "I've been trying to debug the authentication flow. The user's session isn't persisting across requests. Here's what I've checked: the cookie is set with httpOnly=true and sameSite=Lax, but it's not being sent on subsequent API calls to /api/v1/auth/me";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves realistic prompt: Terraform + RDS + ALB", () => {
    const text = "That's the Terraform config I've been working on. It's deploying to us-east-1 with the RDS instance at db.t3.medium. The app's health check endpoint /health returns 200, but the ALB's target group isn't registering healthy targets";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves realistic prompt: CI/CD pipeline debugging", () => {
    const text = "Here's the problem: the pipeline's build step can't find NODE_ENV=production in the Docker container. I've checked the Dockerfile and it's not setting the ENV directive. The team's deploy.yml workflow doesn't pass it either";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves realistic prompt: code review with Go context", () => {
    const text = "The reviewer's feedback on PR #342 is that we shouldn't use goroutines without proper context cancellation. I've refactored the worker pool to accept ctx context.Context but it's still not passing the integration test at TestWorkerPool_CancelledContext";
    assert.equal(redactSecrets(text), text);
  });

  // ── Single-quoted secrets must still be caught ────────────────────────

  it("redacts high-entropy single-quoted string in assignment", () => {
    const text = "token = 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW'"; // fake credential, test fixture. gitleaks:allow
    assert.ok(!redactSecrets(text).includes("aB3dE5fG7h"));
  });

  it("redacts high-entropy single-quoted string after colon", () => {
    const text = "secret: 'xK9mQ2rL5wN8yT3vB7cF0jH6dA4eG1iU'"; // fake credential, test fixture. gitleaks:allow
    assert.ok(!redactSecrets(text).includes("xK9mQ2rL5"));
  });

  it("redacts high-entropy single-quoted string in array literal", () => {
    const text = "keys: ['aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW']";
    assert.ok(!redactSecrets(text).includes("aB3dE5fG7h"));
  });

  it("redacts high-entropy single-quoted string in function call", () => {
    const text = "setApiKey('xK9mQ2rL5wN8yT3vB7cF0jH6dA4eG1iU')";
    assert.ok(!redactSecrets(text).includes("xK9mQ2rL5"));
  });

  // ── Quotes containing apostrophes (cross-quote robustness) ────────────

  it("redacts high-entropy double-quoted string containing apostrophe", () => {
    const text = 'config: "aB3\'dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW"';
    assert.ok(!redactSecrets(text).includes("aB3'dE5fG7h"));
  });

  it("preserves low-entropy double-quoted string containing apostrophe", () => {
    const text = 'message: "it\'s a simple message about testing and nothing more"';
    assert.equal(redactSecrets(text), text);
  });

  it("redacts high-entropy backtick string containing apostrophe", () => {
    const text = "const key = `aB3'dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW`";
    assert.ok(!redactSecrets(text).includes("aB3'dE5fG7h"));
  });

  // ── Mixed: contractions + real secrets in same text ────────────────────

  it("preserves contractions while redacting double-quoted secret", () => {
    const text = 'I\'ve set the key to "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW" and it\'s working';
    const result = redactSecrets(text);
    assert.ok(!result.includes("aB3dE5fG7h"), "secret should be redacted");
    assert.ok(result.includes("I've set the key to"), "text before preserved");
    assert.ok(result.includes("and it's working"), "text after preserved");
  });

  it("preserves contractions while redacting backtick secret", () => {
    // "token:" is also caught by pattern 22 (TOKEN keyword), so the span
    // extends to include "token: `value`". Contractions must still survive.
    const text = "Here's the token: `xK9mQ2rL5wN8yT3vB7cF0jH6dA4eG1iU` and that's all"; // fake credential, test fixture. gitleaks:allow
    const result = redactSecrets(text);
    assert.ok(!result.includes("xK9mQ2rL5"), "secret should be redacted");
    assert.ok(result.includes("Here's the"), "contraction before preserved");
    assert.ok(result.includes("and that's all"), "contraction after preserved");
  });

  it("preserves contractions while redacting single-quoted secret in code context", () => {
    const text = "I've configured token = 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW' and it's deployed"; // fake credential, test fixture. gitleaks:allow
    const result = redactSecrets(text);
    assert.ok(!result.includes("aB3dE5fG7h"), "secret should be redacted");
    assert.ok(result.includes("I've configured"), "contraction preserved");
    assert.ok(result.includes("and it's deployed"), "contraction preserved");
  });

  // ── Entropy threshold edge cases ──────────────────────────────────────

  it("preserves single-quoted English text even if 16+ chars", () => {
    const text = "echo 'this is just a normal test string nothing special'";
    assert.equal(redactSecrets(text), text);
  });

  it("preserves double-quoted English text even if 16+ chars", () => {
    const text = 'echo "this is just a normal test string nothing special"';
    assert.equal(redactSecrets(text), text);
  });

  it("preserves quoted string with high length but low entropy", () => {
    const text = 'value = "aaaaaabbbbbbccccccdddddd"';
    assert.equal(redactSecrets(text), text);
  });

  it("preserves quoted string with mixed types but low entropy", () => {
    const text = 'value = "aA1aA1aA1aA1aA1aA1aA1aA1"';
    assert.equal(redactSecrets(text), text);
  });

  it("redacts quoted high-entropy strings containing true", () => {
    const text = 'value = "A9x1-true-Q7m2-Z8p3-R4n5"';
    assert.ok(!redactSecrets(text).includes("A9x1-true-Q7m2-Z8p3-R4n5"));
  });

  it("redacts quoted high-entropy strings containing null", () => {
    const text = 'value = "A9x1-null-Q7m2-Z8p3-R4n5"';
    assert.ok(!redactSecrets(text).includes("A9x1-null-Q7m2-Z8p3-R4n5"));
  });

  it("redacts quoted high-entropy strings containing let", () => {
    const text = 'value = "A9x1-let-Q7m2-Z8p3-R4n5"';
    assert.ok(!redactSecrets(text).includes("A9x1-let-Q7m2-Z8p3-R4n5"));
  });

  it("redacts quoted high-entropy strings containing module", () => {
    const text = 'value = "A9x1-module-Q7m2-Z8p3-R4n5"';
    assert.ok(!redactSecrets(text).includes("A9x1-module-Q7m2-Z8p3-R4n5"));
  });

  it("prefers a full JWT over its Bearer prefix overlap", () => {
    const text =
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"; // fake credential, test fixture. gitleaks:allow
    const result = redactSecrets(text);
    assert.equal(result, `Authorization: ${R}`);
  });

  it("redacts overlapping assignment and quoted-secret matches once", () => {
    const text = 'CLIENT_SECRET="aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW"'; // fake credential, test fixture. gitleaks:allow
    const result = redactSecrets(text);
    assert.equal(result, `${R}"`);
  });

  // ── Password separator variations ────────────────────────────────────────
  // All forms: password=, password:, password (space), with/without quotes

  it("redacts password= (no space)", () => {
    assert.ok(!redactSecrets("password=secretvalue123").includes("secretvalue123"));
  });

  it("redacts password = (spaces around =)", () => {
    assert.ok(!redactSecrets("password = secretvalue123").includes("secretvalue123"));
  });

  it("redacts password: (colon separator)", () => {
    assert.ok(!redactSecrets("password: secretvalue123").includes("secretvalue123"));
  });

  it("redacts password: (colon, no space)", () => {
    assert.ok(!redactSecrets("password:secretvalue123").includes("secretvalue123"));
  });

  it("redacts password : (space before colon)", () => {
    assert.ok(!redactSecrets("password : secretvalue123").includes("secretvalue123"));
  });

  it("redacts password <space> value (space-separated)", () => {
    assert.ok(!redactSecrets("password secretvalue123").includes("secretvalue123"));
  });

  it("redacts password='value' (single-quoted)", () => {
    assert.ok(!redactSecrets("password='secretvalue123'").includes("secretvalue123"));
  });

  it("redacts password=\"value\" (double-quoted)", () => {
    assert.ok(!redactSecrets('password="secretvalue123"').includes("secretvalue123"));
  });

  it("redacts password=`value` (backtick-quoted)", () => {
    assert.ok(!redactSecrets("password=`secretvalue123`").includes("secretvalue123"));
  });

  it("redacts Password= (mixed case)", () => {
    assert.ok(!redactSecrets("Password=secretvalue123").includes("secretvalue123"));
  });

  it("redacts PASSWORD= (all caps)", () => {
    assert.ok(!redactSecrets("PASSWORD=secretvalue123").includes("secretvalue123"));
  });

  // ── passwd / pwd variations ──────────────────────────────────────────────

  it("redacts passwd= (Unix abbreviation with =)", () => {
    assert.ok(!redactSecrets("passwd=secretvalue123").includes("secretvalue123"));
  });

  it("redacts passwd: (Unix abbreviation with :)", () => {
    assert.ok(!redactSecrets("passwd: secretvalue123").includes("secretvalue123"));
  });

  it("redacts passwd <space> value", () => {
    assert.ok(!redactSecrets("passwd secretvalue123").includes("secretvalue123"));
  });

  it("redacts pwd= (short abbreviation with =)", () => {
    assert.ok(!redactSecrets("pwd=secretvalue123").includes("secretvalue123"));
  });

  it("redacts pwd: (short abbreviation with :)", () => {
    assert.ok(!redactSecrets("pwd: secretvalue123").includes("secretvalue123"));
  });

  it("redacts pwd <space> value", () => {
    assert.ok(!redactSecrets("pwd secretvalue123").includes("secretvalue123"));
  });

  // ── API key variations ───────────────────────────────────────────────────

  it("redacts api_key= (underscore)", () => {
    assert.ok(!redactSecrets("api_key=dummy_api_key_value").includes("dummy_api_key_value"));
  });

  it("redacts api-key= (hyphen)", () => {
    assert.ok(!redactSecrets("api-key=dummy_api_key_value").includes("dummy_api_key_value"));
  });

  it("redacts apikey= (no separator)", () => {
    assert.ok(!redactSecrets("apikey=dummy_api_key_value").includes("dummy_api_key_value"));
  });

  it("redacts Api key: (space between words)", () => {
    const line = "Api key: dummy_api_key";
    assert.ok(!redactSecrets(line).includes("dummy_api_key"));
  });

  it("redacts api key: (lowercase with space)", () => {
    assert.ok(!redactSecrets("api key: dummy_api_key").includes("dummy_api_key"));
  });

  it("redacts API KEY: (all caps with space)", () => {
    assert.ok(!redactSecrets("API KEY: dummy_api_key").includes("dummy_api_key"));
  });

  it("redacts API_KEY= (env var style)", () => {
    assert.ok(!redactSecrets("API_KEY=dummy_api_key_value_here").includes("dummy_api_key_value_here"));
  });

  // ── Negative cases — must NOT be redacted ────────────────────────────────

  it("does not redact 'password is required'", () => {
    const text = "Error: password is required";
    assert.equal(redactSecrets(text), text);
  });

  it("does not redact 'password has expired'", () => {
    const text = "Your password has expired";
    assert.equal(redactSecrets(text), text);
  });

  it("does not redact 'password was incorrect'", () => {
    const text = "The password was incorrect";
    assert.equal(redactSecrets(text), text);
  });

  it("redacts a value of any length after a password key", () => {
    assert.equal(redactSecrets("password: secret"), "████████");
  });
});

describe("redactSecrets — email domains", () => {
  it("redacts an address whose domain run is longer than 253 characters", () => {
    const out = redactSecrets(`contact bob@${"a".repeat(300)}.com today`);
    assert.ok(!out.includes("bob@"), out.slice(0, 80));
  });
});

describe("redactSecrets — linear time on long runs", () => {
  // Each input is 512 KB; a pattern that is quadratic in a run of word or
  // address characters takes minutes on it.
  const inputs: Record<string, string> = {
    "one repeated letter": "x".repeat(512 * 1024),
    "word and dash characters": "a-".repeat(256 * 1024),
    "a repeated key name": "secret".repeat(87382),
    "address characters with no domain": "a.b+".repeat(128 * 1024),
    "connection-string schemes with no credentials": "http://".repeat(75000),
    "connection-string userinfo runs before one host": `${"x://u:p".repeat(34952)}@h${"a".repeat(8 * 34952)}`,
  };
  for (const [name, input] of Object.entries(inputs)) {
    it(`scrubs ${name} within two seconds`, () => {
      const start = performance.now();
      redactSecrets(input);
      const ms = performance.now() - start;
      assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
    });
  }
});
