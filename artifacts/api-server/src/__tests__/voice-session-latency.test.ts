/**
 * Integration tests: the voice-call connect-latency changes in
 * routes/voice-agent.ts.
 *
 *  - POST /voice-agent/session returns the token/tone session fields — and
 *    NO `firstMessage`: the field was dead plumbing (the client stopped
 *    forwarding it when ElevenLabs began rejecting the first_message
 *    override with a 1008; greetings come from the custom LLM's
 *    synthetic-greeting path, pinned in voice-greeting-fastpath.test.ts).
 *  - POST /voice-agent/client-timing accepts the connect-timing beacon,
 *    answers 204, and logs a WARN pointing at the dashboard override flags
 *    when the "full" attempt failed but a lower level connected (each failed
 *    level is a full paid reconnection — that tax must never stay silent).
 *
 * Env: forces the public-agent path (agent id set, API key removed) so no
 * request ever leaves the process; both vars are restored afterwards.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { logger } from "../lib/logger.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const PRIOR_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const PRIOR_API_KEY = process.env.ELEVENLABS_API_KEY;

const emails: string[] = [];

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`
    BEGIN;
    DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM email_verification_tokens WHERE user_id = ${uid};
    DELETE FROM profile WHERE user_id = ${uid};
    DELETE FROM users   WHERE id      = ${uid};
    COMMIT;
  `);
}

async function signupUser(tag: string) {
  const email = `voice-latency-${tag}-${Date.now()}@example.invalid`;
  emails.push(email);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(res.status).toBe(201);
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [
    res.body.user.id,
  ]);
  return { agent, userId: res.body.user.id as number };
}

beforeAll(() => {
  process.env.ELEVENLABS_AGENT_ID = "agent_test_latency";
  delete process.env.ELEVENLABS_API_KEY; // public-agent path — no outbound fetch
});

afterAll(async () => {
  if (PRIOR_AGENT_ID === undefined) delete process.env.ELEVENLABS_AGENT_ID;
  else process.env.ELEVENLABS_AGENT_ID = PRIOR_AGENT_ID;
  if (PRIOR_API_KEY === undefined) delete process.env.ELEVENLABS_API_KEY;
  else process.env.ELEVENLABS_API_KEY = PRIOR_API_KEY;
  await Promise.all(emails.splice(0).map(cleanupUser));
  await pool.end();
});

describe("POST /voice-agent/session response shape", () => {
  it("returns the session fields — and no dead firstMessage plumbing", async () => {
    const { agent } = await signupUser("fm");

    const res = await agent.post("/api/voice-agent/session").send({});
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.mode).toBe("public");
    expect(typeof res.body.userToken).toBe("string");
    expect(typeof res.body.tone).toBe("string");
    // The greeting is the LLM fast path's job (voice-greeting-fastpath
    // .test.ts); nothing in this response should resurrect the dead field.
    expect(res.body).not.toHaveProperty("firstMessage");
  });
});

describe("POST /voice-agent/client-timing", () => {
  it("accepts a normal timing beacon with 204 and logs at info", async () => {
    const { agent } = await signupUser("timing");
    const infoSpy = vi.spyOn(logger, "info");
    const warnSpy = vi.spyOn(logger, "warn");

    const res = await agent.post("/api/voice-agent/client-timing").send({
      sessionSource: "prefetched",
      sessionFetchMs: 3,
      attempts: [{ level: "full", ok: true, ms: 850 }],
      connectedLevel: "full",
      connectMs: 900,
      firstAudioMs: 1400,
    });
    expect(res.status).toBe(204);

    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ connectedLevel: "full", sessionSource: "prefetched" }),
      "voice-connect timing",
    );
    const overrideWarns = warnSpy.mock.calls.filter(
      (c) => typeof c[1] === "string" && c[1].includes("override"),
    );
    expect(overrideWarns.length).toBe(0);
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("logs the disabled-overrides WARN when 'full' failed and a lower level connected", async () => {
    const { agent } = await signupUser("warn");
    const warnSpy = vi.spyOn(logger, "warn");

    const res = await agent.post("/api/voice-agent/client-timing").send({
      sessionSource: "fresh",
      sessionFetchMs: 120,
      attempts: [
        { level: "full", ok: false, ms: 700, message: "socket closed during initiation" },
        { level: "voice", ok: true, ms: 650 },
      ],
      connectedLevel: "voice",
      connectMs: 1500,
      firstAudioMs: 2100,
    });
    expect(res.status).toBe(204);

    const overrideWarn = warnSpy.mock.calls.find(
      (c) => typeof c[1] === "string" && (c[1] as string).includes("Security settings"),
    );
    expect(overrideWarn).toBeDefined();
    expect(overrideWarn![0]).toMatchObject({ connectedLevel: "voice" });
    warnSpy.mockRestore();
  });

  it("sanitizes junk payloads instead of failing", async () => {
    const { agent } = await signupUser("junk");
    const res = await agent.post("/api/voice-agent/client-timing").send({
      sessionSource: 42,
      sessionFetchMs: "soon",
      attempts: "nope",
      connectMs: -5,
    });
    expect(res.status).toBe(204);
  });
});
