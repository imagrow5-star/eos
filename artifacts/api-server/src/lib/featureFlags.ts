/**
 * featureFlags.ts
 * Runtime feature flags read from process.env at request time. The api-server
 * reads env at runtime (see build.mjs — no esbuild `define` inlining), so
 * flipping a flag only needs an env-var change + a server restart, never a
 * frontend rebuild.
 */

/**
 * Realtime Voice Call (ElevenLabs Conversational AI) entry point.
 *
 * Hidden by default while the ElevenLabs agent is still being configured, so
 * testers never see a Voice Call button that disconnects. The per-message
 * "Listen" text-to-speech playback is a SEPARATE feature and is NOT gated by
 * this flag — it keeps working regardless.
 *
 * To re-enable once the agent is fully wired up: set VOICE_CALL_ENABLED=true on
 * the api-server and restart it. No rebuild required.
 */
export function isVoiceCallEnabled(): boolean {
  return process.env.VOICE_CALL_ENABLED === "true";
}
