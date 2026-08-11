/**
 * Integration tests: POST /api/internal/reflection/weekly-run (Phase 3).
 *
 * DATABASE_URL-gated. Covers the weekly auto-sweep:
 *  - HMAC auth: no/'wrong' token → 401; a valid current-hour token → 200;
 *  - due-user selection: a user with ≥ the minimum-content bar of recent
 *    messages and no report this period is selected;
 *  - the minimum-content gate: a user below the bar is NOT selected;
 *  - idempotency: a user who already has a report this period is NOT selected;
 *  - dry-run reports decisions without generating or storing anything;
 *  - a real run in the test env (no ANTHROPIC_API_KEY) attempts generation and
 *    records it as unavailable, storing no report.
 *
 * All sweep calls are scoped with { userId } so the assertions never depend on
 * other tests' users in the shared DB.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import pg from "pg";
import { reflectionRunToken } from "../routes/reflection-internal.js";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const RUN = "/api/internal/reflection/weekly-run";

describe.skipIf(!HAS_DB)("POST /api/internal/reflection/weekly-run", () => {
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
        DELETE FROM reflection_reports WHERE user_id = ${uid};
        DELETE FROM messages           WHERE user_id = ${uid};
        DELETE FROM users              WHERE id      = ${uid};
        COMMIT;
      `);
    }
    await pool.end();
  });

  function token(): string {
    return reflectionRunToken(process.env.SESSION_SECRET as string, new Date());
  }

  async function makeUser(tag: string, opts: { messages: number; recentReport?: boolean }): Promise<number> {
    const email = `refl-sweep-${tag}-${Date.now()}-${seq++}@example.invalid`;
    emails.push(email);
    const u = await pool.query<{ id: number }>(
      `INSERT INTO users (email, hashed_password, email_verified_at) VALUES ($1,'x',NOW()) RETURNING id`,
      [email],
    );
    const uid = u.rows[0]!.id;
    for (let i = 0; i < opts.messages; i++) {
      await pool.query(
        `INSERT INTO messages (user_id, role, content) VALUES ($1,'user',$2),($1,'assistant',$3)`,
        [uid, `msg ${i} from ${tag}`, `reply ${i}`],
      );
    }
    if (opts.recentReport) {
      await pool.query(
        `INSERT INTO reflection_reports (user_id, content, period_start, period_end, generated_by)
         VALUES ($1, 'prior report', NOW() - interval '7 days', NOW(), 'auto')`,
        [uid],
      );
    }
    return uid;
  }

  it("rejects missing / wrong tokens", async () => {
    const none = await request(app).post(RUN).send({});
    expect(none.status).toBe(401);
    const wrong = await request(app).post(RUN).set("x-internal-token", "nope").send({});
    expect(wrong.status).toBe(401);
  });

  it("selects a due, active-enough user (dry-run, scoped)", async () => {
    const uid = await makeUser("due", { messages: 6 });
    const res = await request(app).post(RUN).set("x-internal-token", token()).send({ userId: uid, dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.candidates).toBe(1);
    expect(res.body.decisions).toEqual([{ userId: uid, decision: "would_generate" }]);
    // Nothing stored on a dry run.
    const rows = await pool.query("SELECT id FROM reflection_reports WHERE user_id = $1", [uid]);
    expect(rows.rowCount).toBe(0);
  });

  it("skips a user below the minimum-content bar", async () => {
    const uid = await makeUser("thin", { messages: 2 });
    const res = await request(app).post(RUN).set("x-internal-token", token()).send({ userId: uid, dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.candidates).toBe(0);
    expect(res.body.decisions).toEqual([]);
  });

  it("skips a user who already has a report this period (idempotent)", async () => {
    const uid = await makeUser("already", { messages: 8, recentReport: true });
    const res = await request(app).post(RUN).set("x-internal-token", token()).send({ userId: uid, dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.candidates).toBe(0);
  });

  it("a real run attempts generation and records unavailable without an API key (stores nothing)", async () => {
    const uid = await makeUser("realrun", { messages: 6 });
    const res = await request(app).post(RUN).set("x-internal-token", token()).send({ userId: uid });
    expect(res.status).toBe(200);
    expect(res.body.candidates).toBe(1);
    // No ANTHROPIC_API_KEY in the test env → the service returns "unavailable".
    expect(res.body.generated).toBe(0);
    expect(res.body.unavailable).toBe(1);
    const rows = await pool.query("SELECT id FROM reflection_reports WHERE user_id = $1", [uid]);
    expect(rows.rowCount).toBe(0);
  });
});
