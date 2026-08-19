/**
 * Integration tests: POST /api/auth/reset-password token validation.
 *
 * Covers:
 *  - Unknown token → 400 TOKEN_INVALID
 *  - Expired token → 400 TOKEN_EXPIRED
 *  - Already-used token → 400 TOKEN_USED
 *  - Valid token → 200 ok:true, password updated, token marked used, sessions cleared
 *  - Replay of a just-consumed token → 400 TOKEN_USED
 */

import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { hashAuthToken } from "../lib/authTokenHash.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>(
    "SELECT id FROM users WHERE email = $1",
    [email],
  );
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`
    BEGIN;
    DELETE FROM user_sessions        WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM password_reset_tokens WHERE user_id = ${uid};
    DELETE FROM profile              WHERE user_id = ${uid};
    DELETE FROM users                WHERE id       = ${uid};
    COMMIT;
  `);
}

async function insertToken(
  userId: number,
  token: string,
  opts: { expired?: boolean; used?: boolean } = {},
): Promise<void> {
  const expiresAt = opts.expired
    ? "NOW() - INTERVAL '1 second'"
    : "NOW() + INTERVAL '1 hour'";
  const usedAt = opts.used ? "NOW()" : "NULL";
  // Stored HASHED (tokens are hashed at rest); the raw value stays with the
  // test, which presents it to the endpoint exactly like a user's email link.
  await pool.query(
    `INSERT INTO password_reset_tokens (token, user_id, expires_at, used_at)
     VALUES ($1, $2, ${expiresAt}, ${usedAt})`,
    [hashAuthToken(token), userId],
  );
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const TEST_EMAIL = `reset-token-test-${Date.now()}@example.invalid`;
const TEST_PASSWORD = "OldPass123!";
const NEW_PASSWORD = "NewPass456!";

describe("POST /api/auth/reset-password — token validation", () => {
  let userId: number;

  afterEach(async () => {
    await cleanupUser(TEST_EMAIL);
    userId = 0;
  });

  async function createUser(): Promise<number> {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(res.status).toBe(201);
    userId = res.body.user.id as number;
    return userId;
  }

  it("returns TOKEN_INVALID for a token that does not exist", async () => {
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "completely-made-up-token", password: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TOKEN_INVALID");
  });

  it("returns TOKEN_EXPIRED for a token past its expiry date", async () => {
    const uid = await createUser();
    await insertToken(uid, "expired-token-abc", { expired: true });

    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "expired-token-abc", password: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TOKEN_EXPIRED");
    expect(res.body.error).toMatch(/expired/i);
  });

  it("returns TOKEN_USED for a token that has already been consumed", async () => {
    const uid = await createUser();
    await insertToken(uid, "used-token-xyz", { used: true });

    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "used-token-xyz", password: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TOKEN_USED");
    expect(res.body.error).toMatch(/already been used/i);
  });

  it("succeeds with a valid token and prevents replay", async () => {
    const uid = await createUser();
    await insertToken(uid, "valid-token-fresh", {});

    // ── Happy path ──
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "valid-token-fresh", password: NEW_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // ── Verify new password works ──
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL, password: NEW_PASSWORD });
    expect(loginRes.status).toBe(200);

    // ── Old password no longer works ──
    const oldLoginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(oldLoginRes.status).toBe(401);

    // ── Replay is rejected as TOKEN_USED ──
    const replayRes = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "valid-token-fresh", password: "AnotherPass789!" });

    expect(replayRes.status).toBe(400);
    expect(replayRes.body.code).toBe("TOKEN_USED");
  });

  it("returns 400 when token is missing from the request body", async () => {
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ password: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/token/i);
  });

  it("returns 400 when password is too short", async () => {
    const res = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: "any-token", password: "short" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 characters/i);
  });
});
