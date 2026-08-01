/**
 * Integration test: the memory export is rate-limited to 1/hour/user.
 *
 * Same dynamic-import pattern as usage-limits.test.ts / rate-limit.test.ts:
 * the limit is read from the environment at app-import time, so this file sets
 * MEMORY_EXPORT_LIMIT_PER_HOUR=1 and then imports the app dynamically. Other
 * test files get the high default from setup/rate-limit-env.ts and can export
 * as often as they like.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import pg from "pg";

process.env.MEMORY_EXPORT_LIMIT_PER_HOUR = "1";

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("GET /api/memory/export — rate limit (1/hour)", () => {
  let app: Express;
  let pool: pg.Pool;
  const emails: string[] = [];

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
        DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = '${uid}';
        DELETE FROM email_verification_tokens WHERE user_id = ${uid};
        DELETE FROM profile WHERE user_id = ${uid};
        DELETE FROM users   WHERE id      = ${uid};
        COMMIT;
      `);
    }
    await pool.end();
  });

  async function signup(tag: string) {
    const email = `memexport-rl-${tag}-${Date.now()}@example.invalid`;
    emails.push(email);
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
    expect(res.status).toBe(201);
    await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [res.body.user.id]);
    return agent;
  }

  it("allows the first export and 429s the second within the hour", async () => {
    const agent = await signup("a");

    const first = await agent.get("/api/memory/export?format=json");
    expect(first.status).toBe(200);

    const second = await agent.get("/api/memory/export?format=markdown");
    expect(second.status).toBe(429);
    expect(second.body.code).toBe("RATE_LIMITED");
  });

  it("keys per user — a second user is unaffected by the first's limit", async () => {
    const agentA = await signup("b1");
    const agentB = await signup("b2");

    expect((await agentA.get("/api/memory/export")).status).toBe(200);
    expect((await agentA.get("/api/memory/export")).status).toBe(429);

    // B has its own budget.
    expect((await agentB.get("/api/memory/export")).status).toBe(200);
  });
});
