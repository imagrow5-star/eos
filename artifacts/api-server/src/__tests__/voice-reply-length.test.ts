/**
 * Spoken reply length (voice audit, PR 5) and spoken register (PR 6).
 *
 *   • the voice addendum asks for one or two sentences, about 25 words, longer
 *     only when the question needs it (the old "1–3 sentences, under about 45
 *     words" is gone);
 *   • the voice paths (in-app call and the landing-page demo) cap the model at
 *     VOICE_MAX_TOKENS = 300 as a guard; text chat keeps 600. Proven at the
 *     Anthropic client: messages.create is stubbed and its max_tokens read.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY ||= "test-key-unused-create-is-stubbed";
});

import request from "supertest";
import pg from "pg";
import { createRequire } from "node:module";
import app from "../app.js";
import { mintVoiceToken } from "../lib/voiceToken.js";
import { buildVoiceCallAddendum, streamCompanionReply, VOICE_MAX_TOKENS } from "../services/ai.js";

const DB = !!process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];
let createSpy: ReturnType<typeof vi.spyOn>;

/** A minimal Anthropic stream: one text delta, then usage. */
function fakeStream(text: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text } };
      yield { type: "message_delta", usage: { output_tokens: 5 } };
    },
  };
}

beforeAll(() => {
  const require = createRequire(import.meta.url);
  const mod = require("@anthropic-ai/sdk");
  const Anthropic = mod.default || mod.Anthropic;
  const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: "x" }).messages);
  createSpy = vi.spyOn(messagesProto, "create").mockImplementation(async () => fakeStream("Go on, I'm listening.") as never);
});

afterAll(async () => {
  createSpy?.mockRestore();
  for (const email of emails) {
    const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
    if (!r.rowCount) continue;
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
  await pool.end();
});

function lastMaxTokens(): number | undefined {
  const call = createSpy.mock.calls.at(-1) as unknown as [{ max_tokens?: number }] | undefined;
  return call?.[0]?.max_tokens;
}

describe("voice addendum: length", () => {
  it("asks for one or two sentences, about 25 words, longer only when needed", () => {
    for (const addendum of [buildVoiceCallAddendum(false), buildVoiceCallAddendum(true)]) {
      expect(addendum).toContain("One or two sentences, about 25 words. Go longer only when what they asked genuinely needs it.");
      expect(addendum).not.toMatch(/45 words|1–3 brief sentences/);
    }
  });

  it("carries the spoken-register rules, with the numbers line kept neutral (no British examples)", () => {
    const addendum = buildVoiceCallAddendum(false);
    for (const line of [
      "This is talking, not writing. Fragments are fine. One thought per turn, then let them respond.",
      "React to what they just said before you ask anything. At most one question, and never two in a row.",
      "No summaries, no recaps, no \"so what I'm hearing is\". Just respond.",
      "Say numbers and times the way people say them aloud, not as written figures.",
      "Never read a memory back word for word. Mention it the way a friend would, in passing.",
    ]) {
      expect(addendum).toContain(line);
    }
    expect(addendum).not.toMatch(/half seven|quid/i);
    // The old "one gentle question" line is folded into the react-first rule.
    expect(addendum).not.toContain("Ask at most one gentle question");
  });

  it("the guard is 300 output tokens", () => {
    expect(VOICE_MAX_TOKENS).toBe(300);
  });
});

describe("max_tokens at the Anthropic client", () => {
  const system = { stable: "You are Eos.", context: "" };

  it("a voice call passes VOICE_MAX_TOKENS; text chat keeps 600", async () => {
    createSpy.mockClear();
    await streamCompanionReply(system, [], "hi", 1, () => {}, { callType: "voice", maxTokens: VOICE_MAX_TOKENS });
    expect(lastMaxTokens()).toBe(300);

    await streamCompanionReply(system, [], "hi", 1, () => {}, { callType: "chat" });
    expect(lastMaxTokens()).toBe(600);
  });

  it.skipIf(!DB)("the live voice route sends the voice cap", async () => {
    const email = `reply-length-${Date.now()}@example.invalid`;
    emails.push(email);
    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
    expect(signup.status).toBe(201);
    const userId: number = signup.body.user.id;
    await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
    expect((await agent.get("/api/profile")).status).toBe(200);

    createSpy.mockClear();
    const res = await request(app)
      .post("/api/voice-llm/v1/chat/completions")
      .send({
        model: "gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "what should I have for dinner" }],
        elevenlabs_extra_body: { user_token: mintVoiceToken(userId) },
      });
    expect(res.status).toBe(200);
    expect(res.body.choices[0].message.content).toBe("Go on, I'm listening.");
    const voiceCalls = (createSpy.mock.calls as unknown as [{ max_tokens?: number; stream?: boolean }][])
      .filter((c) => c[0]?.stream === true);
    expect(voiceCalls.length).toBeGreaterThanOrEqual(1);
    for (const [args] of voiceCalls) expect(args.max_tokens).toBe(300);

    // The route persists the turn after replying; wait for it so cleanup
    // never races the insert.
    for (let i = 0; i < 40; i++) {
      const n = Number((await pool.query("SELECT count(*) AS n FROM messages WHERE user_id = $1", [userId])).rows[0].n);
      if (n >= 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  });
});
