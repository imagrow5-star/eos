/**
 * Contextual greeting — the proactive "morning note" that fires when the app
 * opens after onboarding.
 *
 * Regression guard for the fresh-signup bug: a brand-new account received a
 * note inventing a shared past ("…how the work stuff settled down… good to
 * hear from you again"). Root cause was a null lastGreetingAt being read as a
 * ~41-day absence (hoursSinceLast defaults to 999), routing a first-ever
 * greeting into the "welcome back" slot whose prompt asks for specifics — so
 * the model fabricated them. This path had NO tests, which is why it shipped.
 *
 * Two INDEPENDENT guards must hold (routes/chat.ts):
 *   1. no prior USER message  → no proactive note at all;
 *   2. never greeted (null lastGreetingAt) → never the "absent / welcome back"
 *      slot, even if guard 1 were removed.
 *
 * The keyless test env returns generateContextualGreeting's per-slot FALLBACK
 * lines (no network), so slot selection is observable from the content.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

async function makeUser(tag: string) {
  const email = `ctxgreet-${tag}-${Date.now()}-${emails.length}@example.invalid`;
  emails.push(email);
  const agent = request.agent(app);
  const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signup.status).toBe(201);
  const userId: number = signup.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  return { agent, userId };
}

// content is an encrypted column, but the greeting route only checks for the
// EXISTENCE of a role="user" row (it never decrypts), so a plaintext seed is
// fine for exercising the history gate.
async function seedUserMessage(userId: number, content = "hey"): Promise<void> {
  await pool.query(
    "INSERT INTO messages (user_id, role, content) VALUES ($1, 'user', $2)",
    [userId, content],
  );
}

async function cleanup(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (!r.rowCount) return;
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

afterAll(async () => {
  for (const e of emails) await cleanup(e);
  await pool.end();
});

describe("contextual greeting: no invented history on a fresh account", () => {
  // GUARD 1 — the exact screenshot bug. A brand-new account with no
  // conversation must receive NO proactive note. Deterministic at any time of
  // day: the route returns before any slot logic or model call.
  it("a brand-new account with no prior user message gets no note", async () => {
    const { agent } = await makeUser("fresh");
    const res = await agent.post("/api/chat/contextual-greeting").send({});
    expect(res.status).toBe(200);
    expect(res.body.message).toBeNull();
  });

  // GUARD 2 — independent of guard 1. With history (so guard 1 passes) but a
  // null lastGreetingAt, a never-greeted account must NEVER get the "absent /
  // welcome back" greeting. The absent fallback is the only line implying a
  // shared past; pre-fix it fired here at any hour, post-fix it can't:
  //   - a real slot (morning/evening/night) → that slot's fallback (not absent);
  //   - afternoon, no absence → suppressed (null message).
  it("a never-greeted account (with history) never gets the absent / welcome-back note", async () => {
    const { agent, userId } = await makeUser("nevergreeted");
    await seedUserMessage(userId);
    const res = await agent.post("/api/chat/contextual-greeting").send({});
    expect(res.status).toBe(200);
    const content: string | undefined = res.body.message?.content;
    if (content) {
      // The "absent" fallback signature — must never appear for a first greeting.
      expect(content).not.toMatch(/thinking about you\. glad you're here/i);
    }
  });
});
