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
 * actually handles, plus returning users (who carry a session cookie).
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
 * True when GET "/" should serve welcome.html rather than the SPA. Serve the
 * landing page unless the URL carries a known SPA query key, or the visitor
 * already has a session cookie (a returning user should land in the app).
 */
export function shouldServeLanding(
  originalUrl: string,
  cookieHeader: string | undefined,
): boolean {
  const params = new URLSearchParams(originalUrl.split("?")[1] ?? "");
  const wantsSpa = SPA_ROOT_QUERY_KEYS.some((key) => params.has(key));
  const hasSession = (cookieHeader ?? "").includes("sid=");
  return !wantsSpa && !hasSession;
}
