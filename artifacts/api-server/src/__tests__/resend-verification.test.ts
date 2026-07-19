/**
 * Integration tests: POST /api/auth/resend-verification — the recovery path
 * for users whose verification link expired or got lost.
 *
 * Asserts that:
 *   1. The unauthenticated {email} path replaces the old token with a fresh
 *      one valid for ~7 days.
 *   2. Unknown addresses get the exact same generic 200 (no account probing).
 *   3. Already-verified accounts get the generic 200 and NO new token.
 *   4. A second request inside the 60s cooldown issues no extra token
 *      (silent 200 for the email path, 429 for the logged-in gate).
 *   5. A resend does not delete a pending change-email staging token.
 *
 * The email itself is fired after the response (fire-and-forget), so tests
 * poll the tokens table instead of assuming synchronous inserts.
 */

import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const stamp = Date.now();
const EMAIL = `resend-${stamp}@example.invalid`;
const PASSWORD = "Test1234!";

const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

/** Clean up the test user (and its rows) after each test. */
async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>(
    "SELECT id FROM users WHERE email = $1",
    [email],
  );
  if (r.rowCount === 0) return;
  const uid = r.rows[0]!.id;

  await pool.query(`
    BEGIN;
    DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM email_verification_tokens WHERE user_id = ${uid};
    DELETE FROM password_reset_tokens WHERE user_id = ${uid};
    DELETE FROM profile WHERE user_id = ${uid};
    DELETE FROM users WHERE id = ${uid};
    COMMIT;
  `);
}

/** All signup (non-staging) verification tokens for a user, newest first. */
async function signupTokens(
  userId: number,
): Promise<{ token: string; expires_at: Date; created_at: Date }[]> {
  const r = await pool.query<{ token: string; expires_at: Date; created_at: Date }>(
    `SELECT token, expires_at, created_at FROM email_verification_tokens
     WHERE user_id = $1 AND new_email IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return r.rows;
}

/** Polls until the user has `count` signup tokens (token insert is async). */
async function waitForSignupTokens(
  userId: number,
  count: number,
  timeoutMs = 4000,
): Promise<{ token: string; expires_at: Date; created_at: Date }[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await signupTokens(userId);
    if (rows.length === count) return rows;
    if (Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Backdates all tokens so the 60s resend cooldown does not apply. */
async function ageTokens(userId: number): Promise<void> {
  await pool.query(
    `UPDATE email_verification_tokens
     SET created_at = NOW() - interval '10 minutes'
     WHERE user_id = $1`,
    [userId],
  );
}

/** Signs up the test user and waits for its signup token to land. */
async function signup(): Promise<number> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email: EMAIL, password: PASSWORD });
  expect(res.status).toBe(201);
  const userId: number = res.body.user.id;
  await waitForSignupTokens(userId, 1);
  return userId;
}

describe("resend-verification recovery path", () => {
  afterEach(async () => {
    await cleanupUser(EMAIL);
  });

  it("unauthenticated {email} request replaces the token with a fresh ~7-day one", async () => {
    const userId = await signup();
    await ageTokens(userId);
    const [before] = await signupTokens(userId);

    const res = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: EMAIL });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // Old token is deleted before the response; the new one lands async.
    const after = await waitForSignupTokens(userId, 1);
    expect(after.length).toBe(1);
    expect(after[0]!.token).not.toBe(before!.token);
    expect(after[0]!.expires_at.getTime()).toBeGreaterThan(Date.now() + SIX_DAYS_MS);
  });

  it("unknown address gets the same generic 200 — no account probing", async () => {
    const res = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: `nobody-${stamp}@example.invalid` });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      message:
        "If an account exists for that address, a new verification link is on its way.",
    });
  });

  it("already-verified account gets generic 200 and no new token", async () => {
    const userId = await signup();
    await pool.query(`UPDATE users SET email_verified_at = NOW() WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM email_verification_tokens WHERE user_id = $1`, [userId]);

    const res = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: EMAIL });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 600));
    expect((await signupTokens(userId)).length).toBe(0);
  });

  it("second request inside the cooldown issues no extra token", async () => {
    const userId = await signup();
    await ageTokens(userId);

    // First resend — issues a fresh token (created_at ≈ now).
    const first = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: EMAIL });
    expect(first.status).toBe(200);
    const [fresh] = await waitForSignupTokens(userId, 1);

    // Immediate second resend — silently absorbed by the cooldown.
    const second = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: EMAIL });
    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 600));
    const after = await signupTokens(userId);
    expect(after.length).toBe(1);
    expect(after[0]!.token).toBe(fresh!.token);
  });

  it("parallel resends issue exactly one token (atomic cooldown)", async () => {
    const userId = await signup();
    await ageTokens(userId);
    const [old] = await signupTokens(userId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post("/api/auth/resend-verification").send({ email: EMAIL }),
      ),
    );
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
    }

    // The winning request commits its token before responding; losers hit
    // the in-lock cooldown. Exactly one fresh token must remain.
    const after = await signupTokens(userId);
    expect(after.length).toBe(1);
    expect(after[0]!.token).not.toBe(old!.token);
  });

  it("logged-in gate gets a 429 inside the cooldown", async () => {
    const agent = request.agent(app);
    const res = await agent
      .post("/api/auth/signup")
      .send({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(201);
    const userId: number = res.body.user.id;
    await waitForSignupTokens(userId, 1); // signup token created seconds ago

    const resend = await agent.post("/api/auth/resend-verification");
    expect(resend.status).toBe(429);
    expect(resend.body.error).toMatch(/wait a minute/i);
  });

  it("resend leaves a pending change-email staging token untouched", async () => {
    const userId = await signup();
    await ageTokens(userId);
    await pool.query(
      `INSERT INTO email_verification_tokens (token, user_id, new_email, expires_at)
       VALUES ($1, $2, $3, NOW() + interval '1 day')`,
      [`staging-${stamp}`, userId, `new-${stamp}@example.invalid`],
    );

    const res = await request(app)
      .post("/api/auth/resend-verification")
      .send({ email: EMAIL });
    expect(res.status).toBe(200);
    await waitForSignupTokens(userId, 1);

    const staging = await pool.query(
      `SELECT token FROM email_verification_tokens
       WHERE user_id = $1 AND new_email IS NOT NULL`,
      [userId],
    );
    expect(staging.rowCount).toBe(1);
    expect(staging.rows[0]!.token).toBe(`staging-${stamp}`);
  });
});
