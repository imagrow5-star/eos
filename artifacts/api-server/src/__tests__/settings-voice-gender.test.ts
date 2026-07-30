/**
 * Voice-gender restructure tests (real DB).
 *
 * Voice gender is a NEW, separate preference from companion gender: it
 * defaults from companion gender (boot backfill + read-time fallback) but can
 * diverge. Covers: the endpoint, voice-options filtering (incl. the ?gender
 * override the onboarding card uses), the backfill for every companion-gender
 * shape, catalog validation against the resolved gender, and the onboarding
 * card's gender field.
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { resolveVoiceGender } from "../services/settings/voiceCatalog.js";
import { backfillVoiceGender } from "../services/settings/voiceGenderBackfill.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const createdEmails: string[] = [];

const RACHEL = "21m00Tcm4TlvDq8ikWAM"; // en/us female
const ADAM = "pNInz6obpgDQGcFmaJgB"; // en/us male

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (r.rowCount === 0) return;
  const uid = r.rows[0]!.id;
  await pool.query(`DELETE FROM crisis_events WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM messages WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM email_verification_tokens WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = '${uid}'`);
  await pool.query(`DELETE FROM profile WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM users WHERE id = ${uid}`);
}

afterAll(async () => {
  await Promise.all(createdEmails.splice(0).map(cleanupUser));
  await pool.end();
});

async function makeUser(tag: string) {
  const email = `voice-gender-${tag}-${Date.now()}@example.invalid`;
  createdEmails.push(email);
  const agent = request.agent(app);
  const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signup.status).toBe(201);
  const userId: number = signup.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  await agent.get("/api/profile");
  return { agent, userId };
}

async function profileVoice(userId: number) {
  const r = await pool.query(
    "SELECT companion_gender, voice_gender, voice_id FROM profile WHERE user_id = $1",
    [userId],
  );
  return r.rows[0] as { companion_gender: string; voice_gender: string | null; voice_id: string };
}

// ─── resolveVoiceGender (pure) ───────────────────────────────────────────────

describe("resolveVoiceGender", () => {
  it("explicit voice gender wins; else derives; else female display default", () => {
    expect(resolveVoiceGender({ voiceGender: "male", companionGender: "woman" }))
      .toEqual({ gender: "male", explicit: true });
    expect(resolveVoiceGender({ voiceGender: null, companionGender: "man" }))
      .toEqual({ gender: "male", explicit: false });
    expect(resolveVoiceGender({ voiceGender: null, companionGender: "woman" }))
      .toEqual({ gender: "female", explicit: false });
    expect(resolveVoiceGender({ voiceGender: null, companionGender: "nonbinary" }))
      .toEqual({ gender: "female", explicit: false });
    expect(resolveVoiceGender({})).toEqual({ gender: "female", explicit: false });
  });
});

// ─── Endpoint ────────────────────────────────────────────────────────────────

describe("POST /settings/voice-gender", () => {
  it("requires auth", async () => {
    expect((await request(app).post("/api/settings/voice-gender").send({ gender: "female" })).status).toBe(401);
  });

  it("accepts female/male and persists; rejects anything else", async () => {
    const { agent, userId } = await makeUser("endpoint");
    for (const g of ["male", "female"] as const) {
      const res = await agent.post("/api/settings/voice-gender").send({ gender: g });
      expect(res.status).toBe(200);
      expect(res.body.gender).toBe(g);
      expect((await profileVoice(userId)).voice_gender).toBe(g);
    }
    for (const bad of ["robot", "", "FEMALEXX", 1, null]) {
      expect(
        (await agent.post("/api/settings/voice-gender").send({ gender: bad })).status,
        String(bad),
      ).toBe(400);
    }
  });
});

// ─── voice-options filtering ─────────────────────────────────────────────────

describe("GET /settings/voice-options gender filtering", () => {
  it("follows the stored voice gender even when it diverges from companion gender", async () => {
    const { agent } = await makeUser("filter");
    // Default woman companion → female voices.
    let res = await agent.get("/api/settings/voice-options");
    expect(res.body.currentVoiceGender).toBe("female");
    let us = res.body.accents.find((a: { code: string }) => a.code === "us");
    expect(us.voices.every((v: { gender: string }) => v.gender === "female")).toBe(true);

    // Flip the VOICE gender only — companion gender untouched.
    await agent.post("/api/settings/voice-gender").send({ gender: "male" });
    res = await agent.get("/api/settings/voice-options");
    expect(res.body.currentVoiceGender).toBe("male");
    expect(res.body.voiceGenderExplicit).toBe(true);
    expect(res.body.companionGender).toBe("woman");
    us = res.body.accents.find((a: { code: string }) => a.code === "us");
    expect(us.voices.length).toBeGreaterThan(0);
    expect(us.voices.every((v: { gender: string }) => v.gender === "male")).toBe(true);
  });

  it("?gender= override filters without saving (the onboarding card's path)", async () => {
    const { agent, userId } = await makeUser("override");
    // Nonbinary keeps voice_gender NULL even if the (global) backfill test
    // runs concurrently — the null assertion below must never race it.
    await pool.query("UPDATE profile SET companion_gender='nonbinary' WHERE user_id=$1", [userId]);
    const res = await agent.get("/api/settings/voice-options?gender=male");
    const us = res.body.accents.find((a: { code: string }) => a.code === "us");
    expect(us.voices.every((v: { gender: string }) => v.gender === "male")).toBe(true);
    // Nothing was stored.
    expect((await profileVoice(userId)).voice_gender).toBeNull();
  });
});

// ─── Backfill ────────────────────────────────────────────────────────────────

describe("voice_gender backfill", () => {
  it("stamps man→male, woman→female; nonbinary stays null but still gets options", async () => {
    const users = {
      man: await makeUser("bf-man"),
      woman: await makeUser("bf-woman"),
      nb: await makeUser("bf-nb"),
    };
    await pool.query("UPDATE profile SET companion_gender='man', voice_gender=NULL WHERE user_id=$1", [users.man.userId]);
    await pool.query("UPDATE profile SET companion_gender='woman', voice_gender=NULL WHERE user_id=$1", [users.woman.userId]);
    await pool.query("UPDATE profile SET companion_gender='nonbinary', voice_gender=NULL WHERE user_id=$1", [users.nb.userId]);

    await backfillVoiceGender();

    expect((await profileVoice(users.man.userId)).voice_gender).toBe("male");
    expect((await profileVoice(users.woman.userId)).voice_gender).toBe("female");
    expect((await profileVoice(users.nb.userId)).voice_gender).toBeNull();

    // Nonbinary/null still gets a working picker: female display default, not explicit.
    const res = await users.nb.agent.get("/api/settings/voice-options");
    expect(res.status).toBe(200);
    expect(res.body.currentVoiceGender).toBe("female");
    expect(res.body.voiceGenderExplicit).toBe(false);
    const us = res.body.accents.find((a: { code: string }) => a.code === "us");
    expect(us.voices.length).toBeGreaterThan(0);
  });

  it("is idempotent and never overwrites an explicit choice", async () => {
    const { agent, userId } = await makeUser("bf-idem");
    await agent.post("/api/settings/voice-gender").send({ gender: "male" }); // woman companion, explicit male
    await backfillVoiceGender();
    await backfillVoiceGender();
    expect((await profileVoice(userId)).voice_gender).toBe("male");
  });
});

// ─── Voice save respects the resolved voice gender ───────────────────────────

describe("POST /settings/voice with a diverged voice gender", () => {
  it("accepts male voices (and rejects female ones) once voice gender is male", async () => {
    const { agent, userId } = await makeUser("save");
    await agent.post("/api/settings/voice-gender").send({ gender: "male" });
    expect((await agent.post("/api/settings/voice").send({ voice_id: ADAM })).status).toBe(200);
    expect((await profileVoice(userId)).voice_id).toBe(ADAM);
    expect((await agent.post("/api/settings/voice").send({ voice_id: RACHEL })).status).toBe(400);
  });
});

// ─── Onboarding card ─────────────────────────────────────────────────────────

async function walkToVoiceStep(agent: request.Agent, companionGender: string) {
  for (const [step, answer] of [
    ["purpose", "breakup"],
    ["companionGender", companionGender],
    ["name", "Priya"],
    ["companionName", "Eos"],
  ] as Array<[string, string]>) {
    const res = await agent.post("/api/onboarding/answer").send({ step, answer });
    expect(res.status).toBe(200);
  }
}

describe("onboarding voice step with voice gender", () => {
  it("an explicit gender + matching voice persists (diverging from companion gender)", async () => {
    const { agent, userId } = await makeUser("ob-gender");
    await walkToVoiceStep(agent, "woman");
    const res = await agent.post("/api/onboarding/answer").send({
      step: "voice",
      answer: JSON.stringify({ language: "en", accent: "us", voiceGender: "male", voiceId: ADAM }),
    });
    expect(res.status).toBe(200);
    const row = await profileVoice(userId);
    expect(row.companion_gender).toBe("woman"); // untouched
    expect(row.voice_gender).toBe("male");
    expect(row.voice_id).toBe(ADAM);
  });

  it("skip stores no voice gender — the derived default keeps applying", async () => {
    const { agent, userId } = await makeUser("ob-skip");
    // Nonbinary companion: immune to the (global) backfill test running
    // concurrently, so the null assertion below can never race it.
    await walkToVoiceStep(agent, "nonbinary");
    const res = await agent.post("/api/onboarding/answer").send({ step: "voice", answer: "skip" });
    expect(res.status).toBe(200);
    const row = await profileVoice(userId);
    expect(row.voice_gender).toBeNull();
    // Reads resolve the display default (female) without marking it explicit.
    const opts = await agent.get("/api/settings/voice-options");
    expect(opts.body.currentVoiceGender).toBe("female");
    expect(opts.body.voiceGenderExplicit).toBe(false);
  });
});
