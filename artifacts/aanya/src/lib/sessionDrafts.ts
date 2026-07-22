/**
 * Per-tab (sessionStorage) draft persistence keys.
 *
 * Mobile browsers routinely discard backgrounded tabs; these keys let
 * in-progress, NON-SENSITIVE state (never passwords) survive the resulting
 * reload. Everything here is wiped at auth boundaries (login, signup,
 * logout) so a shared device never carries one account's drafts or form
 * state into another user's session.
 */
export const AUTH_DRAFT_KEY = "eos-auth-draft";
export const RESET_TOKEN_KEY = "eos-reset-token";
export const CHAT_DRAFT_KEY = "eos-chat-draft";

export function clearSessionDrafts(): void {
  try {
    sessionStorage.removeItem(AUTH_DRAFT_KEY);
    sessionStorage.removeItem(RESET_TOKEN_KEY);
    sessionStorage.removeItem(CHAT_DRAFT_KEY);
  } catch {
    // sessionStorage unavailable (rare private-mode edge cases) — nothing to clear.
  }
}
