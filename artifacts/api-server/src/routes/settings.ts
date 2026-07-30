// ─── Language & voice preference endpoints ───────────────────────────────────
// Storage + curated-catalog validation. Choosing an ACTIVE language switches
// Eos's conversation, crisis detection, helpline card copy, and TTS model to
// that language (Sprint 1.6); choosing an inactive one stores the preference
// while she keeps speaking English. Voice ids are validated against the
// curated catalog so users can never point their profile at an arbitrary
// ElevenLabs voice.

import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, profileTable } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { getOrCreateProfileForUser } from "./profile.js";
import { LANGUAGES, isValidLanguage, languageByCode } from "../services/settings/languages.js";
import {
  ENGLISH_ACCENTS,
  ENGLISH_ACCENT_CODES,
  NON_ENGLISH_ACCENT,
  voicesFor,
  findCatalogVoice,
  isVoiceAllowed,
  resolveVoiceGender,
} from "../services/settings/voiceCatalog.js";
import { ttsUsageLimits } from "../middleware/usageLimits.js";

const router: IRouter = Router();

// ─── GET /settings/voice-options ─────────────────────────────────────────────
// Everything the four pickers need in one fetch, with the voice lists
// filtered by the user's voice gender (explicit voice_gender when set; legacy
// fallback derives it from companion gender). `?gender=female|male` overrides
// the filter for flows where the selection is still local — the onboarding
// card flips the gender chip before anything is saved. Non-English languages
// return no accents or voices yet (Sprint 1.6).

router.get("/settings/voice-options", async (req, res): Promise<void> => {
  const profile = await getOrCreateProfileForUser(req.userId);
  const profileLanguage = (profile as { preferredLanguage?: string }).preferredLanguage ?? "en";
  // ?language= override: the onboarding card picks a language locally before
  // anything is saved and needs that language's voices. Valid codes only.
  const langOverride = typeof req.query.language === "string" ? req.query.language.toLowerCase() : "";
  const language = isValidLanguage(langOverride) ? langOverride : profileLanguage;
  const languageActive = languageByCode(language)?.active ?? false;
  const accent = (profile as { voiceAccent?: string | null }).voiceAccent ?? "us";
  const companionGender = (profile as { companionGender?: string }).companionGender ?? "woman";
  const resolved = resolveVoiceGender(profile as { voiceGender?: string | null; companionGender?: string | null });

  const override = typeof req.query.gender === "string" ? req.query.gender : "";
  const filterGender =
    override === "female" || override === "male" ? override : resolved.gender;

  const toChip = (v: { voiceId: string; displayName: string; gender: "female" | "male" }) => ({
    voiceId: v.voiceId,
    displayName: v.displayName,
    gender: v.gender,
  });

  // English → the six real accents. Active non-English → one pseudo-accent
  // ("std") carrying that language's curated voices. Inactive → nothing (the
  // UI shows the coming-soon helper instead).
  const accents =
    language === "en"
      ? ENGLISH_ACCENTS.map((a) => ({
          ...a,
          voices: voicesFor("en", a.code, filterGender).map(toChip),
        }))
      : languageActive
        ? [
            {
              code: NON_ENGLISH_ACCENT,
              label: "",
              flag: "",
              primary: true,
              voices: voicesFor(language, NON_ENGLISH_ACCENT, filterGender).map(toChip),
            },
          ]
        : [];

  res.json({
    languages: LANGUAGES,
    currentLanguage: language,
    currentLanguageActive: languageActive,
    currentAccent: accent,
    currentVoiceId: profile.voiceId,
    companionGender,
    currentVoiceGender: resolved.gender,
    voiceGenderExplicit: resolved.explicit,
    accents,
  });
});

// ─── POST /settings/voice-gender ─────────────────────────────────────────────
// The voice's gender — a separate preference from companion gender (who she
// IS), defaulting from it but free to diverge. The current voice keeps
// playing until the user actually picks a new voice.

router.post("/settings/voice-gender", async (req, res): Promise<void> => {
  const raw = (req.body as { gender?: unknown } | undefined)?.gender;
  const gender = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (gender !== "female" && gender !== "male") {
    res.status(400).json({ error: `Unknown voice gender "${String(raw)}"` });
    return;
  }
  const profile = await getOrCreateProfileForUser(req.userId);
  await db
    .update(profileTable)
    .set({ voiceGender: gender })
    .where(and(eq(profileTable.id, profile.id), eq(profileTable.userId, req.userId)));
  logger.info({ userId: req.userId, gender }, "settings: voice gender saved");
  res.json({ ok: true, gender });
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
  // Accents are an English concept — non-English catalogs live under "std".
  const accent =
    language === "en"
      ? ((profile as { voiceAccent?: string | null }).voiceAccent ?? "us")
      : NON_ENGLISH_ACCENT;
  const voiceGender = resolveVoiceGender(
    profile as { voiceGender?: string | null; companionGender?: string | null },
  ).gender;

  if (!isVoiceAllowed(voiceId, language, accent, voiceGender)) {
    res.status(400).json({
      error: "That voice isn't available for your current language, accent, and voice gender.",
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
