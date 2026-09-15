/**
 * Accumulating transcripts (voice): when end of turn fires mid-thought, Hume
 * re-sends the whole utterance with more on the end, sometimes with a word
 * revised earlier in it. What must hold:
 *   • isContinuationOf recognises the continued turn, tolerates a small ASR
 *     revision, and rejects a different turn, a shorter one, or an identical one;
 *   • through the voice route, five accumulating versions of one turn leave
 *     ONE user row holding the final version; a genuinely new turn adds a row.
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { mintVoiceToken } from "../lib/voiceToken.js";
import { isContinuationOf, transcriptTokens } from "../services/voice/continuation.js";
import { isEncrypted, decryptText } from "@workspace/db";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

afterAll(async () => {
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

// The real call, as transcribed (a word revised between the first two).
const V = [
  "Uh. Nothing much uh. Everyday routine I go to gym and I came back and uh.",
  "Uh. Nothing much uh. Everyday routine I go to gym and came back and uh. Eating well good protein and uh.",
  "Uh. Nothing much uh. Everyday routine I go to gym and came back and uh. Eating well good protein and uh. I'm walking on you like I don't have. Zero customers at that right now.",
  "Uh. Nothing much uh. Everyday routine I go to gym and came back and uh. Eating well good protein and uh. I'm working on you like I don't have. Zero customers at right now so.",
  "Uh. Nothing much uh. Everyday routine I go to gym and came back and uh. Eating well good protein and uh. I'm walking on you like I don't have. Customers at that right now so i'm planning to how to get my customers how how can I reach to people.",
];

describe("isContinuationOf", () => {
  it("recognises each accumulating version as the previous one continued or revised", () => {
    for (let i = 1; i < V.length; i++) expect(isContinuationOf(V[i - 1]!, V[i]!), `v${i}`).toBe(true);
  });

  it("rejects the reverse, the identical, and a different turn", () => {
    expect(isContinuationOf(V[1]!, V[0]!)).toBe(false); // shorter
    expect(isContinuationOf(V[2]!, V[2]!)).toBe(false); // identical
    expect(isContinuationOf("I came back.", "I came back!")).toBe(false); // punctuation only
    // Same length, one word revised: the same turn, re-sent.
    expect(isContinuationOf("I'm walking on you like I don't have", "I'm working on you like I don't have")).toBe(true);
    expect(isContinuationOf(V[0]!, "Yes yes.")).toBe(false);
    expect(isContinuationOf("I think i'm writing blogs in.", "I think i'm writing blogs in medium and linkedin.")).toBe(true);
    expect(isContinuationOf("Okay.", "Keep keep going.")).toBe(false);
    expect(isContinuationOf("", "anything")).toBe(false);
  });

  it("a short previous turn must survive whole; a long one may lose a word", () => {
    expect(isContinuationOf("so what", "so what difference it made")).toBe(true);
    expect(isContinuationOf("so what", "no what difference it made")).toBe(false);
    expect(isContinuationOf(
      "the thing about my brother is that he never calls back",
      "the thing about my brother is he never calls back and it drives me mad",
    )).toBe(true);
    expect(transcriptTokens("I'm here, Naveen. Take your time.")).toEqual(["i'm", "here", "naveen", "take", "your", "time"]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("voice route: one turn, one row", () => {
  it("five accumulating versions leave one row with the last version; a new turn adds one", async () => {
    const email = `continuation-${Date.now()}@example.invalid`;
    emails.push(email);
    const agent = request.agent(app);
    const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
    expect(signup.status).toBe(201);
    const userId: number = signup.body.user.id;
    await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
    expect((await agent.get("/api/profile")).status).toBe(200);
    const token = mintVoiceToken(userId);

    const userRows = async () => {
      const { rows } = await pool.query<{ content: string }>(
        "SELECT content FROM messages WHERE user_id = $1 AND role = 'user' ORDER BY created_at, id",
        [userId],
      );
      return rows.map((r) => (isEncrypted(r.content) ? decryptText(r.content, "messages.content") : r.content));
    };
    const waitFor = async (pred: (rows: string[]) => boolean) => {
      for (let i = 0; i < 60; i++) {
        const rows = await userRows();
        if (pred(rows)) return rows;
        await new Promise((r) => setTimeout(r, 50));
      }
      return userRows();
    };

    for (const content of V) {
      const res = await request(app)
        .post("/api/voice-llm/v1/chat/completions")
        .send({ model: "gpt-4o", stream: false, messages: [{ role: "user", content }], elevenlabs_extra_body: { user_token: token } });
      expect(res.status).toBe(200);
      await waitFor((rows) => rows.includes(content));
    }
    expect(await userRows()).toEqual([V[V.length - 1]]);

    const res = await request(app)
      .post("/api/voice-llm/v1/chat/completions")
      .send({ model: "gpt-4o", stream: false, messages: [{ role: "user", content: V[V.length - 1]! }, { role: "assistant", content: "Okay." }, { role: "user", content: "Yes yes." }], elevenlabs_extra_body: { user_token: token } });
    expect(res.status).toBe(200);
    expect(await waitFor((rows) => rows.length === 2)).toEqual([V[V.length - 1], "Yes yes."]);
  });
});
