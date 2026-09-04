// EVI appends its expression annotation to user TRANSCRIPT text — e.g.
// "Rato. {very slightly excited, very slightly amused}" (first seen live
// 2026-09-03, after the EVI config was edited in the dashboard). Tone context
// reaches the model only via formatVoiceTone (routes/humeLlm.ts), so these
// braces must never survive into the prompt or the persisted transcript.
// ASR never emits braces: any {…} group in user speech content is Hume's
// annotation, not the user's words. Shared by the live normalizer
// (routes/humeLlm.ts) and the boot scrub for rows persisted before the
// normalizer stripped them (services/messageAnnotationScrub.ts).
export function stripExpressionTags(content: string): string {
  return content.replace(/\{[^{}]*\}/g, " ").replace(/\s{2,}/g, " ").trim();
}
