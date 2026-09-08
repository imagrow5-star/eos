/**
 * The user's own name — what the companion calls them — as written through
 * Settings (PUT /api/profile). Onboarding has its own conversational cleaner
 * (extractName strips "my name is …"); a form field is typed directly, so
 * this only tidies and bounds it.
 *
 * Required, 1–40 characters: the product addresses people by name constantly
 * and a fallback "there" is a worse experience than enforcing the field. The
 * 40 cap matches the onboarding name step.
 *
 * The client mirrors this rule for its inline note (aanya/src/lib/profileName.ts);
 * the server copy is the authoritative one.
 */

export const USER_NAME_MAX = 40;

/** Collapses whitespace, strips control characters, trims. Returns null when
 *  nothing usable remains or it's over the cap.
 *  Whitespace FIRST: tab and newline are control characters, so stripping
 *  those first would fuse "Anne\tSmith" into "AnneSmith" instead of spacing it. */
export function normalizeUserName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw
    .replace(/\s+/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  if (value.length === 0 || value.length > USER_NAME_MAX) return null;
  return value;
}

export const USER_NAME_ERROR = `Please enter a name of 1 to ${USER_NAME_MAX} characters.`;
