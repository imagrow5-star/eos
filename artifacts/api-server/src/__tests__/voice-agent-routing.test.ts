/**
 * Per-language ElevenLabs agent routing (pure env-based unit tests).
 *
 * English (or unset language) → the English/Flash agent, always.
 * Active non-English → the Multilingual agent when configured; otherwise a
 * warned fallback to the English agent (safe degrade — never a dead call).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import {
  resolveAgentIdForUser,
  resolveAgentRouting,
} from "../services/voiceAgentRouting.js";

const EN_AGENT = "agent_english_123";
const ML_AGENT = "agent_multilingual_456";

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved.en = process.env.ELEVENLABS_AGENT_ID;
  saved.ml = process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL;
  process.env.ELEVENLABS_AGENT_ID = EN_AGENT;
  process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL = ML_AGENT;
});

afterEach(() => {
  if (saved.en === undefined) delete process.env.ELEVENLABS_AGENT_ID;
  else process.env.ELEVENLABS_AGENT_ID = saved.en;
  if (saved.ml === undefined) delete process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL;
  else process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL = saved.ml;
});

describe("resolveAgentIdForUser", () => {
  it("English user → the English/Flash agent", () => {
    expect(resolveAgentIdForUser({ preferredLanguage: "en" })).toBe(EN_AGENT);
    expect(resolveAgentRouting({ preferredLanguage: "en" }).agentUsed).toBe("english");
  });

  it("German user → the Multilingual agent", () => {
    expect(resolveAgentIdForUser({ preferredLanguage: "de" })).toBe(ML_AGENT);
    expect(resolveAgentRouting({ preferredLanguage: "de" }).agentUsed).toBe("multilingual");
  });

  it("every other activated language also routes to Multilingual", () => {
    for (const lang of ["nl", "fr", "es", "it", "pt", "sv", "no", "da", "pl"]) {
      expect(resolveAgentIdForUser({ preferredLanguage: lang }), lang).toBe(ML_AGENT);
    }
  });

  it("no language set → the English agent (safe default)", () => {
    expect(resolveAgentIdForUser({ preferredLanguage: null })).toBe(EN_AGENT);
    expect(resolveAgentIdForUser({})).toBe(EN_AGENT);
    expect(resolveAgentIdForUser(null)).toBe(EN_AGENT);
    expect(resolveAgentIdForUser(undefined)).toBe(EN_AGENT);
  });

  it("missing multilingual agent + non-English user → warned fallback to the English agent", () => {
    delete process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL;
    const routing = resolveAgentRouting({ preferredLanguage: "de" });
    expect(routing.agentId).toBe(EN_AGENT);
    expect(routing.agentUsed).toBe("english"); // logs honestly what was actually used
    expect(resolveAgentIdForUser({ preferredLanguage: "de" })).toBe(EN_AGENT);
  });

  it("blank/whitespace multilingual id is treated as missing", () => {
    process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL = "   ";
    expect(resolveAgentIdForUser({ preferredLanguage: "fr" })).toBe(EN_AGENT);
  });

  it("no agents configured at all → empty string (endpoint reports not_configured first)", () => {
    delete process.env.ELEVENLABS_AGENT_ID;
    delete process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL;
    expect(resolveAgentIdForUser({ preferredLanguage: "en" })).toBe("");
    expect(resolveAgentIdForUser({ preferredLanguage: "de" })).toBe("");
  });
});

// ─── Session endpoint: transcription-language hint ───────────────────────────
// Public-agent mode (no ELEVENLABS_API_KEY) so no outbound call is made; the
// response carries `language` ONLY for multilingual-agent calls.

import request from "supertest";
import pg from "pg";
import app from "../app.js";

describe("POST /voice-agent/session language hint", () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const emails: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.key = process.env.ELEVENLABS_API_KEY;
    savedEnv.flag = process.env.VOICE_CALL_ENABLED;
    delete process.env.ELEVENLABS_API_KEY; // force public mode — no outbound fetch
    process.env.VOICE_CALL_ENABLED = "true";
  });
  afterEach(() => {
    if (savedEnv.key === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = savedEnv.key;
    if (savedEnv.flag === undefined) delete process.env.VOICE_CALL_ENABLED;
    else process.env.VOICE_CALL_ENABLED = savedEnv.flag;
  });

  afterAll(async () => {
    for (const email of emails.splice(0)) {
      const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
      if (r.rowCount) {
        const uid = r.rows[0]!.id;
        await pool.query(`DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = '${uid}'`);
        await pool.query(`DELETE FROM email_verification_tokens WHERE user_id = ${uid}`);
        await pool.query(`DELETE FROM profile WHERE user_id = ${uid}`);
        await pool.query(`DELETE FROM users WHERE id = ${uid}`);
      }
    }
    await pool.end();
  });

  async function makeSessionUser(tag: string, language: string) {
    const email = `agent-lang-${tag}-${Date.now()}@example.invalid`;
    emails.push(email);
    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
    expect(signup.status).toBe(201);
    const userId: number = signup.body.user.id;
    await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
    await agent.get("/api/profile");
    await pool.query("UPDATE profile SET preferred_language=$1 WHERE user_id=$2", [language, userId]);
    return agent;
  }

  it("German user on the multilingual agent → response includes language 'de'", async () => {
    const agent = await makeSessionUser("de", "de");
    const res = await agent.post("/api/voice-agent/session").send({});
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.agentId).toBe(ML_AGENT);
    expect(res.body.language).toBe("de");
  });

  it("English user → no language field, English agent (regression)", async () => {
    const agent = await makeSessionUser("en", "en");
    const res = await agent.post("/api/voice-agent/session").send({});
    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe(EN_AGENT);
    expect(res.body.language).toBeUndefined();
  });

  it("non-English user degraded to the English agent (no multilingual id) → no language hint", async () => {
    delete process.env.ELEVENLABS_AGENT_ID_MULTILINGUAL;
    const agent = await makeSessionUser("degrade", "fr");
    const res = await agent.post("/api/voice-agent/session").send({});
    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe(EN_AGENT);
    // The English/Flash agent must never receive a language override.
    expect(res.body.language).toBeUndefined();
  });
});
