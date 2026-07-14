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
  firstMessageAt: string | null;
  lastMessageAt: string | null;
}

interface PopulateCounts {
  messages: number;
  habits: number;
  moods: number;
  memories: number;
}

/**
 * Sign up + verify a test user, then write `counts` rows into each of the four
 * tables the summary card previews. Uses distinct dates for mood_scores because
 * that table has a unique (user_id, date) constraint.
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

  for (let i = 0; i < counts.habits; i++) {
    await pool.query(
      `INSERT INTO habits (user_id, name, when_then, reason)
       VALUES ($1, $2, 'Every morning', 'Health')`,
      [userId, `Habit-${tag}-${i}`],
    );
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

  it("returns 401 when the caller is not authenticated", async () => {
    const res = await request(app).get("/api/account/export/summary");
    expect(res.status).toBe(401);
  });
});
