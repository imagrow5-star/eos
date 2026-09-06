/**
 * Root-route decision (lib/landingRoute.ts): landing page vs SPA at "/".
 *
 * Regression guard for the paid-traffic bug: Instagram/Meta append a tracking
 * param to every outbound link, so a tapped bio link arrives as /?igsh=… . A
 * prior "any query string → SPA" check treated that as non-clean and served
 * the signup screen — 40 paid IG clicks, 0 landing-page views, 0 signups. The
 * landing page must win for tracking params; the SPA owns "/" only for the
 * specific keys it handles, plus returning users (session cookie).
 */
import { describe, it, expect } from "vitest";
import { shouldServeLanding, SPA_ROOT_QUERY_KEYS } from "../lib/landingRoute.js";

describe("shouldServeLanding — landing page vs SPA at /", () => {
  it("serves the landing page for a clean root URL", () => {
    expect(shouldServeLanding("/", undefined)).toBe(true);
    expect(shouldServeLanding("/", "")).toBe(true);
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
      expect(shouldServeLanding(url, undefined)).toBe(true);
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
      expect(shouldServeLanding(url, undefined)).toBe(false);
    }
    // Every declared key routes to the SPA — nothing in the list is dead.
    for (const key of SPA_ROOT_QUERY_KEYS) {
      expect(shouldServeLanding(`/?${key}=x`, undefined)).toBe(false);
    }
  });

  it("hands / to the SPA when a returning user has a session cookie", () => {
    expect(shouldServeLanding("/", "sid=abc; theme=dark")).toBe(false);
    // …even alongside a marketing param (they're already a user)
    expect(shouldServeLanding("/?igsh=abc", "sid=abc")).toBe(false);
  });

  // A real SPA key mixed with a tracking param still goes to the SPA — the
  // token link must never be swallowed by the marketing-param path.
  it("routes to the SPA when a known key rides alongside a tracking param", () => {
    expect(shouldServeLanding("/?igsh=abc&verifyToken=tok", undefined)).toBe(false);
    expect(shouldServeLanding("/?fbclid=z&enter=1", undefined)).toBe(false);
  });
});
