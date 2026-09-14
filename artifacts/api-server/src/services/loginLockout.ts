/**
 * Per-account login throttle.
 *
 * The per-IP limiter on /api/auth (app.ts) caps how fast ONE address can
 * guess, but anyone with a pool of addresses — a botnet, a cloud provider's
 * free tier — can spread a dictionary attack on one account across them and
 * never trip it. This counts consecutive failed password logins per ACCOUNT
 * and holds password logins for that account after a threshold, with a
 * delay that doubles per further failure up to a cap.
 *
 *   failures 1–4  → no hold
 *   failure  5    → 1 minute
 *   failure  6    → 2 minutes
 *   failure  7    → 4 minutes
 *   failure  8    → 8 minutes
 *   failure  9+   → 15 minutes (cap)
 *
 * The cap keeps this from being a cheap way to lock a person out of their own
 * account for long: the worst an attacker can do is force 15-minute gaps,
 * and a password reset clears the hold entirely (the person has just proven
 * control of their inbox). A successful login resets the count.
 *
 * Trade-off, documented in SECURITY.md: the "too many attempts" answer is
 * only ever given for an address that has an account, so after five
 * failures it confirms the account exists. Five failed logins per address
 * per 15 minutes, behind the per-IP limiter, is an expensive and noisy way
 * to enumerate addresses; the alternative (returning the generic 401 while
 * silently refusing the correct password) leaves the real person unable to
 * tell why their right password stopped working.
 *
 * All state lives on the users row so it survives restarts and is shared by
 * every instance. The increment is a single UPDATE, so concurrent failures
 * can't lose counts.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_CAP_MINUTES = 15;

/** Minutes a password login is held after this many consecutive failures. */
export function lockoutMinutesFor(failures: number): number {
  if (failures < LOCKOUT_THRESHOLD) return 0;
  return Math.min(LOCKOUT_CAP_MINUTES, 2 ** (failures - LOCKOUT_THRESHOLD));
}

/** Seconds until password logins are accepted again, or 0 when not held. */
export function lockoutRemainingSeconds(lockedUntil: Date | null, now = new Date()): number {
  if (!lockedUntil) return 0;
  return Math.max(0, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000));
}

/** Records one failed password login; returns the new consecutive-failure count. */
export async function recordFailedLogin(userId: number): Promise<number> {
  // Same formula as lockoutMinutesFor(), evaluated in SQL so the increment and
  // the hold are one atomic statement.
  const { rows } = await pool.query<{ failed_login_attempts: number }>(
    `UPDATE users
        SET failed_login_attempts = failed_login_attempts + 1,
            locked_until = CASE
              WHEN failed_login_attempts + 1 >= $2
                THEN now() + (LEAST($3, power(2, failed_login_attempts + 1 - $2))::int * interval '1 minute')
              ELSE locked_until
            END
      WHERE id = $1
      RETURNING failed_login_attempts`,
    [userId, LOCKOUT_THRESHOLD, LOCKOUT_CAP_MINUTES],
  );
  return rows[0]?.failed_login_attempts ?? 0;
}

/** Clears the failure count and any hold: after a successful login or a password reset. */
export async function clearLoginFailures(userId: number): Promise<void> {
  await db.execute(
    sql`UPDATE users SET failed_login_attempts = 0, locked_until = NULL
         WHERE id = ${userId} AND (failed_login_attempts <> 0 OR locked_until IS NOT NULL)`,
  );
}
