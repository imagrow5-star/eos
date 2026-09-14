/**
 * Security review follow-up: login hardening.
 *
 *  1. Per-account lockout: five wrong passwords hold the account — the SIXTH
 *     attempt is refused with 429 even when the password is right; the hold
 *     is recorded on the users row; once it lapses the right password logs
 *     in and the counter resets. A password reset lifts the hold.
 *  2. Unknown email costs a bcrypt compare, so timing can't enumerate.
 *  3. Password policy: over 72 bytes is refused everywhere a password is set;
 *     a breached password is refused (fetch seam), and HIBP being down lets
 *     the password through (fails open).
 *  4. change-password: wrong current password → 403; success re-keys the
 *     login, revokes every OTHER session and keeps the caller's, and drops
 *     pending reset tokens.
 *  5. logout-all revokes the other sessions and keeps the caller's.
 *  6. Confirming an email change revokes the other sessions and keeps the
 *     confirming browser's.
 */

import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import pg from "pg";
import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import app from "../app.js";
import { _setBreachFetchForTests } from "../lib/passwordPolicy.js";
import { lockoutMinutesFor } from "../services/loginLockout.js";
import { hashAuthToken } from "../lib/authTokenHash.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const PASSWORD = "Password123";
const created: string[] = [];

function email(tag: string): string {
  const e = `login-hardening-${tag}-${Date.now()}-${created.length}@example.invalid`;
  created.push(e);
  return e;
}

async function cleanup(): Promise<void> {
  for (const e of created.splice(0)) {
    const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [e]);
    if (!r.rowCount) continue;
    const uid = r.rows[0]!.id;
    await pool.query(`DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = $1`, [String(uid)]);
    await pool.query(`DELETE FROM email_verification_tokens WHERE user_id = $1`, [uid]);
    await pool.query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [uid]);
    await pool.query(`DELETE FROM profile WHERE user_id = $1`, [uid]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [uid]);
  }
}

function sid(res: request.Response): string {
  const header = res.headers["set-cookie"] as unknown as string[] | undefined;
  const c = header?.find((x) => x.startsWith("sid="))?.split(";")[0];
  if (!c) throw new Error("no sid cookie");
  return c;
}

async function signup(e: string, password = PASSWORD): Promise<{ id: number; cookie: string }> {
  const res = await request(app).post("/api/auth/signup").send({ email: e, password });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, cookie: sid(res) };
}

const login = (e: string, password: string, cookie?: string) => {
  const r = request(app).post("/api/auth/login");
  return (cookie ? r.set("Cookie", cookie) : r).send({ email: e, password });
};
const me = (cookie: string) => request(app).get("/api/auth/me").set("Cookie", cookie);

afterEach(async () => {
  _setBreachFetchForTests(null);
  vi.restoreAllMocks();
  await cleanup();
});
afterAll(() => pool.end());

// ─── 1. lockout ──────────────────────────────────────────────────────────────

describe("per-account login lockout", () => {
  it("schedule: no hold under five failures, then 1,2,4,8 minutes, capped at 15", () => {
    expect([1, 2, 3, 4].map(lockoutMinutesFor)).toEqual([0, 0, 0, 0]);
    expect([5, 6, 7, 8, 9, 20].map(lockoutMinutesFor)).toEqual([1, 2, 4, 8, 15, 15]);
  });

  it("five wrong passwords hold the account; the right password is then refused with 429", async () => {
    const e = email("lock");
    const { id } = await signup(e);

    for (let i = 0; i < 5; i++) {
      const res = await login(e, "wrong-password");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Incorrect email or password.");
    }
    const row = await pool.query<{ failed_login_attempts: number; locked_until: Date | null }>(
      "SELECT failed_login_attempts, locked_until FROM users WHERE id = $1",
      [id],
    );
    expect(row.rows[0]!.failed_login_attempts).toBe(5);
    expect(row.rows[0]!.locked_until).not.toBeNull();
    // 1-minute hold, give or take clock skew between node and postgres.
    const heldFor = row.rows[0]!.locked_until!.getTime() - Date.now();
    expect(heldFor).toBeGreaterThan(30_000);
    expect(heldFor).toBeLessThanOrEqual(61_000);

    const held = await login(e, PASSWORD);
    expect(held.status).toBe(429);
    expect(held.headers["retry-after"]).toMatch(/^\d+$/);
    expect(held.body.error).toMatch(/Too many attempts for this account/);
    expect(held.body.retryAfterSeconds).toBeGreaterThan(0);

    // The hold lapses: the right password logs in and the counter resets.
    await pool.query("UPDATE users SET locked_until = now() - interval '1 second' WHERE id = $1", [id]);
    const ok = await login(e, PASSWORD);
    expect(ok.status).toBe(200);
    const after = await pool.query<{ failed_login_attempts: number; locked_until: Date | null }>(
      "SELECT failed_login_attempts, locked_until FROM users WHERE id = $1",
      [id],
    );
    expect(after.rows[0]).toEqual({ failed_login_attempts: 0, locked_until: null });
  });

  it("a password reset lifts the hold", async () => {
    const e = email("reset-unlock");
    const { id } = await signup(e);
    await pool.query(
      "UPDATE users SET failed_login_attempts = 9, locked_until = now() + interval '15 minutes' WHERE id = $1",
      [id],
    );
    expect((await login(e, PASSWORD)).status).toBe(429);

    const token = "a".repeat(64);
    await pool.query(
      "INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [hashAuthToken(token), id],
    );
    const reset = await request(app).post("/api/auth/reset-password").send({ token, password: "Brand-new-pass-9" });
    expect(reset.status).toBe(200);

    expect((await login(e, "Brand-new-pass-9")).status).toBe(200);
  });
});

// ─── 2. timing ───────────────────────────────────────────────────────────────

describe("unknown email costs the same as a wrong password", () => {
  it("runs a bcrypt compare when the address has no account", async () => {
    const compare = vi.spyOn(bcrypt, "compare");
    const res = await login(email("nobody"), "whatever-1234");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Incorrect email or password.");
    expect(compare).toHaveBeenCalledTimes(1);
  });
});

// ─── 3. password policy ──────────────────────────────────────────────────────

describe("password policy", () => {
  it("refuses a password over 72 bytes at signup, reset and change", async () => {
    // 36 two-byte characters: 36 chars, 72 bytes — allowed. One more: refused.
    const ok72 = "é".repeat(36);
    const over = "é".repeat(37);
    expect(Buffer.byteLength(over, "utf8")).toBe(74);

    const e = email("long");
    const refused = await request(app).post("/api/auth/signup").send({ email: e, password: over });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("Password must be 72 characters or fewer.");

    const { id, cookie } = await signup(e, ok72);

    const change = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", cookie)
      .send({ currentPassword: ok72, newPassword: over });
    expect(change.status).toBe(400);
    expect(change.body.error).toBe("New password must be 72 characters or fewer.");

    const token = "b".repeat(64);
    await pool.query(
      "INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [hashAuthToken(token), id],
    );
    const reset = await request(app).post("/api/auth/reset-password").send({ token, password: over });
    expect(reset.status).toBe(400);
    expect(reset.body.error).toBe("Password must be 72 characters or fewer.");
  });

  it("refuses a breached password (k-anonymity range lookup) and fails open when HIBP is down", async () => {
    process.env.PASSWORD_BREACH_CHECK = "on";
    try {
      const pw = "correct horse battery staple";
      const sha1 = createHash("sha1").update(pw).digest("hex").toUpperCase();
      const calls: string[] = [];
      _setBreachFetchForTests(async (url) => {
        calls.push(url);
        // A padded line (count 0) for a different suffix, then the real hit.
        return {
          ok: true,
          status: 200,
          text: async () => `0018A45C4D1DEF81644B54AB7F969B88D65:0\r\n${sha1.slice(5)}:1234\r\n`,
        };
      });

      const refused = await request(app).post("/api/auth/signup").send({ email: email("breach"), password: pw });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/known data breach/);
      // Only the five-character prefix went over the wire.
      expect(calls).toEqual([`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`]);

      _setBreachFetchForTests(async () => {
        throw new Error("ECONNRESET");
      });
      const allowed = await request(app).post("/api/auth/signup").send({ email: email("hibp-down"), password: pw });
      expect(allowed.status).toBe(201);
    } finally {
      process.env.PASSWORD_BREACH_CHECK = "off";
    }
  });
});

// ─── 4. change-password ──────────────────────────────────────────────────────

describe("POST /api/auth/change-password", () => {
  it("needs a session and the current password", async () => {
    const anon = await request(app).post("/api/auth/change-password").send({ currentPassword: "x", newPassword: "Something-new-1" });
    expect(anon.status).toBe(401);

    const e = email("change-wrong");
    const { cookie } = await signup(e);
    const wrong = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", cookie)
      .send({ currentPassword: "not-it", newPassword: "Something-new-1" });
    expect(wrong.status).toBe(403);
    expect((await login(e, PASSWORD)).status).toBe(200); // unchanged
  });

  it("re-keys the login, keeps the caller's session, revokes the others and drops reset tokens", async () => {
    const e = email("change-ok");
    const { id, cookie: a } = await signup(e);
    const b = sid(await login(e, PASSWORD));
    expect((await me(b)).status).toBe(200);
    await pool.query(
      "INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [hashAuthToken("c".repeat(64)), id],
    );

    const changed = await request(app)
      .post("/api/auth/change-password")
      .set("Cookie", a)
      .send({ currentPassword: PASSWORD, newPassword: "Another-good-one-2" });
    expect(changed.status).toBe(200);
    expect(changed.body).toEqual({ ok: true, signedOut: 1 });

    expect((await me(a)).status).toBe(200); // the caller stays signed in
    expect((await me(b)).status).toBe(401); // the other browser is out
    expect((await login(e, PASSWORD)).status).toBe(401);
    expect((await login(e, "Another-good-one-2")).status).toBe(200);
    const tokens = await pool.query("SELECT 1 FROM password_reset_tokens WHERE user_id = $1", [id]);
    expect(tokens.rowCount).toBe(0);
  });
});

// ─── 5. logout-all ───────────────────────────────────────────────────────────

describe("POST /api/auth/logout-all", () => {
  it("revokes every other session and keeps the caller's", async () => {
    const e = email("logout-all");
    const { cookie: a } = await signup(e);
    const b = sid(await login(e, PASSWORD));
    const c = sid(await login(e, PASSWORD));

    const res = await request(app).post("/api/auth/logout-all").set("Cookie", a);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, signedOut: 2 });
    expect((await me(a)).status).toBe(200);
    expect((await me(b)).status).toBe(401);
    expect((await me(c)).status).toBe(401);

    expect((await request(app).post("/api/auth/logout-all")).status).toBe(401);
  });
});

// ─── 6. email change confirmation ────────────────────────────────────────────

describe("confirming an email change revokes the other sessions", () => {
  it("keeps the confirming browser signed in and signs the rest out", async () => {
    const e = email("email-change");
    const { id, cookie: a } = await signup(e);
    const b = sid(await login(e, PASSWORD));
    const newEmail = email("email-change-new");
    const token = "d".repeat(64);
    await pool.query(
      "INSERT INTO email_verification_tokens (token, user_id, new_email, expires_at) VALUES ($1, $2, $3, now() + interval '1 day')",
      [hashAuthToken(token), id, newEmail],
    );

    const confirm = await request(app).get("/api/auth/verify-email").query({ token }).set("Cookie", a);
    expect(confirm.status).toBe(200);
    expect(confirm.body).toEqual({ ok: true, emailChanged: true });

    expect((await me(a)).status).toBe(200);
    expect((await me(b)).status).toBe(401);
    expect((await login(newEmail, PASSWORD)).status).toBe(200);
  });
});
