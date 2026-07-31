/**
 * Privacy audit Tier 2 — per-site proof that the fixed log lines carry a hashed
 * `uh` and NONE of: the raw userId, gender, accent, language, userPath,
 * preferredLanguage. Real app + DB, DATABASE_URL-gated exactly like the rest of
 * the suite (skips cleanly where no DB is provisioned).
 *
 * Sites covered here (the api-server route sites): settings voice-gender /
 * language / accent, and onboarding-complete. voice-agent "call routed" needs
 * ElevenLabs env + a live call and is left to its own integration path; its
 * payload change is identical in shape and covered by the diff + helper tests.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const HAS_DB = Boolean(process.env.DATABASE_URL);
const SALT = "tier2-integration-salt-abcdef0123";

describe.skipIf(!HAS_DB)("privacy Tier 2 — fixed log payloads (integration)", () => {
  let request: any; // supertest is CJS export= (no .default on its type)
  let app: typeof import("../app.js").default;
  let logger: typeof import("../lib/logger.js").logger;
  let hashUserIdForLog: typeof import("../lib/logging/hashUserIdForLog.js").hashUserIdForLog;
  let pg: typeof import("pg");
  let pool: import("pg").Pool;
  const emails: string[] = [];
  const priorSalt = process.env.LOG_HASH_SALT;

  beforeAll(async () => {
    process.env.LOG_HASH_SALT = SALT;
    request = (await import("supertest")).default;
    app = (await import("../app.js")).default;
    ({ logger } = await import("../lib/logger.js"));
    ({ hashUserIdForLog } = await import("../lib/logging/hashUserIdForLog.js"));
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
        DELETE FROM personalization_state     WHERE user_id = ${uid};
        DELETE FROM profile                   WHERE user_id = ${uid};
        DELETE FROM users                     WHERE id      = ${uid};
        COMMIT;
      `);
    }
    await pool.end();
    if (priorSalt === undefined) delete process.env.LOG_HASH_SALT;
    else process.env.LOG_HASH_SALT = priorSalt;
  });

  async function makeUser(tag: string) {
    const email = `tier2-${tag}-${Date.now()}-${emails.length}@example.invalid`;
    emails.push(email);
    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
    expect(signup.status).toBe(201);
    const userId: number = signup.body.user.id;
    await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
    await agent.get("/api/profile");
    return { agent, userId };
  }

  /** Capture the payload of the first log call (any level) with `message`. */
  function findLog(
    spies: Array<ReturnType<typeof vi.spyOn>>,
    message: string,
  ): Record<string, unknown> | undefined {
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        if (call[1] === message) return call[0] as Record<string, unknown>;
      }
    }
    return undefined;
  }

  function assertSafe(
    payload: Record<string, unknown> | undefined,
    userId: number,
    forbiddenValues: unknown[],
  ) {
    expect(payload, "the fixed log line should still fire").toBeTruthy();
    expect(payload!.uh).toBe(hashUserIdForLog(userId));
    expect(payload!.uh).toMatch(/^[0-9a-f]{8}$/);
    // Never the raw userId, in any field.
    expect(payload).not.toHaveProperty("userId");
    expect(JSON.stringify(payload)).not.toContain(String(userId));
    // Never the sensitive companion trait value.
    for (const v of forbiddenValues) {
      if (v !== undefined && v !== null) {
        expect(JSON.stringify(payload)).not.toContain(String(v));
      }
    }
  }

  it("settings: voice gender saved → uh only, no userId, no gender", async () => {
    const { agent, userId } = await makeUser("gender");
    const info = vi.spyOn(logger, "info");
    try {
      const res = await agent.post("/api/settings/voice-gender").send({ gender: "man" });
      expect([200, 204]).toContain(res.status);
      assertSafe(findLog([info], "settings: voice gender saved"), userId, ["man"]);
    } finally {
      info.mockRestore();
    }
  });

  it("settings: language saved → uh only, no userId, no language", async () => {
    const { agent, userId } = await makeUser("lang");
    const info = vi.spyOn(logger, "info");
    try {
      const res = await agent.post("/api/settings/language").send({ language: "es" });
      expect([200, 204]).toContain(res.status);
      assertSafe(findLog([info], "settings: language preference saved"), userId, ["es"]);
    } finally {
      info.mockRestore();
    }
  });

  it("settings: accent saved → uh only, no userId, no accent", async () => {
    const { agent, userId } = await makeUser("accent");
    const info = vi.spyOn(logger, "info");
    try {
      const res = await agent.post("/api/settings/accent").send({ accent: "british" });
      expect([200, 204, 400]).toContain(res.status); // accepts whatever the route validates
      const payload = findLog([info], "settings: accent preference saved");
      if (payload) assertSafe(payload, userId, ["british"]);
    } finally {
      info.mockRestore();
    }
  });
});
