/**
 * Auth tokens hashed at rest (security review, Aug 2026).
 *
 * The database stores sha256("sha256:"-prefixed) digests of password-reset
 * and email-verification tokens; users still receive the raw token by email.
 * What these tests pin:
 *   • END TO END: the raw token captured from the actual (recorded) email
 *     still resets the password — while the database row holds only a hash;
 *   • DUMP ATTACK: presenting the STORED value (what a database thief has)
 *     does NOT work;
 *   • expired and already-used tokens still fail with their precise codes;
 *   • the one-time boot sweep hashes pre-existing raw rows in place so
 *     pending resets issued before the deploy keep working, and is
 *     idempotent (second run: zero changes).
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { hashAuthToken, TOKEN_HASH_PREFIX } from "../lib/authTokenHash.js";
import { runAuthTokenHashSweep } from "../services/authTokenHashSweep.js";
import type { RecordedEmail } from "./setup/suppress-resend.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Emails only fire when a key exists; suppress-resend intercepts + records
// them, so no real send can happen.
const savedResendKey = process.env.RESEND_API_KEY;
process.env.RESEND_API_KEY = "test-key-not-real";
const emails: string[] = [];
const PASSWORD = "Test1234!";
const NEW_PASSWORD = "Fresh5678!";

function recordedEmails(): RecordedEmail[] {
  return (globalThis as { __recordedEmails?: RecordedEmail[] }).__recordedEmails ?? [];
}

async function waitForEmail(
  to: string,
  param: string,
  timeoutMs = 5000,
): Promise<string> {
  const start = Date.now();
  const re = new RegExp(`${param}=([0-9a-f]{64})`);
  while (Date.now() - start < timeoutMs) {
    for (const e of recordedEmails()) {
      if (e.to.includes(to)) {
        const m = re.exec(e.html);
        if (m) return m[1]!;
      }
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no recorded email to ${to} carrying ${param}=…`);
}

async function makeUser(tag: string) {
  const email = `tokhash-${tag}-${Date.now()}@example.invalid`;
  emails.push(email);
  const agent = request.agent(app);
  const signup = await agent.post("/api/auth/signup").send({ email, password: PASSWORD });
  expect(signup.status).toBe(201);
  const userId: number = signup.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  return { agent, userId, email };
}

afterAll(async () => {
  if (savedResendKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = savedResendKey;
  for (const email of emails) {
    const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
    if (!r.rowCount) continue;
    const uid = r.rows[0]!.id;
    await pool.query(`
      BEGIN;
      DELETE FROM user_sessions             WHERE sess::jsonb->>'userId' = '${uid}';
      DELETE FROM email_verification_tokens WHERE user_id = ${uid};
      DELETE FROM password_reset_tokens     WHERE user_id = ${uid};
      DELETE FROM messages                  WHERE user_id = ${uid};
      DELETE FROM profile                   WHERE user_id = ${uid};
      DELETE FROM users                     WHERE id      = ${uid};
      COMMIT;
    `);
  }
  await pool.end();
});

describe("password reset — hashed at rest, end to end", () => {
  it("the raw token from the email works; the database holds only its hash", async () => {
    const { email, userId } = await makeUser("e2e");

    const req = await request(app).post("/api/auth/forgot-password").send({ email });
    expect(req.status).toBe(200);

    // The raw token exists ONLY in the email — capture it like a user would.
    const raw = await waitForEmail(email, "resetToken");

    // The database stores the hash, never the raw value.
    const { rows } = await pool.query(
      "SELECT token FROM password_reset_tokens WHERE user_id = $1",
      [userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token).toBe(hashAuthToken(raw));
    expect(rows[0]!.token).not.toBe(raw);
    expect(rows[0]!.token.startsWith(TOKEN_HASH_PREFIX)).toBe(true);

    // The emailed raw token completes the reset…
    const reset = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: raw, password: NEW_PASSWORD });
    expect(reset.status).toBe(200);
    expect(reset.body.ok).toBe(true);

    // …and the new password logs in.
    const login = await request(app)
      .post("/api/auth/login")
      .send({ email, password: NEW_PASSWORD });
    expect(login.status).toBe(200);
  });

  it("DUMP ATTACK: the stored hash string itself is NOT a usable token", async () => {
    const { email, userId } = await makeUser("dump");
    await request(app).post("/api/auth/forgot-password").send({ email });
    await waitForEmail(email, "resetToken");

    const { rows } = await pool.query(
      "SELECT token FROM password_reset_tokens WHERE user_id = $1",
      [userId],
    );
    const storedValue: string = rows[0]!.token; // what a database thief has

    const attempt = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: storedValue, password: "Attacker99!" });
    expect(attempt.status).toBe(400);
    expect(attempt.body.code).toBe("TOKEN_INVALID");

    // Old password still works — nothing changed.
    const login = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
  });

  it("an expired token fails with TOKEN_EXPIRED", async () => {
    const { userId } = await makeUser("expired");
    const raw = `expired-raw-${Date.now()}`;
    await pool.query(
      `INSERT INTO password_reset_tokens (token, user_id, expires_at)
       VALUES ($1, $2, NOW() - INTERVAL '1 second')`,
      [hashAuthToken(raw), userId],
    );
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: raw, password: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TOKEN_EXPIRED");
  });

  it("a used token fails on replay with TOKEN_USED", async () => {
    const { email } = await makeUser("used");
    await request(app).post("/api/auth/forgot-password").send({ email });
    const raw = await waitForEmail(email, "resetToken");

    const first = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: raw, password: NEW_PASSWORD });
    expect(first.status).toBe(200);

    const replay = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: raw, password: "Third000!" });
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe("TOKEN_USED");
  });
});

describe("email verification — hashed at rest, end to end", () => {
  it("the raw verifyToken from the signup email verifies; DB holds the hash", async () => {
    const email = `tokhash-verify-${Date.now()}@example.invalid`;
    emails.push(email);
    const signup = await request(app).post("/api/auth/signup").send({ email, password: PASSWORD });
    expect(signup.status).toBe(201);
    const userId: number = signup.body.user.id;

    const raw = await waitForEmail(email, "verifyToken");
    const { rows } = await pool.query(
      "SELECT token FROM email_verification_tokens WHERE user_id = $1",
      [userId],
    );
    expect(rows[0]!.token).toBe(hashAuthToken(raw));

    const verify = await request(app).get("/api/auth/verify-email").query({ token: raw });
    expect(verify.status).toBe(200);
    const u = await pool.query("SELECT email_verified_at FROM users WHERE id = $1", [userId]);
    expect(u.rows[0]!.email_verified_at).not.toBeNull();
  });
});

describe("boot sweep — pre-deploy raw rows are hashed in place", () => {
  it("hashes legacy raw rows (pending reset keeps working) and is idempotent", async () => {
    const { userId, email } = await makeUser("sweep");

    // Simulate pre-deploy rows: RAW tokens exactly as the old code stored them.
    const rawReset = "a".repeat(32) + "b".repeat(32); // 64 hex chars, like randomBytes(32).hex
    const rawVerify = "c".repeat(64);
    await pool.query(
      `INSERT INTO password_reset_tokens (token, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
      [rawReset, userId],
    );
    await pool.query(
      `INSERT INTO email_verification_tokens (token, user_id, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
      [rawVerify, userId],
    );

    const first = await runAuthTokenHashSweep();
    expect(first).not.toBeNull();
    expect(first!.password_reset_tokens).toBeGreaterThanOrEqual(1);
    expect(first!.email_verification_tokens).toBeGreaterThanOrEqual(1);

    // Rows are now hashes of the raw values.
    const r1 = await pool.query(
      "SELECT token FROM password_reset_tokens WHERE user_id = $1",
      [userId],
    );
    expect(r1.rows[0]!.token).toBe(hashAuthToken(rawReset));

    // The user's emailed raw token (issued pre-deploy) still works post-sweep.
    const reset = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: rawReset, password: NEW_PASSWORD });
    expect(reset.status).toBe(200);
    const login = await request(app).post("/api/auth/login").send({ email, password: NEW_PASSWORD });
    expect(login.status).toBe(200);

    // Idempotent: nothing left to hash for this user's tables.
    const second = await runAuthTokenHashSweep();
    expect(second).not.toBeNull();
    const leftoverRaw = await pool.query(
      `SELECT count(*)::int AS n FROM email_verification_tokens WHERE token NOT LIKE $1`,
      [`${TOKEN_HASH_PREFIX}%`],
    );
    expect(leftoverRaw.rows[0]!.n).toBe(0);
  });
});
