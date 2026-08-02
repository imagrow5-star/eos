/**
 * DB-gated integration tests for POST /api/memory/reset + GET
 * /api/memory/reset-eligible (Sprint: dedup & reset).
 *
 * The allowlist is read from process.env at call time, so each test sets
 * MEMORY_RESET_ALLOWLIST for the case it needs and restores it after.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import request from "supertest";
import type { Express } from "express";
import pg from "pg";

const DB = !!process.env.DATABASE_URL;

describe.skipIf(!DB)("POST /api/memory/reset", () => {
  let app: Express;
  let pool: pg.Pool;
  const emails: string[] = [];
  let seq = 0;
  const priorAllowlist = process.env.MEMORY_RESET_ALLOWLIST;

  beforeAll(async () => {
    app = (await import("../app.js")).default;
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterEach(() => {
    if (priorAllowlist === undefined) delete process.env.MEMORY_RESET_ALLOWLIST;
    else process.env.MEMORY_RESET_ALLOWLIST = priorAllowlist;
  });

  afterAll(async () => {
    for (const email of emails.splice(0)) {
      const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
      if (!r.rowCount) continue;
      const uid = r.rows[0]!.id;
      await pool.query(`
        BEGIN;
        DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = '${uid}';
        DELETE FROM email_verification_tokens WHERE user_id = ${uid};
        DELETE FROM crisis_events     WHERE user_id = ${uid};
        DELETE FROM habit_completions WHERE user_id = ${uid};
        DELETE FROM habits            WHERE user_id = ${uid};
        DELETE FROM goals             WHERE user_id = ${uid};
        DELETE FROM commitments       WHERE user_id = ${uid};
        DELETE FROM mood_scores       WHERE user_id = ${uid};
        DELETE FROM memory_facts      WHERE user_id = ${uid};
        DELETE FROM memory_feelings   WHERE user_id = ${uid};
        DELETE FROM sealed_notes      WHERE user_id = ${uid};
        DELETE FROM weekly_chapters   WHERE user_id = ${uid};
        DELETE FROM messages          WHERE user_id = ${uid};
        DELETE FROM profile           WHERE user_id = ${uid};
        DELETE FROM users             WHERE id      = ${uid};
        COMMIT;
      `);
    }
    await pool.end();
  });

  async function signup(tag: string) {
    const email = `memreset-${tag}-${Date.now()}-${seq++}@example.invalid`;
    emails.push(email);
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
    expect(res.status).toBe(201);
    const userId: number = res.body.user.id;
    await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
    return { agent, userId, email };
  }

  async function populate(userId: number) {
    await pool.query(`INSERT INTO memory_facts (user_id, fact, category) VALUES ($1, 'a fact', 'life')`, [userId]);
    await pool.query(`INSERT INTO memory_feelings (user_id, feeling, category) VALUES ($1, 'the dinner made them feel small', 'shame')`, [userId]);
    await pool.query(`INSERT INTO mood_scores (user_id, score, date) VALUES ($1, 6, '2026-07-14')`, [userId]);
    await pool.query(`INSERT INTO commitments (user_id, content, cue) VALUES ($1, 'text Sam', 'morning')`, [userId]);
    await pool.query(`INSERT INTO goals (user_id, title, description) VALUES ($1, 'sleep earlier', 'd')`, [userId]);
    const h = await pool.query<{ id: number }>(
      `INSERT INTO habits (user_id, name, when_then, reason) VALUES ($1, 'walk', 'after coffee', 'health') RETURNING id`,
      [userId],
    );
    await pool.query(`INSERT INTO habit_completions (user_id, habit_id, completed_date) VALUES ($1, $2, '2026-07-14')`, [userId, h.rows[0]!.id]);
    // Kept-intact data:
    await pool.query(`INSERT INTO messages (user_id, role, content) VALUES ($1, 'user', 'hello there')`, [userId]);
  }

  async function count(table: string, userId: number): Promise<number> {
    const r = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = $1`, [userId]);
    return parseInt(r.rows[0]!.n, 10);
  }

  it("wipes only the memory tables and leaves conversations intact", async () => {
    const { agent, userId, email } = await signup("wipe");
    process.env.MEMORY_RESET_ALLOWLIST = email;
    await populate(userId);

    const res = await agent.post("/api/memory/reset");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toMatchObject({
      memory_facts: 1,
      memory_feelings: 1,
      habits: 1,
      habit_completions: 1,
      commitments: 1,
      goals: 1,
      mood_scores: 1,
    });

    // Memory tables are empty…
    expect(await count("memory_facts", userId)).toBe(0);
    expect(await count("memory_feelings", userId)).toBe(0);
    expect(await count("habits", userId)).toBe(0);
    expect(await count("habit_completions", userId)).toBe(0);
    expect(await count("commitments", userId)).toBe(0);
    expect(await count("goals", userId)).toBe(0);
    expect(await count("mood_scores", userId)).toBe(0);
    // …conversations are NOT.
    expect(await count("messages", userId)).toBe(1);
  });

  it("returns 403 for an authenticated user not on the allowlist", async () => {
    const { agent } = await signup("forbidden");
    process.env.MEMORY_RESET_ALLOWLIST = "someone-else@example.com";

    const res = await agent.post("/api/memory/reset");
    expect(res.status).toBe(403);
  });

  it("returns 404 when the allowlist env var is not set", async () => {
    const { agent } = await signup("notconfigured");
    delete process.env.MEMORY_RESET_ALLOWLIST;

    const res = await agent.post("/api/memory/reset");
    expect(res.status).toBe(404);
  });

  it("reset-eligible reflects the allowlist", async () => {
    const { agent, email } = await signup("eligible");

    process.env.MEMORY_RESET_ALLOWLIST = email;
    const yes = await agent.get("/api/memory/reset-eligible");
    expect(yes.status).toBe(200);
    expect(yes.body.eligible).toBe(true);

    process.env.MEMORY_RESET_ALLOWLIST = "other@example.com";
    const no = await agent.get("/api/memory/reset-eligible");
    expect(no.body.eligible).toBe(false);

    delete process.env.MEMORY_RESET_ALLOWLIST;
    const unset = await agent.get("/api/memory/reset-eligible");
    expect(unset.body.eligible).toBe(false);
  });

  it("requires authentication", async () => {
    process.env.MEMORY_RESET_ALLOWLIST = "anyone@example.com";
    const res = await request(app).post("/api/memory/reset");
    expect(res.status).toBe(401);
  });
});
