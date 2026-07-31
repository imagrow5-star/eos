/**
 * Privacy audit Tier 1 — integration proofs (real app + DB, DATABASE_URL-gated
 * exactly like the rest of the suite).
 *
 *  - Auth RESEND-unset path: the dev-fallback log for reset/verify/cancel emails
 *    must carry NO token, NO URL, NO userId.
 *  - Chapters crisis-seal path: sealing a note with crisis language must NOT
 *    emit a per-user "crisis language at write time" log line (userId in any
 *    form). The caring response to the user is unchanged.
 *
 * Heavy modules are imported dynamically so this file loads (and cleanly skips)
 * where no DB is provisioned — @workspace/db and app throw at import otherwise.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("privacy Tier 1 — auth + crisis log paths (integration)", () => {
  // supertest is a CJS `export =` module (no `.default` on its type namespace),
  // so it is typed loosely here (test-only) to avoid TS2694.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let request: any;
  let app: typeof import("../app.js").default;
  let logger: typeof import("../lib/logger.js").logger;
  let pg: typeof import("pg");
  let pool: import("pg").Pool;

  const TS = Date.now();
  const emails: string[] = [];

  beforeAll(async () => {
    request = (await import("supertest")).default;
    app = (await import("../app.js")).default;
    ({ logger } = await import("../lib/logger.js"));
    pg = await import("pg");
    pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL });
  });

  afterAll(async () => {
    for (const email of emails) {
      const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email=$1", [email]);
      if (!r.rowCount) continue;
      const uid = r.rows[0]!.id;
      await pool.query(`
        BEGIN;
        DELETE FROM user_sessions            WHERE sess::jsonb->>'userId' = '${uid}';
        DELETE FROM email_verification_tokens WHERE user_id = ${uid};
        DELETE FROM password_reset_tokens     WHERE user_id = ${uid};
        DELETE FROM sealed_notes              WHERE user_id = ${uid};
        DELETE FROM weekly_chapters           WHERE user_id = ${uid};
        DELETE FROM messages                  WHERE user_id = ${uid};
        DELETE FROM profile                   WHERE user_id = ${uid};
        DELETE FROM users                     WHERE id      = ${uid};
        COMMIT;
      `);
    }
    await pool.end();
  });

  // ── Auth: RESEND-unset dev-fallback log carries no token/URL/userId ────────
  it("forgot-password with RESEND unset logs no token, no URL, no userId", async () => {
    const email = `tier1-auth-${TS}-${emails.length}@example.invalid`;
    emails.push(email);

    // Create a verified user so forgot-password reaches the send path.
    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
    expect(signup.status).toBe(201);
    const userId: number = signup.body.user.id;
    await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);

    const priorResend = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    const warn = vi.spyOn(logger, "warn");
    try {
      await request(app).post("/api/auth/forgot-password").send({ email });
      // The send is fire-and-forget; give the background task a tick to log.
      await new Promise((r) => setTimeout(r, 250));

      const fallback = warn.mock.calls.find(
        (c) => typeof c[0] === "string" && (c[0] as string).includes("Email delivery unavailable"),
      );
      expect(fallback, "dev-fallback warn should have fired").toBeTruthy();

      // The whole fallback call — message + any args — carries nothing sensitive.
      const serialized = JSON.stringify(warn.mock.calls);
      expect(serialized).not.toMatch(/https?:\/\//); // no URL
      expect(serialized).not.toMatch(/resetToken=|verifyToken=|cancelReset=|cancelEmailChange=/); // no token
      expect(serialized.toLowerCase()).not.toContain("reseturl");
      expect(serialized).not.toContain(String(userId)); // no userId in the warn payload
    } finally {
      warn.mockRestore();
      if (priorResend === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = priorResend;
    }
  });

  // ── Chapters: crisis-seal path emits no per-user crisis log line ────────────
  it("sealing a crisis-language note emits no per-user crisis log line", async () => {
    const email = `tier1-crisis-${TS}-${emails.length}@example.invalid`;
    emails.push(email);

    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
    expect(signup.status).toBe(201);
    const userId: number = signup.body.user.id;
    await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
    await agent.get("/api/profile"); // materialize profile row

    const chapter = await pool.query<{ id: number }>(
      `INSERT INTO weekly_chapters
         (user_id, week_start, week_end, status, thread_opening, threshold_question, themes, note_invite, seal_resolution)
       VALUES ($1, '2026-07-13', '2026-07-19', 'revealed', 'An opening.', 'How did the week land?', '[]'::jsonb, $2, NULL)
       RETURNING id`,
      [userId, JSON.stringify({ prompt: "Where will your head be next Sunday?" })],
    );
    const chapterId = chapter.rows[0]!.id;

    const warn = vi.spyOn(logger, "warn");
    const info = vi.spyOn(logger, "info");
    try {
      const res = await agent
        .post(`/api/chapters/${chapterId}/note`)
        .send({ kind: "free", text: "I want to end my life and can't go on" });
      // Product behavior unchanged: crisis is answered with care immediately.
      expect(res.status).toBe(200);
      expect(res.body.care?.message).toBeTruthy();

      // No log line about crisis at write time...
      const crisisLine = [...warn.mock.calls, ...info.mock.calls].find(
        (c) => typeof c[1] === "string" && (c[1] as string).includes("crisis language at write time"),
      );
      expect(crisisLine, "the crisis-context log line must be gone").toBeUndefined();
      // ...and no crisis-path log carries this user's id in any form.
      const serialized = JSON.stringify([warn.mock.calls, info.mock.calls]);
      const anyCrisis = serialized.includes("crisis");
      if (anyCrisis) expect(serialized).not.toContain(`"userId":${userId}`);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });
});
