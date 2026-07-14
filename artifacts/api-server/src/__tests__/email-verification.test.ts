/**
 * Integration tests: email verification cannot be bypassed or replayed.
 *
 * The verification flow (GET /api/auth/verify-email, POST /api/auth/resend-verification)
 * has security-sensitive edge cases. These tests assert that:
 *   1. An expired token returns 400 and does NOT mark the user verified.
 *   2. An already-used token returns 400 (it is deleted on first use → replay fails).
 *   3. A token for user A only verifies user A — even when a *different* user (B)
 *      is the one who is logged in and clicks the link, B stays unverified.
 *   4. Resending verification after the email is already verified returns 400.
 *
 * Tokens are inserted directly via pg for deterministic control over
 * expiry and ownership (signup also fires a token asynchronously, but we
 * never rely on that).
 */

import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";

// ─── DB connection (same DATABASE_URL the app uses) ─────────────────────────

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns the `email_verified_at` value for a user (null if unverified). */
async function verifiedAt(userId: number): Promise<Date | null> {
  const r = await pool.query<{ email_verified_at: Date | null }>(
    "SELECT email_verified_at FROM users WHERE id = $1",
    [userId],
  );
  return r.rows[0]?.email_verified_at ?? null;
}

/** Inserts a verification token for a user with an explicit expiry. */
async function insertToken(
  token: string,
  userId: number,
  expiresAt: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO email_verification_tokens (token, user_id, expires_at)
     VALUES ($1, $2, $3)`,
    [token, userId, expiresAt],
  );
}

/** Clean up any test user (and its rows) that may have been left behind. */
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

// ─── Test data ────────────────────────────────────────────────────────────────

const stamp = Date.now();
const EMAIL_A = `verify-a-${stamp}@example.invalid`;
const EMAIL_B = `verify-b-${stamp}@example.invalid`;
const PASSWORD = "Test1234!";

describe("email verification cannot be bypassed or replayed", () => {
  afterEach(async () => {
    await Promise.all([cleanupUser(EMAIL_A), cleanupUser(EMAIL_B)]);
  });

  it("expired token returns 400 and leaves the user unverified", async () => {
    const agent = request.agent(app);
    const signup = await agent
      .post("/api/auth/signup")
      .send({ email: EMAIL_A, password: PASSWORD });
    expect(signup.status).toBe(201);
    const userId: number = signup.body.user.id;

    // Token that expired an hour ago
    const token = `expired-${stamp}`;
    await insertToken(token, userId, new Date(Date.now() - 60 * 60 * 1000));

    const res = await agent.get("/api/auth/verify-email").query({ token });
    expect(res.status).toBe(400);

    // The user must NOT have been marked verified
    expect(await verifiedAt(userId)).toBeNull();
  });

  it("already-used token returns 400 on replay and stays verified", async () => {
    const agent = request.agent(app);
    const signup = await agent
      .post("/api/auth/signup")
      .send({ email: EMAIL_A, password: PASSWORD });
    expect(signup.status).toBe(201);
    const userId: number = signup.body.user.id;

    const token = `valid-${stamp}`;
    await insertToken(token, userId, new Date(Date.now() + 60 * 60 * 1000));

    // First use succeeds
    const first = await agent.get("/api/auth/verify-email").query({ token });
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    const firstVerifiedAt = await verifiedAt(userId);
    expect(firstVerifiedAt).not.toBeNull();

    // Replaying the same token fails (token was deleted on first use)
    const replay = await agent.get("/api/auth/verify-email").query({ token });
    expect(replay.status).toBe(400);

    // Still verified — the failed replay didn't change anything
    expect(await verifiedAt(userId)).not.toBeNull();
  });

  it("a token for user A cannot verify a different logged-in user B", async () => {
    // User A
    const agentA = request.agent(app);
    const signupA = await agentA
      .post("/api/auth/signup")
      .send({ email: EMAIL_A, password: PASSWORD });
    expect(signupA.status).toBe(201);
    const userAId: number = signupA.body.user.id;

    // User B — this agent is logged in as B
    const agentB = request.agent(app);
    const signupB = await agentB
      .post("/api/auth/signup")
      .send({ email: EMAIL_B, password: PASSWORD });
    expect(signupB.status).toBe(201);
    const userBId: number = signupB.body.user.id;

    // A verification token that belongs to user A
    const token = `for-a-${stamp}`;
    await insertToken(token, userAId, new Date(Date.now() + 60 * 60 * 1000));

    // User B (logged in) clicks A's link. The token is bound to A, so A gets
    // verified and B must remain unverified — the session identity is ignored.
    const res = await agentB.get("/api/auth/verify-email").query({ token });
    expect(res.status).toBe(200);

    expect(await verifiedAt(userAId)).not.toBeNull(); // A verified
    expect(await verifiedAt(userBId)).toBeNull(); // B untouched
  });

  it("resend after already-verified returns 400", async () => {
    const agent = request.agent(app);
    const signup = await agent
      .post("/api/auth/signup")
      .send({ email: EMAIL_A, password: PASSWORD });
    expect(signup.status).toBe(201);
    const userId: number = signup.body.user.id;

    // Verify via a valid token
    const token = `resend-${stamp}`;
    await insertToken(token, userId, new Date(Date.now() + 60 * 60 * 1000));
    const verify = await agent.get("/api/auth/verify-email").query({ token });
    expect(verify.status).toBe(200);
    expect(await verifiedAt(userId)).not.toBeNull();

    // Resending now must be rejected
    const resend = await agent.post("/api/auth/resend-verification");
    expect(resend.status).toBe(400);
    expect(resend.body.error).toMatch(/already verified/i);
  });

  it("missing token returns 400", async () => {
    const agent = request.agent(app);
    const res = await agent.get("/api/auth/verify-email");
    expect(res.status).toBe(400);
  });
});
