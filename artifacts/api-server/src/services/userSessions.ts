/**
 * Session revocation. Sessions live in user_sessions (connect-pg-simple) with
 * the user id inside the `sess` JSON, so "every session of this user" is a
 * jsonb match rather than a column.
 *
 * Used wherever a credential changes hands: password reset and change,
 * email-change confirmation, "sign out everywhere", account deletion. A
 * stolen cookie must not outlive the moment its owner regains control.
 */
import { pool } from "@workspace/db";

/**
 * Deletes every session belonging to the user. Pass `except` to keep one —
 * the session the person is acting from — so changing a password or
 * confirming a new email doesn't sign them out of the browser they're in.
 * Returns the number of sessions revoked.
 */
export async function purgeUserSessions(userId: number, opts: { except?: string } = {}): Promise<number> {
  const res = opts.except
    ? await pool.query(
        `DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = $1::text AND sid <> $2`,
        [String(userId), opts.except],
      )
    : await pool.query(`DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = $1::text`, [
        String(userId),
      ]);
  return res.rowCount ?? 0;
}
