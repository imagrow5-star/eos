/**
 * Settings → "Your name": validation and the save choreography, pulled out of
 * the Chat component so the one thing that would feel broken is unit-tested:
 *
 *   A voice-call session is minted with the user's name baked in — the server
 *   builds the call's frozen system prompt AND primes the profile so the
 *   greeting turn runs database-free (api-server routes/voice-agent.ts). The
 *   UI prefetches such a session on call intent. So a session prefetched
 *   BEFORE a rename would greet the person by their OLD name for the whole
 *   call. commitUserNameChange drops it — and anything minted while the save
 *   is still in flight — before the new name can be heard.
 *
 * The server (api-server/src/lib/userName.ts) holds the authoritative rule;
 * this mirror only drives the inline note so the person sees the reason
 * without a round trip.
 */

export const USER_NAME_MAX = 40;

export type NameCheck = { ok: true; value: string } | { ok: false; note: string };

/** Collapse whitespace, strip control characters, trim; 1–40 chars.
 *  Whitespace FIRST (tab/newline are control characters) — same order as the server. */
export function normalizeUserName(raw: string): NameCheck {
  const value = raw
    .replace(/\s+/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim();
  if (value.length === 0) return { ok: false, note: "Please enter a name — it's what Eos calls you." };
  if (value.length > USER_NAME_MAX) {
    return { ok: false, note: `Names are ${USER_NAME_MAX} characters at most.` };
  }
  return { ok: true, value };
}

export interface CommitUserNameDeps {
  /** What the person typed. */
  raw: string;
  /** The name currently saved on the profile. */
  current: string;
  /** The voice-session prefetcher (real one in the app; real one in tests). */
  prefetcher: { invalidate(): void };
  /** Persist the name. Call `afterSaved` once the server has it, so a session
   *  minted during the save window (still carrying the old name) is dropped too. */
  save: (name: string, afterSaved: () => void) => void;
}

export interface CommitUserNameResult {
  saved: boolean;
  /** Inline note for the row: a validation message, or null. */
  note: string | null;
}

export function commitUserNameChange(d: CommitUserNameDeps): CommitUserNameResult {
  const check = normalizeUserName(d.raw);
  if (!check.ok) return { saved: false, note: check.note };
  if (check.value === d.current) return { saved: false, note: null }; // nothing to do
  // Invalidate BEFORE the save: drops the cached session and orphans any
  // in-flight prefetch (its result is generation-checked and never cached).
  d.prefetcher.invalidate();
  // …and AFTER: a prefetch that STARTED between the two (call intent during
  // the ~100ms save) was minted with the old name — drop that one as well.
  d.save(check.value, () => d.prefetcher.invalidate());
  return { saved: true, note: null };
}
