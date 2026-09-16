/**
 * Root-route decision: does a GET "/" serve the marketing landing page
 * (public/welcome.html) or fall through to the SPA?
 *
 * Extracted as a pure function so this rule stays under test — the same
 * discipline as aanya's authEntry.ts, and for the same reason. A broad
 * "any query string → SPA" check once sent ALL paid social traffic to the
 * signup screen: Instagram and Meta append a tracking parameter to every
 * outbound link (?igsh=…, ?igshid=…, ?fbclid=…, utm_ params, gclid), so a tapped bio
 * link arrives as /?igsh=… — which is NOT a clean root URL. The landing page
 * must win for those; the SPA owns "/" only for the specific query keys it
 * actually handles, plus returning users (who are signed in).
 */

/**
 * Query keys that mean "the SPA should own /". Keep in sync with the keys read
 * in aanya's App.tsx (verifyToken), AuthScreen.tsx (resetToken, cancelReset,
 * cancelEmailChange, googleError), authEntry.ts (enter, mode) and
 * pendingPlan.ts (plan). Anything NOT in this list — every marketing/tracking
 * param — falls through to the landing page.
 */
export const SPA_ROOT_QUERY_KEYS = [
  "enter", "mode", "plan",            // landing-page CTAs (authEntry, pendingPlan)
  "verifyToken", "resetToken",        // emailed token links
  "cancelReset", "cancelEmailChange", // emailed cancel links
  "googleError",                      // failed Google sign-in return (success sets the session cookie)
] as const;

/**
 * The session's view of the visitor. Only userId matters here; the module
 * takes this narrow shape so the rule stays a pure function under test.
 */
export type SessionView = { userId?: number | null } | null | undefined;

/**
 * True when GET "/" should serve welcome.html rather than the SPA. Serve the
 * landing page unless the URL carries a known SPA query key, or the visitor
 * is signed in (a returning member should land in the app).
 *
 * "Signed in" means the session middleware resolved the cookie to a live
 * session with a user on it — NOT that a cookie named sid is present. A
 * cookie outlives its session (it is set for 30 days; the row behind it can
 * expire, be destroyed, or belong to an abandoned Google sign-in), and a
 * stale one used to send every such visitor to the app, which greeted them
 * with the sign-in form instead of the landing page.
 */
export function shouldServeLanding(originalUrl: string, signedIn: boolean): boolean {
  const params = new URLSearchParams(originalUrl.split("?")[1] ?? "");
  const wantsSpa = SPA_ROOT_QUERY_KEYS.some((key) => params.has(key));
  return !wantsSpa && !signedIn;
}

/** A member: the request's session carries a user. */
export function isSignedIn(session: SessionView): boolean {
  return typeof session?.userId === "number";
}

/**
 * The request carries a cookie NAMED sid (not merely one whose name ends in
 * "sid"). With isSignedIn false, that cookie is stale and worth clearing so
 * the browser stops sending it.
 */
export function hasSessionCookie(cookieHeader: string | undefined): boolean {
  return /(^|;\s*)sid=/.test(cookieHeader ?? "");
}

/**
 * True when GET /pricing should serve the static public/pricing.html rather
 * than the SPA. A visitor gets the static page: it's a decision page and must
 * render in any browser with JavaScript off. A signed-in member keeps the
 * app's pricing page, which knows their current plan and opens checkout.
 */
export function shouldServeStaticPricing(signedIn: boolean): boolean {
  return !signedIn;
}
