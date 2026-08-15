/**
 * Voice-settings reconciliation — the "I picked Female but Eos speaks male"
 * family (2026-08).
 *
 * Root cause: the gender/accent/language endpoints each saved their own
 * column and left profile.voice_id untouched, while every speech path (TTS
 * "Listen", the voice-call tts override) plays voice_id. These tests pin the
 * fix: any context change reconciles voice_id to a catalog voice matching
 * the new context, so what PLAYS always matches what was PICKED.
 *
 * Unit layer: reconcileVoiceForContext. Endpoint layer (DB-gated): the three
 * settings routes write the reconciled voice_id to the profile row — asserted
 * against the database, i.e. exactly what TTS and voice calls will read.
 */

import { describe, it, expect, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import app from "../app.js";
import {
  reconcileVoiceForContext,
  voicesFor,
  findCatalogVoice,
} from "../services/settings/voiceCatalog.js";

const DB = !!process.env.DATABASE_URL;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const ADAM = "pNInz6obpgDQGcFmaJgB"; // male, en/us
const ELLI = "MF3mGyEYCl7XYWbV9V6O"; // female, en/us only (not in std)
const LILY = "pFZP5JQG7iQjIQuC4Bku"; // female, en/gb (also std)

const emails: string[] = [];
async function makeAgent(tag: string) {
  const email = `voice-rec-${tag}-${Date.now()}-${emails.length}@example.invalid`;
  emails.push(email);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email, password: "Test1234!" });
  expect(res.status).toBe(201);
  const userId: number = res.body.user.id;
  await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = $1", [userId]);
  // Touch a profile row into existence, then pin a known starting voice state.
  await agent.get("/api/profile");
  return { agent, userId };
}

async function setVoiceState(
  userId: number,
  state: { voiceId?: string; voiceGender?: string | null; voiceAccent?: string; preferredLanguage?: string },
) {
  const sets: string[] = [];
  const vals: unknown[] = [userId];
  const add = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (state.voiceId !== undefined) add("voice_id", state.voiceId);
  if (state.voiceGender !== undefined) add("voice_gender", state.voiceGender);
  if (state.voiceAccent !== undefined) add("voice_accent", state.voiceAccent);
  if (state.preferredLanguage !== undefined) add("preferred_language", state.preferredLanguage);
  await pool.query(`UPDATE profile SET ${sets.join(", ")} WHERE user_id = $1`, vals);
}

async function readVoiceState(userId: number) {
  const r = await pool.query<{
    voice_id: string;
    voice_gender: string | null;
    voice_accent: string | null;
    preferred_language: string;
  }>(
    "SELECT voice_id, voice_gender, voice_accent, preferred_language FROM profile WHERE user_id = $1",
    [userId],
  );
  return r.rows[0]!;
}

afterAll(async () => {
  for (const email of emails.splice(0)) {
    const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
    if (!r.rowCount) continue;
    const uid = r.rows[0]!.id;
    await pool.query(`
      BEGIN;
      DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = '${uid}';
      DELETE FROM personalization_state WHERE user_id = ${uid};
      DELETE FROM profile WHERE user_id = ${uid};
      DELETE FROM users   WHERE id      = ${uid};
      COMMIT;
    `);
  }
  await pool.end();
});

// ─── Unit: reconcileVoiceForContext ──────────────────────────────────────────

describe("reconcileVoiceForContext", () => {
  it("keeps a voice that is already valid for the context", () => {
    const r = reconcileVoiceForContext({ currentVoiceId: ADAM, language: "en", accent: "us", gender: "male" });
    expect(r).toEqual({ voiceId: ADAM, changed: false, accent: "us" });
  });

  it("switches a male voice to the accent's first female voice on gender flip", () => {
    const r = reconcileVoiceForContext({ currentVoiceId: ADAM, language: "en", accent: "us", gender: "female" });
    expect(r.changed).toBe(true);
    expect(findCatalogVoice(r.voiceId)?.gender).toBe("female");
    expect(voicesFor("en", "us", "female").some((v) => v.voiceId === r.voiceId)).toBe(true);
  });

  it("falls back to the 'us' accent when the stored accent has no voices of the gender (gender wins)", () => {
    // Australian has NO female voices in the catalog — the honest gap.
    const r = reconcileVoiceForContext({ currentVoiceId: ADAM, language: "en", accent: "au", gender: "female" });
    expect(r.changed).toBe(true);
    expect(r.accent).toBe("us");
    expect(findCatalogVoice(r.voiceId)?.gender).toBe("female");
  });

  it("moves an English-only voice into the language's std catalog on language change", () => {
    // Elli exists only under en/us — switching to German must re-point.
    const r = reconcileVoiceForContext({ currentVoiceId: ELLI, language: "de", accent: "us", gender: "female" });
    expect(r.changed).toBe(true);
    expect(r.accent).toBe("std");
    expect(voicesFor("de", "std", "female").some((v) => v.voiceId === r.voiceId)).toBe(true);
  });

  it("keeps a shared voice across a language change when it exists in both catalogs", () => {
    // Lily is in en/gb AND every non-English std set.
    const r = reconcileVoiceForContext({ currentVoiceId: LILY, language: "fr", accent: "gb", gender: "female" });
    expect(r).toEqual({ voiceId: LILY, changed: false, accent: "std" });
  });
});

// ─── Endpoints: the row that speech paths actually read ──────────────────────

describe.skipIf(!DB)("voice settings endpoints reconcile profile.voice_id", () => {
  it("POST /settings/voice-gender female switches a stored male voice to a female one", async () => {
    const { agent, userId } = await makeAgent("gender");
    await setVoiceState(userId, { voiceId: ADAM, voiceGender: "male", voiceAccent: "us", preferredLanguage: "en" });

    const res = await agent.post("/api/settings/voice-gender").send({ gender: "female" });
    expect(res.status).toBe(200);
    expect(res.body.voiceChanged).toBe(true);

    const row = await readVoiceState(userId);
    expect(row.voice_gender).toBe("female");
    expect(findCatalogVoice(row.voice_id)?.gender).toBe("female");
  });

  it("POST /settings/voice-gender falls back off a gap accent so the gender pick still wins", async () => {
    const { agent, userId } = await makeAgent("gender-gap");
    await setVoiceState(userId, { voiceId: ADAM, voiceGender: "male", voiceAccent: "au", preferredLanguage: "en" });

    const res = await agent.post("/api/settings/voice-gender").send({ gender: "female" });
    expect(res.status).toBe(200);

    const row = await readVoiceState(userId);
    expect(findCatalogVoice(row.voice_id)?.gender).toBe("female");
    expect(row.voice_accent).toBe("us"); // au has no female voices — accent followed the possible voice
  });

  it("POST /settings/accent gb re-points an American voice at a British one of the same gender", async () => {
    const { agent, userId } = await makeAgent("accent");
    await setVoiceState(userId, { voiceId: ELLI, voiceGender: "female", voiceAccent: "us", preferredLanguage: "en" });

    const res = await agent.post("/api/settings/accent").send({ accent: "gb" });
    expect(res.status).toBe(200);
    expect(res.body.voiceChanged).toBe(true);

    const row = await readVoiceState(userId);
    expect(row.voice_accent).toBe("gb");
    expect(voicesFor("en", "gb", "female").some((v) => v.voiceId === row.voice_id)).toBe(true);
  });

  it("POST /settings/accent keeps the current voice when the accent has no voices of the gender", async () => {
    const { agent, userId } = await makeAgent("accent-gap");
    await setVoiceState(userId, { voiceId: ELLI, voiceGender: "female", voiceAccent: "us", preferredLanguage: "en" });

    const res = await agent.post("/api/settings/accent").send({ accent: "au" });
    expect(res.status).toBe(200);
    expect(res.body.voiceChanged).toBe(false);

    const row = await readVoiceState(userId);
    expect(row.voice_accent).toBe("au"); // choice saved
    expect(row.voice_id).toBe(ELLI); // voice honestly unchanged (UI shows the gap note)
  });

  it("POST /settings/language de re-points an English-only voice at a German catalog voice", async () => {
    const { agent, userId } = await makeAgent("language");
    await setVoiceState(userId, { voiceId: ELLI, voiceGender: "female", voiceAccent: "us", preferredLanguage: "en" });

    const res = await agent.post("/api/settings/language").send({ language: "de" });
    expect(res.status).toBe(200);
    expect(res.body.voiceChanged).toBe(true);

    const row = await readVoiceState(userId);
    expect(row.preferred_language).toBe("de");
    expect(voicesFor("de", "std", "female").some((v) => v.voiceId === row.voice_id)).toBe(true);
  });

  it("POST /settings/language leaves the voice alone for an INACTIVE language (still English)", async () => {
    const { agent, userId } = await makeAgent("language-inactive");
    await setVoiceState(userId, { voiceId: ELLI, voiceGender: "female", voiceAccent: "us", preferredLanguage: "en" });

    const res = await agent.post("/api/settings/language").send({ language: "fi" });
    expect(res.status).toBe(200);
    expect(res.body.voiceChanged).toBe(false);

    const row = await readVoiceState(userId);
    expect(row.voice_id).toBe(ELLI);
  });
});
