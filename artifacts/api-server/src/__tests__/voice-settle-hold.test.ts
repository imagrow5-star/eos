/**
 * Settle hold (services/voice/settle.ts, routes/voice-llm.ts).
 *   • looksUnfinished: hesitation sounds in their common spellings, dangling
 *     words, and pause punctuation say "more coming"; a finished sentence
 *     doesn't;
 *   • a turn that looks unfinished is held ~1.2 s before the reply, logged
 *     held: true with heldMs; a clean turn isn't held at all;
 *   • if Hume cancels during the hold, nothing is generated and nothing is
 *     stored (the longer version of the turn is on its way), logged as held
 *     and aborted.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.hoisted(() => {
  process.env.ANTHROPIC_API_KEY ||= "test-key-unused-create-is-stubbed";
});

import request from "supertest";
import pg from "pg";
import { createRequire } from "node:module";
import app from "../app.js";
import { logger } from "../lib/logger.js";
import { mintVoiceToken } from "../lib/voiceToken.js";
import { looksUnfinished, settleHold, SETTLE_HOLD_MS, TRAILING_FILLERS } from "../services/voice/settle.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];
let createSpy: ReturnType<typeof vi.spyOn>;
let modelCalls = 0;

beforeAll(() => {
  const require = createRequire(import.meta.url);
  const mod = require("@anthropic-ai/sdk");
  const Anthropic = mod.default || mod.Anthropic;
  const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: "x" }).messages);
  createSpy = vi.spyOn(messagesProto, "create").mockImplementation(async (params: unknown) => {
    // Count only the streamed reply calls: background extraction after a turn
    // also goes through messages.create (non-streaming) and must not count.
    if ((params as { stream?: boolean })?.stream === true) modelCalls += 1;
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } };
        yield { type: "content_block_delta", delta: { type: "text_delta", text: "Go on." } };
        yield { type: "message_delta", usage: { output_tokens: 2 } };
      },
    } as never;
  });
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

describe("looksUnfinished", () => {
  it("catches hesitation sounds in their common spellings", () => {
    for (const t of ["and uh.", "I was thinking um", "so we went there and uhm", "it's like, er", "well hmm", "Eating well good protein and uh.", "Zero customers at right now so."]) {
      expect(looksUnfinished(t), t).toBe(true);
    }
    for (const w of ["uh", "um", "uhm", "er", "erm", "hmm", "hm", "mm"]) expect(TRAILING_FILLERS.has(w), w).toBe(true);
  });

  it("catches dangling words and pause punctuation", () => {
    for (const t of ["I think i'm writing blogs in.", "and then I", "the thing about my brother is that", "I went to the shop,", "I don't know…", "maybe we could...", "she said —"]) {
      expect(looksUnfinished(t), t).toBe(true);
    }
  });

  it("leaves finished turns alone", () => {
    for (const t of ["Yes yes.", "I think i'm writing blogs in medium and linkedin.", "Keep keep going.", "Something interesting.", "Tell me a story.", "Okay.", "", "   "]) {
      expect(looksUnfinished(t), t).toBe(false);
    }
  });

  it("the hold ends early when the signal fires", async () => {
    const ctl = new AbortController();
    const t0 = performance.now();
    setTimeout(() => ctl.abort(), 80);
    await settleHold(5000, ctl.signal);
    expect(performance.now() - t0).toBeLessThan(1000);
    // Already-aborted: returns at once.
    const t1 = performance.now();
    await settleHold(5000, ctl.signal);
    expect(performance.now() - t1).toBeLessThan(50);
    expect(SETTLE_HOLD_MS).toBe(1200);
  });
});

async function makeUser(tag: string) {
  const email = `settle-${tag}-${Date.now()}@example.invalid`;
  emails.push(email);
  const agent = request.agent(app);
  const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signup.status).toBe(201);
  const userId: number = signup.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  expect((await agent.get("/api/profile")).status).toBe(200);
  return { userId };
}

type LogCall = [Record<string, unknown>, string];
const timingLines = (spy: ReturnType<typeof vi.spyOn>) =>
  (spy.mock.calls as unknown as LogCall[]).filter((c) => c[1] === "voice turn timing" && c[0]?.greeting === false).map((c) => c[0]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const userRowCount = async (userId: number) =>
  Number((await pool.query("SELECT count(*) AS n FROM messages WHERE user_id = $1 AND role = 'user'", [userId])).rows[0].n);

describe.skipIf(!process.env.DATABASE_URL)("voice route", () => {
  it("holds an unfinished turn ~1.2 s and then answers; a clean turn is not held", async () => {
    const { userId } = await makeUser("hold");
    const token = mintVoiceToken(userId);
    const spy = vi.spyOn(logger, "info");
    try {
      const t0 = performance.now();
      const res = await request(app)
        .post("/api/voice-llm/v1/chat/completions")
        .send({ model: "gpt-4o", stream: false, messages: [{ role: "user", content: "so I went to the shop and uh" }], elevenlabs_extra_body: { user_token: token } });
      const elapsed = performance.now() - t0;
      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe("Go on.");
      expect(elapsed).toBeGreaterThanOrEqual(SETTLE_HOLD_MS - 50);
      const [line] = timingLines(spy);
      expect(line).toMatchObject({ held: true, aborted: false });
      expect(line!.heldMs as number).toBeGreaterThanOrEqual(SETTLE_HOLD_MS - 50);
      expect(line!.heldMs as number).toBeLessThan(SETTLE_HOLD_MS + 400);

      spy.mockClear();
      const t1 = performance.now();
      const clean = await request(app)
        .post("/api/voice-llm/v1/chat/completions")
        .send({ model: "gpt-4o", stream: false, messages: [{ role: "user", content: "so I went to the shop and uh" }, { role: "assistant", content: "Go on." }, { role: "user", content: "I bought the bread." }], elevenlabs_extra_body: { user_token: token } });
      expect(clean.status).toBe(200);
      expect(performance.now() - t1).toBeLessThan(SETTLE_HOLD_MS);
      expect(timingLines(spy)[0]).toMatchObject({ held: false, heldMs: 0, aborted: false });
    } finally {
      spy.mockRestore();
    }
    for (let i = 0; i < 40 && (await userRowCount(userId)) < 2; i++) await sleep(50);
  });

  it("a cancel during the hold generates nothing and stores nothing", async () => {
    const { userId } = await makeUser("cancel");
    const token = mintVoiceToken(userId);
    const spy = vi.spyOn(logger, "info");
    const before = modelCalls;
    try {
      const req = request(app)
        .post("/api/voice-llm/v1/chat/completions")
        .send({ model: "gpt-4o", stream: true, messages: [{ role: "user", content: "Everyday routine I go to gym and came back and uh." }], elevenlabs_extra_body: { user_token: token } });
      setTimeout(() => req.abort(), 300); // the person carried on; Hume cancelled
      await req.then(() => {}, () => {});
      for (let i = 0; i < 40 && timingLines(spy).length === 0; i++) await sleep(50);
      const [line] = timingLines(spy);
      expect(line).toMatchObject({ held: true, aborted: true, modelMs: 0, firstTokenMs: null, replyWords: 0 });
      expect(line!.heldMs as number).toBeLessThan(SETTLE_HOLD_MS);
      expect(modelCalls).toBe(before); // the hold saved the generation
    } finally {
      spy.mockRestore();
    }
    await sleep(400);
    expect(await userRowCount(userId)).toBe(0); // the longer version of the turn will carry these words
  });
});
