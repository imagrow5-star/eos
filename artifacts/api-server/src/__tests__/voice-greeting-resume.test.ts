/**
 * Second call within hours (services/voiceGreeting.ts, routes/voice-llm.ts).
 * "Hi, I'm glad you called. How are you?" on a second call the same day reads
 * as forgetting. What must hold:
 *   • within RESUME_GREETING_WINDOW_MS of the last message, the curated
 *     greeting comes from the resume pool; outside it, from the usual pools;
 *   • resume lines obey the greeting rules: short, no specifics, no claim to
 *     remember what was said;
 *   • a mid-call reconnect still wins (resume LINE, not a greeting);
 *   • the greeting timing line says resumeGreeting.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { logger } from "../lib/logger.js";
import { mintVoiceToken } from "../lib/voiceToken.js";
import { GREETING_POOLS, buildVoiceFirstMessage, isResumeGreeting, RESUME_GREETING_WINDOW_MS } from "../services/voiceGreeting.js";
import { db, messagesTable } from "@workspace/db";

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

const resumeLines = new Set(GREETING_POOLS.resume.flatMap((t) => [t("Naveen"), t(null)]));
const freshLines = new Set([...GREETING_POOLS.morning, ...GREETING_POOLS.evening, ...GREETING_POOLS.anytime].flatMap((t) => [t("Naveen"), t(null)]));

describe("resume greeting rule", () => {
  it("picks up within the window and greets afresh outside it", () => {
    const now = new Date("2026-09-15T07:00:00Z");
    expect(isResumeGreeting(new Date("2026-09-15T05:30:00Z"), now)).toBe(true);
    expect(isResumeGreeting(new Date(now.getTime() - RESUME_GREETING_WINDOW_MS + 1000), now)).toBe(true);
    expect(isResumeGreeting(new Date(now.getTime() - RESUME_GREETING_WINDOW_MS - 1000), now)).toBe(false);
    expect(isResumeGreeting(new Date("2026-09-13T07:00:00Z"), now)).toBe(false);
    expect(isResumeGreeting(null, now)).toBe(false);
    expect(isResumeGreeting(new Date(now.getTime() + 60_000), now)).toBe(false); // clock skew: never
    expect(RESUME_GREETING_WINDOW_MS).toBe(8 * 60 * 60 * 1000);
  });

  it("buildVoiceFirstMessage draws from the resume pool only when recent", () => {
    const profile = { userName: "Naveen Kumar", timezone: "Asia/Kolkata" } as never;
    const now = new Date("2026-09-15T07:00:00Z");
    for (let i = 0; i < 20; i++) {
      const rng = () => i / 20;
      expect(resumeLines.has(buildVoiceFirstMessage(profile, { now, rng, lastTalkedAt: new Date("2026-09-15T04:00:00Z") }))).toBe(true);
      expect(freshLines.has(buildVoiceFirstMessage(profile, { now, rng, lastTalkedAt: new Date("2026-09-14T04:00:00Z") }))).toBe(true);
      expect(freshLines.has(buildVoiceFirstMessage(profile, { now, rng }))).toBe(true);
    }
  });

  it("resume lines are short, use the first name only, and claim no specifics", () => {
    for (const t of GREETING_POOLS.resume) {
      for (const line of [t("Naveen"), t(null)]) {
        expect(line.split(/\s+/).length).toBeLessThanOrEqual(10);
        expect(line).not.toMatch(/remember|yesterday|last time you said|you told me/i);
        expect(line).not.toMatch(/how are you\?/i); // the thing that read as forgetting
      }
      expect(t("Naveen")).toContain("Naveen");
      expect(t(null)).not.toContain("Naveen");
    }
  });
});

async function makeUser(tag: string, lastMessageAgoMs: number | null) {
  const email = `greet-resume-${tag}-${Date.now()}@example.invalid`;
  emails.push(email);
  const agent = request.agent(app);
  const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signup.status).toBe(201);
  const userId: number = signup.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  expect((await agent.get("/api/profile")).status).toBe(200);
  await pool.query("UPDATE profile SET user_name = $1 WHERE user_id = $2", ["Naveen", userId]);
  if (lastMessageAgoMs !== null) {
    const at = new Date(Date.now() - lastMessageAgoMs);
    await db.insert(messagesTable).values([
      { userId, role: "user", content: "just checking in", isMorningNote: false, createdAt: at },
      { userId, role: "assistant", content: "Good to hear from you.", isMorningNote: false, createdAt: new Date(at.getTime() + 1000) },
    ]);
  }
  return { userId };
}

type LogCall = [Record<string, unknown>, string];
async function greet(userId: number) {
  const spy = vi.spyOn(logger, "info");
  try {
    const res = await request(app)
      .post("/api/voice-llm/v1/chat/completions")
      .send({ model: "gpt-4o", stream: false, messages: [], elevenlabs_extra_body: { user_token: mintVoiceToken(userId) } });
    expect(res.status).toBe(200);
    const line = (spy.mock.calls as unknown as LogCall[]).find((c) => c[1] === "voice turn timing" && c[0]?.greeting === true)?.[0];
    return { text: res.body.choices[0].message.content as string, line };
  } finally {
    spy.mockRestore();
  }
}

describe.skipIf(!process.env.DATABASE_URL)("voice route greeting", () => {
  it("a call two hours after the last conversation picks up; a call two days later greets afresh; a first call greets", async () => {
    const recent = await makeUser("recent", 2 * 60 * 60 * 1000);
    const r = await greet(recent.userId);
    expect(resumeLines.has(r.text), r.text).toBe(true);
    expect(r.line).toMatchObject({ resumeGreeting: true, curated: true });

    const old = await makeUser("old", 2 * 24 * 60 * 60 * 1000);
    const o = await greet(old.userId);
    expect(freshLines.has(o.text), o.text).toBe(true);
    expect(o.line).toMatchObject({ resumeGreeting: false });

    const first = await makeUser("first", null);
    const f = await greet(first.userId);
    expect(freshLines.has(f.text), f.text).toBe(true);
    expect(f.line).toMatchObject({ resumeGreeting: false });
  });
});
