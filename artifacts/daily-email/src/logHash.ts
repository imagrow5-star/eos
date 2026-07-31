import { createHash } from "node:crypto";

/**
 * Salted short hash of a user id for LOG LINES ONLY.
 *
 * MIRROR of artifacts/api-server/src/lib/logging/hashUserIdForLog.ts — same
 * salt (LOG_HASH_SALT) and same formula, so the two deployables emit identical
 * `uh` values for the same user. It is duplicated (not imported) only because
 * this job is a separate package that does not depend on @workspace/api-server;
 * keep the two in sync. See log-audit.md Tier 2.
 *
 * Returns sha256(LOG_HASH_SALT + ":" + String(userId)) sliced to 8 hex chars,
 * or undefined when LOG_HASH_SALT is unset / hashing throws (never throws).
 * Callers drop the whole log line when it is undefined.
 */
export function hashUserIdForLog(userId: number | string): string | undefined {
  try {
    const salt = process.env.LOG_HASH_SALT;
    if (!salt) return undefined;
    return createHash("sha256")
      .update(salt + ":" + String(userId))
      .digest("hex")
      .slice(0, 8);
  } catch {
    return undefined;
  }
}
