import { describe, it, expect } from "vitest";
import { kindStreak } from "../lib/kindStreak";

// The product promise under test: a missed day PAUSES the streak, it never
// resets it. (Old behavior: 3 days + a miss + 1 day => streak 1. Kind
// behavior: => 4.)
describe("kindStreak", () => {
  it("counts consecutive days", () => {
    expect(kindStreak(["2026-08-01", "2026-08-02", "2026-08-03"])).toBe(3);
  });

  it("pauses on a missed day instead of resetting", () => {
    // 3 days, one missed (Aug 4), then back — the effort is kept
    expect(
      kindStreak(["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-05"]),
    ).toBe(4);
  });

  it("holds the count across a long gap", () => {
    expect(kindStreak(["2026-07-01", "2026-07-02", "2026-08-05"])).toBe(3);
  });

  it("is zero with no days", () => {
    expect(kindStreak([])).toBe(0);
  });

  it("ignores duplicates and empty strings", () => {
    expect(kindStreak(["2026-08-01", "2026-08-01", "", "2026-08-02"])).toBe(2);
  });
});
