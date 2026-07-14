/**
 * Integration tests: the email-change flow can't hijack another user's address
 * or bypass the password check.
 *
 * Flow under test:
 *   POST /api/auth/change-email  — an authenticated user stages a change to a new
 *                                  address (guarded by the current password).
 *   GET  /api/auth/verify-email  — confirming a token whose `new_email` is set
 *                                  swaps the account over to the new address.
 *
 * These tests assert that:
 *   1. An unauthenticated request is rejected (401).
 *   2. A missing password is rejected (400) and stages nothing.
 *   3. A wrong password is rejected (403) and stages nothing.
 *   4. Changing to an address already used by another account is rejected (409).
 *   5. Changing to your own current address is rejected (400).
 *   6. Happy path: the account email + email_verified_at are only swapped AFTER
 *      the link is confirmed; the old address stays active until then.
 *   7. The race where the target address gets claimed between request and
 *      confirmation is handled — 409, no crash, and no silent overwrite.
 *
 * The staged token is read directly via pg (the endpoint never returns it), and
 * users are provisioned through the real signup endpoint so sessions are real.
 */

import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";

// ─── DB connection (same DATABASE_URL the app uses) ─────────────────────────

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns the current stored email for a user. */
async function emailOf(userId: number): Promise<string | null> {
  const r = await pool.query<{ email: string }>(
    "SELECT email FROM users WHERE id = $1",
    [userId],
  );
  return r.rows[0]?.email ?? null;
}

/** Returns the `email_verified_at` value for a user (null if unverified). */
async function verifiedAt(userId: number): Promise<Date | null> {
  const r = await pool.query<{ email_verified_at: Date | null }>(
    "SELECT email_verified_at FROM users WHERE id = $1",
    [userId],
  );
  return r.rows[0]?.email_verified_at ?? null;
}

/** Reads the pending email-change token staged for a user (new_email set). */
async function pendingChangeToken(userId: number): Promise<string | null> {
  const r = await pool.query<{ token: string }>(
    `SELECT token FROM email_verification_tokens
     WHERE user_id = $1 AND new_email IS NOT NULL
     ORDER BY expires_at DESC LIMIT 1`,
    [userId],
  );
  return r.rows[0]?.token ?? null;
}

/** Counts every verification token staged for a user (change or signup). */
async function tokenCount(userId: number): Promise<number> {
  const r = await pool.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM email_verification_tokens WHERE user_id = $1",
    [userId],
  );
  return Number(r.rows[0]?.n ?? "0");
}

/** Marks a user verified so we can observe verified status surviving a change. */
async function markVerified(userId: number): Promise<void> {
  await pool.query(
    "UPDATE users SET email_verified_at = NOW() WHERE id = $1",
    [userId],
  );
}

/** Clean up any test user (and its rows) that may have been left behind. */
async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>(
    "SELECT id FROM users WHERE email = $1",
    [email],
  );
  if (!r.rowCount) return;
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
const EMAIL_A = `change-a-${stamp}@example.invalid`; // the account changing its email
const EMAIL_B = `change-b-${stamp}@example.invalid`; // an unrelated existing account
const EMAIL_C = `change-c-${stamp}@example.invalid`; // an unclaimed target address
const PASSWORD = "Test1234!";
const WRONG_PASSWORD = "Wrong9999!";

describe("change-email cannot hijack an address or bypass the password check", () => {
  afterEach(async () => {
    await Promise.all([
      cleanupUser(EMAIL_A),
      cleanupUser(EMAIL_B),
      cleanupUser(EMAIL_C),
    ]);
  });

  /** Signs up a fresh user and returns a logged-in agent plus their id. */
  async function signup(email: string) {
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/signup").send({ email, password: PASSWORD });
    expect(res.status).toBe(201);
    return { agent, userId: res.body.user.id as number };
  }

  it("rejects an unauthenticated change request (401)", async () => {
    const res = await request(app)
      .post("/api/auth/change-email")
      .send({ newEmail: EMAIL_C, password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it("rejects a missing password (400) and stages nothing", async () => {
    const { agent, userId } = await signup(EMAIL_A);

    const res = await agent
      .post("/api/auth/change-email")
      .send({ newEmail: EMAIL_C });
    expect(res.status).toBe(400);

    // No pending change was staged, and the email is untouched.
    expect(await pendingChangeToken(userId)).toBeNull();
    expect(await emailOf(userId)).toBe(EMAIL_A);
  });

  it("rejects a wrong password (403) and stages nothing", async () => {
    const { agent, userId } = await signup(EMAIL_A);

    const res = await agent
      .post("/api/auth/change-email")
      .send({ newEmail: EMAIL_C, password: WRONG_PASSWORD });
    expect(res.status).toBe(403);

    expect(await pendingChangeToken(userId)).toBeNull();
    expect(await emailOf(userId)).toBe(EMAIL_A);
  });

  it("rejects changing to an address another account already uses (409)", async () => {
    // User B occupies EMAIL_B.
    const { userId: userBId } = await signup(EMAIL_B);
    // User A tries to take it.
    const { agent: agentA, userId: userAId } = await signup(EMAIL_A);

    const res = await agentA
      .post("/api/auth/change-email")
      .send({ newEmail: EMAIL_B, password: PASSWORD });
    expect(res.status).toBe(409);

    // Nothing staged for A, and neither account's email moved.
    expect(await pendingChangeToken(userAId)).toBeNull();
    expect(await emailOf(userAId)).toBe(EMAIL_A);
    expect(await emailOf(userBId)).toBe(EMAIL_B);
  });

  it("rejects changing to your own current address (400)", async () => {
    const { agent, userId } = await signup(EMAIL_A);

    // Even with different casing/whitespace it should be treated as the same.
    const res = await agent
      .post("/api/auth/change-email")
      .send({ newEmail: `  ${EMAIL_A.toUpperCase()}  `, password: PASSWORD });
    expect(res.status).toBe(400);

    expect(await pendingChangeToken(userId)).toBeNull();
    expect(await emailOf(userId)).toBe(EMAIL_A);
  });

  it("swaps email + verified_at only AFTER confirmation; old address stays active until then", async () => {
    const { agent, userId } = await signup(EMAIL_A);
    // Start verified so we can watch verification survive the change.
    await markVerified(userId);

    // Request the change.
    const req = await agent
      .post("/api/auth/change-email")
      .send({ newEmail: EMAIL_C, password: PASSWORD });
    expect(req.status).toBe(200);
    expect(req.body.pendingEmail).toBe(EMAIL_C);

    // BEFORE confirmation: the account still uses the OLD address.
    expect(await emailOf(userId)).toBe(EMAIL_A);
    const token = await pendingChangeToken(userId);
    expect(token).not.toBeNull();

    // The old address is still a valid login while the change is pending.
    const stillOldLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL_A, password: PASSWORD });
    expect(stillOldLogin.status).toBe(200);
    // The new address does NOT work yet.
    const newLoginTooEarly = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL_C, password: PASSWORD });
    expect(newLoginTooEarly.status).toBe(401);

    // Confirm the link.
    const confirm = await agent.get("/api/auth/verify-email").query({ token });
    expect(confirm.status).toBe(200);
    expect(confirm.body.emailChanged).toBe(true);

    // AFTER confirmation: the account uses the NEW address and stays verified.
    expect(await emailOf(userId)).toBe(EMAIL_C);
    expect(await verifiedAt(userId)).not.toBeNull();

    // Every token for the user is cleared, and the new address now logs in.
    expect(await tokenCount(userId)).toBe(0);
    const newLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL_C, password: PASSWORD });
    expect(newLogin.status).toBe(200);
  });

  it("handles the target address being claimed between request and confirmation (no crash, no overwrite)", async () => {
    const { agent, userId: userAId } = await signup(EMAIL_A);

    // A stages a change to EMAIL_C (unclaimed at request time).
    const req = await agent
      .post("/api/auth/change-email")
      .send({ newEmail: EMAIL_C, password: PASSWORD });
    expect(req.status).toBe(200);
    const token = await pendingChangeToken(userAId);
    expect(token).not.toBeNull();

    // Between request and confirmation, someone else claims EMAIL_C.
    const { userId: userCId } = await signup(EMAIL_C);
    expect(userCId).not.toBe(userAId);

    // A confirms the now-stale link: it must fail cleanly, not overwrite/crash.
    const confirm = await agent.get("/api/auth/verify-email").query({ token });
    expect(confirm.status).toBe(409);

    // A keeps its original address; C is untouched; the stale token is gone.
    expect(await emailOf(userAId)).toBe(EMAIL_A);
    expect(await emailOf(userCId)).toBe(EMAIL_C);
    expect(await pendingChangeToken(userAId)).toBeNull();
  });
});
