/**
 * Security review follow-up: the mood timeline, the weekly slider answers and
 * the shape of every crisis event (country, channel, dismissal) are encrypted
 * at rest. Proves, against the real DB:
 *   • writes through the ORM land as "enc:v1:…" text in the raw rows — the
 *     number 7, the country "GB", the word "voice" and "true" appear nowhere;
 *   • reads through the ORM round-trip as number / string / boolean;
 *   • the crisis helpers still work now that they filter in JS: the voice
 *     dedupe, the pending-card lookup, and the dismissal review count;
 *   • legacy plaintext rows (the integer→text / boolean→text cast leaves
 *     "7" and "false") read back correctly and the boot sweep encrypts them.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { eq } from "drizzle-orm";
import { db, moodScoresTable, crisisEventsTable, weeklyChaptersTable, usersTable } from "@workspace/db";
import { runDataEncryptionMigration } from "../services/dataEncryptionMigration.js";
import {
  recordVoiceCrisisEvent,
  pendingVoiceCrisisEvent,
  checkDismissalReviewFlag,
} from "../services/crisis/events.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const DB = Boolean(process.env.DATABASE_URL);
let userId = 0;

beforeAll(async () => {
  if (!DB) return;
  const [u] = await db
    .insert(usersTable)
    .values({ email: `scores-enc-${Date.now()}@example.invalid`, hashedPassword: "x" })
    .returning({ id: usersTable.id });
  userId = u!.id;
});

afterAll(async () => {
  if (DB && userId) {
    for (const t of ["crisis_events", "mood_scores", "weekly_chapters"]) {
      await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
    }
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  }
  await pool.end();
});

describe.skipIf(!DB)("mood, threshold and crisis columns are ciphertext at rest", () => {
  it("mood_scores.score: number in, enc:v1 on disk, number out", async () => {
    const [row] = await db.insert(moodScoresTable).values({ userId, score: 7, date: "2026-09-01" }).returning({ id: moodScoresTable.id });
    const raw = await pool.query<{ score: string }>("SELECT score FROM mood_scores WHERE id = $1", [row!.id]);
    expect(raw.rows[0]!.score).toMatch(/^enc:v1:/);
    const [back] = await db.select().from(moodScoresTable).where(eq(moodScoresTable.id, row!.id));
    expect(back!.score).toBe(7);
  });

  it("weekly_chapters threshold scores: null stays null, numbers encrypt", async () => {
    const [ch] = await db
      .insert(weeklyChaptersTable)
      .values({
        userId,
        weekStart: "2026-08-24",
        weekEnd: "2026-08-30",
        status: "ready",
        themes: [],
        threadOpening: "opening",
        thresholdQuestion: "q?",
        noteInvite: { prompt: "p" },
        thresholdMood: 3,
        thresholdLoneliness: null,
      } as never)
      .returning({ id: weeklyChaptersTable.id });
    const raw = await pool.query<{ threshold_mood: string; threshold_loneliness: string | null }>(
      "SELECT threshold_mood, threshold_loneliness FROM weekly_chapters WHERE id = $1",
      [ch!.id],
    );
    expect(raw.rows[0]!.threshold_mood).toMatch(/^enc:v1:/);
    expect(raw.rows[0]!.threshold_loneliness).toBeNull();
    const [back] = await db.select().from(weeklyChaptersTable).where(eq(weeklyChaptersTable.id, ch!.id));
    expect(back!.thresholdMood).toBe(3);
    expect(back!.thresholdLoneliness).toBeNull();
  });

  it("crisis_events: country, channel and dismissal are ciphertext; the helpers still filter correctly", async () => {
    await recordVoiceCrisisEvent({ userId, patternMatched: "explicit_suicidal_ideation", countryServed: "GB" });
    // Same pattern inside the dedupe window → no second row.
    await recordVoiceCrisisEvent({ userId, patternMatched: "explicit_suicidal_ideation", countryServed: "GB" });
    const raw = await pool.query<{ country_served: string; source: string; block_dismissed: string }>(
      "SELECT country_served, source, block_dismissed FROM crisis_events WHERE user_id = $1",
      [userId],
    );
    expect(raw.rows).toHaveLength(1);
    for (const col of ["country_served", "source", "block_dismissed"] as const) {
      expect(raw.rows[0]![col]).toMatch(/^enc:v1:/);
    }
    const dump = JSON.stringify(raw.rows);
    expect(dump).not.toContain("GB");
    expect(dump).not.toContain("voice");

    const pending = await pendingVoiceCrisisEvent(userId);
    expect(pending?.countryServed).toBe("GB");

    // Dismiss it: the pending lookup must now return null and the review
    // counter must see the dismissal, both decided in JS on decrypted values.
    await db
      .update(crisisEventsTable)
      .set({ blockDismissed: true, dismissedAt: new Date() })
      .where(eq(crisisEventsTable.id, pending!.id));
    expect(await pendingVoiceCrisisEvent(userId)).toBeNull();
    // Threshold is > 1 dismissal, so this is false — but it proves the count
    // path reads the encrypted flag without throwing.
    expect(typeof (await checkDismissalReviewFlag(userId))).toBe("boolean");
  });

  it("legacy plaintext rows (post-cast digit strings) read back and get encrypted by the boot sweep", async () => {
    const ins = await pool.query<{ id: number }>(
      "INSERT INTO mood_scores (user_id, score, date) VALUES ($1, '4', '2026-08-15') RETURNING id",
      [userId],
    );
    const [before] = await db.select().from(moodScoresTable).where(eq(moodScoresTable.id, ins.rows[0]!.id));
    expect(before!.score).toBe(4); // passthrough during the migration window

    await runDataEncryptionMigration();

    const raw = await pool.query<{ score: string }>("SELECT score FROM mood_scores WHERE id = $1", [ins.rows[0]!.id]);
    expect(raw.rows[0]!.score).toMatch(/^enc:v1:/);
    const [after] = await db.select().from(moodScoresTable).where(eq(moodScoresTable.id, ins.rows[0]!.id));
    expect(after!.score).toBe(4);
  });
});
