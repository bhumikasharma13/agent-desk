// Copyright 2026 The Agent Desk Authors
// SPDX-License-Identifier: MIT
/**
 * Decodes the payload (claims) of a JWT without verifying its signature.
 * Returns null when the token isn't a well-formed JWT or the payload isn't a
 * JSON object. No signature check — every caller trusts the token on filesystem
 * provenance (issued to this user, on this machine) and reads only non-secret
 * identity claims.
 *
 * Shared rather than per-caller: three sites decode a locally-stored token, and
 * a hand-rolled base64url split at each one is how a decode bug reaches only
 * some of them.
 */
export function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const payloadJson = Buffer.from(parts[1]!, "base64url").toString("utf-8");
    const claims = JSON.parse(payloadJson) as unknown;
    return claims && typeof claims === "object" ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
