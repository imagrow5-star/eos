/**
 * Connection-path speedups (voice call setup):
 *
 *   1. The greeting turn runs DATABASE-FREE: the session mint primes the
 *      call's profile, and the synthetic turn uses it (proven by priming a
 *      name that differs from the DB row — the greeting speaks the primed
 *      one). Real turns still re-read the DB every turn.
 *   2. The session endpoint starts the ElevenLabs signed-URL fetch IN
 *      PARALLEL with the profile read once the user's language is known
 *      (speculative fetch), and discards it correctly when the language
 *      changed since the last call.
 *
 * ElevenLabs is a local stub here (ELEVENLABS_API_BASE) that records which
 * agent ids were asked for and when.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { mintVoiceToken } from "../lib/voiceToken.js";
import { primeCallProfile } from "../routes/voice-llm.js";
import { GREETING_POOLS } from "../services/voiceGreeting.js";
import type { Profile } from "@workspace/db";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

const savedEnv = {
  base: process.env.ELEVENLABS_API_BASE,
  key: process.env.ELEVENLABS_API_KEY,
  agent: process.env.ELEVENLABS_AGENT_ID,
  agentMulti: process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL,
  voice: process.env.VOICE_CALL_ENABLED,
};

// ─── ElevenLabs stub: records (agentId, arrivalMs) per signed-url request ────
let stub: http.Server;
let stubPort = 0;
const stubHits: Array<{ agentId: string; at: number }> = [];

beforeAll(async () => {
  stub = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    stubHits.push({ agentId: url.searchParams.get("agent_id") ?? "?", at: Date.now() });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ signed_url: `wss://stub.invalid/${url.searchParams.get("agent_id")}` }));
  });
  await new Promise<void>((resolve) => stub.listen(0, resolve));
  stubPort = (stub.address() as { port: number }).port;
  process.env.ELEVENLABS_API_BASE = `http://localhost:${stubPort}`;
  process.env.ELEVENLABS_API_KEY = "stub-key";
  process.env.ELEVENLABS_AGENT_ID = "agent_en_stub";
  process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL = "agent_multi_stub";
  process.env.VOICE_CALL_ENABLED = "true";
});

afterAll(async () => {
  for (const [k, v] of Object.entries({
    ELEVENLABS_API_BASE: savedEnv.base,
    ELEVENLABS_API_KEY: savedEnv.key,
    ELEVENLABS_AGENT_ID: savedEnv.agent,
    ELEVENLABS_AGENT_ID_MULTILINGUAL: savedEnv.agentMulti,
    VOICE_CALL_ENABLED: savedEnv.voice,
  })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  for (const email of emails) {
    const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
    if (r.rowCount) {
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
  }
  await pool.end();
});

async function makeUser(tag: string) {
  const email = `connfast-${tag}-${Date.now()}@example.invalid`;
  emails.push(email);
  const agent = request.agent(app);
  const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signup.status).toBe(201);
  const userId: number = signup.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  const prof = await agent.get("/api/profile");
  expect(prof.status).toBe(200);
  return { agent, userId };
}

describe("greeting turn is database-free (primed profile)", () => {
  it("speaks the PRIMED profile's name, not the DB row's", async () => {
    const { userId } = await makeUser("primed");
    await pool.query("UPDATE profile SET user_name = 'Dbname' WHERE user_id = $1", [userId]);

    const token = mintVoiceToken(userId);
    const issuedAt = Number(token.split(".")[1]);
    // Simulate what the session mint does — but with a name that ONLY exists
    // in the primed copy, never in the database.
    const { rows } = await pool.query("SELECT * FROM profile WHERE user_id = $1", [userId]);
    primeCallProfile(userId, issuedAt, {
      ...(rows[0] as Profile),
      userName: "Primeda",
      timezone: "UTC",
    } as Profile);

    const res = await request(app)
      .post("/api/voice-llm/v1/chat/completions")
      .send({
        model: "gpt-4o",
        stream: false,
        messages: [],
        elevenlabs_extra_body: { user_token: token },
      });
    expect(res.status).toBe(200);
    const content: string = res.body.choices[0].message.content;
    const primedLines = new Set(
      Object.values(GREETING_POOLS)
        .flat()
        .map((t) => t("Primeda")),
    );
    expect(primedLines.has(content)).toBe(true); // primed name spoken ⇒ no DB read
    expect(content).not.toContain("Dbname");
  });

  it("an unprimed greeting still works (falls back to the DB read)", async () => {
    const { userId } = await makeUser("unprimed");
    await pool.query("UPDATE profile SET user_name = 'Fallbackia' WHERE user_id = $1", [userId]);
    const res = await request(app)
      .post("/api/voice-llm/v1/chat/completions")
      .send({
        model: "gpt-4o",
        stream: false,
        messages: [],
        elevenlabs_extra_body: { user_token: mintVoiceToken(userId) },
      });
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toContain("Fallbackia");
  });
});

describe("session endpoint: speculative parallel signed-URL fetch", () => {
  it("first call is sequential; the next call fires the fetch speculatively and reuses it", async () => {
    const { agent } = await makeUser("spec");

    stubHits.length = 0;
    const r1 = await agent.post("/api/voice-agent/session");
    expect(r1.status).toBe(200);
    expect(r1.body.mode).toBe("signed");
    expect(r1.body.signedUrl).toBe("wss://stub.invalid/agent_en_stub");
    expect(stubHits.map((h) => h.agentId)).toEqual(["agent_en_stub"]);

    stubHits.length = 0;
    const r2 = await agent.post("/api/voice-agent/session");
    expect(r2.status).toBe(200);
    expect(r2.body.mode).toBe("signed");
    // Exactly ONE fetch — the speculative one was for the right agent and was
    // reused, not duplicated.
    expect(stubHits.map((h) => h.agentId)).toEqual(["agent_en_stub"]);
  });

  it("a language change discards the speculative fetch and gets the RIGHT agent", async () => {
    const { agent, userId } = await makeUser("langswitch");

    // Call 1: seeds the language memory with "en".
    const r1 = await agent.post("/api/voice-agent/session");
    expect(r1.status).toBe(200);

    // The user switches Eos to German between calls.
    await pool.query("UPDATE profile SET preferred_language = 'de' WHERE user_id = $1", [userId]);

    stubHits.length = 0;
    const r2 = await agent.post("/api/voice-agent/session");
    expect(r2.status).toBe(200);
    expect(r2.body.mode).toBe("signed");
    // The signed URL the CLIENT gets is for the multilingual agent — the stale
    // speculative fetch (en) fired but was discarded, never served.
    expect(r2.body.signedUrl).toBe("wss://stub.invalid/agent_multi_stub");
    const agentsAsked = stubHits.map((h) => h.agentId);
    expect(agentsAsked).toContain("agent_multi_stub");

    // Call 3: memory now says "de" — speculation is right again, one fetch.
    stubHits.length = 0;
    const r3 = await agent.post("/api/voice-agent/session");
    expect(r3.status).toBe(200);
    expect(r3.body.signedUrl).toBe("wss://stub.invalid/agent_multi_stub");
    expect(stubHits.map((h) => h.agentId)).toEqual(["agent_multi_stub"]);
  });
});
