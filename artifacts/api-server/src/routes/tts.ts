/**
 * tts.ts — ElevenLabs text-to-speech proxy
 *
 * Model: eleven_multilingual_v2 (emotionally-aware, warmer delivery)
 * Voice settings tuned for warm, expressive, human presence.
 * Falls back gracefully if a voice ID is invalid or expired.
 *
 * Uses the /with-timestamps endpoint so the frontend can drive live captions.
 * Response: { audio: base64, format: "mp3", alignment?: CharAlignment }
 */

import { Router, type IRouter } from "express";
import { logger } from "../lib/logger.js";
import { isResolvedRomanticVoiceId } from "../services/voiceLibrary.js";

const router: IRouter = Router();

// ─── Premade voice allowlist ──────────────────────────────────────────────────
// These IDs work immediately without any account setup.

const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel — calm & warm

const PREMADE_VOICE_IDS = new Set([
  // Female
  "21m00Tcm4TlvDq8ikWAM", // Rachel — calm & warm (American, younger)
  "EXAVITQu4vr4xnSDxMaL", // Bella  — soft & friendly (American, younger)
  "piTKgcLEGmPE4e6mEKli", // Nicole — soft & intimate (American, younger)
  "MF3mGyEYCl7XYWbV9V6O", // Elli   — emotional & expressive (American, younger)
  "XrExE9yKIg1WjnnlVkGX", // Matilda — warm & friendly (American, mature)
  "pFZP5JQG7iQjIQuC4Bku", // Lily   — gentle (British, mature)
  "Xb7hH8MSUJpSbSDYk0k2", // Alice  — confident (British, mature)
  // Male
  "ErXwobaYiN019PkySvjV", // Antoni — warm & easy (American, younger)
  "pNInz6obpgDQGcFmaJgB", // Adam   — deep & warm (American, mature)
  "nPczCjzI2devNBz1zQrb", // Brian  — deep & comforting (American, mature)
  "TX3LPaxmHKxFdv7VOQHJ", // Liam   — natural (American)
  "JBFqnCBsd6RMkjVDRZzb", // George — warm & refined (British, mature)
  "IKne3meq5aSn9XLyUdCD", // Charlie — casual (Australian, younger)
]);

// ─── Warm voice settings ──────────────────────────────────────────────────────

const VOICE_SETTINGS = {
  stability: 0.45,        // looser = more expressive, human variation
  similarity_boost: 0.8,  // high fidelity to the voice character
  style: 0.3,             // slight style injection for emotional presence
  use_speaker_boost: true,
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

interface CharAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

interface TTSWithTimestampsResponse {
  audio_base64: string;
  alignment: CharAlignment;
  normalized_alignment: CharAlignment;
}

// ─── Helper: make a single TTS attempt (with-timestamps endpoint) ────────────

async function attemptTTS(
  apiKey: string,
  voiceId: string,
  text: string,
): Promise<
  | { ok: true; audioBase64: string; alignment: CharAlignment }
  | { ok: false; status: number; body: string }
> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/with-timestamps`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        text: text.slice(0, 5000),
        model_id: "eleven_flash_v2_5",
        voice_settings: VOICE_SETTINGS,
      }),
    },
  );

  if (res.ok) {
    const data = await res.json() as TTSWithTimestampsResponse;
    return {
      ok: true,
      audioBase64: data.audio_base64,
      alignment: data.alignment,
    };
  }
  return { ok: false, status: res.status, body: await res.text() };
}

// ─── Route ───────────────────────────────────────────────────────────────────

router.post("/tts", async (req, res): Promise<void> => {
  const { text, voiceId: requestedVoiceId } = req.body as {
    text?: string;
    voiceId?: string;
  };

  if (!text || typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: "text (non-empty string) required" });
    return;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    res
      .status(503)
      .json({ error: "ElevenLabs not configured — ELEVENLABS_API_KEY secret not set" });
    return;
  }

  // ── Resolve voice ID ────────────────────────────────────────────────────────
  // Priority (strict): explicit request voiceId > env override > default.
  // The env override (ELEVENLABS_VOICE_ID) is a global fallback ONLY — it must
  // never override an explicit, allowlisted voiceId from the request, or every
  // voice card in the picker would play the same voice regardless of selection.
  let voiceId = DEFAULT_VOICE_ID;
  const envOverride = process.env.ELEVENLABS_VOICE_ID?.trim();

  if (requestedVoiceId) {
    const isPremade = PREMADE_VOICE_IDS.has(requestedVoiceId);
    const isRomantic = isResolvedRomanticVoiceId(requestedVoiceId);
    if (isPremade || isRomantic) {
      // Explicit valid voice — use it; env override does NOT apply here
      voiceId = requestedVoiceId;
    } else {
      // Unknown/unresolved voice — fall back: env override > default
      logger.warn(
        { requestedVoiceId },
        "Requested voice ID is not in allowlist or not yet resolved — using fallback",
      );
      if (envOverride) voiceId = envOverride;
    }
  } else if (envOverride) {
    // No voiceId in request — env override applies
    voiceId = envOverride;
  }

  // ── TTS call with graceful fallback ────────────────────────────────────────
  try {
    let result = await attemptTTS(apiKey, voiceId, text);

    // Retry with default if voice has expired or is invalid (422 / 404)
    if (!result.ok && (result.status === 422 || result.status === 404) && voiceId !== DEFAULT_VOICE_ID) {
      logger.warn(
        { status: result.status, voiceId, fallback: DEFAULT_VOICE_ID },
        "Voice ID returned error — retrying with default voice",
      );
      result = await attemptTTS(apiKey, DEFAULT_VOICE_ID, text);
    }

    if (!result.ok) {
      logger.error(
        { status: result.status, voiceId, body: result.body },
        "ElevenLabs API returned error",
      );
      res.status(502).json({
        error: "ElevenLabs API error",
        detail: result.body,
        httpStatus: result.status,
      });
      return;
    }

    logger.info({ voiceId, chars: text.length }, "TTS audio generated");
    res.json({
      audio: result.audioBase64,
      format: "mp3",
      alignment: result.alignment,
    });
  } catch (err) {
    logger.error({ err, voiceId }, "ElevenLabs fetch threw an error");
    res.status(502).json({ error: "TTS request failed — check server logs" });
  }
});

export default router;
