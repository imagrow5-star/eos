/**
 * Pure builder for the ElevenLabs conversation-override payload, one per
 * cascade level (see startRealtimeCall in realtimeVoice.ts). Kept SDK-free so
 * tests can pin exactly what each level sends.
 *
 * Levels — each failed level costs a full paid reconnection, so lower levels
 * drop only what could have caused the rejection:
 *   full  — tone TTS (stability/speed) + chosen voiceId + instant firstMessage
 *   voice — chosen voiceId + firstMessage (tone fields dropped)
 *   none  — no overrides at all: agent-default voice, and the greeting comes
 *           from the agent's own config (the slow LLM path — the pre-override
 *           behavior), so the call still works when every override flag is
 *           disabled in the dashboard.
 *
 * firstMessage rides at "full" AND "voice": it's the instant-greeting fix
 * (spoken on connect with no LLM round trip), so it must survive the common
 * failure mode where only the TONE fields are disabled on the agent.
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
  firstMessage?: string;
}

/**
 * Returns the `{ overrides: ... }` fragment to spread into
 * Conversation.startSession's config — or {} when the level sends nothing.
 * The SDK maps agent.firstMessage → conversation_config_override.agent
 * .first_message in the initiation message (verified against
 * @elevenlabs/client's constructOverrides).
 */
export function buildSessionOverrides(
  level: OverrideLevel,
  inputs: OverrideInputs,
): { overrides?: { tts?: Record<string, unknown>; agent?: { firstMessage: string } } } {
  if (level === "none") return {};

  const tts: Record<string, unknown> = {};
  if (level === "full") {
    const toneTts = TONE_TTS[inputs.tone ?? "auto"] ?? TONE_TTS.auto;
    tts.stability = toneTts.stability;
    tts.speed = toneTts.speed;
  }
  if (inputs.voiceId) tts.voiceId = inputs.voiceId;

  const overrides: { tts?: Record<string, unknown>; agent?: { firstMessage: string } } = {};
  if (Object.keys(tts).length > 0) overrides.tts = tts;
  if (inputs.firstMessage) overrides.agent = { firstMessage: inputs.firstMessage };

  return Object.keys(overrides).length > 0 ? { overrides } : {};
}
