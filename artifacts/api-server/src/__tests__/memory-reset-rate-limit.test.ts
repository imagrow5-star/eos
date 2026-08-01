/**
 * DB-gated: POST /api/memory/reset is rate-limited to 1/hour/user.
 *
 * Sets MEMORY_RESET_LIMIT_PER_HOUR=1 before importing the app (the limit is read
 * at import time), same pattern as the other rate-limit suites.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import pg from "pg";

process.env.MEMORY_RESET_LIMIT_PER_HOUR = "1";

const DB = !!process.env.DATABASE_URL;

describe.skipIf(!DB)("POST /api/memory/reset — rate limit (1/hour)", () => {
  let app: Express;
  let pool: pg.Pool;
  const emails: string[] = [];
  const priorAllowlist = process.env.MEMORY_RESET_ALLOWLIST;

  beforeAll(async () => {
    app = (await import("../app.js")).default;
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    if (priorAllowlist === undefined) delete process.env.MEMORY_RESET_ALLOWLIST;
    else process.env.MEMORY_RESET_ALLOWLIST = priorAllowlist;
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

  it("allows the first reset and 429s the second within the hour", async () => {
    const email = `memreset-rl-${Date.now()}@example.invalid`;
    emails.push(email);
    process.env.MEMORY_RESET_ALLOWLIST = email;

    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
    expect(signup.status).toBe(201);
    await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [signup.body.user.id]);

    const first = await agent.post("/api/memory/reset");
    expect(first.status).toBe(200);

    const second = await agent.post("/api/memory/reset");
    expect(second.status).toBe(429);
    expect(second.body.code).toBe("RATE_LIMITED");
  });
});
