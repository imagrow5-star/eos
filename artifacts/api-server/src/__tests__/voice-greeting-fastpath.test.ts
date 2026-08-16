/**
 * Fast first response (voice greeting) — routes/voice-llm.ts synthetic path.
 *
 * What must hold after the change:
 *   • an ENGLISH call's greeting comes from the curated voiceGreeting pools —
 *     no LLM round trip at all (proven by exact pool membership: the keyless
 *     dev mock could never produce one of these lines);
 *   • a NON-ENGLISH call still gets an LLM greeting, but from the tiny
 *     greeting-only prompt (proven small, language- and name-aware);
 *   • the greeting is persisted to chat history exactly like before
 *     (assistant row only — the synthetic instruction is never saved);
 *   • real turns are untouched (covered by crisis-floor voice tests; here we
 *     just pin that a non-empty transcript does NOT take the fast path).
 */
import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { mintVoiceToken } from "../lib/voiceToken.js";
import { GREETING_POOLS } from "../services/voiceGreeting.js";
import { buildGreetingPrompt } from "../routes/voice-llm.js";
import { isEncrypted, decryptText } from "@workspace/db";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

async function makeUser(tag: string, patch: Record<string, unknown> = {}) {
  const email = `greet-${tag}-${Date.now()}@example.invalid`;
  emails.push(email);
  const agent = request.agent(app);
  const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signup.status).toBe(201);
  const userId: number = signup.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  const prof = await agent.get("/api/profile");
  expect(prof.status).toBe(200);
  for (const [col, val] of Object.entries(patch)) {
    await pool.query(`UPDATE profile SET ${col} = $1 WHERE user_id = $2`, [val, userId]);
  }
  return { userId };
}

async function cleanup(email: string) {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (!r.rowCount) return;
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

afterAll(async () => {
  for (const e of emails) await cleanup(e);
  await pool.end();
});

function greetingTurn(userId: number) {
  return request(app)
    .post("/api/voice-llm/v1/chat/completions")
    .send({
      model: "gpt-4o",
      stream: false,
      messages: [], // empty transcript ⇒ synthetic greeting turn
      elevenlabs_extra_body: { user_token: mintVoiceToken(userId) },
    });
}

async function persistedAssistantRows(userId: number): Promise<string[]> {
  // persistVoiceTurn is fire-and-forget — poll briefly.
  for (let i = 0; i < 20; i++) {
    const { rows } = await pool.query(
      "SELECT content FROM messages WHERE user_id = $1 AND role = 'assistant'",
      [userId],
    );
    if (rows.length) {
      return rows.map((r) =>
        isEncrypted(r.content) ? decryptText(r.content, "messages.content") : r.content,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
}

describe("English greeting — instant curated line, no LLM", () => {
  it("returns exactly one of the vetted pool lines, fast, and persists it", async () => {
    const { userId } = await makeUser("en", { user_name: "Greta" });

    const t0 = performance.now();
    const res = await greetingTurn(userId);
    const ms = Math.round(performance.now() - t0);
    expect(res.status).toBe(200);
    const content: string = res.body.choices[0].message.content;

    // Membership in the curated pools is the proof there was no LLM: the
    // keyless dev mock (and any real model) cannot reproduce these lines.
    const candidates = new Set(
      Object.values(GREETING_POOLS)
        .flat()
        .flatMap((t) => [t("Greta"), t(null)]),
    );
    expect(candidates.has(content)).toBe(true);

    // eslint-disable-next-line no-console
    console.log(`[fastpath] English greeting server time: ${ms}ms — "${content}"`);

    // Persisted like before: assistant row only, exact spoken words.
    const rows = await persistedAssistantRows(userId);
    expect(rows).toContain(content);
    const userRows = await pool.query(
      "SELECT 1 FROM messages WHERE user_id = $1 AND role = 'user'",
      [userId],
    );
    expect(userRows.rowCount).toBe(0); // the synthetic instruction is never saved
  });
});

describe("Non-English greeting — tiny prompt, still an LLM turn", () => {
  it("answers 200 with a spoken line (keyless mock here) and persists it", async () => {
    const { userId } = await makeUser("de", { user_name: "Jonas", preferred_language: "de" });
    const res = await greetingTurn(userId);
    expect(res.status).toBe(200);
    const content: string = res.body.choices[0].message.content;
    expect(content.length).toBeGreaterThan(0);
    // NOT a canned English pool line — this path must go through the LLM.
    const candidates = new Set(
      Object.values(GREETING_POOLS)
        .flat()
        .flatMap((t) => [t("Jonas"), t(null)]),
    );
    expect(candidates.has(content)).toBe(false);
    const rows = await persistedAssistantRows(userId);
    expect(rows).toContain(content);
  });

  it("buildGreetingPrompt is tiny, language- and name-aware, tone-aware", () => {
    const prompt = buildGreetingPrompt({
      companionName: "Nova",
      userName: "Jonas Maria Berg",
      preferredLanguage: "de",
      voiceTone: "calm",
    } as never);
    expect(prompt.stable).toContain("Nova");
    expect(prompt.stable).toContain("Jonas"); // first word of the name only
    expect(prompt.stable).not.toContain("Maria");
    expect(prompt.stable).toContain("German");
    expect(prompt.stable).toContain("calm & steady"); // tone delivery rides along
    expect(prompt.instruction).toContain("German");
    // The whole point: orders of magnitude smaller than the full frozen
    // persona/memory prompt (which is several thousand characters).
    expect(prompt.stable.length + prompt.instruction.length).toBeLessThan(800);
  });
});

describe("real turns do not take the fast path", () => {
  it("a non-empty transcript gets the full-pipeline reply (keyless mock text)", async () => {
    const { userId } = await makeUser("real", { user_name: "Ravi" });
    const res = await request(app)
      .post("/api/voice-llm/v1/chat/completions")
      .send({
        model: "gpt-4o",
        stream: false,
        messages: [{ role: "user", content: "hey, how are you tonight?" }],
        elevenlabs_extra_body: { user_token: mintVoiceToken(userId) },
      });
    expect(res.status).toBe(200);
    const content: string = res.body.choices[0].message.content;
    const candidates = new Set(
      Object.values(GREETING_POOLS)
        .flat()
        .flatMap((t) => [t("Ravi"), t(null)]),
    );
    // A real turn must never be answered with a canned greeting.
    expect(candidates.has(content)).toBe(false);
    expect(content.length).toBeGreaterThan(0);
  });
});
