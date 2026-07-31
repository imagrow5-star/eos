/**
 * Sprint 2A — memory-fact importance scoring (pure-function unit tests).
 * No DB. Each factor is isolated by holding the others at neutral values.
 */

import { describe, it, expect } from "vitest";
import {
  scoreFactImportance,
  rankFactsByImportance,
  contentTokens,
  messageReferencesFact,
  categoryEmotionalWeight,
  type ScorableFact,
} from "../services/memory/importance.js";

const NOW = Date.parse("2026-07-31T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000);

/** A neutral fact: created long ago (recency ≈ 0), never referenced, no weight. */
function neutral(overrides: Partial<ScorableFact> = {}): ScorableFact {
  return {
    createdAt: daysAgo(3650), // ~10y → recency score ≈ 0
    timesReferenced: 0,
    lastReferencedAt: null,
    emotionalWeight: 0,
    userMarkedImportant: false,
    ...overrides,
  };
}

describe("scoreFactImportance — individual factors", () => {
  it("recency: newer scores higher, ~half at 62 days, gentle decay", () => {
    const fresh = scoreFactImportance(neutral({ createdAt: daysAgo(0) }), NOW);
    const old = scoreFactImportance(neutral({ createdAt: daysAgo(90) }), NOW);
    expect(fresh).toBeCloseTo(1.0, 2); // exp(0) * 1
    expect(scoreFactImportance(neutral({ createdAt: daysAgo(62) }), NOW)).toBeCloseTo(0.5, 1);
    expect(fresh).toBeGreaterThan(old);
  });

  it("frequency: logarithmic, saturating", () => {
    const one = scoreFactImportance(neutral({ timesReferenced: 1 }), NOW);
    const ten = scoreFactImportance(neutral({ timesReferenced: 9 }), NOW); // log10(10)=1 → 2.0
    const hundred = scoreFactImportance(neutral({ timesReferenced: 99 }), NOW); // log10(100)=2 → 4.0
    expect(one).toBeCloseTo(Math.log10(2) * 2, 3);
    expect(ten).toBeCloseTo(2.0, 3);
    expect(hundred).toBeCloseTo(4.0, 3);
    // Saturating: 9→99 (+90 refs) adds less than 0→9 relative to the count.
    expect(hundred - ten).toBeLessThan(ten * 2);
  });

  it("recent-reference boost fires only within its windows", () => {
    const base = scoreFactImportance(neutral(), NOW);
    expect(scoreFactImportance(neutral({ lastReferencedAt: daysAgo(1) }), NOW) - base).toBeCloseTo(5.0, 5);
    expect(scoreFactImportance(neutral({ lastReferencedAt: daysAgo(3) }), NOW) - base).toBeCloseTo(5.0, 5);
    expect(scoreFactImportance(neutral({ lastReferencedAt: daysAgo(5) }), NOW) - base).toBeCloseTo(2.0, 5);
    expect(scoreFactImportance(neutral({ lastReferencedAt: daysAgo(7) }), NOW) - base).toBeCloseTo(2.0, 5);
    expect(scoreFactImportance(neutral({ lastReferencedAt: daysAgo(20) }), NOW) - base).toBeCloseTo(0.5, 5);
    expect(scoreFactImportance(neutral({ lastReferencedAt: daysAgo(30) }), NOW) - base).toBeCloseTo(0.5, 5);
    expect(scoreFactImportance(neutral({ lastReferencedAt: daysAgo(31) }), NOW) - base).toBeCloseTo(0, 5);
  });

  it("emotional weight scales linearly ×3 and clamps to [0,1]", () => {
    const base = scoreFactImportance(neutral(), NOW);
    expect(scoreFactImportance(neutral({ emotionalWeight: 0.6 }), NOW) - base).toBeCloseTo(1.8, 5);
    expect(scoreFactImportance(neutral({ emotionalWeight: 1.0 }), NOW) - base).toBeCloseTo(3.0, 5);
    expect(scoreFactImportance(neutral({ emotionalWeight: 5 }), NOW) - base).toBeCloseTo(3.0, 5); // clamped
  });

  it("user_marked_important trumps everything (+10, beats a fresh, frequent, emotional fact)", () => {
    const marked = scoreFactImportance(neutral({ userMarkedImportant: true }), NOW);
    const strongUnmarked = scoreFactImportance(
      neutral({ createdAt: daysAgo(0), timesReferenced: 99, lastReferencedAt: daysAgo(0), emotionalWeight: 1 }),
      NOW,
    );
    // Strong unmarked tops out around 1 + 4 + 5 + 3 = ~13; a marked-but-otherwise
    // -neutral fact gets 10. But two OLD grief facts: the marked one must win.
    const markedOldGrief = scoreFactImportance(
      neutral({ createdAt: daysAgo(120), timesReferenced: 8, emotionalWeight: 0.8, userMarkedImportant: true }),
      NOW,
    );
    const newTrivial = scoreFactImportance(neutral({ createdAt: daysAgo(0) }), NOW);
    expect(marked).toBeGreaterThan(newTrivial + 5);
    expect(markedOldGrief).toBeGreaterThan(strongUnmarked);
  });

  it("the motivating case: old grief (8×, still surfacing) beats new trivial", () => {
    // A fact mentioned 8× over months is, by nature, one that keeps resurfacing,
    // so it carries a recent reference too — then frequency + emotional weight
    // dominate. (When BOTH are referenced equally recently, the +5 cancels and
    // grief's frequency/emotion win — see below.)
    const oldGrief = scoreFactImportance(
      { createdAt: daysAgo(120), timesReferenced: 8, lastReferencedAt: daysAgo(2), emotionalWeight: 0.8, userMarkedImportant: false },
      NOW,
    );
    const newTrivial = scoreFactImportance(
      { createdAt: daysAgo(1), timesReferenced: 1, lastReferencedAt: daysAgo(1), emotionalWeight: 0.2, userMarkedImportant: false },
      NOW,
    );
    expect(oldGrief).toBeGreaterThan(newTrivial);
  });

  it("with equal recent-reference, frequency+emotion make old grief win outright", () => {
    // Isolate the durable factors: same recent-reference boost for both.
    const oldGrief = scoreFactImportance(
      { createdAt: daysAgo(120), timesReferenced: 8, lastReferencedAt: daysAgo(1), emotionalWeight: 0.8, userMarkedImportant: false },
      NOW,
    );
    const newTrivial = scoreFactImportance(
      { createdAt: daysAgo(1), timesReferenced: 1, lastReferencedAt: daysAgo(1), emotionalWeight: 0.2, userMarkedImportant: false },
      NOW,
    );
    expect(oldGrief).toBeGreaterThan(newTrivial);
  });
});

describe("rankFactsByImportance", () => {
  it("returns the top-N by score, not newest-N", () => {
    const facts = [
      { id: "new-trivial", createdAt: daysAgo(0), timesReferenced: 1, lastReferencedAt: daysAgo(0), emotionalWeight: 0.2, userMarkedImportant: false },
      { id: "old-important", createdAt: daysAgo(150), timesReferenced: 12, lastReferencedAt: daysAgo(2), emotionalWeight: 0.9, userMarkedImportant: false },
      { id: "old-trivial", createdAt: daysAgo(200), timesReferenced: 0, lastReferencedAt: null, emotionalWeight: 0.1, userMarkedImportant: false },
    ];
    const top2 = rankFactsByImportance(facts, NOW, 2).map((f) => f.id);
    expect(top2).toContain("old-important"); // survives despite age
    expect(top2).not.toContain("old-trivial");
  });

  it("returns all facts when fewer than the limit", () => {
    const facts = [neutral(), neutral()];
    expect(rankFactsByImportance(facts, NOW, 40)).toHaveLength(2);
  });
});

describe("tokenization + matching", () => {
  it("tokens are ≥4 chars, lowercase, stop-words removed", () => {
    const toks = contentTokens("My mother passed away and I still think about her");
    expect(toks.has("mother")).toBe(true);
    expect(toks.has("passed")).toBe(true);
    expect(toks.has("about")).toBe(false); // stop word
    expect(toks.has("her")).toBe(false); // <4 chars
    expect(toks.has("still")).toBe(false); // stop word
  });

  it("messageReferencesFact matches on a shared content token, ignores stop words", () => {
    expect(messageReferencesFact("I miss my mother so much", "has grief about their mother")).toBe(true);
    expect(messageReferencesFact("the weather is nice today", "has grief about their mother")).toBe(false);
    // Shared word is only a stop word / short → no match.
    expect(messageReferencesFact("this that with", "about them then")).toBe(false);
  });
});

describe("categoryEmotionalWeight", () => {
  it("maps categories to the backfill base weights", () => {
    for (const c of ["value", "event", "goal", "person"]) expect(categoryEmotionalWeight(c)).toBe(0.6);
    for (const c of ["life", "work", "routine"]) expect(categoryEmotionalWeight(c)).toBe(0.4);
    for (const c of ["preference", "soother", "interest"]) expect(categoryEmotionalWeight(c)).toBe(0.2);
  });
});
