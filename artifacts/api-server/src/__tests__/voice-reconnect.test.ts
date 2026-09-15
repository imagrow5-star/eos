/**
 * Mid-call reconnect (voice audit, PR 3) — routes/voice-llm.ts.
 *
 * Hume's reconnecting socket redials into a NEW EVI chat whose first CLM
 * request is an empty transcript, like a fresh call's. What must hold:
 *   • the FIRST empty-transcript request of a call greets (curated pool line,
 *     persisted) — and so does a double-fired greeting before anyone spoke;
 *   • an empty transcript AFTER the person has spoken in this call (same
 *     token, same issuedAt) gets the one resume line, in the profile's
 *     language, and it is NOT persisted;
 *   • the next real turn, whose transcript opens with the resume line, gets
 *     the pre-drop turns back as context (from the DB) and the resume line
 *     itself never reaches the model;
 *   • a genuinely new call (fresh token) still greets.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { logger } from "../lib/logger.js";
import { mintVoiceToken } from "../lib/voiceToken.js";
import { GREETING_POOLS } from "../services/voiceGreeting.js";
import { RESUME_LINES, resumeLineFor, isResumeLine } from "../services/voiceResume.js";
import { isEncrypted, decryptText } from "@workspace/db";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const emails: string[] = [];

async function makeUser(tag: string, patch: Record<string, unknown> = {}) {
  const email = `reconnect-${tag}-${Date.now()}@example.invalid`;
  emails.push(email);
  const agent = request.agent(app);
  const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signup.status).toBe(201);
  const userId: number = signup.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  const prof = await agent.get("/api/profile");
  expect(prof.status).toBe(200);
  for (const [col, val] of Object.entries({ user_name: "Nadia", ...patch })) {
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

type Turn = { role: "user" | "assistant"; content: string };

function voiceTurn(userToken: string, messages: Turn[]) {
  return request(app)
    .post("/api/voice-llm/v1/chat/completions")
    .send({ model: "gpt-4o", stream: false, messages, elevenlabs_extra_body: { user_token: userToken } });
}

async function rows(userId: number, role: "user" | "assistant"): Promise<string[]> {
  const { rows } = await pool.query<{ content: string }>(
    "SELECT content FROM messages WHERE user_id = $1 AND role = $2 ORDER BY created_at, id",
    [userId, role],
  );
  return rows.map((r) => (isEncrypted(r.content) ? decryptText(r.content, "messages.content") : r.content));
}

/** persistVoiceTurn is fire-and-forget — wait until a row with this text exists. */
async function waitForRow(userId: number, role: "user" | "assistant", text: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if ((await rows(userId, role)).includes(text)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`row never persisted: ${role} "${text}"`);
}

const greetingCandidates = new Set(
  Object.values(GREETING_POOLS).flat().flatMap((t) => [t("Nadia"), t(null)]),
);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("resume line copy", () => {
  it("has one gender-neutral line per supported language and recognises every one", () => {
    expect(Object.keys(RESUME_LINES).sort()).toEqual(["da", "de", "en", "es", "fr", "it", "nl", "no", "pl", "pt", "sv"]);
    for (const line of Object.values(RESUME_LINES)) {
      expect(isResumeLine(line)).toBe(true);
      expect(isResumeLine(`  ${line}  `)).toBe(true);
      expect(line.split(/\s+/).length).toBeLessThanOrEqual(10);
    }
    expect(resumeLineFor("de")).toBe(RESUME_LINES.de);
    expect(resumeLineFor("xx")).toBe(RESUME_LINES.en);
    expect(resumeLineFor(undefined)).toBe(RESUME_LINES.en);
    expect(isResumeLine("Sorry, I lost you.")).toBe(false);
  });
});

describe("empty transcript: greeting vs resume", () => {
  it("greets on a fresh call (and on a double-fired greeting before anyone spoke), resumes after the person has spoken, and does not store the resume line", async () => {
    const { userId } = await makeUser("en");
    const token = mintVoiceToken(userId);

    const g1 = await voiceTurn(token, []);
    expect(g1.status).toBe(200);
    const greeting: string = g1.body.choices[0].message.content;
    expect(greetingCandidates.has(greeting)).toBe(true);
    await waitForRow(userId, "assistant", greeting);

    // Double fire before any speech: still a greeting, never the resume line.
    const g2 = await voiceTurn(token, []);
    expect(greetingCandidates.has(g2.body.choices[0].message.content)).toBe(true);

    // The person speaks.
    const said = "my cat is called Biscuit and she hates the rain";
    const t1 = await voiceTurn(token, [{ role: "assistant", content: greeting }, { role: "user", content: said }]);
    expect(t1.status).toBe(200);
    const reply1: string = t1.body.choices[0].message.content;
    expect(reply1.length).toBeGreaterThan(0);
    await waitForRow(userId, "user", said);
    await waitForRow(userId, "assistant", reply1);
    const assistantBefore = await rows(userId, "assistant");

    // Network blip: Hume redials into a new chat → empty transcript, SAME token.
    const spy = vi.spyOn(logger, "info");
    let r: request.Response;
    try {
      r = await voiceTurn(token, []);
      expect(r.status).toBe(200);
      const line = (spy.mock.calls as unknown as [Record<string, unknown>, string][])
        .filter((c) => c[1] === "voice turn timing" && c[0]?.greeting === true)
        .map((c) => c[0]);
      expect(line).toHaveLength(1);
      expect(line[0]).toMatchObject({ greeting: true, reconnect: true, curated: false });
    } finally {
      spy.mockRestore();
    }
    expect(r.body.choices[0].message.content).toBe(RESUME_LINES.en);

    // Not persisted: give the (non-existent) write a moment, then compare.
    await sleep(300);
    expect(await rows(userId, "assistant")).toEqual(assistantBefore);
    expect((await rows(userId, "assistant")).some(isResumeLine)).toBe(false);
  });

  it("speaks the resume line in the profile's language", async () => {
    const { userId } = await makeUser("de", { preferred_language: "de" });
    const token = mintVoiceToken(userId);
    const g = await voiceTurn(token, []);
    expect(g.status).toBe(200);
    const said = "ich habe heute meine Schwester angerufen";
    const t = await voiceTurn(token, [{ role: "assistant", content: g.body.choices[0].message.content }, { role: "user", content: said }]);
    expect(t.status).toBe(200);
    await waitForRow(userId, "user", said);

    const r = await voiceTurn(token, []);
    expect(r.status).toBe(200);
    expect(r.body.choices[0].message.content).toBe(RESUME_LINES.de);
  });

  it("a genuinely new call (fresh token) still greets even though older calls have rows", async () => {
    const { userId } = await makeUser("newcall");
    const token = mintVoiceToken(userId);
    const g = await voiceTurn(token, []);
    const said = "quick one before bed";
    await voiceTurn(token, [{ role: "assistant", content: g.body.choices[0].message.content }, { role: "user", content: said }]);
    await waitForRow(userId, "user", said);

    await sleep(1100); // the token's issuedAt has second granularity — start the next call in a later second
    const later = mintVoiceToken(userId);
    const g2 = await voiceTurn(later, []);
    expect(g2.status).toBe(200);
    expect(greetingCandidates.has(g2.body.choices[0].message.content)).toBe(true);
  });
});

describe("the turn after a reconnect", () => {
  it("puts the pre-drop turns back as context and keeps the resume line out of it", async () => {
    const { userId } = await makeUser("context");
    const token = mintVoiceToken(userId);
    const g = await voiceTurn(token, []);
    const greeting: string = g.body.choices[0].message.content;
    const said = "I finally handed in the thesis this morning";
    const t1 = await voiceTurn(token, [{ role: "assistant", content: greeting }, { role: "user", content: said }]);
    const reply1: string = t1.body.choices[0].message.content;
    await waitForRow(userId, "user", said);
    await waitForRow(userId, "assistant", reply1);

    // Reconnect: resume line spoken, then the person carries on in the NEW
    // chat, whose transcript is only [resume line, new utterance].
    const resume = await voiceTurn(token, []);
    expect(resume.body.choices[0].message.content).toBe(RESUME_LINES.en);

    const spy = vi.spyOn(logger, "info");
    try {
      const t2 = await voiceTurn(token, [
        { role: "assistant", content: RESUME_LINES.en },
        { role: "user", content: "so what do you think I should do to celebrate" },
      ]);
      expect(t2.status).toBe(200);
      const lines = (spy.mock.calls as unknown as [Record<string, unknown>, string][])
        .filter((c) => c[1] === "voice turn timing" && c[0]?.greeting === false)
        .map((c) => c[0]);
      expect(lines).toHaveLength(1);
      // Context = the pre-drop exchange (user + assistant) from the DB; the
      // resume line is stripped, so nothing else is in there.
      expect(lines[0]).toMatchObject({ resumed: true, contextTurns: 2 });
    } finally {
      spy.mockRestore();
    }

    // A normal (non-reconnect) turn with the same history pays no extra work
    // and sees only its own transcript.
    const spy2 = vi.spyOn(logger, "info");
    try {
      const t3 = await voiceTurn(token, [
        { role: "assistant", content: greeting },
        { role: "user", content: said },
        { role: "assistant", content: reply1 },
        { role: "user", content: "and one more thing" },
      ]);
      expect(t3.status).toBe(200);
      const [line] = (spy2.mock.calls as unknown as [Record<string, unknown>, string][])
        .filter((c) => c[1] === "voice turn timing" && c[0]?.greeting === false)
        .map((c) => c[0]);
      expect(line).toMatchObject({ resumed: false, contextTurns: 2 });
    } finally {
      spy2.mockRestore();
    }
  });
});
