/**
 * Integration tests: /api/reflection/* (Phase 1).
 *
 * DATABASE_URL-gated (skips where no DB is present, like the rest of the DB
 * suite). Covers:
 *  - GET /reflection lists the caller's reports (metadata only, no content);
 *  - GET /reflection/:id returns the decrypted report; DELETE removes it;
 *  - ownership isolation: user A never sees or deletes user B's report (404);
 *  - unauthenticated caller gets 401;
 *  - POST /reflection/generate with no ANTHROPIC_API_KEY (test env) degrades to
 *    503 rather than crashing — confirms the endpoint + gate wiring;
 *  - account deletion cascades reflection_reports away.
 *
 * Reports are seeded via raw SQL with PLAINTEXT content: encrypted columns pass
 * legacy-plaintext through on read (same trick the memory-export test uses), so
 * GET /reflection/:id returns exactly what we inserted.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import pg from "pg";

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("/api/reflection", () => {
  let app: Express;
  let pool: pg.Pool;
  const emails: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    app = (await import("../app.js")).default;
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    for (const email of emails.splice(0)) {
      const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
      if (!r.rowCount) continue;
      const uid = r.rows[0]!.id;
      await pool.query(`
        BEGIN;
        DELETE FROM user_sessions       WHERE sess::jsonb->>'userId' = '${uid}';
        DELETE FROM email_verification_tokens WHERE user_id = ${uid};
        DELETE FROM reflection_reports  WHERE user_id = ${uid};
        DELETE FROM messages            WHERE user_id = ${uid};
        DELETE FROM goals               WHERE user_id = ${uid};
        DELETE FROM profile             WHERE user_id = ${uid};
        DELETE FROM users               WHERE id      = ${uid};
        COMMIT;
      `);
    }
    await pool.end();
  });

  function nextEmail(tag: string): string {
    const email = `reflection-${tag}-${Date.now()}-${seq++}@example.invalid`;
    emails.push(email);
    return email;
  }

  async function signup(tag: string) {
    const email = nextEmail(tag);
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
    expect(res.status).toBe(201);
    const userId: number = res.body.user.id;
    await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
    return { agent, userId, email };
  }

  /** Insert a report with plaintext content; returns its id. */
  async function seedReport(userId: number, content: string, generatedBy = "on_demand"): Promise<number> {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO reflection_reports (user_id, content, period_start, period_end, generated_by)
       VALUES ($1, $2, NOW() - interval '7 days', NOW(), $3) RETURNING id`,
      [userId, content, generatedBy],
    );
    return r.rows[0]!.id;
  }

  it("lists reports (metadata only) and fetches full content, newest first", async () => {
    const { agent, userId } = await signup("list");
    await seedReport(userId, "OLDER report body");
    await new Promise((r) => setTimeout(r, 5));
    const newerId = await seedReport(userId, "NEWER report body — you mentioned your brother twice.");

    const list = await agent.get("/api/reflection");
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect(list.body.length).toBe(2);
    // Metadata only — the list must NOT ship the (decrypted) content.
    expect(list.body[0]).not.toHaveProperty("content");
    expect(list.body[0]).toHaveProperty("periodStart");
    // Newest first.
    expect(list.body[0].id).toBe(newerId);

    const one = await agent.get(`/api/reflection/${newerId}`);
    expect(one.status).toBe(200);
    expect(one.body.content).toContain("you mentioned your brother twice");
    expect(one.body.generatedBy).toBe("on_demand");
  });

  it("deletes a report; a second delete is 404", async () => {
    const { agent, userId } = await signup("del");
    const id = await seedReport(userId, "to be deleted");

    const del = await agent.delete(`/api/reflection/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const again = await agent.delete(`/api/reflection/${id}`);
    expect(again.status).toBe(404);

    const gone = await agent.get(`/api/reflection/${id}`);
    expect(gone.status).toBe(404);
  });

  it("never lets one user read or delete another's report", async () => {
    const a = await signup("owner");
    const b = await signup("intruder");
    const aReport = await seedReport(a.userId, "user A private reflection");

    const bRead = await b.agent.get(`/api/reflection/${aReport}`);
    expect(bRead.status).toBe(404);

    const bDelete = await b.agent.delete(`/api/reflection/${aReport}`);
    expect(bDelete.status).toBe(404);

    // A can still read it — B's attempts changed nothing.
    const aRead = await a.agent.get(`/api/reflection/${aReport}`);
    expect(aRead.status).toBe(200);
    expect(aRead.body.content).toContain("user A private reflection");
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/reflection");
    expect(res.status).toBe(401);
  });

  it("generate degrades to 503 when the model is unavailable (no API key in test env)", async () => {
    const { agent, userId } = await signup("gen");
    // Give the period some content so we exercise the LLM path, not the gate.
    await pool.query(
      `INSERT INTO messages (user_id, role, content) VALUES ($1,'user',$2),($1,'assistant',$3)`,
      [userId, "I keep circling the same worry about work", "tell me about it"],
    );
    const res = await agent.post("/api/reflection/generate").send({});
    // getAnthropic() is null without ANTHROPIC_API_KEY → unavailable → 503.
    expect(res.status).toBe(503);
    expect(res.body.error).toBeTruthy();
    // Nothing was stored.
    const list = await agent.get("/api/reflection");
    expect(list.body.length).toBe(0);
  });

  it("account deletion removes the user's reports (cascade)", async () => {
    const { agent, userId, email } = await signup("cascade");
    await seedReport(userId, "should vanish with the account");

    const del = await agent.delete("/api/auth/account").send({ password: "Test1234!" });
    expect([200, 204]).toContain(del.status);

    const rows = await pool.query("SELECT id FROM reflection_reports WHERE user_id = $1", [userId]);
    expect(rows.rowCount).toBe(0);
    // Account is gone — drop it from the teardown list.
    const idx = emails.indexOf(email);
    if (idx >= 0) emails.splice(idx, 1);
  });
});
