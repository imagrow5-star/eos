/**
 * Root-route decision (lib/landingRoute.ts): landing page vs SPA at "/".
 *
 * Regression guard for the paid-traffic bug: Instagram/Meta append a tracking
 * param to every outbound link, so a tapped bio link arrives as /?igsh=… . A
 * prior "any query string → SPA" check treated that as non-clean and served
 * the signup screen — 40 paid IG clicks, 0 landing-page views, 0 signups. The
 * landing page must win for tracking params; the SPA owns "/" only for the
 * specific keys it handles, plus returning users (signed in).
 *
 * "Signed in" is the session's word, not the cookie's: a sid cookie outlives
 * the session behind it, and judging by the cookie alone sent every visitor
 * with a stale one to the app's sign-in form instead of the landing page.
 */
import { describe, it, expect } from "vitest";
import { shouldServeLanding, shouldServeStaticPricing, isSignedIn, hasSessionCookie, SPA_ROOT_QUERY_KEYS } from "../lib/landingRoute.js";

describe("isSignedIn — the session, not the cookie, says who is a member", () => {
  it("is true only for a session carrying a user", () => {
    expect(isSignedIn({ userId: 7 })).toBe(true);
    expect(isSignedIn({})).toBe(false); // a fresh session behind a stale cookie
    expect(isSignedIn({ userId: null })).toBe(false);
    expect(isSignedIn(undefined)).toBe(false);
    expect(isSignedIn(null)).toBe(false);
  });

  it("hasSessionCookie matches a cookie NAMED sid, not one whose name ends in sid", () => {
    expect(hasSessionCookie("sid=abc")).toBe(true);
    expect(hasSessionCookie("theme=dark; sid=abc")).toBe(true);
    expect(hasSessionCookie("_gsid=abc")).toBe(false);
    expect(hasSessionCookie("theme=dark")).toBe(false);
    expect(hasSessionCookie(undefined)).toBe(false);
  });
});

describe("shouldServeStaticPricing — static plans for visitors, the app for members", () => {
  it("visitors get the static page, members the app", () => {
    expect(shouldServeStaticPricing(false)).toBe(true);
    expect(shouldServeStaticPricing(true)).toBe(false);
  });
});

describe("shouldServeLanding — landing page vs SPA at /", () => {
  it("serves the landing page for a clean root URL", () => {
    expect(shouldServeLanding("/", false)).toBe(true);
  });

  // The exact bug. These MUST reach the marketing page, not signup.
  it("serves the landing page despite marketing / tracking params", () => {
    for (const url of [
      "/?igsh=abc123",
      "/?igshid=abc123",
      "/?fbclid=xyz",
      "/?utm_source=instagram&utm_medium=paid&utm_campaign=launch",
      "/?gclid=zzz",
      "/?ref=linktree",
    ]) {
      expect(shouldServeLanding(url, false)).toBe(true);
    }
  });

  it("hands / to the SPA for every key it actually handles", () => {
    for (const url of [
      "/?enter=1",
      "/?enter=1&mode=login",
      "/?plan=always",
      "/?verifyToken=tok",
      "/?resetToken=tok",
      "/?cancelReset=tok",
      "/?cancelEmailChange=tok",
      "/?googleError=cancelled",
    ]) {
      expect(shouldServeLanding(url, false)).toBe(false);
    }
    // Every declared key routes to the SPA — nothing in the list is dead.
    for (const key of SPA_ROOT_QUERY_KEYS) {
      expect(shouldServeLanding(`/?${key}=x`, false)).toBe(false);
    }
  });

  it("hands / to the SPA when a returning user is signed in", () => {
    expect(shouldServeLanding("/", true)).toBe(false);
    // …even alongside a marketing param (they're already a user)
    expect(shouldServeLanding("/?igsh=abc", true)).toBe(false);
  });

  // A real SPA key mixed with a tracking param still goes to the SPA — the
  // token link must never be swallowed by the marketing-param path.
  it("routes to the SPA when a known key rides alongside a tracking param", () => {
    expect(shouldServeLanding("/?igsh=abc&verifyToken=tok", false)).toBe(false);
    expect(shouldServeLanding("/?fbclid=z&enter=1", false)).toBe(false);
  });
});
