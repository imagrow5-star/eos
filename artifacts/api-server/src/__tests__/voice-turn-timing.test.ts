/**
 * Voice instrumentation (voice audit, PR 1): one "voice turn timing" log line
 * per spoken turn from the CLM route, and a "voice turn timing (client)" line
 * per reply from the browser beacon.
 *
 * What must hold:
 *   • every voice turn (greeting and real) logs exactly one timing line whose
 *     fields are numbers/booleans on a fixed key set — never a word of what
 *     was said or replied, and never the raw user id;
 *   • the real-turn line carries the per-stage figures the audit needs
 *     (auth, profile, db, prompt, classifier wait, first token, model, total);
 *   • the beacon logs its numbers with the hashed id, rejects a body without
 *     a turn number, and drops anything that is not a sane number.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { logger } from "../lib/logger.js";
import { mintVoiceToken } from "../lib/voiceToken.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

async function makeUser(tag: string) {
  const email = `turn-timing-${tag}-${Date.now()}@example.invalid`;
  emails.push(email);
  const agent = request.agent(app);
  const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signup.status).toBe(201);
  const userId: number = signup.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  const prof = await agent.get("/api/profile");
  expect(prof.status).toBe(200);
  await pool.query("UPDATE profile SET user_name = $1 WHERE user_id = $2", ["Tamsin", userId]);
  return { userId, agent };
}

async function cleanup(email: string) {
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

// The hashed id (`uh`) is only emitted when LOG_HASH_SALT is set, as it is in
// production; pin one here so the tests can prove the raw id never appears.
const priorSalt = process.env.LOG_HASH_SALT;
beforeAll(() => {
  process.env.LOG_HASH_SALT = "turn-timing-test-salt";
});

afterAll(async () => {
  if (priorSalt === undefined) delete process.env.LOG_HASH_SALT;
  else process.env.LOG_HASH_SALT = priorSalt;
  for (const e of emails) await cleanup(e);
  await pool.end();
});

type LogCall = [Record<string, unknown>, string];

/** The "voice turn timing" lines (server-side) logged since the spy started. */
function timingLines(spy: ReturnType<typeof vi.spyOn>, msg: string): Record<string, unknown>[] {
  return (spy.mock.calls as unknown as LogCall[])
    .filter((c) => c[1] === msg && typeof c[0] === "object" && c[0] !== null)
    .map((c) => c[0]);
}

function voiceTurn(userId: number, messages: { role: "user" | "assistant"; content: string }[]) {
  return request(app)
    .post("/api/voice-llm/v1/chat/completions")
    .send({
      model: "gpt-4o",
      stream: false,
      messages,
      elevenlabs_extra_body: { user_token: mintVoiceToken(userId) },
    });
}

const NUMERIC_REAL_TURN_KEYS = [
  "heldMs", "authMs", "profileMs", "dbMs", "promptMs", "modelMs", "totalMs", "replyWords", "contextTurns",
] as const;

describe("server: one 'voice turn timing' line per spoken turn", () => {
  it("the greeting turn logs its stages, the hashed id, and no words", async () => {
    const { userId } = await makeUser("greet");
    const spy = vi.spyOn(logger, "info");
    try {
      const res = await voiceTurn(userId, []);
      expect(res.status).toBe(200);
      const reply: string = res.body.choices[0].message.content;

      const lines = timingLines(spy, "voice turn timing").filter((l) => l.greeting === true);
      expect(lines).toHaveLength(1);
      const line = lines[0]!;
      expect(Object.keys(line).sort()).toEqual(
        ["authMs", "curated", "degraded", "greeting", "primedProfile", "profileMs", "reconnect", "replyWords", "totalMs", "uh"].sort(),
      );
      for (const k of ["authMs", "profileMs", "totalMs", "replyWords"]) {
        expect(typeof line[k], k).toBe("number");
        expect(line[k] as number).toBeGreaterThanOrEqual(0);
      }
      expect(line.curated).toBe(true); // English ⇒ curated pool, no model
      expect(line.replyWords).toBe(reply.split(/\s+/).filter(Boolean).length);

      // Privacy: hashed id only, and none of the spoken words.
      const serialized = JSON.stringify(line);
      expect(typeof line.uh).toBe("string");
      expect(line.uh).not.toBe(String(userId));
      expect(serialized).not.toContain(reply);
      expect(serialized).not.toContain("Tamsin");
    } finally {
      spy.mockRestore();
    }
  });

  it("a real turn logs every stage as a number and leaks neither side of the exchange", async () => {
    const { userId } = await makeUser("real");
    const spy = vi.spyOn(logger, "info");
    try {
      const userText = "my quokka ate the violet spreadsheet again tonight";
      const res = await voiceTurn(userId, [{ role: "user", content: userText }]);
      expect(res.status).toBe(200);
      const reply: string = res.body.choices[0].message.content;
      expect(reply.length).toBeGreaterThan(0);

      const lines = timingLines(spy, "voice turn timing").filter((l) => l.greeting === false);
      expect(lines).toHaveLength(1);
      const line = lines[0]!;
      expect(Object.keys(line).sort()).toEqual(
        [
          "uh", "greeting", "frozenHit", "held", "heldMs", "authMs", "profileMs", "dbMs", "promptMs",
          "classifierMs", "classifierRan", "firstTokenMs", "firstSentenceMs", "modelMs", "totalMs", "replyWords", "contextTurns",
          "resumed", "crisis", "crisisArmed", "aborted", "abortedAtMs", "degraded", "tone",
        ].sort(),
      );
      for (const k of NUMERIC_REAL_TURN_KEYS) {
        expect(typeof line[k], k).toBe("number");
        expect(line[k] as number).toBeGreaterThanOrEqual(0);
      }
      // Stages nest: the model can't take longer than the whole turn.
      expect(line.modelMs as number).toBeLessThanOrEqual(line.totalMs as number);
      // firstTokenMs and classifierMs are a number or null (never a string).
      for (const k of ["firstTokenMs", "firstSentenceMs", "classifierMs"]) {
        expect(line[k] === null || typeof line[k] === "number", k).toBe(true);
      }
      for (const k of ["frozenHit", "held", "classifierRan", "resumed", "crisis", "crisisArmed", "aborted", "degraded", "tone"]) {
        expect(typeof line[k], k).toBe("boolean");
      }
      // A plain sentence is not a crisis and the classifier did run for it.
      expect(line.crisis).toBe(false);
      expect(line.classifierRan).toBe(true);
      expect(line.contextTurns).toBe(0); // prior turns only — the current message is not context
      expect(line.replyWords).toBe(reply.split(/\s+/).filter(Boolean).length);

      const serialized = JSON.stringify(line);
      expect(serialized).not.toContain("quokka");
      expect(serialized).not.toContain("spreadsheet");
      expect(serialized).not.toContain(reply);
      expect(serialized).not.toContain(`"uh":"${userId}"`);
      expect(serialized).not.toContain("Tamsin");
    } finally {
      spy.mockRestore();
    }
  });

  it("a second turn in the same call reports the frozen prompt as a hit", async () => {
    const { userId } = await makeUser("frozen");
    const first = await voiceTurn(userId, [{ role: "user", content: "just checking in" }]);
    expect(first.status).toBe(200);
    // Note: mintVoiceToken() in voiceTurn issues a fresh token per request, so
    // the frozen prompt is keyed per second — same second ⇒ same call.
    const spy = vi.spyOn(logger, "info");
    try {
      const second = await voiceTurn(userId, [
        { role: "user", content: "just checking in" },
        { role: "assistant", content: first.body.choices[0].message.content },
        { role: "user", content: "and again" },
      ]);
      expect(second.status).toBe(200);
      const lines = timingLines(spy, "voice turn timing").filter((l) => l.greeting === false);
      expect(lines).toHaveLength(1);
      expect(typeof lines[0]!.frozenHit).toBe("boolean");
      expect(lines[0]!.contextTurns).toBe(2); // the two prior turns
    } finally {
      spy.mockRestore();
    }
  });
});

describe("client beacon: POST /api/voice-agent/turn-timing", () => {
  it("logs the numbers with the hashed id and answers 200", async () => {
    const { userId, agent } = await makeUser("beacon");
    const spy = vi.spyOn(logger, "info");
    try {
      const res = await agent.post("/api/voice-agent/turn-timing").send({
        turn: 3,
        greeting: false,
        finalToFirstAudioMs: 1432.6,
        textToFirstAudioMs: 310,
        userEndToFinalMs: 640,
        lastInterimToFirstAudioMs: 2210,
        transcript: "should never be logged", // not a field — dropped
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      const lines = timingLines(spy, "voice turn timing (client)");
      expect(lines).toHaveLength(1);
      const line = lines[0]!;
      expect(line).toEqual({
        uh: expect.any(String),
        turn: 3,
        greeting: false,
        finalToFirstAudioMs: 1433,
        textToFirstAudioMs: 310,
        userEndToFinalMs: 640,
        lastInterimToFirstAudioMs: 2210,
      });
      expect(line.uh).not.toBe(String(userId));
      expect(JSON.stringify(line)).not.toContain("never be logged");
    } finally {
      spy.mockRestore();
    }
  });

  it("the greeting reply has null user-side figures; junk values become null", async () => {
    const { agent } = await makeUser("beacon-nulls");
    const spy = vi.spyOn(logger, "info");
    try {
      const res = await agent.post("/api/voice-agent/turn-timing").send({
        turn: 1,
        greeting: true,
        finalToFirstAudioMs: null,
        textToFirstAudioMs: "fast", // wrong type
        userEndToFinalMs: 999_999_999, // beyond the 120 s sanity cap
      });
      expect(res.status).toBe(200);
      const [line] = timingLines(spy, "voice turn timing (client)");
      expect(line).toMatchObject({
        turn: 1,
        greeting: true,
        finalToFirstAudioMs: null,
        textToFirstAudioMs: null,
        userEndToFinalMs: null,
        lastInterimToFirstAudioMs: null,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("a body without a turn number is a 400 and logs nothing", async () => {
    const { agent } = await makeUser("beacon-400");
    const spy = vi.spyOn(logger, "info");
    try {
      const res = await agent.post("/api/voice-agent/turn-timing").send({ finalToFirstAudioMs: 500 });
      expect(res.status).toBe(400);
      expect(timingLines(spy, "voice turn timing (client)")).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
});
