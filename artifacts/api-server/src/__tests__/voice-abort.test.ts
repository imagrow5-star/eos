/**
 * Hume cancels a CLM request when the person starts talking again (end of
 * turn fired mid-thought). What must hold — routes/voice-llm.ts:
 *   • the provider stream is aborted (the AbortSignal handed to
 *     messages.create fires) instead of generating to the end;
 *   • the person's words are still persisted (they said them), the reply
 *     nobody heard is NOT, and it never feeds the anti-repetition list;
 *   • the timing line says aborted: true with abortedAtMs; a normal turn
 *     says aborted: false and its signal never fires.
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
import { isEncrypted, decryptText } from "@workspace/db";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];
let createSpy: ReturnType<typeof vi.spyOn>;
/** The signal handed to the last messages.create call, if any. */
const signals: AbortSignal[] = [];

const TOKEN_GAP_MS = 120;
const TOKENS = ["Right, ", "so ", "that ", "sounds ", "like ", "a ", "lot ", "to ", "carry ", "tonight. ", "What ", "part ", "of ", "it ", "weighs ", "most?"];

/** A slow Anthropic stream: one word every TOKEN_GAP_MS, stopping when the signal fires. */
function slowStream(signal: AbortSignal | undefined) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } };
      for (const t of TOKENS) {
        await new Promise((r) => setTimeout(r, TOKEN_GAP_MS));
        if (signal?.aborted) {
          const err = new Error("Request was aborted.");
          err.name = "APIUserAbortError";
          throw err;
        }
        yield { type: "content_block_delta", delta: { type: "text_delta", text: t } };
      }
      yield { type: "message_delta", usage: { output_tokens: TOKENS.length } };
    },
  };
}

beforeAll(() => {
  const require = createRequire(import.meta.url);
  const mod = require("@anthropic-ai/sdk");
  const Anthropic = mod.default || mod.Anthropic;
  const messagesProto = Object.getPrototypeOf(new Anthropic({ apiKey: "x" }).messages);
  createSpy = vi.spyOn(messagesProto, "create").mockImplementation(async (_params: unknown, options?: { signal?: AbortSignal }) => {
    if (options?.signal) signals.push(options.signal);
    return slowStream(options?.signal) as never;
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

async function makeUser(tag: string) {
  const email = `abort-${tag}-${Date.now()}@example.invalid`;
  emails.push(email);
  const agent = request.agent(app);
  const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signup.status).toBe(201);
  const userId: number = signup.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  expect((await agent.get("/api/profile")).status).toBe(200);
  return { userId };
}

async function rows(userId: number, role: "user" | "assistant"): Promise<string[]> {
  const { rows } = await pool.query<{ content: string }>(
    "SELECT content FROM messages WHERE user_id = $1 AND role = $2 ORDER BY created_at, id",
    [userId, role],
  );
  return rows.map((r) => (isEncrypted(r.content) ? decryptText(r.content, "messages.content") : r.content));
}

type LogCall = [Record<string, unknown>, string];
function timingLines(spy: ReturnType<typeof vi.spyOn>) {
  return (spy.mock.calls as unknown as LogCall[])
    .filter((c) => c[1] === "voice turn timing" && c[0]?.greeting === false)
    .map((c) => c[0]);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Hume cancels the request mid-reply", () => {
  it("aborts the provider stream, keeps the person's words, stores no reply", async () => {
    const { userId } = await makeUser("cut");
    const said = "I was going to say something about my brother but";
    const spy = vi.spyOn(logger, "info");
    signals.length = 0;
    try {
      const req = request(app)
        .post("/api/voice-llm/v1/chat/completions")
        .send({
          model: "gpt-4o",
          stream: true,
          messages: [{ role: "user", content: said }],
          elevenlabs_extra_body: { user_token: mintVoiceToken(userId) },
        });
      // Hume's cancel: the client drops the connection a few tokens in.
      setTimeout(() => req.abort(), 450);
      await req.then(() => {}, () => {});

      // Give the handler time to notice the close and finish up.
      for (let i = 0; i < 40 && timingLines(spy).length === 0; i++) await sleep(50);
      const lines = timingLines(spy);
      expect(lines).toHaveLength(1);
      const line = lines[0]!;
      expect(line.aborted).toBe(true);
      expect(typeof line.abortedAtMs).toBe("number");
      // It stopped well short of the full reply (16 tokens × 120 ms ≈ 1.9 s).
      expect(line.modelMs as number).toBeLessThan(TOKENS.length * TOKEN_GAP_MS - 300);
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(true);
    } finally {
      spy.mockRestore();
    }

    // The person's words land; the unheard reply never does.
    for (let i = 0; i < 40 && !(await rows(userId, "user")).includes(said); i++) await sleep(50);
    expect(await rows(userId, "user")).toContain(said);
    await sleep(400);
    expect(await rows(userId, "assistant")).toEqual([]);
  });

  it("a turn that runs to the end is unchanged: reply stored, signal never fired", async () => {
    const { userId } = await makeUser("full");
    const said = "okay that is everything I wanted to say";
    const spy = vi.spyOn(logger, "info");
    signals.length = 0;
    try {
      const res = await request(app)
        .post("/api/voice-llm/v1/chat/completions")
        .send({
          model: "gpt-4o",
          stream: false,
          messages: [{ role: "user", content: said }],
          elevenlabs_extra_body: { user_token: mintVoiceToken(userId) },
        });
      expect(res.status).toBe(200);
      expect(res.body.choices[0].message.content).toBe(TOKENS.join(""));
      const [line] = timingLines(spy);
      expect(line).toMatchObject({ aborted: false, abortedAtMs: null });
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(false);
    } finally {
      spy.mockRestore();
    }
    for (let i = 0; i < 40 && (await rows(userId, "assistant")).length === 0; i++) await sleep(50);
    expect(await rows(userId, "assistant")).toEqual([TOKENS.join("")]);
  });
});
