/**
 * Hume voice provider — session-mint branch (stage A, server only).
 *
 * The Hume branch fires only when EVERY gate opens: client opt-in
 * (?provider=hume), HUME_* env config, the founder allowlist, and an
 * English-language profile. Every closed gate falls through to the
 * ElevenLabs flow unchanged — including a failed access-token exchange
 * (fail open to the provider that works). The OAuth exchange is
 * intercepted at the fetch layer and asserted against the scheme verified
 * from the Hume SDK source (Basic apiKey:secretKey, client_credentials).
 */

import { describe, it, expect, afterAll, beforeEach } from "vitest";
import request from "supertest";
import pg from "pg";

process.env.HUME_API_KEY = "hume-test-api-key";
process.env.HUME_SECRET_KEY = "hume-test-secret-key";
process.env.HUME_CONFIG_ID = "cfg_test_1";
process.env.HUME_API_BASE = "https://hume-test.invalid";

// ── OAuth exchange interception ──────────────────────────────────────────────
const tokenCalls: Array<{ auth: string | undefined; body: string }> = [];
let tokenExchangeFails = false;

const priorFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("https://hume-test.invalid/oauth2-cc/token")) {
    const headers = new Headers(init?.headers);
    tokenCalls.push({ auth: headers.get("authorization") ?? undefined, body: String(init?.body ?? "") });
    return Promise.resolve(
      tokenExchangeFails
        ? new Response("simulated hume outage", { status: 500 })
        : new Response(JSON.stringify({ access_token: "hume-access-token-test" }), { status: 200 }),
    );
  }
  return priorFetch(input, init);
}) as typeof fetch;

import app from "../app.js";
import { humeAllowlistDecision } from "../services/hume.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

function nextEmail(tag: string): string {
  const e = `humesess-${tag}-${Date.now()}-${emails.length}@example.invalid`;
  emails.push(e);
  return e;
}

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

/** Signed-in agent with a verified email (the session route needs a session). */
async function signupAgent(tag: string) {
  const email = nextEmail(tag);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(res.status).toBe(201);
  const userId: number = res.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  return { agent, userId, email };
}

afterAll(async () => {
  for (const email of emails) await cleanupUser(email);
  await pool.end();
});

beforeEach(() => {
  tokenCalls.length = 0;
  tokenExchangeFails = false;
  delete process.env.HUME_VOICE_ALLOWLIST;
});

describe("humeAllowlistDecision (mirrors the memory-reset gate)", () => {
  it("unset/blank/empty allowlist → not_configured", () => {
    expect(humeAllowlistDecision("a@b.c", undefined)).toBe("not_configured");
    expect(humeAllowlistDecision("a@b.c", "  ")).toBe("not_configured");
    expect(humeAllowlistDecision("a@b.c", " , ,")).toBe("not_configured");
  });

  it("case-insensitive, whitespace-tolerant matching", () => {
    expect(humeAllowlistDecision("Founder@Example.com", " founder@example.com , dev@x.com ")).toBe("allowed");
    expect(humeAllowlistDecision("other@example.com", "founder@example.com")).toBe("forbidden");
    expect(humeAllowlistDecision(null, "founder@example.com")).toBe("forbidden");
  });
});

describe("session-mint provider branch", () => {
  it("all gates open → Hume session with access token, config id, and voice token", async () => {
    const { agent, email } = await signupAgent("allowed");
    process.env.HUME_VOICE_ALLOWLIST = email;

    const res = await agent.post("/api/voice-agent/session?provider=hume");
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.mode).toBe("hume");
    expect(res.body.accessToken).toBe("hume-access-token-test");
    expect(res.body.configId).toBe("cfg_test_1");
    expect(typeof res.body.userToken).toBe("string");
    expect(res.body.userToken.split(".").length).toBe(5);
    // Voice-gender parity: a fresh profile resolves to the female display
    // default → Kora (id from the live Voice Library capture, 2026-09-03).
    expect(res.body.humeVoiceId).toBe("59cfc7ab-e945-43de-ad1a-471daa379c67");

    // The exchange used the scheme from the SDK source: Basic key:secret +
    // client_credentials.
    expect(tokenCalls).toHaveLength(1);
    const expectedBasic = `Basic ${Buffer.from("hume-test-api-key:hume-test-secret-key").toString("base64")}`;
    expect(tokenCalls[0]!.auth).toBe(expectedBasic);
    expect(tokenCalls[0]!.body).toContain("grant_type=client_credentials");
    await cleanupUser(email);
  });

  it("male voice gender → the male Hume voice in the session response", async () => {
    const { agent, userId, email } = await signupAgent("malevoice");
    process.env.HUME_VOICE_ALLOWLIST = email;
    // Materialize the profile row, then pick the male voice gender the way
    // POST /settings/voice-gender stores it.
    const prof = await agent.get("/api/profile");
    expect(prof.status).toBe(200);
    const upd = await pool.query(
      "UPDATE profile SET voice_gender = 'male' WHERE user_id = $1",
      [userId],
    );
    expect(upd.rowCount).toBe(1);
    const res = await agent.post("/api/voice-agent/session?provider=hume");
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("hume");
    // Comforting Male Conversationalist (live Voice Library capture).
    expect(res.body.humeVoiceId).toBe("99d2cb9c-9011-4ead-8734-641656d3df66");
    await cleanupUser(email);
  });

  it("no ?provider=hume opt-in → ElevenLabs flow even for an allowlisted user", async () => {
    const { agent, email } = await signupAgent("noopt");
    process.env.HUME_VOICE_ALLOWLIST = email;
    const res = await agent.post("/api/voice-agent/session");
    expect(res.status).toBe(200);
    expect(res.body.mode).not.toBe("hume");
    expect(tokenCalls).toHaveLength(0);
    await cleanupUser(email);
  });

  it("opt-in but NOT on the allowlist → ElevenLabs flow", async () => {
    const { agent, email } = await signupAgent("denied");
    process.env.HUME_VOICE_ALLOWLIST = "someone-else@example.invalid";
    const res = await agent.post("/api/voice-agent/session?provider=hume");
    expect(res.status).toBe(200);
    expect(res.body.mode).not.toBe("hume");
    expect(tokenCalls).toHaveLength(0);
    await cleanupUser(email);
  });

  it("allowlist unset → feature doesn't exist, ElevenLabs flow", async () => {
    const { agent, email } = await signupAgent("unset");
    const res = await agent.post("/api/voice-agent/session?provider=hume");
    expect(res.status).toBe(200);
    expect(res.body.mode).not.toBe("hume");
    await cleanupUser(email);
  });

  it("non-English profile → ElevenLabs flow (multilingual routing is ElevenLabs-specific)", async () => {
    const { agent, userId, email } = await signupAgent("lang");
    process.env.HUME_VOICE_ALLOWLIST = email;
    // Ensure the profile row exists (GET /profile creates it), then set a
    // non-English language directly.
    const prof = await agent.get("/api/profile");
    expect(prof.status).toBe(200);
    const upd = await pool.query(
      "UPDATE profile SET preferred_language = 'nl' WHERE user_id = $1",
      [userId],
    );
    expect(upd.rowCount).toBe(1);
    const res = await agent.post("/api/voice-agent/session?provider=hume");
    expect(res.status).toBe(200);
    expect(res.body.mode).not.toBe("hume");
    expect(tokenCalls).toHaveLength(0);
    await cleanupUser(email);
  });

  it("settings/voice-options reports voiceCallProvider 'hume' for an allowlisted English account", async () => {
    const { agent, email } = await signupAgent("vopts");
    process.env.HUME_VOICE_ALLOWLIST = email;
    const res = await agent.get("/api/settings/voice-options");
    expect(res.status).toBe(200);
    expect(res.body.voiceCallProvider).toBe("hume");
    await cleanupUser(email);
  });

  it("settings/voice-options reports 'elevenlabs' when not allowlisted (and when unset)", async () => {
    const { agent, email } = await signupAgent("vopts2");
    process.env.HUME_VOICE_ALLOWLIST = "someone-else@example.invalid";
    const denied = await agent.get("/api/settings/voice-options");
    expect(denied.body.voiceCallProvider).toBe("elevenlabs");
    delete process.env.HUME_VOICE_ALLOWLIST;
    const unset = await agent.get("/api/settings/voice-options");
    expect(unset.body.voiceCallProvider).toBe("elevenlabs");
    await cleanupUser(email);
  });

  it("token exchange failure → falls back to the ElevenLabs flow, never a dead session", async () => {
    const { agent, email } = await signupAgent("outage");
    process.env.HUME_VOICE_ALLOWLIST = email;
    tokenExchangeFails = true;
    const res = await agent.post("/api/voice-agent/session?provider=hume");
    expect(res.status).toBe(200);
    expect(res.body.mode).not.toBe("hume");
    expect(tokenCalls).toHaveLength(1); // it tried, failed, fell through
    await cleanupUser(email);
  });
});
