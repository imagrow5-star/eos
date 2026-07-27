/**
 * Integration tests: ownership enforcement on PUT /goals/:id/tasks/:taskId.
 *
 * Review finding: the route verified the GOAL belonged to the caller but then
 * updated the TASK by its raw id, so user B could flip user A's task by
 * sending B's own goal id together with A's (guessable, sequential) task id.
 * The fix scopes the UPDATE to (task.id AND task.goalId). These tests pin the
 * behavior:
 *  - the owner can still toggle their own task;
 *  - another user gets 404 whether they present their own goal id + the
 *    victim's task id, or the victim's goal id outright — and the victim's
 *    task row is unchanged either way;
 *  - a task id that belongs to a DIFFERENT goal of the same user is also 404
 *    (the task must belong to the goal named in the URL).
 */

import { describe, it, expect, afterAll, afterEach } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const emails: string[] = [];
let seq = 0;
function nextEmail(tag: string): string {
  const email = `goal-own-${tag}-${Date.now()}-${seq++}@example.invalid`;
  emails.push(email);
  return email;
}

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`
    BEGIN;
    DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM email_verification_tokens WHERE user_id = ${uid};
    DELETE FROM goal_tasks WHERE goal_id IN (SELECT id FROM goals WHERE user_id = ${uid});
    DELETE FROM goals   WHERE user_id = ${uid};
    DELETE FROM profile WHERE user_id = ${uid};
    DELETE FROM users   WHERE id      = ${uid};
    COMMIT;
  `);
}

async function signupUser(tag: string) {
  const email = nextEmail(tag);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(res.status).toBe(201);
  const userId: number = res.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  await agent.get("/api/profile"); // materialize profile row
  return { agent, userId };
}

/** Insert a goal + one task directly (no AI breakdown involved). */
async function insertGoalWithTask(userId: number, title: string) {
  const g = await pool.query<{ id: number }>(
    `INSERT INTO goals (user_id, title, description) VALUES ($1, $2, '') RETURNING id`,
    [userId, title],
  );
  const goalId = g.rows[0]!.id;
  const t = await pool.query<{ id: number }>(
    `INSERT INTO goal_tasks (goal_id, content, "order") VALUES ($1, 'step one', 0) RETURNING id`,
    [goalId],
  );
  return { goalId, taskId: t.rows[0]!.id };
}

async function taskIsComplete(taskId: number): Promise<boolean> {
  const r = await pool.query<{ is_complete: boolean }>(
    `SELECT is_complete FROM goal_tasks WHERE id = $1`,
    [taskId],
  );
  return r.rows[0]!.is_complete;
}

afterEach(async () => {
  await Promise.all(emails.splice(0).map(cleanupUser));
});

afterAll(async () => {
  await pool.end();
});

describe("PUT /goals/:id/tasks/:taskId ownership", () => {
  it("lets the owner toggle their own task", async () => {
    const alice = await signupUser("alice");
    const { goalId, taskId } = await insertGoalWithTask(alice.userId, "Owner goal");

    const res = await alice.agent
      .put(`/api/goals/${goalId}/tasks/${taskId}`)
      .send({ isComplete: true });
    expect(res.status).toBe(200);
    expect(res.body.isComplete).toBe(true);
    expect(await taskIsComplete(taskId)).toBe(true);
  });

  it("returns 404 and changes nothing when another user targets the task via their own goal", async () => {
    const alice = await signupUser("victim");
    const bob = await signupUser("attacker");

    const victim = await insertGoalWithTask(alice.userId, "Victim goal");
    const attacker = await insertGoalWithTask(bob.userId, "Attacker goal");

    // The original hole: attacker's OWN goal id (passes the goal check) +
    // the victim's task id.
    const res = await bob.agent
      .put(`/api/goals/${attacker.goalId}/tasks/${victim.taskId}`)
      .send({ isComplete: true });

    expect(res.status).toBe(404);
    expect(await taskIsComplete(victim.taskId)).toBe(false);
    // And the attacker's own goal must not have been auto-completed as a side
    // effect of the "all tasks done" check.
    const g = await pool.query<{ is_complete: boolean }>(
      `SELECT is_complete FROM goals WHERE id = $1`,
      [attacker.goalId],
    );
    expect(g.rows[0]!.is_complete).toBe(false);
  });

  it("returns 404 when another user targets the victim's goal id directly", async () => {
    const alice = await signupUser("victim2");
    const bob = await signupUser("attacker2");
    const victim = await insertGoalWithTask(alice.userId, "Victim goal 2");

    const res = await bob.agent
      .put(`/api/goals/${victim.goalId}/tasks/${victim.taskId}`)
      .send({ isComplete: true });

    expect(res.status).toBe(404);
    expect(await taskIsComplete(victim.taskId)).toBe(false);
  });

  it("returns 404 when the task belongs to a different goal of the same user", async () => {
    const alice = await signupUser("crossgoal");
    const a = await insertGoalWithTask(alice.userId, "Goal A");
    const b = await insertGoalWithTask(alice.userId, "Goal B");

    const res = await alice.agent
      .put(`/api/goals/${a.goalId}/tasks/${b.taskId}`)
      .send({ isComplete: true });

    expect(res.status).toBe(404);
    expect(await taskIsComplete(b.taskId)).toBe(false);
  });
});
