/**
 * Pure builder for the ElevenLabs conversation-override payload, one per
 * cascade level (see startRealtimeCall in realtimeVoice.ts). Kept SDK-free so
 * tests can pin exactly what each level sends.
 *
 * Levels — each failed level costs a full paid reconnection, so lower levels
 * drop only what could have caused the rejection:
 *   full  — tone TTS (stability/speed) + chosen voiceId
 *   voice — chosen voiceId only (tone fields dropped)
 *   none  — no overrides at all: agent defaults.
 *
 * NO `agent` block is EVER sent. Two runtime agent overrides have now been
 * rejected by ElevenLabs config with hard post-connect 1008 disconnects:
 * first_message (~July 29) and agent.language (July 31 — "Override for field
 * 'language' is not allowed by config", and the rejection lands AFTER the
 * socket opens, so the retry cascade cannot catch it and calls simply die).
 * The multilingual agent transcribes with its dashboard-configured language
 * settings; Multilingual v2 TTS speaks whatever language the reply text is
 * in, and the brain-side language directive keeps replies in the user's
 * language — so dropping the hint costs transcription bias only, never the
 * spoken language.
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
}

/**
 * Returns the `{ overrides: ... }` fragment to spread into
 * Conversation.startSession's config — or {} when the level sends nothing.
 * Never emits an `agent` block of any kind — ElevenLabs rejects agent-field
 * overrides (first_message, language) with post-connect 1008 disconnects
 * that kill the call (see the module comment).
 */
export function buildSessionOverrides(
  level: OverrideLevel,
  inputs: OverrideInputs,
): { overrides?: { tts?: Record<string, unknown> } } {
  if (level === "none") return {};

  const tts: Record<string, unknown> = {};
  if (level === "full") {
    const toneTts = TONE_TTS[inputs.tone ?? "auto"] ?? TONE_TTS.auto;
    tts.stability = toneTts.stability;
    tts.speed = toneTts.speed;
  }
  if (inputs.voiceId) tts.voiceId = inputs.voiceId;

  return Object.keys(tts).length > 0 ? { overrides: { tts } } : {};
}
