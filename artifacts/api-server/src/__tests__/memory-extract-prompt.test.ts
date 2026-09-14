/**
 * Deterministic unit test for the structured-memory extraction prompt.
 *
 * Wins are read back to the user verbatim on Journey ("Small things you did
 * for yourself") and feed the weekly review, so they must be the user's OWN
 * first-person memory — "I walked two days running, even though it felt
 * heavy." — never a third-person case note ("User engaged in physical
 * activity"). This pins that contract without a model call.
 */

import { describe, it, expect } from "vitest";
import { buildMemoryExtractPrompt, selectExtractContext, EXTRACT_CONTEXT_MAX } from "../services/ai.js";

const messages = [
  { role: "user", content: "I walked again today, two days in a row now, even though it felt heavy" },
  { role: "assistant", content: "Two days running. That counts." },
];

describe("buildMemoryExtractPrompt", () => {
  it("labels turns with the user's name and the companion's name", () => {
    const prompt = buildMemoryExtractPrompt(messages, "Sam", "Eos");
    expect(prompt).toContain("Sam: I walked again today");
    expect(prompt).toContain("Eos: Two days running.");
  });

  it("asks for wins in the user's own first-person voice, with a worked example", () => {
    const prompt = buildMemoryExtractPrompt(messages, "Sam", "Eos");
    expect(prompt).toMatch(/wins: .*FIRST PERSON/);
    expect(prompt).toContain('"I walked two days running, even though it felt heavy."');
    // The forbidden voices are named explicitly so the model has no excuse.
    expect(prompt).toContain('NEVER "the user…"');
    expect(prompt).toContain('NEVER "they…" or "Sam…"');
    expect(prompt).toContain("case-note summary");
  });

  it("still asks for facts, signals, mood and change talk (the rest of the shape is unchanged)", () => {
    const prompt = buildMemoryExtractPrompt(messages, "Sam", "Eos");
    for (const key of ['"facts"', '"signals"', '"wins"', '"moodScore"', '"changeTalk"']) {
      expect(prompt).toContain(key);
    }
    expect(prompt).toContain("Return empty arrays if nothing fits. Do NOT make things up.");
  });
});

// ─── Supersede / retire (memory audit, item 1) ───────────────────────────────

describe("buildMemoryExtractPrompt — existing facts", () => {
  it("lists the already-remembered facts with their ids and asks for supersedes and retired", () => {
    const prompt = buildMemoryExtractPrompt(messages, "Sam", "Eos", [
      { id: 12, fact: "Lives in London" },
      { id: 30, fact: "Target is 100 crores this year" },
    ]);
    expect(prompt).toContain("Already remembered about Sam (id: fact)");
    expect(prompt).toContain("  12: Lives in London");
    expect(prompt).toContain("  30: Target is 100 crores this year");
    expect(prompt).toContain('"supersedes": <id of an already-remembered fact this REPLACES, or null>');
    expect(prompt).toContain('"retired": [<ids of already-remembered facts that are no longer true');
    expect(prompt).toContain("Never repeat an already-remembered fact that hasn't changed.");
  });

  it("without existing facts the block is absent and nothing else moves", () => {
    const prompt = buildMemoryExtractPrompt(messages, "Sam", "Eos");
    expect(prompt).not.toContain("Already remembered");
    expect(prompt).toContain("Return empty arrays if nothing fits. Do NOT make things up.");
  });
});

describe("selectExtractContext", () => {
  const day = 86_400_000;
  const fact = (id: number, text: string, ageDays: number, extra: Partial<{ timesReferenced: number; userMarkedImportant: boolean }> = {}) => ({
    id, fact: text, createdAt: new Date(Date.now() - ageDays * day), timesReferenced: 1, emotionalWeight: 0, userMarkedImportant: false, lastReferencedAt: null, ...extra,
  });

  it("takes the top-ranked facts plus older ones the new messages mention, within the cap", () => {
    const facts = [
      ...Array.from({ length: 45 }, (_, i) => fact(100 + i, `Ranked fact number ${i}`, i)),
      fact(900, "Lives in London with two cats", 400), // old, unreferenced — would never rank
      fact(901, "Plays chess on Thursdays", 400),
    ];
    const chosen = selectExtractContext(facts, [{ role: "user", content: "we moved from London to Berlin last week" }]);
    const ids = chosen.map((c) => c.id);
    expect(ids).toContain(900);
    expect(ids).not.toContain(901);
    expect(chosen.length).toBeLessThanOrEqual(EXTRACT_CONTEXT_MAX);
    expect(chosen.filter((c) => c.id >= 100 && c.id < 145)).toHaveLength(40);
  });

  it("returns nothing for a person with no facts", () => {
    expect(selectExtractContext([], [{ role: "user", content: "hi" }])).toEqual([]);
  });
});
