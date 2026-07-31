/**
 * Privacy audit Tier 3 — runtime regression across representative cluster
 * paths. Spies every logger level and asserts that NO log payload emitted while
 * exercising real routes carries a `userId` key (a `uh` hash is fine).
 *
 * DATABASE_URL-gated like the rest of the suite; skips where no DB is present.
 * The static guardrail (logs-privacy-tier3-guardrail.test.ts) covers the whole
 * tree without a DB — this is the belt-and-suspenders runtime check.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const HAS_DB = Boolean(process.env.DATABASE_URL);

describe.skipIf(!HAS_DB)("Tier 3 — representative paths emit no raw userId", () => {
  let request: any; // supertest CJS export=
  let app: typeof import("../app.js").default;
  let logger: typeof import("../lib/logger.js").logger;
  let pg: typeof import("pg");
  let pool: import("pg").Pool;
  const emails: string[] = [];
  const priorSalt = process.env.LOG_HASH_SALT;

  beforeAll(async () => {
    process.env.LOG_HASH_SALT = "tier3-paths-salt-abcdef0123456789";
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
        DELETE FROM user_sessions             WHERE sess::jsonb->>'userId' = '${uid}';
        DELETE FROM email_verification_tokens WHERE user_id = ${uid};
        DELETE FROM messages                  WHERE user_id = ${uid};
        DELETE FROM profile                   WHERE user_id = ${uid};
        DELETE FROM users                     WHERE id      = ${uid};
        COMMIT;
      `);
    }
    await pool.end();
    if (priorSalt === undefined) delete process.env.LOG_HASH_SALT;
    else process.env.LOG_HASH_SALT = priorSalt;
  });

  /** Every payload logged (any level) while `fn` runs. */
  async function payloadsDuring(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
    const spies = (["info", "warn", "error", "debug"] as const).map((l) => vi.spyOn(logger, l));
    try {
      await fn();
      const out: Record<string, unknown>[] = [];
      for (const s of spies) {
        for (const call of s.mock.calls) {
          if (call[0] && typeof call[0] === "object") out.push(call[0] as Record<string, unknown>);
        }
      }
      return out;
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  }

  it("auth signup + settings paths log `uh`, never `userId`", async () => {
    const email = `tier3-path-${Date.now()}@example.invalid`;
    emails.push(email);
    const agent = request.agent(app);

    const payloads = await payloadsDuring(async () => {
      const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
      expect(signup.status).toBe(201);
      const userId: number = signup.body.user.id;
      await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
      await agent.get("/api/profile");
      await agent.post("/api/settings/voice-gender").send({ gender: "man" });
    });

    // At least one path logged something structured.
    expect(payloads.length).toBeGreaterThan(0);
    // No payload carries a raw userId; at least one carries a uh.
    for (const p of payloads) {
      expect(p).not.toHaveProperty("userId");
    }
    expect(payloads.some((p) => typeof p.uh === "string" && /^[0-9a-f]{8}$/.test(p.uh as string))).toBe(true);
  });
});
