// ─── Language & voice preference endpoints (Sprint 1.5) ──────────────────────
// Storage + curated-catalog validation only. Choosing a non-English language
// STORES the preference but does not change conversation behavior yet —
// Sprint 1.6 activates each language once the crisis floor's detection covers
// it. Voice ids are validated against the curated catalog so users can never
// point their profile at an arbitrary ElevenLabs voice.

import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, profileTable } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { getOrCreateProfileForUser } from "./profile.js";
import { LANGUAGES, isValidLanguage, languageByCode } from "../services/settings/languages.js";
import {
  ENGLISH_ACCENTS,
  ENGLISH_ACCENT_CODES,
  voicesFor,
  findCatalogVoice,
  isVoiceAllowed,
} from "../services/settings/voiceCatalog.js";
import { ttsUsageLimits } from "../middleware/usageLimits.js";

const router: IRouter = Router();

// ─── GET /settings/voice-options ─────────────────────────────────────────────
// Everything the language + voice pickers need in one fetch, already filtered
// to the user's companion gender. Non-English languages return no accents or
// voices yet (Sprint 1.6).

router.get("/settings/voice-options", async (req, res): Promise<void> => {
  const profile = await getOrCreateProfileForUser(req.userId);
  const language = (profile as { preferredLanguage?: string }).preferredLanguage ?? "en";
  const accent = (profile as { voiceAccent?: string | null }).voiceAccent ?? "us";
  const companionGender = (profile as { companionGender?: string }).companionGender ?? "woman";

  const accents =
    language === "en"
      ? ENGLISH_ACCENTS.map((a) => ({
          ...a,
          voices: voicesFor("en", a.code, companionGender).map((v) => ({
            voiceId: v.voiceId,
            displayName: v.displayName,
            gender: v.gender,
          })),
        }))
      : [];

  res.json({
    languages: LANGUAGES,
    currentLanguage: language,
    currentAccent: accent,
    currentVoiceId: profile.voiceId,
    companionGender,
    accents,
  });
});

// ─── POST /settings/language ─────────────────────────────────────────────────

router.post("/settings/language", async (req, res): Promise<void> => {
  const raw = (req.body as { language?: unknown } | undefined)?.language;
  const language = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!isValidLanguage(language)) {
    res.status(400).json({ error: `Unknown language code "${String(raw)}"` });
    return;
  }
  const profile = await getOrCreateProfileForUser(req.userId);
  await db
    .update(profileTable)
    .set({ preferredLanguage: language })
    .where(and(eq(profileTable.id, profile.id), eq(profileTable.userId, req.userId)));

  const info = languageByCode(language)!;
  logger.info({ userId: req.userId, language }, "settings: language preference saved");
  res.json({ ok: true, language, active: info.active });
});

// ─── POST /settings/accent ───────────────────────────────────────────────────

router.post("/settings/accent", async (req, res): Promise<void> => {
  const raw = (req.body as { accent?: unknown } | undefined)?.accent;
  const accent = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!ENGLISH_ACCENT_CODES.has(accent)) {
    res.status(400).json({ error: `Unknown accent "${String(raw)}"` });
    return;
  }
  const profile = await getOrCreateProfileForUser(req.userId);
  await db
    .update(profileTable)
    .set({ voiceAccent: accent })
    .where(and(eq(profileTable.id, profile.id), eq(profileTable.userId, req.userId)));
  logger.info({ userId: req.userId, accent }, "settings: accent preference saved");
  res.json({ ok: true, accent });
});

// ─── POST /settings/voice ────────────────────────────────────────────────────
// Saves a voice ONLY when it's in the curated catalog for the user's current
// language + accent + companion gender.

router.post("/settings/voice", async (req, res): Promise<void> => {
  const raw = (req.body as { voice_id?: unknown; voiceId?: unknown } | undefined);
  const voiceId =
    typeof raw?.voice_id === "string" ? raw.voice_id
    : typeof raw?.voiceId === "string" ? raw.voiceId
    : "";
  if (!voiceId) {
    res.status(400).json({ error: "voice_id required" });
    return;
  }
  const profile = await getOrCreateProfileForUser(req.userId);
  const language = (profile as { preferredLanguage?: string }).preferredLanguage ?? "en";
  const accent = (profile as { voiceAccent?: string | null }).voiceAccent ?? "us";
  const companionGender = (profile as { companionGender?: string }).companionGender ?? "woman";

  if (!isVoiceAllowed(voiceId, language, accent, companionGender)) {
    res.status(400).json({
      error: "That voice isn't available for your current language, accent, and companion.",
    });
    return;
  }

  await db
    .update(profileTable)
    .set({ voiceId })
    .where(and(eq(profileTable.id, profile.id), eq(profileTable.userId, req.userId)));
  logger.info({ userId: req.userId }, "settings: voice saved from curated catalog");
  res.json({ ok: true, voiceId });
});

// ─── POST /settings/voice/preview ────────────────────────────────────────────
// Speaks the voice's ~4-second preview sample. Catalog-validated (404 for
// unknown ids) BEFORE any provider call, and rate-limited like TTS.

router.post("/settings/voice/preview", ...ttsUsageLimits, async (req, res): Promise<void> => {
  const raw = (req.body as { voice_id?: unknown; voiceId?: unknown } | undefined);
  const voiceId =
    typeof raw?.voice_id === "string" ? raw.voice_id
    : typeof raw?.voiceId === "string" ? raw.voiceId
    : "";
  const voice = voiceId ? findCatalogVoice(voiceId) : undefined;
  if (!voice) {
    res.status(404).json({ error: "Unknown voice" });
    return;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "Voice previews aren't available right now." });
    return;
  }

  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice.voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: voice.previewSample,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
      }),
    });
    if (!r.ok) {
      logger.error({ status: r.status, voiceId }, "voice preview: ElevenLabs error");
      res.status(502).json({ error: "Preview failed — please try again." });
      return;
    }
    const audio = Buffer.from(await r.arrayBuffer());
    res.json({ audio: audio.toString("base64"), format: "mp3" });
  } catch (err) {
    logger.error({ err, voiceId }, "voice preview failed");
    res.status(502).json({ error: "Preview failed — please try again." });
  }
});

export default router;
