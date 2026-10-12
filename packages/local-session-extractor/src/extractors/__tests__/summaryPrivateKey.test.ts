// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * A tool summary is bounded before it is redacted, so a private key longer than
 * the bound arrives without its END line. None of the key may survive: an
 * unterminated PEM block is redacted to the end of the text.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionEventBuilder } from "../../internal";
import { redactText } from "../../redaction";

// A body long enough that the END line falls past the summary's bounded slice.
const BODY = Array.from({ length: 40 }, (_, i) => `MIIEowIBAAKCAQEAu${i.toString(36).padStart(2, "0")}Zx9Qk7Lm3Np5Rt8Vw2Yb4Df6Hj1Kc0Ge9`).join("\n");
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${BODY}\n-----END RSA PRIVATE KEY-----`; // fake credential, test fixture. gitleaks:allow

describe("a private key in a bounded tool summary", () => {
  it("leaves no part of the key in the summary", () => {
    const b = new SessionEventBuilder();
    b.addExternalToolCall({ name: "run_terminal_cmd", at: "2026-01-01T00:00:00.000Z", callId: "c1", summary: `cat > id_rsa <<'EOF'\n${PEM}\nEOF` });
    const summary = b.build().find((e) => e.call_id === "c1")?.redacted_summary ?? "";
    assert.ok(!summary.includes("PRIVATE KEY"), summary);
    assert.ok(!summary.includes("MIIEowIBAAKCAQEA"), summary);
  });

  it("redacts an unterminated PEM block in any text, and keeps the text before it", () => {
    const out = redactText(`key follows:\n-----BEGIN OPENSSH PRIVATE KEY-----\n${BODY.slice(0, 300)}`);
    assert.ok(out.startsWith("key follows:"), out);
    assert.ok(!out.includes("BEGIN OPENSSH PRIVATE KEY") && !out.includes("MIIEowIBAAKCAQEA"), out);
  });

  it("still redacts a complete PEM block and keeps the text after it", () => {
    const out = redactText(`${PEM}\nnext line`);
    assert.ok(!out.includes("PRIVATE KEY") && out.endsWith("next line"), out);
  });
});
