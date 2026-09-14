/**
 * One cleaner for everything the memory system stores as text (memory
 * audit, item 2). Extracted facts, feelings, personality signals and wins
 * are written by a model from a conversation and read back into every
 * future prompt, so what is stored must be one bounded, plain line:
 *
 *   • Unicode-normalised (NFC), so the same word is the same bytes;
 *   • no control characters, no line breaks, no zero-width or bidirectional
 *     formatting characters — a stored line can't fake a new prompt section
 *     or hide text;
 *   • whitespace collapsed, ends trimmed;
 *   • a leading "[tag]" or bullet stripped, so a line can't impersonate the
 *     "- [category]" shape the prompt renders;
 *   • a hard length cap per kind, cut at a word boundary with an ellipsis;
 *   • a floor: anything shorter than a few characters is nothing.
 *
 * The fact category is validated against the ten the extraction prompt
 * names; anything else becomes "life". Pure, dependency-free, unit-tested.
 * Applied at every write, by the boot sweep for rows that predate it, and
 * once more when the prompt renders — a second wall, not the first.
 */

export const FACT_TEXT_MAX = 200;
export const FEELING_TEXT_MAX = 240;
export const SIGNAL_TEXT_MAX = 160;
export const WIN_TEXT_MAX = 160;
export const MEMORY_TEXT_MIN = 5;

export const FACT_CATEGORIES = [
  "life", "interest", "routine", "person", "work", "value", "soother", "preference", "event", "goal",
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

// C0 and C1 controls, soft hyphen, zero-width and joiner characters, line
// and paragraph separators, bidirectional embeddings/overrides/isolates,
// word joiner and friends, and the byte-order mark.
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
// A leading bracketed tag or bullet marker, possibly repeated: "[goal] ",
// "- ", "• ", "* ".
const LEADING_MARKUP = /^(?:\[[^\]]{0,40}\]|[-•*]|\d+[.)])\s*/;

/**
 * Clean one stored line. Returns null when nothing worth keeping remains.
 * `max` is the cap for this kind of text; `min` the floor.
 */
export function cleanMemoryText(raw: unknown, max: number, min = MEMORY_TEXT_MIN): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.normalize("NFC").replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  for (let guard = 0; guard < 5 && LEADING_MARKUP.test(s); guard++) s = s.replace(LEADING_MARKUP, "");
  if (s.length > max) {
    const cut = s.slice(0, max - 1);
    const space = cut.lastIndexOf(" ");
    s = (space >= Math.floor(max * 0.6) ? cut.slice(0, space) : cut).trimEnd() + "…";
  }
  return s.length >= min ? s : null;
}

/** The fact category, or "life" for anything the extraction prompt didn't name. */
export function normalizeFactCategory(raw: unknown): FactCategory {
  if (typeof raw !== "string") return "life";
  const c = raw.trim().toLowerCase();
  return (FACT_CATEGORIES as readonly string[]).includes(c) ? (c as FactCategory) : "life";
}

/** True when a stored line is already exactly what the cleaner would produce. */
export function isCleanMemoryText(value: string, max: number, min = MEMORY_TEXT_MIN): boolean {
  return cleanMemoryText(value, max, min) === value;
}
