/**
 * Integration tests: GET /api/account/export/summary count accuracy.
 *
 * The summary endpoint powers the preview card shown before a user downloads
 * their full export. It counts rows live from the database, so the card must
 * always reflect the current state.
 *
 * Covers:
 *  1. Counts across all four previewed tables (messages, habits, mood_scores,
 *     memory_facts) match what was written for the user.
 *  2. A second user's records never contaminate the first user's counts.
 *  3. Deleting a record and re-fetching returns the decremented count.
 */

import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";

// ─── DB connection ────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>(
    "SELECT id FROM users WHERE email = $1",
    [email],
  );
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`
    BEGIN;
    DELETE FROM user_sessions              WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM password_reset_tokens       WHERE user_id = ${uid};
    DELETE FROM email_verification_tokens   WHERE user_id = ${uid};
    DELETE FROM messages                    WHERE user_id = ${uid};
    DELETE FROM memory_facts                WHERE user_id = ${uid};
    DELETE FROM personality_signals         WHERE user_id = ${uid};
    DELETE FROM wins                        WHERE user_id = ${uid};
    DELETE FROM mood_scores                 WHERE user_id = ${uid};
    DELETE FROM reminders                   WHERE user_id = ${uid};
    DELETE FROM commitments                 WHERE user_id = ${uid};
    DELETE FROM habit_completions           WHERE habit_id IN (SELECT id FROM habits WHERE user_id = ${uid});
    DELETE FROM habits                      WHERE user_id = ${uid};
    DELETE FROM goals                       WHERE user_id = ${uid};
    DELETE FROM profile                     WHERE user_id = ${uid};
    DELETE FROM users                       WHERE id      = ${uid};
    COMMIT;
  `);
}

interface SummaryBody {
  messageCount: number;
  habitCount: number;
  moodCount: number;
  memoryCount: number;
  winCount: number;
  goalCount: number;
  commitmentCount: number;
  reminderCount: number;
  personalitySignalCount: number;
  habitCompletionCount: number;
  weeklyChapterCount: number;
  chapterQuoteDismissalCount: number;
  chapterOfferEventCount: number;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
}

interface PopulateCounts {
  messages: number;
  habits: number;
  moods: number;
  memories: number;
  wins?: number;
  goals?: number;
  commitments?: number;
  reminders?: number;
  signals?: number;
  // Number of completion rows to add to the *first* habit created for the user.
  habitCompletions?: number;
}

/**
 * Sign up + verify a test user, then write `counts` rows into each user-owned
 * category the summary card previews. Uses distinct dates for mood_scores and
 * habit_completions because those have per-day semantics.
 */
async function signupAndPopulate(
  agent: ReturnType<typeof request.agent>,
  email: string,
  tag: string,
  counts: PopulateCounts,
): Promise<number> {
  const signupRes = await agent
    .post("/api/auth/signup")
    .send({ email, password: "Test1234!" });
  expect(signupRes.status).toBe(201);
  const userId: number = signupRes.body.user.id;

  await pool.query(
    `UPDATE users SET email_verified_at = NOW() WHERE id = $1`,
    [userId],
  );

  for (let i = 0; i < counts.messages; i++) {
    await pool.query(
      `INSERT INTO messages (user_id, role, content) VALUES ($1, 'user', $2)`,
      [userId, `msg ${i} from ${tag}`],
    );
  }

  let firstHabitId: number | null = null;
  for (let i = 0; i < counts.habits; i++) {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO habits (user_id, name, when_then, reason)
       VALUES ($1, $2, 'Every morning', 'Health') RETURNING id`,
      [userId, `Habit-${tag}-${i}`],
    );
    if (firstHabitId === null) firstHabitId = r.rows[0]!.id;
  }

  for (let i = 0; i < counts.moods; i++) {
    // Unique date per row — one mood log per calendar day.
    const day = String(i + 1).padStart(2, "0");
    await pool.query(
      `INSERT INTO mood_scores (user_id, score, date) VALUES ($1, 7, $2)`,
      [userId, `2026-06-${day}`],
    );
  }

  for (let i = 0; i < counts.memories; i++) {
    await pool.query(
      `INSERT INTO memory_facts (user_id, fact, category) VALUES ($1, $2, 'life')`,
      [userId, `fact ${i} from ${tag}`],
    );
  }

  for (let i = 0; i < (counts.wins ?? 0); i++) {
    await pool.query(
      `INSERT INTO wins (user_id, content) VALUES ($1, $2)`,
      [userId, `win ${i} from ${tag}`],
    );
  }

  for (let i = 0; i < (counts.goals ?? 0); i++) {
    await pool.query(
      `INSERT INTO goals (user_id, title) VALUES ($1, $2)`,
      [userId, `goal ${i} from ${tag}`],
    );
  }

  for (let i = 0; i < (counts.commitments ?? 0); i++) {
    await pool.query(
      `INSERT INTO commitments (user_id, content) VALUES ($1, $2)`,
      [userId, `commitment ${i} from ${tag}`],
    );
  }

  for (let i = 0; i < (counts.reminders ?? 0); i++) {
    await pool.query(
      `INSERT INTO reminders (user_id, content) VALUES ($1, $2)`,
      [userId, `reminder ${i} from ${tag}`],
    );
  }

  for (let i = 0; i < (counts.signals ?? 0); i++) {
    await pool.query(
      `INSERT INTO personality_signals (user_id, signal) VALUES ($1, $2)`,
      [userId, `signal ${i} from ${tag}`],
    );
  }

  if ((counts.habitCompletions ?? 0) > 0) {
    // Completions attach to a habit, so a habit must exist to hang them on.
    expect(firstHabitId).not.toBeNull();
    for (let i = 0; i < (counts.habitCompletions ?? 0); i++) {
      const day = String(i + 1).padStart(2, "0");
      await pool.query(
        `INSERT INTO habit_completions (user_id, habit_id, completed_date)
         VALUES ($1, $2, $3)`,
        [userId, firstHabitId, `2026-05-${day}`],
      );
    }
  }

  return userId;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

const TS = Date.now();
const EMAIL_A = `summary-a-${TS}@example.invalid`;
const EMAIL_B = `summary-b-${TS}@example.invalid`;

describe("GET /api/account/export/summary", () => {
  afterEach(async () => {
    await Promise.all([cleanupUser(EMAIL_A), cleanupUser(EMAIL_B)]);
  });

  it("returns counts matching the rows written across all four tables", async () => {
    const agentA = request.agent(app);
    const want: PopulateCounts = { messages: 3, habits: 2, moods: 4, memories: 5 };
    await signupAndPopulate(agentA, EMAIL_A, "A", want);

    const res = await agentA.get("/api/account/export/summary");
    expect(res.status).toBe(200);

    const body = res.body as SummaryBody;
    expect(body.messageCount).toBe(want.messages);
    expect(body.habitCount).toBe(want.habits);
    expect(body.moodCount).toBe(want.moods);
    expect(body.memoryCount).toBe(want.memories);

    // With messages present, the first/last timestamps should be populated.
    expect(body.firstMessageAt).not.toBeNull();
    expect(body.lastMessageAt).not.toBeNull();
  });

  it("does not include a second user's records in the first user's counts", async () => {
    const agentA = request.agent(app);
    const agentB = request.agent(app);

    const aCounts: PopulateCounts = { messages: 2, habits: 1, moods: 3, memories: 1 };
    const bCounts: PopulateCounts = { messages: 9, habits: 7, moods: 8, memories: 6 };

    await Promise.all([
      signupAndPopulate(agentA, EMAIL_A, "A", aCounts),
      signupAndPopulate(agentB, EMAIL_B, "B", bCounts),
    ]);

    const resA = await agentA.get("/api/account/export/summary");
    expect(resA.status).toBe(200);
    const bodyA = resA.body as SummaryBody;

    // A's counts reflect only A's rows, not B's larger set.
    expect(bodyA.messageCount).toBe(aCounts.messages);
    expect(bodyA.habitCount).toBe(aCounts.habits);
    expect(bodyA.moodCount).toBe(aCounts.moods);
    expect(bodyA.memoryCount).toBe(aCounts.memories);

    // And B still sees only B's own counts.
    const resB = await agentB.get("/api/account/export/summary");
    expect(resB.status).toBe(200);
    const bodyB = resB.body as SummaryBody;
    expect(bodyB.messageCount).toBe(bCounts.messages);
    expect(bodyB.habitCount).toBe(bCounts.habits);
    expect(bodyB.moodCount).toBe(bCounts.moods);
    expect(bodyB.memoryCount).toBe(bCounts.memories);
  });

  it("returns a decremented count after a record is deleted", async () => {
    const agentA = request.agent(app);
    const want: PopulateCounts = { messages: 3, habits: 2, moods: 2, memories: 2 };
    const userId = await signupAndPopulate(agentA, EMAIL_A, "A", want);

    const before = await agentA.get("/api/account/export/summary");
    expect(before.status).toBe(200);
    expect((before.body as SummaryBody).habitCount).toBe(want.habits);
    expect((before.body as SummaryBody).messageCount).toBe(want.messages);

    // Delete one habit and one message.
    await pool.query(
      `DELETE FROM habits WHERE id = (
         SELECT id FROM habits WHERE user_id = $1 ORDER BY id ASC LIMIT 1
       )`,
      [userId],
    );
    await pool.query(
      `DELETE FROM messages WHERE id = (
         SELECT id FROM messages WHERE user_id = $1 ORDER BY id ASC LIMIT 1
       )`,
      [userId],
    );

    const after = await agentA.get("/api/account/export/summary");
    expect(after.status).toBe(200);
    const body = after.body as SummaryBody;
    expect(body.habitCount).toBe(want.habits - 1);
    expect(body.messageCount).toBe(want.messages - 1);
    // Untouched tables keep their counts.
    expect(body.moodCount).toBe(want.moods);
    expect(body.memoryCount).toBe(want.memories);
  });

  it("returns counts for every user-owned category, not just the original four", async () => {
    const agentA = request.agent(app);
    const want: PopulateCounts = {
      messages: 3,
      habits: 2,
      moods: 4,
      memories: 5,
      wins: 6,
      goals: 2,
      commitments: 3,
      reminders: 1,
      signals: 4,
      habitCompletions: 5,
    };
    await signupAndPopulate(agentA, EMAIL_A, "A", want);

    const res = await agentA.get("/api/account/export/summary");
    expect(res.status).toBe(200);
    const body = res.body as SummaryBody;

    expect(body.messageCount).toBe(want.messages);
    expect(body.habitCount).toBe(want.habits);
    expect(body.moodCount).toBe(want.moods);
    expect(body.memoryCount).toBe(want.memories);
    expect(body.winCount).toBe(want.wins);
    expect(body.goalCount).toBe(want.goals);
    expect(body.commitmentCount).toBe(want.commitments);
    expect(body.reminderCount).toBe(want.reminders);
    expect(body.personalitySignalCount).toBe(want.signals);
    expect(body.habitCompletionCount).toBe(want.habitCompletions);
  });

  it("keeps summary counts in sync with the categories in the full export", async () => {
    const agentA = request.agent(app);
    // Populate every category with a distinct, non-zero count so a count wired
    // to the wrong table (or missing entirely) would be caught.
    const want: PopulateCounts = {
      messages: 3,
      habits: 2,
      moods: 4,
      memories: 5,
      wins: 6,
      goals: 7,
      commitments: 8,
      reminders: 9,
      signals: 10,
      habitCompletions: 5,
    };
    await signupAndPopulate(agentA, EMAIL_A, "A", want);

    const summaryRes = await agentA.get("/api/account/export/summary");
    expect(summaryRes.status).toBe(200);
    const summary = summaryRes.body as SummaryBody;

    const exportRes = await agentA.get("/api/account/export");
    expect(exportRes.status).toBe(200);
    const exp = exportRes.body as Record<string, unknown[]>;

    // Every collection category in the full export must have a matching count in
    // the preview summary. If a new category is added to the export, this map
    // must grow too — otherwise the preview silently under-reports.
    const pairs: Array<[keyof SummaryBody, string]> = [
      ["messageCount", "messages"],
      ["habitCount", "habits"],
      ["habitCompletionCount", "habitCompletions"],
      ["moodCount", "moodScores"],
      ["memoryCount", "memoryFacts"],
      ["winCount", "wins"],
      ["goalCount", "goals"],
      ["commitmentCount", "commitments"],
      ["reminderCount", "reminders"],
      ["personalitySignalCount", "personalitySignals"],
      ["weeklyChapterCount", "weeklyChapters"],
      ["chapterQuoteDismissalCount", "chapterQuoteDismissals"],
      ["chapterOfferEventCount", "chapterOfferEvents"],
    ];

    for (const [countKey, arrayKey] of pairs) {
      expect(Array.isArray(exp[arrayKey])).toBe(true);
      expect(summary[countKey]).toBe((exp[arrayKey] as unknown[]).length);
    }

    // Guard against the export growing a new array category that the summary
    // (and this test's pairs map) forgets to cover. `profile` is a single object
    // and `range`/`exportedAt` are scalars, so exclude them.
    const nonCategoryKeys = new Set(["profile", "range", "exportedAt"]);
    const exportArrayKeys = Object.keys(exp).filter(
      (k) => !nonCategoryKeys.has(k) && Array.isArray(exp[k]),
    );
    const coveredKeys = new Set(pairs.map(([, arrayKey]) => arrayKey));
    for (const key of exportArrayKeys) {
      expect(coveredKeys.has(key)).toBe(true);
    }
  });

  it("returns 401 when the caller is not authenticated", async () => {
    const res = await request(app).get("/api/account/export/summary");
    expect(res.status).toBe(401);
  });
});
