/**
 * Crisis classifier off the critical path on voice calls (voice audit, PR 4)
 * — routes/voice-llm.ts. Text chat is unchanged (crisis-ambiguous-card.test.ts
 * still proves the same-turn card there).
 *
 * What must hold on a Hume/ElevenLabs call:
 *   • the reply no longer waits for the semantic classifier: a slow "yes"
 *     resolves after the turn has already been answered (classifierMs null in
 *     the timing line, no reinforcement on that turn);
 *   • the late yes still records the event, so the status poll shows the card
 *     with the ambiguous first line, within seconds;
 *   • the late yes ARMS the next turn: it carries the reinforcement block
 *     (crisis: true, crisisArmed: true), and the flag is consumed after it;
 *   • a regex hit is untouched: same-turn reinforcement, the classifier
 *     doesn't run, the card opens with the clear first line.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { logger } from "../lib/logger.js";
import { mintVoiceToken } from "../lib/voiceToken.js";
import { clearCallCrisisFlags } from "../services/crisis/callFlag.js";

// The classifier says YES, slowly, and only to the first message it sees.
const CLASSIFIER_DELAY_MS = 3000; // well past a cold first turn (frozen prompt build) on this machine
const answers: boolean[] = [];
vi.mock("../services/crisis/semanticDetector.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/crisis/semanticDetector.js")>();
  return {
    ...real,
    detectCrisisSemantic: vi.fn(async () => {
      const matched = answers.shift() ?? false;
      await new Promise((r) => setTimeout(r, CLASSIFIER_DELAY_MS));
      return { matched, available: true };
    }),
  };
});

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

async function makeUser(tag: string) {
  const email = `offpath-${tag}-${Date.now()}@example.invalid`;
  emails.push(email);
  const agent = request.agent(app);
  const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signup.status).toBe(201);
  const userId: number = signup.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  const prof = await agent.get("/api/profile");
  expect(prof.status).toBe(200);
  await pool.query("UPDATE profile SET user_name = $1, country = $2 WHERE user_id = $3", ["Priya", "GB", userId]);
  return { userId, agent };
}

async function cleanup(email: string) {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`
    BEGIN;
    DELETE FROM crisis_events             WHERE user_id = ${uid};
    DELETE FROM user_sessions             WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM email_verification_tokens WHERE user_id = ${uid};
    DELETE FROM messages                  WHERE user_id = ${uid};
    DELETE FROM profile                   WHERE user_id = ${uid};
    DELETE FROM users                     WHERE id      = ${uid};
    COMMIT;
  `);
}

const priorSalt = process.env.LOG_HASH_SALT;
beforeAll(() => {
  process.env.LOG_HASH_SALT = "offpath-test-salt";
  clearCallCrisisFlags();
});
afterAll(async () => {
  if (priorSalt === undefined) delete process.env.LOG_HASH_SALT;
  else process.env.LOG_HASH_SALT = priorSalt;
  for (const e of emails) await cleanup(e);
  await pool.end();
});

type Turn = { role: "user" | "assistant"; content: string };
type LogCall = [Record<string, unknown>, string];

/** One voice turn; returns the response and its "voice turn timing" line. */
async function timedTurn(token: string, messages: Turn[]) {
  const spy = vi.spyOn(logger, "info");
  try {
    const res = await request(app)
      .post("/api/voice-llm/v1/chat/completions")
      .send({ model: "gpt-4o", stream: false, messages, elevenlabs_extra_body: { user_token: token } });
    const lines = (spy.mock.calls as unknown as LogCall[])
      .filter((c) => c[1] === "voice turn timing" && c[0]?.greeting === false)
      .map((c) => c[0]);
    expect(lines).toHaveLength(1);
    return { res, timing: lines[0]! };
  } finally {
    spy.mockRestore();
  }
}

async function waitForCard(agent: ReturnType<typeof request.agent>): Promise<{ id: number; blockText: string }> {
  for (let i = 0; i < 60; i++) {
    const r = await agent.get("/api/voice-agent/crisis-status");
    expect(r.status).toBe(200);
    if (r.body.active && r.body.event) return r.body.event;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("crisis card never became active");
}

describe("semantic classifier off the critical path (voice)", () => {
  it("answers before the classifier does, shows the card late, and arms the next turn once", async () => {
    const { userId, agent } = await makeUser("late");
    const token = mintVoiceToken(userId);
    answers.push(true); // first classified message: a slow YES

    // No regex hit here: only the classifier could catch it.
    const t0 = performance.now();
    const t1 = await timedTurn(token, [{ role: "user", content: "honestly I don't see the point of any of it any more" }]);
    const elapsed = performance.now() - t0;
    expect(t1.res.status).toBe(200);
    expect(t1.res.body.choices[0].message.content.length).toBeGreaterThan(0);
    // The turn did not wait the classifier out.
    expect(elapsed).toBeLessThan(CLASSIFIER_DELAY_MS);
    expect(t1.timing).toMatchObject({ classifierRan: true, classifierMs: null, crisis: false, crisisArmed: false });

    // Nothing recorded yet …
    const before = await agent.get("/api/voice-agent/crisis-status");
    expect(before.body.active).toBe(false);
    // … then the late yes lands: card through the poll, ambiguous first line.
    const card = await waitForCard(agent);
    expect(card.blockText).toMatch(/^—\nWhichever it is — these are here if you ever want them:\n- /);

    // Next turn carries the reinforcement (armed), even though this turn's
    // own classifier answer is NO.
    const t2 = await timedTurn(token, [
      { role: "user", content: "honestly I don't see the point of any of it any more" },
      { role: "assistant", content: t1.res.body.choices[0].message.content },
      { role: "user", content: "I don't know, maybe I'm just tired" },
    ]);
    expect(t2.res.status).toBe(200);
    expect(t2.timing).toMatchObject({ crisis: true, crisisArmed: true, classifierRan: true });

    // The flag was consumed: the turn after is a plain turn again.
    await new Promise((r) => setTimeout(r, CLASSIFIER_DELAY_MS + 100)); // let turn 2's NO resolve
    const t3 = await timedTurn(token, [
      { role: "user", content: "honestly I don't see the point of any of it any more" },
      { role: "assistant", content: t1.res.body.choices[0].message.content },
      { role: "user", content: "I don't know, maybe I'm just tired" },
      { role: "assistant", content: t2.res.body.choices[0].message.content },
      { role: "user", content: "anyway, what were you saying about the weekend" },
    ]);
    expect(t3.timing).toMatchObject({ crisis: false, crisisArmed: false });

    // Exactly one event for the whole exchange.
    const events = await pool.query("SELECT count(*)::int AS n FROM crisis_events WHERE user_id = $1", [userId]);
    expect(events.rows[0].n).toBe(1);
  });

  it("a regex hit keeps same-turn reinforcement, skips the classifier, and opens the clear card", async () => {
    const { userId, agent } = await makeUser("regex");
    const token = mintVoiceToken(userId);
    const t = await timedTurn(token, [{ role: "user", content: "I want to kill myself" }]);
    expect(t.res.status).toBe(200);
    expect(t.timing).toMatchObject({ crisis: true, crisisArmed: false, classifierRan: false, classifierMs: null });
    const card = await waitForCard(agent);
    expect(card.blockText).toMatch(/^—\nSomeone who can be with you right now/);
  });
});
