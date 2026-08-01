/**
 * Deterministic unit tests for the reset feature gate
 * (services/memory/resetGate.ts). No DB — the pure decision function is the
 * single source of truth the endpoint's 404/403/allowed branches rest on.
 */

import { describe, it, expect } from "vitest";
import { resetAllowlistDecision } from "../services/memory/resetGate.js";

describe("resetAllowlistDecision", () => {
  it("returns not_configured when the env var is unset or blank", () => {
    expect(resetAllowlistDecision("a@b.com", undefined)).toBe("not_configured");
    expect(resetAllowlistDecision("a@b.com", "")).toBe("not_configured");
    expect(resetAllowlistDecision("a@b.com", "   ")).toBe("not_configured");
    expect(resetAllowlistDecision("a@b.com", " , , ")).toBe("not_configured");
  });

  it("allows an email that is on the list", () => {
    expect(resetAllowlistDecision("founder@example.com", "founder@example.com")).toBe("allowed");
    expect(resetAllowlistDecision("dev@x.com", "founder@example.com,dev@x.com")).toBe("allowed");
  });

  it("forbids an email that is NOT on the list", () => {
    expect(resetAllowlistDecision("stranger@example.com", "founder@example.com")).toBe("forbidden");
  });

  it("is case-insensitive and whitespace-tolerant", () => {
    expect(resetAllowlistDecision("Founder@Example.com", " founder@example.com , dev@x.com ")).toBe("allowed");
    expect(resetAllowlistDecision("  DEV@X.COM  ", "founder@example.com,dev@x.com")).toBe("allowed");
  });

  it("forbids a null/empty email even when a list is configured", () => {
    expect(resetAllowlistDecision(null, "founder@example.com")).toBe("forbidden");
    expect(resetAllowlistDecision("", "founder@example.com")).toBe("forbidden");
  });
});
