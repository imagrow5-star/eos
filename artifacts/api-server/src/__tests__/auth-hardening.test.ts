/**
 * Integration tests: auth robustness hardening.
 *
 * Covers:
 *  1. Unmatched /api paths answer JSON 404 (never Express's HTML 404 page).
 *  2. Malformed JSON bodies answer JSON 400 via the API error handler
 *     (body-parser errors used to surface as an HTML error page, which the
 *     SPA mislabelled as "Network error").
 *  3. Session fixation: login and signup regenerate the session ID, and the
 *     pre-auth session ID stops working.
 *  4. getAppBaseUrl() fails fast in production when APP_URL is missing
 *     instead of silently emailing localhost links.
 *  5. forgot-password per-email cooldown: a rapid second request does not
 *     mint a second reset token (each request sends two emails, so this is
 *     the email-bombing guard).
 */

import { describe, it, expect, afterEach, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { getAppBaseUrl } from "../routes/auth.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

/** Extracts the "sid=..." cookie pair from a supertest response, if any. */
function sidCookie(res: request.Response): string | undefined {
  const header = res.headers["set-cookie"] as unknown as string[] | undefined;
  return header?.find((c) => c.startsWith("sid="))?.split(";")[0];
}

afterAll(async () => {
  await pool.end();
});

// ─── 1 + 2: JSON responses for unmatched paths and malformed bodies ──────────

describe("API always answers JSON (no HTML error pages)", () => {
  const EMAIL = `json-api-test-${Date.now()}@example.invalid`;

  afterEach(async () => {
    await cleanupUser(EMAIL);
  });

  it("returns JSON 401 for an unmatched /api path without a session", async () => {
    const res = await request(app).post("/api/definitely-not-a-route");
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(typeof res.body.error).toBe("string");
  });

  it("returns JSON 404 for an unmatched /api path with a verified session", async () => {
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: EMAIL, password: "Password123" });
    expect(signup.status).toBe(201);
    const cookie = sidCookie(signup)!;
    await pool.query(
      "UPDATE users SET email_verified_at = NOW() WHERE id = $1",
      [signup.body.user.id],
    );

    const res = await request(app)
      .get("/api/definitely-not-a-route")
      .set("Cookie", cookie);
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("returns JSON 400 for a malformed JSON body", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email": "broken');
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toBe("Invalid JSON in request body.");
  });
});

// ─── 3: session regeneration on login/signup ─────────────────────────────────

describe("session fixation defence", () => {
  const EMAIL = `session-regen-test-${Date.now()}@example.invalid`;
  const PASSWORD = "Password123";

  afterEach(async () => {
    await cleanupUser(EMAIL);
  });

  it("issues a new session ID on login and invalidates the previous one", async () => {
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: EMAIL, password: PASSWORD });
    expect(signup.status).toBe(201);
    const signupSid = sidCookie(signup);
    expect(signupSid).toBeDefined();

    // Log in while presenting the existing (pre-login) session cookie.
    const login = await request(app)
      .post("/api/auth/login")
      .set("Cookie", signupSid!)
      .send({ email: EMAIL, password: PASSWORD });
    expect(login.status).toBe(200);
    const loginSid = sidCookie(login);
    expect(loginSid).toBeDefined();

    // The session ID must have changed...
    expect(loginSid).not.toBe(signupSid);

    // ...the new session works...
    const meNew = await request(app).get("/api/auth/me").set("Cookie", loginSid!);
    expect(meNew.status).toBe(200);
    expect(meNew.body.user.email).toBe(EMAIL);

    // ...and the old (pre-login) session no longer authenticates.
    const meOld = await request(app).get("/api/auth/me").set("Cookie", signupSid!);
    expect(meOld.status).toBe(401);
  });
});

// ─── 4: fail-fast APP_URL in production ──────────────────────────────────────

describe("getAppBaseUrl production fail-fast", () => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    APP_URL: process.env.APP_URL,
    REPLIT_DOMAINS: process.env.REPLIT_DOMAINS,
    REPLIT_DEV_DOMAIN: process.env.REPLIT_DEV_DOMAIN,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("throws in production when APP_URL and Replit domains are all missing", () => {
    process.env.NODE_ENV = "production";
    delete process.env.APP_URL;
    delete process.env.REPLIT_DOMAINS;
    delete process.env.REPLIT_DEV_DOMAIN;
    expect(() => getAppBaseUrl()).toThrow(/APP_URL must be set in production/);
  });

  it("returns APP_URL (trailing slash stripped) when set in production", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_URL = "https://eos-oug8.onrender.com/";
    expect(getAppBaseUrl()).toBe("https://eos-oug8.onrender.com");
  });

  it("still falls back to localhost outside production", () => {
    process.env.NODE_ENV = "test";
    delete process.env.APP_URL;
    delete process.env.REPLIT_DOMAINS;
    delete process.env.REPLIT_DEV_DOMAIN;
    expect(getAppBaseUrl()).toBe("http://localhost:3000");
  });
});

// ─── 5: forgot-password per-email cooldown ───────────────────────────────────

describe("forgot-password per-email cooldown", () => {
  const EMAIL = `reset-cooldown-test-${Date.now()}@example.invalid`;

  afterEach(async () => {
    await cleanupUser(EMAIL);
  });

  async function countResetTokens(userId: number): Promise<number> {
    const r = await pool.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM password_reset_tokens WHERE user_id = $1",
      [userId],
    );
    return Number(r.rows[0]!.n);
  }

  /** The route responds before its background work; poll until it lands. */
  async function waitForTokens(userId: number, atLeast: number): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if ((await countResetTokens(userId)) >= atLeast) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  it("does not mint a second token for a rapid repeat request", async () => {
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: EMAIL, password: "Password123" });
    expect(signup.status).toBe(201);
    const userId = signup.body.user.id as number;

    const first = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: EMAIL });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ ok: true });
    await waitForTokens(userId, 1);
    expect(await countResetTokens(userId)).toBe(1);

    // Second request inside the cooldown window: same generic response,
    // but no new token (and therefore no second pair of emails).
    const second = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: EMAIL });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true });

    // Give the background handler time to run before asserting it skipped.
    await new Promise((r) => setTimeout(r, 500));
    expect(await countResetTokens(userId)).toBe(1);
  });
});
