/**
 * Integration tests: conversational goal-setting.
 *
 * The full loop under test:
 *  1. Companion proposes a goal, user clearly agrees → a goals row + AI-broken
 *     steps appear (same code path as the Journey form: createGoalWithTasks).
 *  2. A recurring routine agreement becomes a HABIT, not a goal (taxonomy gate).
 *  3. A decline creates nothing and records the re-offer cooldown.
 *  4. The system prompt reflects state: goal-setting rules in the stable block,
 *     "HOLD OFF" cooldown line in the context block after a decline.
 *
 * These call the real extraction model (claude-haiku-4-5) against the real dev
 * DB — the exact pipeline production uses after every chat/voice exchange.
 */

import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import pg from "pg";
import { eq, and } from "drizzle-orm";
import { db, goalsTable, goalTasksTable, habitsTable, profileTable } from "@workspace/db";
import app from "../app.js";
import { detectHabitMentions } from "../services/ai.js";
import { buildSystemPrompt } from "../services/systemPrompt.js";
import { getOrCreateProfileForUser } from "../routes/profile.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const HAS_AI = Boolean(process.env.ANTHROPIC_API_KEY);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const createdEmails: string[] = [];

async function makeUser(tag: string) {
  const email = `goal-test-${tag}-${Date.now()}@example.com`;
  createdEmails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "Password123!" });
  expect([200, 201]).toContain(res.status);

  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  const userId = r.rows[0]!.id;

  await getOrCreateProfileForUser(userId);
  await db
    .update(profileTable)
    .set({ userName: "Sam", isOnboardingComplete: true, country: "US", timezone: "UTC" })
    .where(eq(profileTable.userId, userId));
  const [profile] = await db.select().from(profileTable).where(eq(profileTable.userId, userId));
  return { userId, profile: profile! };
}

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (r.rowCount === 0) return;
  const uid = r.rows[0]!.id;
  await pool.query(`DELETE FROM goal_tasks WHERE goal_id IN (SELECT id FROM goals WHERE user_id = ${uid})`);
  await pool.query(`DELETE FROM goals WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM habit_completions WHERE habit_id IN (SELECT id FROM habits WHERE user_id = ${uid})`);
  await pool.query(`DELETE FROM habits WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM personalization_state WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM email_verification_tokens WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM profile WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM users WHERE id = ${uid}`);
}

afterEach(async () => {
  while (createdEmails.length > 0) {
    await cleanupUser(createdEmails.pop()!);
  }
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("conversational goal-setting", () => {
  it.skipIf(!HAS_AI)(
    "creates a goal with AI-broken steps when the user clearly agrees",
    async () => {
      const { userId, profile } = await makeUser("agree");

      const result = await detectHabitMentions(
        profile,
        "Yes — set it. Three applications by Friday.",
        "Done — it's set: apply to three marketing jobs by next Friday. It's on your Journey now, broken into small steps. I'll ask you tomorrow how the first one went.",
        [],
        [],
      );

      expect(result.newGoal).not.toBeNull();

      const goals = await db.select().from(goalsTable).where(eq(goalsTable.userId, userId));
      expect(goals.length).toBe(1);
      expect(goals[0]!.title.length).toBeGreaterThan(3);
      expect(goals[0]!.isComplete).toBe(false);

      const tasks = await db
        .select()
        .from(goalTasksTable)
        .where(eq(goalTasksTable.goalId, goals[0]!.id));
      expect(tasks.length).toBeGreaterThanOrEqual(1);
      expect(tasks.length).toBeLessThanOrEqual(5);
    },
  );

  it.skipIf(!HAS_AI)(
    "routes a recurring routine to habits, not goals",
    async () => {
      const { userId, profile } = await makeUser("routine");

      await detectHabitMentions(
        profile,
        "okay, let's do it — every morning after coffee",
        "Deal — every morning after your coffee, ten minutes outside on the balcony. It's on your Journey with a streak from day one.",
        [],
        [],
      );

      const habits = await db
        .select()
        .from(habitsTable)
        .where(and(eq(habitsTable.userId, userId), eq(habitsTable.isActive, true)));
      const goals = await db.select().from(goalsTable).where(eq(goalsTable.userId, userId));

      expect(habits.length).toBe(1);
      expect(goals.length).toBe(0);
    },
  );

  it.skipIf(!HAS_AI)(
    "a decline creates nothing and records the re-offer cooldown",
    async () => {
      const { userId, profile } = await makeUser("decline");

      const result = await detectHabitMentions(
        profile,
        "hmm, not right now. maybe later",
        "Of course — no pressure at all. The idea will keep; we don't need to make it a goal today.",
        [],
        [],
      );

      expect(result.newGoal).toBeNull();
      expect(result.newHabit).toBeNull();
      expect(result.goalOfferDeclined).toBe(true);

      const goals = await db.select().from(goalsTable).where(eq(goalsTable.userId, userId));
      const habits = await db.select().from(habitsTable).where(eq(habitsTable.userId, userId));
      expect(goals.length).toBe(0);
      expect(habits.length).toBe(0);

      const ps = await pool.query(
        "SELECT goal_offer_declined_at FROM personalization_state WHERE user_id = $1",
        [userId],
      );
      expect(ps.rowCount).toBe(1);
      expect(ps.rows[0]!.goal_offer_declined_at).not.toBeNull();

      // 4. System prompt picks the cooldown up in the volatile context block
      const parts = await buildSystemPrompt(profile);
      expect(parts.context).toContain("GOAL OFFERS — HOLD OFF");
      expect(parts.context).not.toContain("you may offer to set ONE small goal");
    },
  );

  it("always ships the conversational goal-setting rules in the stable prompt", async () => {
    const { profile } = await makeUser("prompt");
    const parts = await buildSystemPrompt(profile);
    expect(parts.stable).toContain("CONVERSATIONAL GOAL-SETTING");
    expect(parts.stable).toContain("GOALS & ROUTINES — YOU CAN SET THEM RIGHT HERE IN THE CONVERSATION");
    // Agreement-gate language: only a clear yes creates anything
    expect(parts.stable).toContain("Hesitation is not yes");
  });
});
