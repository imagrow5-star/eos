// ─── Helpline resolution + block formatting — LOGIC ──────────────────────────
// Data lives in helplineDirectory.ts. This module turns a profile country code
// into the deterministic helpline block that the crisis floor appends to a
// reply AFTER the LLM has finished — so the resources reach the user even if
// the model ignored every safety instruction.

import {
  HELPLINE_DIRECTORY,
  FALLBACK_HELPLINES,
  type HelplineEntry,
} from "./helplineDirectory.js";

export type { HelplineEntry } from "./helplineDirectory.js";

export interface ResolvedHelplines {
  /** ISO-2 country whose lines are being served, or "fallback". */
  countryServed: string;
  lines: HelplineEntry[];
}

/**
 * profile.country → helplines. Accepts the stored codes as-is ("US", "UK",
 * "IN", "", "other", null…). Unknown/absent → the global fallback set.
 */
export function resolveHelplines(country: string | null | undefined): ResolvedHelplines {
  const code = (country ?? "").trim().toUpperCase();
  const entry = code ? HELPLINE_DIRECTORY.get(code) : undefined;
  if (!entry) return { countryServed: "fallback", lines: FALLBACK_HELPLINES };
  // "UK" alias resolves to the GB entry — report the code we actually served.
  return { countryServed: entry.country, lines: entry.lines.slice(0, 3) };
}

// The first line of every helpline block. The frontend uses this exact marker
// to split an assistant message into "Eos's words" + "helpline card", so the
// card renders visually distinct and dismissible. Change it in BOTH places or
// history rendering breaks (see aanya/src/lib/crisisBlock.ts).
export const HELPLINE_BLOCK_MARKER =
  "—\nSomeone who can be with you right now, if you want to reach:";

export function formatHelplineLine(l: HelplineEntry): string {
  const note = l.languageNote ? ` — ${l.languageNote}` : "";
  return `- ${l.name} — ${l.number} — ${l.hours} (${l.modality})${note}`;
}

/**
 * The exact text appended to the assistant reply (and persisted with it, so
 * the card is part of chat history and exports).
 */
export function buildHelplineBlockText(lines: HelplineEntry[]): string {
  return [
    HELPLINE_BLOCK_MARKER,
    ...lines.map(formatHelplineLine),
    "I'm not going anywhere. Take your time.",
  ].join("\n");
}
