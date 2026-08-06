/**
 * Pure decisions for how a logged-out arrival enters the auth flow.
 *
 * Extracted from App.tsx / AuthScreen.tsx so the routing that once broke
 * password reset stays under test: before the front-door fix, a
 * `/?resetToken=…` arrival rendered the (since-retired) React landing page,
 * which ignored the token — the emailed link led nowhere and testers read it
 * as "reset isn't letting me". The rule now is structural: an unauthenticated
 * arrival ALWAYS renders AuthScreen, and these helpers only decide which tab.
 */

export type UnauthView = "login" | "signup";
export type InitialAuthTab = "login" | "signup" | "forgot" | "reset";

/** Which AuthScreen tab App.tsx requests for a logged-out visitor. */
export function resolveUnauthView(search: string): UnauthView {
  const params = new URLSearchParams(search);
  // welcome.html's "Sign in" carries ?mode=login; a failed Google sign-in
  // redirect (?googleError=…) must also land on login where its message shows.
  return params.has("googleError") || params.get("mode") === "login"
    ? "login"
    : "signup";
}

/**
 * AuthScreen's initial tab. Order of precedence:
 *  1. A stored reset token (arrived from the email link, possibly reloaded
 *     since — mobile browsers discard backgrounded tabs) → reset.
 *  2. Explicit URL intent: ?mode=login → login; ?enter=1 → the requested
 *     tab (sign-up), except a mid-flow forgot-password draft keeps priority.
 *  3. The per-tab draft (survives reloads), never restoring into reset
 *     without a token.
 *  4. The requested default.
 */
export function resolveInitialAuthTab(opts: {
  search: string;
  hasStoredResetToken: boolean;
  draftTab?: InitialAuthTab;
  initialTab: UnauthView;
}): InitialAuthTab {
  const { search, hasStoredResetToken, draftTab, initialTab } = opts;
  if (hasStoredResetToken) return "reset";
  const params = new URLSearchParams(search);
  if (params.get("mode") === "login") return "login";
  if (params.has("enter") && draftTab !== "forgot") return initialTab;
  return draftTab === "reset" ? "login" : (draftTab ?? initialTab);
}
