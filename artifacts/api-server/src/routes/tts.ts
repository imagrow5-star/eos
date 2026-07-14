import { Router, type IRouter } from "express";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// Default: Sarah — warm, natural, friendly female voice from ElevenLabs premade library
const DEFAULT_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";

// All curated premade voices available in the voice picker (female + male)
const ALLOWED_VOICE_IDS = new Set([
  // Female
  "EXAVITQu4vr4xnSDxMaL", // Sarah — soft & warm (younger)
  "XrExE9yKIg1WjnnlVkGX", // Matilda — bright & friendly (younger)
  "pFZP5JQG7iQjIQuC4Bku", // Lily — gentle, British
  "21m00Tcm4TlvDq8ikWAM", // Rachel — calm & grounded (mature)
  "Xb7hH8MSUJpSbSDYk0k2", // Alice — confident, British (mature)
  // Male
  "ErXwobaYiN019PkySvjV", // Antoni — warm & easy (younger)
  "IKne3meq5aSn9XLyUdCD", // Charlie — casual, Australian (younger)
  "pNInz6obpgDQGcFmaJgB", // Adam — deep & warm (mature)
  "JBFqnCBsd6RMkjVDRZzb", // George — warm, British (mature)
  "VR6AewLTigWG4xSOukaG", // Arnold — crisp & steady (mature)
]);

router.post("/tts", async (req, res): Promise<void> => {
  const { text, voiceId: requestedVoiceId } = req.body as { text?: string; voiceId?: string };

  if (!text || typeof text !== "string" || !text.trim()) {
    res.status(400).json({ error: "text (non-empty string) required" });
    return;
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "ElevenLabs not configured — ELEVENLABS_API_KEY secret not set" });
    return;
  }

  // Priority: request body voiceId → env override → default
  let voiceId = DEFAULT_VOICE_ID;
  if (requestedVoiceId && ALLOWED_VOICE_IDS.has(requestedVoiceId)) {
    voiceId = requestedVoiceId;
  } else if (process.env.ELEVENLABS_VOICE_ID?.trim()) {
    voiceId = process.env.ELEVENLABS_VOICE_ID.trim();
  }

  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text: text.slice(0, 5000), // ElevenLabs hard cap
          model_id: "eleven_turbo_v2_5",
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.75,
            style: 0.15,
            use_speaker_boost: true,
          },
        }),
      },
    );

    if (!response.ok) {
      const errBody = await response.text();
      logger.error(
        { status: response.status, voiceId, body: errBody },
        "ElevenLabs API returned error",
      );
      res.status(502).json({
        error: "ElevenLabs API error",
        detail: errBody,
        httpStatus: response.status,
      });
      return;
    }

    const buffer = await response.arrayBuffer();
    const base64 = Buffer.from(buffer).toString("base64");

    logger.info({ voiceId, chars: text.length }, "TTS audio generated");
    res.json({ audio: base64, format: "mp3" });
  } catch (err) {
    logger.error({ err, voiceId }, "ElevenLabs fetch threw an error");
    res.status(502).json({ error: "TTS request failed — check server logs" });
  }
});

export default router;
