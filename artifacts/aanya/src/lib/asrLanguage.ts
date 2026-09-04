// ─── ASR-language mismatch evidence (2026-09) ────────────────────────────────
// Hume EVI has NO speech-recognition language setting anywhere in its API
// (session_settings, config, and connect options all verified against SDK
// 0.16.1) — it auto-detects the language per utterance and reports it on
// user_message.language. When the detector mis-hears (Spanish transcribed as
// English gibberish, seen live 2026-09-04), the only recourse is evidence
// for Hume support — so Chat.tsx beacons a mismatch between the detected
// value and the profile language.
//
// Kept in its own tiny module: humeVoice.ts (which surfaces the detected
// value) is lazy-loaded with the Hume SDK, and Chat.tsx must not pull that
// chunk into the main bundle just for this comparison.

/**
 * True when EVI's detected ASR language disagrees with the profile language
 * (en/es). The detected format is UNPINNED — it could plausibly arrive as
 * "en", "eng", "en-US", "english", "es", "spa", "español" — so match
 * loosely; an unknown format counts as a mismatch on purpose, making the
 * beacon fire and put the raw value in the logs.
 */
export function asrLanguageMismatch(detected: string, profileLang: string): boolean {
  const d = detected.trim().toLowerCase();
  if (!d) return false; // nothing detected — nothing to report
  const families: Record<string, string[]> = {
    en: ["en", "eng", "english"],
    es: ["es", "spa", "spanish", "español", "espanol"],
  };
  const accepted = families[profileLang] ?? families.en!;
  return !accepted.some((prefix) => d.startsWith(prefix));
}
