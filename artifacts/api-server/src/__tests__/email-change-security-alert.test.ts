/**
 * Integration tests: the OLD (current) email address is warned when an email
 * change is requested, and the notice's cancel link actually cancels the change.
 *
 * Task #43 added a security notice to the *current* address whenever
 *   POST /api/auth/change-email
 * is called, plus
 *   POST /api/auth/cancel-email-change
 * reachable from that notice's cancel link. A future refactor of the auth email
 * helpers could silently stop warning the rightful owner — the exact failure
 * this feature protects against — so these tests lock the behavior in.
 *
 * These tests assert that:
 *   1. Requesting a change sends a security notice to the OLD address whose body
 *      references the new address ONLY in masked form (never in full) and carries
 *      a working cancel link (?cancelEmailChange=<staged token>).
 *   2. POST /api/auth/cancel-email-change with a valid staged token deletes the
 *      pending change token, so a later GET /api/auth/verify-email with that same
 *      token no longer swaps the account email.
 *   3. An unknown / already-consumed token returns { ok: true } (no enumeration).
 *
 * Outbound email is exercised by stubbing global.fetch and setting a dummy
 * RESEND_API_KEY so the real send helpers run (the endpoint uses `fetch` for
 * Resend, while supertest drives the app over http — the two never collide).
 */

import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
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

/** Polls `cond` until it is truthy or the timeout elapses. */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out waiting for condition");
}

// ─── Test data ────────────────────────────────────────────────────────────────

const stamp = Date.now();
const EMAIL_A = `alert-a-${stamp}@example.invalid`; // the account changing its email
const EMAIL_C = `alert-c-${stamp}@example.invalid`; // the unclaimed new target address
const PASSWORD = "Test1234!";

/** Signs up a fresh user and returns a logged-in agent plus their id. */
async function signup(email: string) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email, password: PASSWORD });
  expect(res.status).toBe(201);
  return { agent, userId: res.body.user.id as number };
}

describe("change-email warns the old address and its cancel link works", () => {
  let originalResendKey: string | undefined;

  beforeAll(() => {
    // Unset the real key so no test can send a real email by accident. Individual
    // tests that need the send helpers to run set a dummy key + stub fetch.
    originalResendKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
  });

  afterAll(() => {
    if (originalResendKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalResendKey;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    delete process.env.RESEND_API_KEY;
    await Promise.all([cleanupUser(EMAIL_A), cleanupUser(EMAIL_C)]);
  });

  it("sends a security notice to the OLD address, masking the new address and including a working cancel link", async () => {
    const { agent, userId } = await signup(EMAIL_A);

    // Capture outbound Resend calls. Run the real send helpers by giving them a
    // (dummy) key; the app uses fetch for Resend, supertest uses http.
    const fetchCalls: Array<{ to: string[]; subject: string; body: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: any) => {
        const parsed = JSON.parse(init.body);
        fetchCalls.push({ to: parsed.to, subject: parsed.subject, body: init.body });
        return new Response(JSON.stringify({ id: "mock" }), { status: 200 });
      }),
    );
    process.env.RESEND_API_KEY = "test-key-not-real";

    const res = await agent
      .post("/api/auth/change-email")
      .send({ newEmail: EMAIL_C, password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.pendingEmail).toBe(EMAIL_C);

    // Emails are sent fire-and-forget after the response — wait for both.
    await waitFor(() => fetchCalls.length >= 2);

    const token = await pendingChangeToken(userId);
    expect(token).not.toBeNull();

    // Find the notice that went to the OLD (current) address.
    const alert = fetchCalls.find((c) => c.to.includes(EMAIL_A));
    expect(alert, "a notice should be sent to the old address").toBeTruthy();
    expect(alert!.subject).toMatch(/security alert/i);

    // The new address must appear ONLY in masked form, never in full.
    expect(alert!.body).not.toContain(EMAIL_C);
    expect(alert!.body).toContain("a***@e***.invalid"); // maskEmail(EMAIL_C)

    // The cancel link must carry the staged token so the owner can act.
    expect(alert!.body).toContain(`cancelEmailChange=${token}`);

    // Sanity: the confirmation email went to the NEW address, not the old one.
    const confirm = fetchCalls.find((c) => c.to.includes(EMAIL_C));
    expect(confirm, "a confirmation should be sent to the new address").toBeTruthy();
  });

  it("cancel-email-change with a valid staged token drops the change so verify-email no longer swaps the email", async () => {
    const { agent, userId } = await signup(EMAIL_A);

    // Stage a change (RESEND_API_KEY is unset here → helpers only log, no send).
    const req = await agent
      .post("/api/auth/change-email")
      .send({ newEmail: EMAIL_C, password: PASSWORD });
    expect(req.status).toBe(200);

    const token = await pendingChangeToken(userId);
    expect(token).not.toBeNull();

    // Cancel it via the notice's cancel endpoint (no session needed).
    const cancel = await request(app)
      .post("/api/auth/cancel-email-change")
      .send({ token });
    expect(cancel.status).toBe(200);
    expect(cancel.body.ok).toBe(true);

    // The staged token is gone.
    expect(await pendingChangeToken(userId)).toBeNull();

    // Confirming the now-cancelled token must NOT swap the email.
    const verify = await agent.get("/api/auth/verify-email").query({ token });
    expect(verify.status).toBe(400);
    expect(verify.body.emailChanged).toBeUndefined();

    // The account keeps its original address.
    expect(await emailOf(userId)).toBe(EMAIL_A);
  });

  it("cancel-email-change with an unknown or already-consumed token returns { ok: true } (no enumeration)", async () => {
    const res = await request(app)
      .post("/api/auth/cancel-email-change")
      .send({ token: `does-not-exist-${stamp}` });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
