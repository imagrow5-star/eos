/**
 * One-time carry-over from the stage 2–3 `weekly_reviews` table into
 * `stories` (kind "week"). Runs at boot after the story tables exist; a
 * no-op when the old table is gone. Rows are re-encrypted under the new
 * column AADs (ciphertext is bound per column, so it cannot be copied as-is);
 * a row that fails to decrypt is left behind and logged by id only. The old
 * table is dropped once every row has been carried across.
 */

import { pool, decryptText, encryptText } from "@workspace/db";
import { logger } from "../lib/logger.js";

export async function migrateWeeklyReviewsToStories(): Promise<void> {
  const exists = await pool.query(`SELECT to_regclass('public.weekly_reviews') AS t`);
  if (!exists.rows[0]?.t) return;

  const { rows } = await pool.query<{
    id: number;
    user_id: number;
    week_start: string;
    week_end: string;
    fragment: string;
    cards: string;
    viewed_at: Date | null;
    created_at: Date;
  }>(`SELECT id, user_id, week_start, week_end, fragment, cards, viewed_at, created_at FROM weekly_reviews`);

  let carried = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const fragment = encryptText(decryptText(r.fragment, "weekly_reviews.fragment"), "stories.fragment");
      const cards = encryptText(decryptText(r.cards, "weekly_reviews.cards"), "stories.cards");
      await pool.query(
        `INSERT INTO stories (user_id, kind, period_start, period_end, subject_id, fragment, cards, viewed_at, created_at)
         VALUES ($1, 'week', $2, $3, NULL, $4, $5, $6, $7)
         ON CONFLICT (user_id, kind, period_start) DO NOTHING`,
        [r.user_id, r.week_start, r.week_end, fragment, cards, r.viewed_at, r.created_at],
      );
      carried++;
    } catch (err) {
      failed++;
      logger.error({ err, weeklyReviewId: r.id }, "stories migration: could not carry a weekly_reviews row");
    }
  }
  if (failed === 0) {
    await pool.query(`DROP TABLE weekly_reviews`);
  }
  if (rows.length > 0) logger.info({ carried, failed, dropped: failed === 0 }, "stories migration: weekly_reviews carried into stories");
}
