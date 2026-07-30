/**
 * Integration tests: per-user usage ceilings on the paid-API endpoints
 * (middleware/usageLimits.ts).
 *
 * Same dynamic-import pattern as rate-limit.test.ts: the limits are read from
 * the environment at app-import time, so this file sets SMALL values and then
 * imports the app dynamically. Other test files get the high defaults from
 * setup/rate-limit-env.ts and can never trip these.
 *
 * Cost note: the limiters run BEFORE body validation, so every probe here
 * sends an INVALID body ({}). Budget is consumed (that's the point — a broken
 * client hammering with garbage must still be throttled) but no Anthropic or
 * ElevenLabs call is ever made and no message rows are written.
 *
 * Covers:
 *  - chat: hourly ceiling trips first, daily ceiling after it, both with the
 *    friendly JSON body ({ error, code: "RATE_LIMITED" });
 *  - keys are PER USER: a second user on the same IP is unaffected;
 *  - tts and voice-agent/session trip their own ceilings;
 *  - voice-llm (no session — ElevenLabs calls it) trips with an
 *    OpenAI-shaped error body, keyed per caller.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import pg from "pg";

process.env.CHAT_LIMIT_PER_HOUR = "2";
process.env.CHAT_LIMIT_PER_DAY = "3";
process.env.TTS_LIMIT_PER_HOUR = "2";
process.env.TTS_LIMIT_PER_DAY = "100000";
process.env.VOICE_SESSION_LIMIT_PER_HOUR = "2";
process.env.VOICE_SESSION_LIMIT_PER_DAY = "100000";
process.env.VOICE_TURN_LIMIT_PER_HOUR = "2";
process.env.VOICE_TURN_LIMIT_PER_DAY = "100000";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

let app: Express;
const emails: string[] = [];
let seq = 0;

function nextEmail(tag: string): string {
  const email = `usage-limit-${tag}-${Date.now()}-${seq++}@example.invalid`;
  emails.push(email);
  return email;
}

async function signupUser(tag: string) {
  const email = nextEmail(tag);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(res.status).toBe(201);
  const userId: number = res.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  return { agent, userId };
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
    DELETE FROM voice_usage WHERE user_id = ${uid};
    DELETE FROM profile  WHERE user_id = ${uid};
    DELETE FROM users    WHERE id      = ${uid};
    COMMIT;
  `);
}

beforeAll(async () => {
  app = (await import("../app.js")).default;
});

afterAll(async () => {
  await Promise.all(emails.splice(0).map(cleanupUser));
  await pool.end();
});

describe("per-user usage limits on paid endpoints", () => {
  it("throttles chat sends hourly, then daily, with friendly JSON errors", async () => {
    const { agent } = await signupUser("chat");

    // Two invalid-body probes consume the hourly budget (400 = past the
    // limiter, rejected by validation — no AI call, no writes).
    for (let i = 0; i < 2; i++) {
      const res = await agent.post("/api/chat/send").send({});
      expect(res.status).toBe(400);
    }

    // 3rd request: within the daily budget (3) but over the hourly (2).
    const hourly = await agent.post("/api/chat/send").send({});
    expect(hourly.status).toBe(429);
    expect(hourly.headers["content-type"]).toMatch(/application\/json/);
    expect(hourly.body.code).toBe("RATE_LIMITED");
    expect(hourly.body.error).toMatch(/lot of messages/i);

    // 4th request: now over the daily budget too — daily message wins
    // (the day limiter runs first).
    const daily = await agent.post("/api/chat/send").send({});
    expect(daily.status).toBe(429);
    expect(daily.body.code).toBe("RATE_LIMITED");
    expect(daily.body.error).toMatch(/today's message limit/i);
  });

  it("keys chat limits by user, not IP — a second user is unaffected", async () => {
    const alice = await signupUser("burner");
    const bob = await signupUser("bystander");

    // Alice burns through her budget (same IP for everyone under supertest).
    for (let i = 0; i < 5; i++) await alice.agent.post("/api/chat/send").send({});
    const aliceLimited = await alice.agent.post("/api/chat/send").send({});
    expect(aliceLimited.status).toBe(429);

    // Bob still gets normal validation errors, never a 429.
    const bobRes = await bob.agent.post("/api/chat/send").send({});
    expect(bobRes.status).toBe(400);
  });

  it("also guards /chat/stream with the same shared chat budget", async () => {
    const { agent } = await signupUser("stream");
    for (let i = 0; i < 2; i++) {
      const res = await agent.post("/api/chat/stream").send({});
      expect(res.status).toBe(400);
    }
    const limited = await agent.post("/api/chat/stream").send({});
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
  });

  it("throttles /tts per user", async () => {
    const { agent } = await signupUser("tts");
    for (let i = 0; i < 2; i++) {
      const res = await agent.post("/api/tts").send({ text: "" });
      expect(res.status).toBe(400); // empty text — rejected before ElevenLabs
    }
    const limited = await agent.post("/api/tts").send({ text: "" });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
    expect(limited.body.error).toMatch(/voice playback/i);
  });

  it("throttles /voice-agent/session per user", async () => {
    const { agent } = await signupUser("vsession");
    for (let i = 0; i < 2; i++) {
      const res = await agent.post("/api/voice-agent/session").send({});
      expect(res.status).toBe(200); // available:false or session info — either is fine
    }
    const limited = await agent.post("/api/voice-agent/session").send({});
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("RATE_LIMITED");
    expect(limited.body.error).toMatch(/voice calls/i);
  });

  it("throttles the voice-llm callback with an OpenAI-shaped error", async () => {
    // No valid token → the handler 401s, and the limiter keys by IP. The
    // shape matters here: ElevenLabs parses OpenAI-style error bodies.
    const probe = () =>
      request(app)
        .post("/api/voice-llm/v1/chat/completions")
        .send({ messages: [], stream: false });

    for (let i = 0; i < 2; i++) {
      const res = await probe();
      expect(res.status).toBe(401);
    }
    const limited = await probe();
    expect(limited.status).toBe(429);
    expect(limited.body.error?.type).toBe("rate_limit_error");
    expect(typeof limited.body.error?.message).toBe("string");
  });
});
