/**
 * Security review follow-up: the two remaining paid model endpoints (the
 * morning note and the contextual greeting) and the account export routes
 * had no per-user ceiling. Same dynamic-import pattern as the other limiter
 * tests: limits are read at app-import time, so this file sets them to 1 and
 * imports the app itself; every other file keeps the high defaults from
 * setup/rate-limit-env.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import pg from "pg";

process.env.MORNING_NOTE_LIMIT_PER_HOUR = "1";
process.env.CONTEXTUAL_GREETING_LIMIT_PER_HOUR = "1";
process.env.ACCOUNT_EXPORT_LIMIT_PER_HOUR = "1";
process.env.ACCOUNT_EXPORT_SUMMARY_LIMIT_PER_HOUR = "1";

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("per-user ceilings on the morning note, greeting and export routes", () => {
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
      await pool.query(`DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = $1`, [String(uid)]);
      for (const t of ["messages", "email_verification_tokens", "profile"]) {
        await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [uid]);
      }
      await pool.query("DELETE FROM users WHERE id = $1", [uid]);
    }
    await pool.end();
  });

  async function signup(tag: string) {
    const email = `paid-rl-${tag}-${Date.now()}@example.invalid`;
    emails.push(email);
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
    expect(res.status).toBe(201);
    await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [res.body.user.id]);
    return agent;
  }

  const cases: Array<[string, (a: ReturnType<typeof request.agent>) => request.Test]> = [
    ["POST /api/chat/morning-note", (a) => a.post("/api/chat/morning-note").send({})],
    ["POST /api/chat/contextual-greeting", (a) => a.post("/api/chat/contextual-greeting").send({})],
    ["GET /api/account/export", (a) => a.get("/api/account/export")],
    ["GET /api/account/export/summary", (a) => a.get("/api/account/export/summary")],
  ];

  for (const [name, call] of cases) {
    it(`${name}: the first call is served, the second within the hour is 429, another user is unaffected`, async () => {
      const a = await signup("a");
      const b = await signup("b");
      const first = await call(a);
      expect(first.status, `${name} first`).toBeLessThan(400);
      const second = await call(a);
      expect(second.status, `${name} second`).toBe(429);
      expect(second.body.code).toBe("RATE_LIMITED");
      expect((await call(b)).status, `${name} other user`).toBeLessThan(400);
    });
  }

  it("the export and the report page share one budget", async () => {
    const a = await signup("report");
    expect((await a.get("/api/account/report")).status).toBe(200);
    expect((await a.get("/api/account/export")).status).toBe(429);
  });
});
