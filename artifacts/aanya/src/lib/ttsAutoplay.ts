/**
 * TTS auto-play policy for chat replies (cost guard).
 *
 * ElevenLabs is billed per character generated. Auto-playing every assistant
 * reply's audio burns credits even when the user never asked to hear it, so
 * auto-play is limited to ONBOARDING — the warm first impression — and is off
 * everywhere else. After onboarding, a reply is silent until the user taps the
 * per-message "Listen" button (user-initiated TTS, expected cost).
 *
 * This does NOT touch the real-time Voice Call (tap-to-call) — that path never
 * routes through here; it speaks via its own streaming pipeline.
 */
export function shouldAutoplayChatReply(opts: { onboardingComplete: boolean }): boolean {
  // Auto-play only while onboarding is still in progress.
  return !opts.onboardingComplete;
}
