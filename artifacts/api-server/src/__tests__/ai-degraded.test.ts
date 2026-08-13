/**
 * Honest degraded mode when the AI provider is unreachable (review finding:
 * outages used to serve canned "mock" replies and record success).
 *
 * Setup: ANTHROPIC_API_KEY is set (so mock mode is OFF) and every fetch to
 * api.anthropic.com is intercepted with a non-retryable 400 — a provider
 * outage in miniature, with zero real API calls. Vitest gives this file its
 * own process, so neither the env nor the fetch wrapper leaks anywhere.
 *
 * Proves:
 *  - /chat/send answers 200 with degraded:true and the honest fallback text
 *    (never a fake "normal" reply), logs the ai_degraded marker, and reports
 *    memoryExtracted:false;
 *  - /chat/stream's SSE done event carries degraded:true;
 *  - the voice custom-LLM endpoint speaks the honest line as a normal
 *    completion (a 500 would make ElevenLabs play its generic error blurb —
 *    this is the graceful failure), persists the USER's words but never the
 *    fallback line;
 *  - no extraction runs on degraded turns (nothing else calls the provider).
 */

import { describe, it, expect, afterAll, vi } from "vitest";
import request from "supertest";
import pg from "pg";

// Must be set before the app handles a request: with a key present the code
// takes the REAL provider path (mock mode off) and hits our interceptor.
process.env.ANTHROPIC_API_KEY = "test-key-degraded-outage";

// Chain on top of suppress-resend's wrapper: Anthropic → 400, rest passthrough.
const priorFetch = globalThis.fetch;
let anthropicCalls = 0;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("api.anthropic.com")) {
    anthropicCalls++;
    return Promise.resolve(
      new Response(
        JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "synthetic outage" } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
    );
  }
  return priorFetch(input, init);
}) as typeof fetch;

import app from "../app.js";
import { DEGRADED_REPLY } from "../services/ai.js";
import { mintVoiceToken } from "../lib/voiceToken.js";
import { logger } from "../lib/logger.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (!r.rowCount) return;
  const uid = r.rows[0]!.id;
  await pool.query(`
    BEGIN;
    DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = '${uid}';
    DELETE FROM email_verification_tokens WHERE user_id = ${uid};
    DELETE FROM commitments WHERE user_id = ${uid};
    DELETE FROM messages    WHERE user_id = ${uid};
    DELETE FROM profile     WHERE user_id = ${uid};
    DELETE FROM users       WHERE id      = ${uid};
    COMMIT;
  `);
}

async function signupUser(tag: string) {
  const email = `degraded-${tag}-${Date.now()}@example.invalid`;
  emails.push(email);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(res.status).toBe(201);
  const userId: number = res.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  await agent.get("/api/profile");
  return { agent, userId };
}

afterAll(async () => {
  await Promise.all(emails.splice(0).map(cleanupUser));
  await pool.end();
  globalThis.fetch = priorFetch;
});

describe("honest degraded mode (provider outage)", () => {
  it("/chat/send: 200 + degraded flag + honest text + ai_degraded metric, no extraction", async () => {
    const { agent, userId } = await signupUser("send");
    const errorSpy = vi.spyOn(logger, "error");
    const callsBefore = anthropicCalls;

    const res = await agent.post("/api/chat/send").send({ content: "are you there?" });
    expect(res.status).toBe(200);
    expect(res.body.degraded).toBe(true);
    expect(res.body.assistantMessage.content).toBe(DEGRADED_REPLY);
    expect(res.body.assistantMessage.content).toMatch(/trouble gathering my thoughts/i);
    expect(res.body.memoryExtracted).toBe(false);

    // Metrics: the outage is recorded as DEGRADED, never silent success.
    const degradedLogs = errorSpy.mock.calls.filter(
      (c) => (c[0] as { aiDegraded?: boolean } | undefined)?.aiDegraded === true,
    );
    expect(degradedLogs.length).toBeGreaterThanOrEqual(1);
    errorSpy.mockRestore();

    // Both sides of the exchange are in history (the user's words matter and
    // the honest line IS what Eos said in chat)…
    const rows = await pool.query<{ role: string }>(
      "SELECT role FROM messages WHERE user_id = $1 ORDER BY id",
      [userId],
    );
    expect(rows.rows.map((r) => r.role)).toContain("assistant");

    // …and no extraction pipeline fired. Two Anthropic calls happen on a
    // regex-miss message: the semantic crisis backstop (fired pre-generation,
    // in parallel) and the chat reply itself. Extraction — skipped on a
    // degraded reply — would have added several MORE Haiku calls, so this count
    // still proves extraction never ran.
    await new Promise((r) => setTimeout(r, 300));
    expect(anthropicCalls - callsBefore).toBe(2);
  });

  it("/chat/stream: SSE done event carries degraded:true with the honest text", async () => {
    const { agent } = await signupUser("stream");

    const res = await agent
      .post("/api/chat/stream")
      .send({ content: "hello?" })
      .buffer(true)
      .parse((res2, cb) => {
        let data = "";
        res2.on("data", (chunk: Buffer) => (data += chunk.toString()));
        res2.on("end", () => cb(null, data));
      });
    expect(res.status).toBe(200);
    const sse = res.body as string;
    expect(sse).toContain("event: done");
    const doneData = /event: done\ndata: (.+)\n/.exec(sse);
    expect(doneData).not.toBeNull();
    const done = JSON.parse(doneData![1]!) as { content: string; degraded?: boolean };
    expect(done.degraded).toBe(true);
    expect(done.content).toBe(DEGRADED_REPLY);
  });

  it("voice: speaks the honest line as a normal completion; user turn persists, fallback doesn't", async () => {
    const { userId } = await signupUser("voice");
    const token = mintVoiceToken(userId);

    const res = await request(app)
      .post("/api/voice-llm/v1/chat/completions")
      .send({
        stream: false,
        elevenlabs_extra_body: { user_token: token },
        messages: [{ role: "user", content: "I had a rough day and needed to hear your voice." }],
      });

    // 200 with the honest words — never a 500 (ElevenLabs would answer that
    // with its generic error blurb or dead air; this way Eos herself says it).
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe(DEGRADED_REPLY);

    // Persistence is async (per-user chain) — give it a beat.
    await new Promise((r) => setTimeout(r, 500));
    const rows = await pool.query<{ role: string; content: string }>(
      "SELECT role, content FROM messages WHERE user_id = $1",
      [userId],
    );
    const roles = rows.rows.map((r) => r.role);
    expect(roles).toContain("user"); // their words are remembered
    expect(roles).not.toContain("assistant"); // the fallback line is not stored as Eos
  });
});
