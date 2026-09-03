/**
 * Sprint 1.5 — language & voice picker integration tests (real DB, no
 * ElevenLabs key: previews answer 503 AFTER catalog validation, so unknown
 * ids still 404 deterministically).
 *
 * Covers: backfill defaults, the voice-options payload, validation on all
 * four POST endpoints (incl. auth), catalog gating by language+accent+gender,
 * and the new onboarding "voice" step (skippable with defaults; a real pick
 * persists; the rest of the flow is untouched).
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import { LANGUAGES } from "../services/settings/languages.js";
import { ENGLISH_ACCENTS, voicesFor, allCatalogVoiceIds } from "../services/settings/voiceCatalog.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const createdEmails: string[] = [];

const RACHEL = "21m00Tcm4TlvDq8ikWAM"; // en/us female
const LILY = "pFZP5JQG7iQjIQuC4Bku"; // en/gb female
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
  const email = `settings-voice-${tag}-${Date.now()}@example.invalid`;
  createdEmails.push(email);
  const agent = request.agent(app);
  const signup = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(signup.status).toBe(201);
  const userId: number = signup.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  await agent.get("/api/profile"); // creates the profile row
  return { agent, userId };
}

async function profileRow(userId: number) {
  const r = await pool.query(
    "SELECT preferred_language, voice_accent, voice_id, companion_gender, onboarding_step FROM profile WHERE user_id = $1",
    [userId],
  );
  return r.rows[0] as {
    preferred_language: string;
    voice_accent: string | null;
    voice_id: string;
    companion_gender: string;
    onboarding_step: string;
  };
}

// ─── Catalog invariants ──────────────────────────────────────────────────────

describe("voice catalog config", () => {
  it("English accents: 6 codes, 4 primary", () => {
    expect(ENGLISH_ACCENTS.map((a) => a.code).sort()).toEqual(["au", "ca", "gb", "ie", "in", "us"]);
    expect(ENGLISH_ACCENTS.filter((a) => a.primary)).toHaveLength(4);
  });

  it("gender filtering: woman → female voices, man → male, nonbinary → both", () => {
    const women = voicesFor("en", "us", "woman");
    const men = voicesFor("en", "us", "man");
    const both = voicesFor("en", "us", "nonbinary");
    expect(women.length).toBeGreaterThan(0);
    expect(women.every((v) => v.gender === "female")).toBe(true);
    expect(men.every((v) => v.gender === "male")).toBe(true);
    expect(both.length).toBe(women.length + men.length);
  });

  it("every catalog voice carries a preview sample and warm display name", () => {
    expect(allCatalogVoiceIds().size).toBeGreaterThanOrEqual(25);
    for (const accent of ENGLISH_ACCENTS) {
      for (const v of voicesFor("en", accent.code, "nonbinary")) {
        expect(v.displayName.length).toBeGreaterThan(3);
        expect(v.previewSample.length).toBeGreaterThan(10);
      }
    }
  });

  it("active non-English languages carry a curated 'std' voice set; inactive ones stay empty", () => {
    for (const l of LANGUAGES.filter((x) => x.code !== "en")) {
      const voices = voicesFor(l.code, "std", "nonbinary");
      if (l.active) {
        expect(voices.length, l.code).toBeGreaterThanOrEqual(6);
      } else {
        expect(voices, l.code).toEqual([]);
      }
    }
  });
});

// ─── Auth ────────────────────────────────────────────────────────────────────

describe("settings endpoints require auth", () => {
  it("401s without a session", async () => {
    expect((await request(app).get("/api/settings/voice-options")).status).toBe(401);
    expect((await request(app).post("/api/settings/language").send({ language: "en" })).status).toBe(401);
    expect((await request(app).post("/api/settings/accent").send({ accent: "us" })).status).toBe(401);
    expect((await request(app).post("/api/settings/voice").send({ voice_id: RACHEL })).status).toBe(401);
    expect((await request(app).post("/api/settings/voice/preview").send({ voice_id: RACHEL })).status).toBe(401);
  });
});

// ─── Backfill + voice-options ────────────────────────────────────────────────

describe("backfill defaults + voice options", () => {
  it("a fresh profile gets en / us and the existing default voice — no behavior change", async () => {
    const { agent, userId } = await makeUser("backfill");
    const row = await profileRow(userId);
    expect(row.preferred_language).toBe("en");
    expect(row.voice_accent).toBe("us");
    expect(row.voice_id).toBeTruthy(); // the pre-existing column default — untouched

    const res = await agent.get("/api/settings/voice-options");
    expect(res.status).toBe(200);
    // English + Spanish only since the ElevenLabs sunset (languages.ts).
    expect(res.body.languages).toHaveLength(2);
    const active = res.body.languages.filter((l: { active: boolean }) => l.active);
    expect(active).toHaveLength(2);
    expect(active.map((l: { code: string }) => l.code)).toEqual(["en", "es"]);
    expect(res.body.currentLanguage).toBe("en");
    expect(res.body.currentAccent).toBe("us");
    // Default companion is a woman → only female voices offered.
    const us = res.body.accents.find((a: { code: string }) => a.code === "us");
    expect(us.voices.length).toBeGreaterThan(0);
    expect(us.voices.every((v: { gender: string }) => v.gender === "female")).toBe(true);
  });
});

// ─── Language sunset boot backfill ───────────────────────────────────────────

describe("backfillLanguageSunset", () => {
  it("moves removed-language rows to English and leaves en/es untouched", async () => {
    const { userId: deUser } = await makeUser("sunset-de");
    const { userId: esUser } = await makeUser("sunset-es");
    const { userId: enUser } = await makeUser("sunset-en");
    await pool.query("UPDATE profile SET preferred_language='de' WHERE user_id=$1", [deUser]);
    await pool.query("UPDATE profile SET preferred_language='es' WHERE user_id=$1", [esUser]);

    const { backfillLanguageSunset } = await import("../services/settings/languageSunset.js");
    await backfillLanguageSunset();

    expect((await profileRow(deUser)).preferred_language).toBe("en");
    expect((await profileRow(esUser)).preferred_language).toBe("es");
    expect((await profileRow(enUser)).preferred_language).toBe("en");
  });
});

// ─── Language endpoint ───────────────────────────────────────────────────────

describe("POST /settings/language", () => {
  it("accepts every configured code and stores it, reporting the live active flag", async () => {
    const { agent, userId } = await makeUser("langs");
    for (const l of LANGUAGES) {
      const res = await agent.post("/api/settings/language").send({ language: l.code });
      expect(res.status, l.code).toBe(200);
      expect(res.body.active, l.code).toBe(l.active);
      expect((await profileRow(userId)).preferred_language).toBe(l.code);
    }
  });

  it("rejects unknown codes", async () => {
    const { agent } = await makeUser("badlang");
    for (const bad of ["xx", "EN-US", "", 42, null]) {
      const res = await agent.post("/api/settings/language").send({ language: bad });
      expect(res.status, String(bad)).toBe(400);
    }
  });
});

// ─── Accent endpoint ─────────────────────────────────────────────────────────

describe("POST /settings/accent", () => {
  it("accepts the 6 English accents, rejects others", async () => {
    const { agent, userId } = await makeUser("accent");
    for (const a of ENGLISH_ACCENTS) {
      const res = await agent.post("/api/settings/accent").send({ accent: a.code });
      expect(res.status, a.code).toBe(200);
      expect((await profileRow(userId)).voice_accent).toBe(a.code);
    }
    expect((await agent.post("/api/settings/accent").send({ accent: "zz" })).status).toBe(400);
    expect((await agent.post("/api/settings/accent").send({})).status).toBe(400);
  });
});

// ─── Voice endpoint ──────────────────────────────────────────────────────────

describe("POST /settings/voice", () => {
  it("saves a curated voice matching language+accent+gender; rejects everything else", async () => {
    const { agent, userId } = await makeUser("voice");

    // Default woman companion, accent us → Rachel is valid.
    const ok = await agent.post("/api/settings/voice").send({ voice_id: RACHEL });
    expect(ok.status).toBe(200);
    expect((await profileRow(userId)).voice_id).toBe(RACHEL);

    // Arbitrary ElevenLabs id — never allowed.
    expect(
      (await agent.post("/api/settings/voice").send({ voice_id: "ZZtotallyMadeUpVoice00" })).status,
    ).toBe(400);

    // Wrong accent: Lily is British; user is on us.
    expect((await agent.post("/api/settings/voice").send({ voice_id: LILY })).status).toBe(400);

    // Wrong gender for a woman companion: Adam is male.
    expect((await agent.post("/api/settings/voice").send({ voice_id: ADAM })).status).toBe(400);

    // Switch accent to gb → Lily becomes valid.
    await agent.post("/api/settings/accent").send({ accent: "gb" });
    expect((await agent.post("/api/settings/voice").send({ voice_id: LILY })).status).toBe(200);
    expect((await profileRow(userId)).voice_id).toBe(LILY);

    // The saved voice never leaked outside the catalog either way.
    expect((await profileRow(userId)).voice_id).not.toBe("ZZtotallyMadeUpVoice00");
  });
});

// ─── Preview endpoint ────────────────────────────────────────────────────────

describe("POST /settings/voice/preview", () => {
  it("404s for unknown voices (validation runs before the provider call)", async () => {
    const { agent } = await makeUser("preview404");
    const res = await agent.post("/api/settings/voice/preview").send({ voice_id: "nope123" });
    expect(res.status).toBe(404);
  });

  it("503s for a valid voice when ElevenLabs isn't configured (test env has no key)", async () => {
    const { agent } = await makeUser("preview503");
    expect(process.env.ELEVENLABS_API_KEY ?? "").toBe("");
    const res = await agent.post("/api/settings/voice/preview").send({ voice_id: RACHEL });
    expect(res.status).toBe(503);
  });
});

// ─── Onboarding voice step ───────────────────────────────────────────────────

async function walkToVoiceStep(agent: request.Agent) {
  const answers: Array<[string, string]> = [
    ["purpose", "breakup"],
    ["companionGender", "woman"],
    ["name", "Priya"],
    ["companionName", "Eos"],
  ];
  let status: { currentStep: string } = { currentStep: "" };
  for (const [step, answer] of answers) {
    const res = await agent.post("/api/onboarding/answer").send({ step, answer });
    expect(res.status).toBe(200);
    status = res.body;
  }
  return status;
}

describe("onboarding voice step", () => {
  it("appears after companionName; skip keeps every default and advances to age", async () => {
    const { agent, userId } = await makeUser("ob-skip");
    const status = await walkToVoiceStep(agent);
    expect(status.currentStep).toBe("voice");

    const before = await profileRow(userId);
    const res = await agent.post("/api/onboarding/answer").send({ step: "voice", answer: "skip" });
    expect(res.status).toBe(200);
    expect(res.body.currentStep).toBe("ageBand");

    const after = await profileRow(userId);
    expect(after.preferred_language).toBe("en");
    expect(after.voice_accent).toBe("us");
    expect(after.voice_id).toBe(before.voice_id); // gender default untouched

    // The rest of the flow still completes exactly as before.
    const age = await agent.post("/api/onboarding/answer").send({ step: "ageBand", answer: "27" });
    expect(age.status).toBe(200);
    const country = await agent.post("/api/onboarding/answer").send({ step: "country", answer: "skip" });
    expect(country.status).toBe(200);
    const gender = await agent.post("/api/onboarding/answer").send({ step: "userGender", answer: "skip" });
    expect(gender.status).toBe(200);
    expect(gender.body.isComplete).toBe(true);
  });

  it("a real pick (English + British + Lily) persists; invalid voice ids are ignored", async () => {
    const { agent, userId } = await makeUser("ob-pick");
    await walkToVoiceStep(agent);

    const res = await agent.post("/api/onboarding/answer").send({
      step: "voice",
      answer: JSON.stringify({ language: "en", accent: "gb", voiceId: LILY }),
    });
    expect(res.status).toBe(200);
    expect(res.body.currentStep).toBe("ageBand");
    const row = await profileRow(userId);
    expect(row.preferred_language).toBe("en");
    expect(row.voice_accent).toBe("gb");
    expect(row.voice_id).toBe(LILY);
  });

  it("a non-English choice is stored, defaults hold elsewhere, and a bogus voice never lands", async () => {
    const { agent, userId } = await makeUser("ob-de");
    await walkToVoiceStep(agent);
    const before = await profileRow(userId);

    const res = await agent.post("/api/onboarding/answer").send({
      step: "voice",
      answer: JSON.stringify({ language: "es", voiceId: "ZZfakeVoice" }),
    });
    expect(res.status).toBe(200);
    const row = await profileRow(userId);
    expect(row.preferred_language).toBe("es"); // the one non-English language left
    expect(row.voice_accent).toBe("us");
    expect(row.voice_id).toBe(before.voice_id); // bogus id ignored
  });
});
