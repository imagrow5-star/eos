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
import { buildMemoryExtractPrompt } from "../services/ai.js";

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
