/**
 * Pure builder for the ElevenLabs conversation-override payload, one per
 * cascade level (see startRealtimeCall in realtimeVoice.ts). Kept SDK-free so
 * tests can pin exactly what each level sends.
 *
 * Levels — each failed level costs a full paid reconnection, so lower levels
 * drop only what could have caused the rejection:
 *   full  — tone TTS (stability/speed) + chosen voiceId + agent.language
 *   voice — chosen voiceId + agent.language (tone fields dropped)
 *   none  — no overrides at all: agent defaults (graceful degrade — voice
 *           still works, transcription is English-biased).
 *
 * agent.language (non-English calls only): tells the multilingual agent which
 * language to target for speech-to-text, so e.g. German speech isn't garbled
 * through an English transcriber. Requires the "language" override toggle on
 * the agent's Security settings; if the config rejects it, the cascade's
 * "none" attempt connects without it.
 *
 * first_message is DELIBERATELY never sent. ElevenLabs tightened runtime
 * override permissions (~July 29) and rejects the field with a hard 1008
 * disconnect ("Override for field 'first_message' is not allowed by config"),
 * and the current subscription tier exposes no dashboard toggle to re-allow
 * it. The greeting now always comes the LLM way: the agent asks our
 * custom-LLM endpoint, whose synthetic-greeting path speaks a personalized
 * opening from the same system prompt (routes/voice-llm.ts).
 */

export type VoiceTone = "auto" | "gentle" | "calm" | "upbeat";
export type OverrideLevel = "full" | "voice" | "none";

// TTS delivery per tone preference. "auto" ships the gentle defaults with no
// fixed prompt instruction — her situational adaptation leads. Requires the
// stability/speed overrides to be enabled in the agent's security settings.
// Delivery style only — the voiceId (which voice she IS) is never touched here.
export const TONE_TTS: Record<VoiceTone, { stability: number; speed: number }> = {
  auto: { stability: 0.4, speed: 0.95 },
  gentle: { stability: 0.4, speed: 0.95 },
  calm: { stability: 0.75, speed: 0.9 },
  upbeat: { stability: 0.45, speed: 1.05 },
};

export interface OverrideInputs {
  tone?: VoiceTone;
  voiceId?: string;
  /** ISO 639-1 transcription-language hint ("de", "fr", …) — only present on
   *  multilingual-agent calls; never set for English. */
  language?: string;
}

/**
 * Returns the `{ overrides: ... }` fragment to spread into
 * Conversation.startSession's config — or {} when the level sends nothing.
 * The `agent` block may carry ONLY `language` — never firstMessage, which
 * ElevenLabs rejects with a 1008 disconnect (see the module comment).
 */
export function buildSessionOverrides(
  level: OverrideLevel,
  inputs: OverrideInputs,
): { overrides?: { tts?: Record<string, unknown>; agent?: { language: string } } } {
  if (level === "none") return {};

  const tts: Record<string, unknown> = {};
  if (level === "full") {
    const toneTts = TONE_TTS[inputs.tone ?? "auto"] ?? TONE_TTS.auto;
    tts.stability = toneTts.stability;
    tts.speed = toneTts.speed;
  }
  if (inputs.voiceId) tts.voiceId = inputs.voiceId;

  const overrides: { tts?: Record<string, unknown>; agent?: { language: string } } = {};
  if (Object.keys(tts).length > 0) overrides.tts = tts;
  if (inputs.language && inputs.language !== "en") overrides.agent = { language: inputs.language };

  return Object.keys(overrides).length > 0 ? { overrides } : {};
}
