/**
 * clampStamp (services/stories.ts): a goal/routine NAME is used verbatim as a
 * card eyebrow, and names aren't capped at creation — so a long one used to
 * fail card validation in insertStory and cost the user their whole story for
 * the period. clampStamp fits any name into the stamp max; this pins that a
 * clamped long name passes the real card schema, and a raw one still fails
 * (the schema stays the backstop). Pure — no DB.
 */
import { describe, it, expect } from "vitest";
import { clampStamp, STAMP_MAX, SubjectCardsSchema } from "../services/stories.js";

describe("clampStamp", () => {
  it("leaves a name at or under the max untouched, trimmed", () => {
    expect(clampStamp("Learn Spanish")).toBe("Learn Spanish");
    expect(clampStamp("  Morning walk  ")).toBe("Morning walk");
    const exactly = "x".repeat(STAMP_MAX);
    expect(clampStamp(exactly)).toBe(exactly);
  });

  it("truncates an over-long name to the max, ending in an ellipsis", () => {
    const long = "Finally get around to sorting out the entire garage and the loft this autumn";
    const out = clampStamp(long);
    expect(out.length).toBeLessThanOrEqual(STAMP_MAX);
    expect(out.endsWith("…")).toBe(true);
    expect(long.startsWith(out.slice(0, -1).trimEnd())).toBe(true);
  });

  it("a clamped long name passes the goal/routine card schema; the raw name fails it", () => {
    const long = "y".repeat(STAMP_MAX + 40);
    // Raw: the exact failure seen in production (ZodError too_big on eyebrow).
    expect(() =>
      SubjectCardsSchema.parse([{ kind: "goal", eyebrow: long, text: "still here whenever you want it" }]),
    ).toThrow();
    // Clamped: valid.
    expect(() =>
      SubjectCardsSchema.parse([{ kind: "goal", eyebrow: clampStamp(long), text: "still here whenever you want it" }]),
    ).not.toThrow();
  });
});
