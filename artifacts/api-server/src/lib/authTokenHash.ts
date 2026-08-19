// ─── Auth-token hashing at rest ───────────────────────────────────────────────
// Password-reset and email-verification tokens are the only bearer credentials
// that ever touched the database in raw form: a stolen dump containing an
// unexpired reset row allowed a full account takeover, no other secret needed
// (security review, Aug 2026). The fix: the user still receives the raw
// random token by email, but the database stores ONLY sha256(token) — a dump
// now yields nothing replayable, and the server never needs the raw value
// back (it only ever answers "does this incoming token match?").
//
// The "sha256:" prefix is load-bearing: raw tokens are 64 hex chars and so
// are bare sha256 digests, so without a marker the one-time hashing sweep
// (services/authTokenHashSweep.ts) could not tell them apart.

import { createHash, timingSafeEqual } from "node:crypto";

export const TOKEN_HASH_PREFIX = "sha256:";

/** What gets STORED for (and looked up against) a raw emailed token. */
export function hashAuthToken(raw: string): string {
  return TOKEN_HASH_PREFIX + createHash("sha256").update(raw, "utf8").digest("hex");
}

export function isHashedAuthToken(stored: string): boolean {
  return stored.startsWith(TOKEN_HASH_PREFIX);
}

/**
 * Timing-safe recheck AFTER a row was fetched by hash equality. The indexed
 * SQL lookup is what finds the row; this guards the final accept so the
 * decision never rests on a non-constant-time string comparison.
 */
export function tokenHashMatches(stored: string, raw: string): boolean {
  const a = Buffer.from(stored, "utf8");
  const b = Buffer.from(hashAuthToken(raw), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
