/**
 * "Continue with Google" — integration tests for routes/googleAuth.ts.
 *
 * The Google-facing gateway is swapped for a fake (same seam pattern as
 * push.ts) so the full route logic — CSRF state, account linking, session
 * regeneration, friendly-error redirects — runs end-to-end with zero Google
 * traffic. The REAL gateway's token verification is Google's own
 * verifyIdToken (signature/audience/issuer/expiry); here we prove the routes
 * refuse whenever that verification throws or reports an unverified email.
 *
 * Covers the required cases:
 *  - callback rejects forged/invalid tokens (and mismatched CSRF state);
 *  - existing verified email logs into the existing account, never a duplicate;
 *  - brand-new Google user is created with email already verified + name;
 *  - feature cleanly disabled when env vars are absent;
 *  - session id is REGENERATED on Google login (fixation defense);
 *  - consent denial redirects with the friendly "cancelled" code;
 *  - the redirect URI is built as APP_URL + /api/auth/google/callback.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import {
  _setGoogleAuthGatewayForTests,
  type GoogleAuthGateway,
  type GoogleIdentity,
} from "../services/googleAuth.js";

process.env.GOOGLE_CLIENT_ID ??= "test-client-id.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET ??= "test-client-secret";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

function nextEmail(tag: string): string {
  const e = `google-auth-${tag}-${Date.now()}-${emails.length}@example.invalid`;
  emails.push(e);
  return e;
}

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`
    BEGIN;
    DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM email_verification_tokens WHERE user_id = ${uid};
    DELETE FROM messages WHERE user_id = ${uid};
    DELETE FROM profile  WHERE user_id = ${uid};
    DELETE FROM users    WHERE id      = ${uid};
    COMMIT;
  `);
}

/** Fake gateway: records what the routes hand it; yields a fixed identity. */
function installGateway(
  identity: GoogleIdentity | Error,
): { seen: { redirectUri?: string; state?: string; code?: string } } {
  const seen: { redirectUri?: string; state?: string; code?: string } = {};
  const gw: GoogleAuthGateway = {
    generateAuthUrl(redirectUri, state) {
      seen.redirectUri = redirectUri;
      seen.state = state;
      return `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`;
    },
    async exchangeCode(code, redirectUri) {
      seen.code = code;
      seen.redirectUri = redirectUri;
      if (identity instanceof Error) throw identity;
      return identity;
    },
  };
  _setGoogleAuthGatewayForTests(gw);
  return { seen };
}

/** Runs the begin→callback dance on one agent; returns the callback response. */
async function completeGoogleLogin(agent: ReturnType<typeof request.agent>, seen: { state?: string }) {
  const begin = await agent.get("/api/auth/google");
  expect(begin.status).toBe(302);
  expect(begin.headers.location).toContain("accounts.google.com");
  expect(seen.state).toBeTruthy();
  return agent.get(`/api/auth/google/callback?code=fake-code&state=${seen.state}`);
}

const sidOf = (res: { headers: Record<string, unknown> }): string | null => {
  const cookies = ([] as string[]).concat((res.headers["set-cookie"] as string[]) ?? []);
  const sid = cookies.find((c) => c.startsWith("sid="));
  return sid ? sid.split(";")[0]! : null;
};

beforeEach(() => {
  _setGoogleAuthGatewayForTests(null);
});

afterAll(async () => {
  _setGoogleAuthGatewayForTests(null);
  await Promise.all(emails.splice(0).map(cleanupUser));
  await pool.end();
});

describe("availability + clean disable", () => {
  it("reports available with env configured, hidden without, and never crashes", async () => {
    const on = await request(app).get("/api/auth/google/available");
    expect(on.status).toBe(200);
    expect(on.body.available).toBe(true);

    const priorId = process.env.GOOGLE_CLIENT_ID;
    const priorSecret = process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    try {
      const off = await request(app).get("/api/auth/google/available");
      expect(off.body.available).toBe(false);

      // Hitting the flow anyway → friendly redirect, no crash, no 500.
      const begin = await request(app).get("/api/auth/google");
      expect(begin.status).toBe(302);
      expect(begin.headers.location).toBe("/?googleError=unavailable");
      const cb = await request(app).get("/api/auth/google/callback?code=x&state=y");
      expect(cb.status).toBe(302);
      expect(cb.headers.location).toBe("/?googleError=unavailable");
    } finally {
      process.env.GOOGLE_CLIENT_ID = priorId;
      process.env.GOOGLE_CLIENT_SECRET = priorSecret;
    }
  });
});

describe("the flow", () => {
  it("builds the redirect URI as APP_URL + /api/auth/google/callback", async () => {
    const { seen } = installGateway({ email: nextEmail("uri"), emailVerified: true, name: "Uri" });
    const agent = request.agent(app);
    await completeGoogleLogin(agent, seen);
    // Test env has no APP_URL/REPLIT_* → base is http://localhost:3000; what
    // matters is the exact PATH Google has registered.
    expect(seen.redirectUri).toMatch(/\/api\/auth\/google\/callback$/);
  });

  it("creates a brand-new user with email already verified and the Google name", async () => {
    const email = nextEmail("new");
    const { seen } = installGateway({ email, emailVerified: true, name: "Priya" });
    const agent = request.agent(app);

    const cb = await completeGoogleLogin(agent, seen);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe("/");

    // Logged in, and requireVerified passes IMMEDIATELY — no gate screen.
    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    expect(me.body.emailVerified).toBe(true);
    const profileRes = await agent.get("/api/profile");
    expect(profileRes.status).toBe(200); // 403 here would mean unverified
    expect(profileRes.body.userName).toBe("Priya");

    const row = await pool.query<{ email_verified_at: Date | null }>(
      "SELECT email_verified_at FROM users WHERE email = $1",
      [email],
    );
    expect(row.rows[0]!.email_verified_at).not.toBeNull();
  });

  it("logs an existing email into the existing account — never a duplicate", async () => {
    const email = nextEmail("existing");
    // Existing account created the normal way (password flow), verified.
    const signupAgent = request.agent(app);
    const signup = await signupAgent.post("/api/auth/signup").send({ email, password: "Test1234!" });
    expect(signup.status).toBe(201);
    const originalId: number = signup.body.user.id;
    await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [originalId]);

    const { seen } = installGateway({ email, emailVerified: true, name: "Existing" });
    const agent = request.agent(app);
    const cb = await completeGoogleLogin(agent, seen);
    expect(cb.headers.location).toBe("/");

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(originalId); // SAME account

    const count = await pool.query<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM users WHERE email = $1",
      [email],
    );
    expect(count.rows[0]!.n).toBe(1); // no duplicate row
  });

  it("regenerates the session id on Google login (fixation defense)", async () => {
    const email = nextEmail("regen");
    const { seen } = installGateway({ email, emailVerified: true, name: "Regen" });
    const agent = request.agent(app);

    const begin = await agent.get("/api/auth/google");
    const preLoginSid = sidOf(begin);
    expect(preLoginSid).toBeTruthy(); // anonymous session holding the state

    const cb = await agent.get(`/api/auth/google/callback?code=fake-code&state=${seen.state}`);
    const postLoginSid = sidOf(cb);
    expect(postLoginSid).toBeTruthy();
    expect(postLoginSid).not.toBe(preLoginSid); // fresh id after login

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
  });
});

describe("rejections — always a friendly redirect, never a raw error", () => {
  it("rejects a forged/invalid token (verification throws)", async () => {
    const email = nextEmail("forged");
    const { seen } = installGateway(new Error("invalid token signature"));
    const agent = request.agent(app);

    const cb = await completeGoogleLogin(agent, seen);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe("/?googleError=failed");
    // No session was minted and no user created.
    expect((await agent.get("/api/auth/me")).status).toBe(401);
    const count = await pool.query("SELECT 1 FROM users WHERE email = $1", [email]);
    expect(count.rowCount).toBe(0);
  });

  it("rejects a mismatched CSRF state", async () => {
    installGateway({ email: nextEmail("csrf"), emailVerified: true, name: "X" });
    const agent = request.agent(app);
    await agent.get("/api/auth/google"); // real state now in the session
    const cb = await agent.get("/api/auth/google/callback?code=fake&state=WRONG");
    expect(cb.headers.location).toBe("/?googleError=failed");
    expect((await agent.get("/api/auth/me")).status).toBe(401);
  });

  it("refuses an email Google itself has not verified", async () => {
    const email = nextEmail("unverified");
    const { seen } = installGateway({ email, emailVerified: false, name: "Nope" });
    const agent = request.agent(app);
    const cb = await completeGoogleLogin(agent, seen);
    expect(cb.headers.location).toBe("/?googleError=failed");
    const count = await pool.query("SELECT 1 FROM users WHERE email = $1", [email]);
    expect(count.rowCount).toBe(0);
  });

  it("treats consent denial as a calm cancellation", async () => {
    installGateway({ email: nextEmail("deny"), emailVerified: true, name: "X" });
    const agent = request.agent(app);
    await agent.get("/api/auth/google");
    const cb = await agent.get("/api/auth/google/callback?error=access_denied");
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe("/?googleError=cancelled");
  });
});
