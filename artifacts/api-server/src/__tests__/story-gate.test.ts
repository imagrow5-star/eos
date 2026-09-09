/**
 * Story language gates — the hard rules for every sentence Eos writes into
 * a goals or routines card. Deterministic; a failing card is dropped, never
 * rewritten. These pin the spec's list and the spec's own example cards.
 */

import { describe, it, expect } from "vitest";
import { storyGateViolations, reflectsExcerpt } from "../services/storyGate.js";

describe("storyGateViolations", () => {
  it("passes the spec's own example cards", () => {
    for (const ok of [
      "You said you got the first run done and your legs hated you for it. That's the one that counts. The first is the hardest to start. Same time Thursday?",
      "You hit the wall you predicted: the gym after 6pm never happens. That's useful. When would it happen?",
      "The Spanish is still here whenever you want to pick it back up. No rush. I just didn't want it to disappear.",
      "You told me in March you wanted to feel strong again by summer. I'm not asking for an update. Just leaving it where you can see it.",
      "Quiet week on the writing. That's allowed. It'll be here when there's room.",
      "You missed yesterday. That's genuinely nothing. One day never broke anything. Today's just today.",
      "It's the first of the month. Clean page if you want one. The old pages don't count against you.",
      "Most mornings now. Four of the last seven.",
    ]) {
      expect(storyGateViolations(ok), ok).toEqual([]);
    }
  });

  it("refuses references to the absence of action", () => {
    expect(storyGateViolations("You haven't touched the Spanish this week.")).toContain("references absence of action");
    expect(storyGateViolations("Still nothing on the writing?")).toContain("references absence of action");
    expect(storyGateViolations("Another week without a run.")).toContain("references absence of action");
    expect(storyGateViolations("You didn't get to the gym.")).toContain("references absence of action");
  });

  it("refuses 'why didn't you' in any form", () => {
    expect(storyGateViolations("Why didn't you go on Tuesday?")).toContain("asks why not");
    expect(storyGateViolations("What stopped you this time?")).toContain("asks why not");
  });

  it("refuses controlling language", () => {
    for (const bad of ["You should try again tomorrow.", "You need to book the class.", "Don't forget the Spanish.", "Make sure you stretch first.", "Try to get out before six."]) {
      expect(storyGateViolations(bad), bad).toContain("controlling language");
    }
  });

  it("refuses person praise but allows acknowledging the action", () => {
    expect(storyGateViolations("You're so disciplined.")).toContain("praises the person");
    expect(storyGateViolations("I'm proud of you.")).toContain("praises the person");
    expect(storyGateViolations("You are really brave for doing that.")).toContain("praises the person");
    expect(storyGateViolations("That first run is the one that counts.")).toEqual([]);
  });

  it("refuses generic encouragement", () => {
    for (const bad of ["You've got this.", "Great week.", "Keep it up.", "Well done on the run.", "Stay positive.", "You're crushing it."]) {
      expect(storyGateViolations(bad), bad).toContain("generic encouragement");
    }
  });

  it("refuses streaks, chains, scores and percentages", () => {
    expect(storyGateViolations("That's a five-day streak.")).toContain("streak or chain count");
    expect(storyGateViolations("Six days in a row now.")).toContain("streak or chain count");
    expect(storyGateViolations("Three days running.")).toContain("streak or chain count");
    expect(storyGateViolations("You're at 80% this month.")).toContain("score or percentile");
    expect(storyGateViolations("That's 4 times this week.")).toContain("kind-truth: digit-count of user behavior");
  });

  it("refuses telling someone what they felt", () => {
    expect(storyGateViolations("You must have felt relieved after the call.")).toContain("infers an emotional state");
    expect(storyGateViolations("You seemed anxious about the gym.")).toContain("infers an emotional state");
    expect(storyGateViolations("You're probably frustrated with the Spanish.")).toContain("infers an emotional state");
    // Their own reported feeling, reflected back verbatim, is not an inference.
    expect(storyGateViolations("You said it felt heavy, and you walked anyway.")).toEqual([]);
  });

  it("carries the kind-truth scrubs", () => {
    expect(storyGateViolations("You're stuck on the writing.")).toContain("kind-truth: verdict-shaped judgment about the person");
    expect(storyGateViolations("This is your anxiety talking.")).toContain("kind-truth: clinical/diagnostic label used as a verdict");
  });
});

describe("reflectsExcerpt", () => {
  it("is true when three consecutive words of their excerpt appear in the card", () => {
    const excerpt = "got the first run done and my legs hated me for it";
    expect(reflectsExcerpt("You said you got the first run done and your legs hated you for it. That counts.", excerpt)).toBe(true);
    expect(reflectsExcerpt("You went running this week. Same time Thursday?", excerpt)).toBe(false);
  });

  it("ignores case and punctuation", () => {
    expect(reflectsExcerpt("You said: 'THE GYM AFTER 6pm never happens'.", "the gym after 6pm never happens")).toBe(true);
  });
});
