/**
 * Unit tests: the instant voice-call opening line (services/voiceGreeting.ts).
 *
 * These lines are spoken via the ElevenLabs firstMessage override with no LLM
 * involved, so the pools themselves must guarantee the product rules:
 *  - under 12 words, always;
 *  - never claim memory of specifics (a canned line must not be able to
 *    contradict Eos's real memory);
 *  - name used when known, graceful without one;
 *  - time-of-day aware (morning/evening pools by the user's timezone).
 */

import { describe, it, expect } from "vitest";
import {
  GREETING_POOLS,
  buildVoiceFirstMessage,
  greetingSlotFor,
} from "../services/voiceGreeting.js";

const wordCount = (s: string) => s.trim().split(/\s+/).length;

// Phrases that would claim specific shared history — banned in a canned line.
const MEMORY_CLAIMS = /yesterday|last time|last night|you said|you told|we talked|you mentioned|about the/i;

describe("greeting pools", () => {
  const allTemplates = Object.values(GREETING_POOLS).flat();

  it("every line is under 12 words, with and without a name", () => {
    for (const tpl of allTemplates) {
      expect(wordCount(tpl("Priya"))).toBeLessThan(12);
      expect(wordCount(tpl(null))).toBeLessThan(12);
    }
  });

  it("never claims memory of specifics", () => {
    for (const tpl of allTemplates) {
      expect(tpl("Priya")).not.toMatch(MEMORY_CLAIMS);
      expect(tpl(null)).not.toMatch(MEMORY_CLAIMS);
    }
  });

  it("uses the name when given and reads cleanly without one", () => {
    for (const tpl of allTemplates) {
      expect(tpl("Priya")).toContain("Priya");
      const nameless = tpl(null);
      expect(nameless).not.toContain("Priya");
      expect(nameless).not.toMatch(/,\s*[.!?]/); // no dangling ", ." from a dropped name
    }
  });
});

describe("greetingSlotFor", () => {
  it("maps part-of-day to pools", () => {
    expect(greetingSlotFor("early morning")).toBe("morning");
    expect(greetingSlotFor("morning")).toBe("morning");
    expect(greetingSlotFor("afternoon")).toBe("anytime");
    expect(greetingSlotFor("evening")).toBe("evening");
    expect(greetingSlotFor("night")).toBe("evening");
  });
});

describe("buildVoiceFirstMessage", () => {
  // 2026-07-27T08:00Z — 8 AM in UTC (morning), 1:30 PM in Kolkata (afternoon).
  const morningUtc = new Date("2026-07-27T08:00:00Z");

  it("picks from the morning pool in the user's local morning (rng pinned to slot pool)", () => {
    const line = buildVoiceFirstMessage(
      { userName: "Sam", timezone: "UTC" },
      { now: morningUtc, rng: () => 0 }, // index 0 → first morning-pool entry
    );
    expect(line).toBe(GREETING_POOLS.morning[0]!("Sam"));
  });

  it("respects the timezone — the same instant is evening elsewhere", () => {
    // 08:00 UTC = 20:00 in Auckland (UTC+12/+13) → evening pool.
    const line = buildVoiceFirstMessage(
      { userName: "Sam", timezone: "Pacific/Auckland" },
      { now: morningUtc, rng: () => 0 },
    );
    expect(line).toBe(GREETING_POOLS.evening[0]!("Sam"));
  });

  it("uses only the first word of a multi-word name", () => {
    const line = buildVoiceFirstMessage(
      { userName: "Sam Whitlock-Aster", timezone: "UTC" },
      { now: morningUtc, rng: () => 0 },
    );
    expect(line).toContain("Sam");
    expect(line).not.toContain("Whitlock");
  });

  it("handles a missing profile and blank names", () => {
    for (const profile of [null, { userName: "", timezone: "UTC" }, { userName: "   ", timezone: null as never }]) {
      const line = buildVoiceFirstMessage(profile, { now: morningUtc, rng: () => 0.99 });
      expect(line.length).toBeGreaterThan(0);
      expect(wordCount(line)).toBeLessThan(12);
    }
  });

  it("varies across rng values (draws from slot + anytime pools)", () => {
    const seen = new Set<string>();
    const poolSize = GREETING_POOLS.morning.length + GREETING_POOLS.anytime.length;
    for (let i = 0; i < poolSize; i++) {
      seen.add(
        buildVoiceFirstMessage(
          { userName: "Sam", timezone: "UTC" },
          { now: morningUtc, rng: () => i / poolSize },
        ),
      );
    }
    expect(seen.size).toBe(poolSize);
  });
});
