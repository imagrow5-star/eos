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
 * ON by default — the Voice Call button is a first-class feature. Set
 * VOICE_CALL_ENABLED=false (and restart the api-server) only if the feature
 * must be temporarily hidden; a missing/unset variable never hides it.
 *
 * The per-message "Listen" text-to-speech playback is a SEPARATE feature and
 * is NOT gated by this flag — it keeps working regardless.
 */
export function isVoiceCallEnabled(): boolean {
  return process.env.VOICE_CALL_ENABLED !== "false";
}
