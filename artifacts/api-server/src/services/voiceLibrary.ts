/**
 * voiceLibrary.ts
 * Manages ElevenLabs community/Voice-Library romantic voices.
 * These must be added to the account before they can be used for TTS.
 * Premade voices (Rachel, Bella, etc.) do NOT need this — they work directly.
 */

import { logger } from "../lib/logger.js";

// ─── Romantic voice catalogue ─────────────────────────────────────────────────

export interface RomanticVoiceConfig {
  /** The ElevenLabs Voice Library public voice ID (not usable for TTS directly) */
  libraryId: string;
  /** Display name used for name-matching when checking existing account voices */
  name: string;
  /** UI label shown in the picker */
  label: string;
  /** Accent / character descriptor shown in the picker */
  desc: string;
  gender: "female" | "male";
}

export const ROMANTIC_VOICES: RomanticVoiceConfig[] = [
  {
    libraryId: "qT3qfGZ0g0ss8WV5908L",
    name: "Sahara",
    label: "Sahara",
    desc: "velvety & soothing (American)",
    gender: "female",
  },
  {
    libraryId: "S9EGwlCtMF7VXtENq79v",
    name: "Emma",
    label: "Emma",
    desc: "soft & tender (British)",
    gender: "female",
  },
  {
    libraryId: "LruHrtVF6PSyGItzMNHS",
    name: "Benjamin",
    label: "Benjamin",
    desc: "gentle & warm (American)",
    gender: "male",
  },
];

// ─── Runtime resolution map (libraryId → account voice_id) ───────────────────

/** Maps each romantic libraryId → resolved account voice_id (stable per-account) */
const resolvedMap = new Map<string, string>();

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Call once at server startup (non-blocking — errors are caught and logged).
 * Populates resolvedMap so the TTS route can use account voice IDs.
 */
export async function initVoiceLibrary(apiKey: string): Promise<void> {
  try {
    const existing = await fetchAccountVoices(apiKey);

    for (const voice of ROMANTIC_VOICES) {
      // Check if this romantic voice is already in the account (matched by name)
      const found = existing.find(
        (v) => v.name.toLowerCase() === voice.name.toLowerCase(),
      );
      if (found) {
        resolvedMap.set(voice.libraryId, found.voice_id);
        logger.info(
          { accountVoiceId: found.voice_id, name: voice.name },
          "Romantic voice already in account",
        );
        continue;
      }

      // Not in account yet — try to add from Voice Library
      try {
        const accountId = await addFromLibrary(apiKey, voice);
        if (accountId) {
          resolvedMap.set(voice.libraryId, accountId);
          logger.info(
            { libraryId: voice.libraryId, accountVoiceId: accountId, name: voice.name },
            "Romantic voice added to account",
          );
        }
      } catch (err) {
        logger.warn(
          { err, libraryId: voice.libraryId, name: voice.name },
          "Could not add romantic voice — will skip gracefully",
        );
      }
    }
  } catch (err) {
    logger.error({ err }, "Voice library init failed — romantic voices will be unavailable");
  }
}

/**
 * Returns true if the given voice_id is a resolved romantic account voice ID
 * (safe to use for TTS directly).
 */
export function isResolvedRomanticVoiceId(voiceId: string): boolean {
  for (const accountId of resolvedMap.values()) {
    if (accountId === voiceId) return true;
  }
  return false;
}

export interface RomanticVoiceStatus {
  libraryId: string;
  name: string;
  label: string;
  desc: string;
  gender: "female" | "male";
  resolved: boolean;
  /** The account voice_id to use for TTS when resolved is true */
  accountVoiceId: string | null;
}

/** Returns the current resolution status for all romantic voices (for the frontend status endpoint) */
export function getRomanticVoiceStatus(): RomanticVoiceStatus[] {
  return ROMANTIC_VOICES.map((v) => {
    const accountVoiceId = resolvedMap.get(v.libraryId) ?? null;
    return {
      libraryId: v.libraryId,
      name: v.name,
      label: v.label,
      desc: v.desc,
      gender: v.gender,
      resolved: accountVoiceId !== null,
      accountVoiceId,
    };
  });
}

// ─── Private helpers ──────────────────────────────────────────────────────────

async function fetchAccountVoices(
  apiKey: string,
): Promise<{ voice_id: string; name: string }[]> {
  const res = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    throw new Error(`GET /v1/voices failed with status ${res.status}`);
  }
  const data = (await res.json()) as {
    voices?: { voice_id: string; name: string }[];
  };
  return data.voices ?? [];
}

async function addFromLibrary(
  apiKey: string,
  voice: RomanticVoiceConfig,
): Promise<string | null> {
  // 1. Search Voice Library to get public_owner_id for this voice
  const searchRes = await fetch(
    `https://api.elevenlabs.io/v1/shared-voices?voice_id=${voice.libraryId}&page_size=5`,
    { headers: { "xi-api-key": apiKey } },
  );
  if (!searchRes.ok) {
    logger.warn(
      { status: searchRes.status, name: voice.name },
      "Voice Library search failed",
    );
    return null;
  }

  const searchData = (await searchRes.json()) as {
    voices?: { public_owner_id: string; voice_id: string }[];
  };
  const match = searchData.voices?.find((v) => v.voice_id === voice.libraryId);
  if (!match?.public_owner_id) {
    logger.warn(
      { libraryId: voice.libraryId, name: voice.name },
      "Romantic voice not found in shared Voice Library",
    );
    return null;
  }

  // 2. Add the voice to the account
  const addRes = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      public_owner_id: match.public_owner_id,
      voice_id: voice.libraryId,
      name: voice.name,
    }),
  });
  if (!addRes.ok) {
    const errText = await addRes.text();
    logger.warn(
      { status: addRes.status, body: errText, name: voice.name },
      "POST /v1/voices/add failed",
    );
    return null;
  }

  const addData = (await addRes.json()) as { voice_id?: string };
  return addData.voice_id ?? null;
}
