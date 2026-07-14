import { Router } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";

const router = Router();

// ─── GET /account/export ──────────────────────────────────────────────────────
// Returns a JSON file containing all user data for download (GDPR Art. 20).

router.get("/account/export", async (req, res): Promise<void> => {
  const userId = (req as any).userId as number;

  try {
    const [
      messagesResult,
      memoryResult,
      winsResult,
      habitsResult,
      habitCompletionsResult,
      goalsResult,
      moodResult,
      profileResult,
    ] = await Promise.all([
      pool.query(
        `SELECT role, content, is_morning_note, created_at FROM messages WHERE user_id = $1 ORDER BY created_at ASC`,
        [userId],
      ),
      pool.query(
        `SELECT fact, created_at FROM memory_facts WHERE user_id = $1 ORDER BY created_at ASC`,
        [userId],
      ),
      pool.query(
        `SELECT title, created_at FROM wins WHERE user_id = $1 ORDER BY created_at ASC`,
        [userId],
      ),
      pool.query(
        `SELECT id, name, frequency, created_at FROM habits WHERE user_id = $1 ORDER BY created_at ASC`,
        [userId],
      ),
      pool.query(
        `SELECT h.name AS habit_name, hc.completed_on FROM habit_completions hc
         JOIN habits h ON h.id = hc.habit_id
         WHERE h.user_id = $1 ORDER BY hc.completed_on ASC`,
        [userId],
      ),
      pool.query(
        `SELECT title, description, status, created_at FROM goals WHERE user_id = $1 ORDER BY created_at ASC`,
        [userId],
      ),
      pool.query(
        `SELECT score, note, recorded_on FROM mood_scores WHERE user_id = $1 ORDER BY recorded_on ASC`,
        [userId],
      ),
      pool.query(
        `SELECT companion_name, user_path, companion_gender, country, age_band, timezone, created_at FROM profile WHERE user_id = $1`,
        [userId],
      ),
    ]);

    const exportPayload = {
      exportedAt: new Date().toISOString(),
      profile: profileResult.rows[0] ?? null,
      messages: messagesResult.rows,
      memoryFacts: memoryResult.rows,
      wins: winsResult.rows,
      habits: habitsResult.rows,
      habitCompletions: habitCompletionsResult.rows,
      goals: goalsResult.rows,
      moodScores: moodResult.rows,
    };

    const filename = `asha-export-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.json(exportPayload);

    logger.info({ userId }, "Account data exported");
  } catch (err) {
    logger.error({ err, userId }, "Failed to export account data");
    res.status(500).json({ error: "Failed to export your data. Please try again." });
  }
});

// ─── GET /account/export/summary ─────────────────────────────────────────────
// Returns lightweight counts used to show a preview card before the user
// downloads the full JSON export.

router.get("/account/export/summary", async (req, res): Promise<void> => {
  const userId = (req as any).userId as number;

  try {
    const [msgResult, habitResult, moodResult, memResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS count,
                MIN(created_at) AS first_at,
                MAX(created_at) AS last_at
         FROM messages WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM habits WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM mood_scores WHERE user_id = $1`,
        [userId],
      ),
      pool.query(
        `SELECT COUNT(*) AS count FROM memory_facts WHERE user_id = $1`,
        [userId],
      ),
    ]);

    res.json({
      messageCount: parseInt(msgResult.rows[0].count, 10),
      habitCount:   parseInt(habitResult.rows[0].count, 10),
      moodCount:    parseInt(moodResult.rows[0].count, 10),
      memoryCount:  parseInt(memResult.rows[0].count, 10),
      firstMessageAt: msgResult.rows[0].first_at ?? null,
      lastMessageAt:  msgResult.rows[0].last_at  ?? null,
    });
  } catch (err) {
    logger.error({ err, userId }, "Failed to fetch export summary");
    res.status(500).json({ error: "Could not load summary. Please try again." });
  }
});

export default router;
