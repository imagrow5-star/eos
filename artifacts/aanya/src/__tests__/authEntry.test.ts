import { describe, it, expect } from "vitest";
import { resolveUnauthView, resolveInitialAuthTab } from "../lib/authEntry";

// Regression under test (tester report: "reset isn't letting me"): a
// `/?resetToken=…` arrival must flow into AuthScreen and end on the reset
// tab. The old code routed logged-out arrivals to a landing page that
// ignored the token entirely.
describe("resolveUnauthView", () => {
  it("reset-link arrivals reach AuthScreen (never a landing page)", () => {
    // any unauth arrival renders AuthScreen by construction; the view for a
    // token link is the default (AuthScreen's own effect then opens reset)
    expect(resolveUnauthView("?resetToken=abc123")).toBe("signup");
  });

  it("welcome's Sign in link opens the login tab", () => {
    expect(resolveUnauthView("?enter=1&mode=login")).toBe("login");
  });

  it("failed Google sign-in redirects land on login", () => {
    expect(resolveUnauthView("?googleError=cancelled")).toBe("login");
  });

  it("sign-up CTAs default to signup", () => {
    expect(resolveUnauthView("?enter=1")).toBe("signup");
    expect(resolveUnauthView("")).toBe("signup");
  });
});

describe("resolveInitialAuthTab", () => {
  const base = { search: "", hasStoredResetToken: false, initialTab: "signup" as const };

  it("a stored reset token always wins (mobile tab-discard reload)", () => {
    expect(
      resolveInitialAuthTab({ ...base, search: "?enter=1&mode=login", hasStoredResetToken: true }),
    ).toBe("reset");
  });

  it("?mode=login outranks a stale signup draft", () => {
    expect(
      resolveInitialAuthTab({ ...base, search: "?enter=1&mode=login", draftTab: "signup" }),
    ).toBe("login");
  });

  it("?enter=1 outranks a stale login draft (Enter Eos means sign-up)", () => {
    expect(
      resolveInitialAuthTab({ ...base, search: "?enter=1", draftTab: "login" }),
    ).toBe("signup");
  });

  it("a mid-flow forgot-password draft survives re-entry", () => {
    expect(
      resolveInitialAuthTab({ ...base, search: "?enter=1", draftTab: "forgot" }),
    ).toBe("forgot");
  });

  it("never restores into reset without a token", () => {
    expect(resolveInitialAuthTab({ ...base, draftTab: "reset" })).toBe("login");
  });

  it("plain reload keeps the draft", () => {
    expect(resolveInitialAuthTab({ ...base, draftTab: "forgot" })).toBe("forgot");
  });
});
