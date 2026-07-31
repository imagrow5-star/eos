import crypto from "node:crypto";

/**
 * Salted, one-way short hash of a user id for LOG LINES ONLY.
 *
 * Privacy: logs must never carry a raw, stable user identifier (it lets anyone
 * with log access correlate a person's activity across lines). This returns a
 * per-deployment-salted 8-hex-char digest instead — stable within a deployment
 * (so you can still group one user's lines while debugging) but not reversible
 * to the id and not linkable across deployments.
 *
 * Contract (single source of truth — see Sprint 2A systemPrompt.ts, now
 * refactored to call this):
 *   - Reads process.env.LOG_HASH_SALT at CALL time (so tests/rotations that
 *     change the env var take effect without a restart).
 *   - Returns sha256(LOG_HASH_SALT + ":" + String(userId)) sliced to 8 hex chars.
 *   - Numeric and string ids hash identically (42 and "42" → same output).
 *   - If LOG_HASH_SALT is unset, or hashing throws for ANY reason, returns
 *     undefined and NEVER throws. Callers drop the whole log line when it is
 *     undefined — logging must never crash the calling code path.
 *
 * No default/fallback salt is committed by design: without LOG_HASH_SALT there
 * is simply no hash and no log line.
 */
export function hashUserIdForLog(userId: number | string): string | undefined {
  try {
    const salt = process.env.LOG_HASH_SALT;
    if (!salt) return undefined;
    return crypto
      .createHash("sha256")
      .update(salt + ":" + String(userId))
      .digest("hex")
      .slice(0, 8);
  } catch {
    return undefined;
  }
}
