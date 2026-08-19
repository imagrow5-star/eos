/**
 * One-time in-place sweep: hash any auth tokens still stored RAW.
 *
 * Password-reset and email-verification tokens used to be stored verbatim —
 * the raw value emailed to the user was also the database value, so a stolen
 * dump contained replayable bearer credentials (security review, Aug 2026).
 * New rows are written as sha256(token) with a "sha256:" prefix
 * (lib/authTokenHash.ts); this sweep converts pre-existing rows so pending
 * resets/verifications issued before the deploy KEEP WORKING — the user's
 * emailed raw token hashes to exactly what the sweep stores.
 *
 * Same safety pattern as dataEncryptionMigration:
 *   - advisory-locked (concurrent instances skip, stay functional)
 *   - detector-driven and idempotent: the "sha256:" prefix marks done rows,
 *     so re-running on every boot is a fast no-op
 *   - per-row optimistic guard (WHERE token = <original>) so a concurrent
 *     write is never clobbered
 *   - logs counts only, never token values
 *
 * Deliberately hashes ALL raw rows, including expired/used ones (the review
 * asked for unexpired+unused as the minimum): an expired raw token in a dump
 * is still a recognizable credential shape, hashing costs nothing, and the
 * token-cleanup job deletes expired rows on its own schedule anyway.
 */
import { pool } from "@workspace/db";
import { hashAuthToken, TOKEN_HASH_PREFIX } from "../lib/authTokenHash.js";
import { logger } from "../lib/logger.js";

const LOCK_KEY = "auth-token-hash-sweep";
const TABLES = ["password_reset_tokens", "email_verification_tokens"] as const;
const BATCH = 500;

export type SweepCounts = Record<string, number>;

export async function runAuthTokenHashSweep(): Promise<SweepCounts | null> {
  const lockClient = await pool.connect();
  try {
    const { rows } = await lockClient.query(
      `SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,
      [LOCK_KEY],
    );
    if (!rows[0]?.locked) {
      logger.info("auth-token hash sweep: another instance holds the lock — skipping");
      return null;
    }
    try {
      const counts: SweepCounts = {};
      for (const table of TABLES) {
        let hashed = 0;
        for (;;) {
          const { rows: raw } = await pool.query<{ token: string }>(
            `SELECT token FROM "${table}" WHERE token NOT LIKE $1 LIMIT ${BATCH}`,
            [`${TOKEN_HASH_PREFIX}%`],
          );
          if (raw.length === 0) break;
          for (const r of raw) {
            const res = await pool.query(
              `UPDATE "${table}" SET token = $1 WHERE token = $2`,
              [hashAuthToken(r.token), r.token],
            );
            hashed += res.rowCount ?? 0;
          }
          if (raw.length < BATCH) break;
        }
        counts[table] = hashed;
      }
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (total > 0) logger.info({ counts }, "auth-token hash sweep: raw tokens hashed in place");
      return counts;
    } finally {
      await lockClient.query(`SELECT pg_advisory_unlock(hashtext($1))`, [LOCK_KEY]);
    }
  } finally {
    lockClient.release();
  }
}
