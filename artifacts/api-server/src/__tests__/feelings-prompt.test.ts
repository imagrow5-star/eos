/**
 * Deterministic unit test for the feelings extraction prompt (Sprint 2C fix).
 *
 * The bug: feelings rendered with a stray subject — "…, Hi felt a quiet
 * frustration…" — because the old prompt fed the user's name in as a speaker
 * label and asked for "third person about the user", so the model used the name
 * (here a mangled "Hi") as the sentence subject. The stored `feeling` is shown
 * verbatim, so the fix is entirely in the prompt: never pass the user's name,
 * and demand a subjectless, situation-anchored sentence.
 *
 * This pins that contract without a model call.
 */

import { describe, it, expect } from "vitest";
import { buildFeelingsPrompt } from "../services/ai.js";

const messages = [
  { role: "user", content: "the contact refused a Zoom call again and I just gave up" },
  { role: "assistant", content: "that sounds heavy" },
];

describe("buildFeelingsPrompt", () => {
  it("labels the user's turns neutrally as 'User:' — never the user's name", () => {
    const prompt = buildFeelingsPrompt(messages, "Eos");
    expect(prompt).toContain("User: the contact refused a Zoom call again");
    // The companion's real name is fine to include (it's not the leaked subject).
    expect(prompt).toContain("Eos: that sounds heavy");
  });

  it("does not interpolate a user name even when the user is oddly named", () => {
    // The real bug: userName was "Hi". The builder takes no user name at all now,
    // so no such token can reach the prompt regardless of what the name is.
    const prompt = buildFeelingsPrompt(
      [{ role: "user", content: "another blocked call, so frustrating" }],
      "Eos",
    );
    // "Hi" only appears (if at all) as ordinary words, never as a "Hi:" speaker
    // label or a "Hi's life" possessive.
    expect(prompt).not.toContain("Hi:");
    expect(prompt).not.toMatch(/\bHi's life\b/);
  });

  it("demands a subjectless, situation-anchored sentence", () => {
    const prompt = buildFeelingsPrompt(messages, "Eos");
    expect(prompt).toContain("SUBJECTLESS");
    expect(prompt).toContain("NEVER name the user");
    // The old, buggy instruction must be gone.
    expect(prompt).not.toContain("in third person about the user");
    expect(prompt).not.toContain("made them feel small");
  });

  it("spells out the personal-subject forms to avoid", () => {
    const prompt = buildFeelingsPrompt(messages, "Eos");
    expect(prompt).toContain('"they felt small"');
    expect(prompt).toContain('"you felt proud"');
    expect(prompt).toContain("<name> felt frustrated");
  });

  it("still returns the feelings JSON shape with the emotion enum + intensity", () => {
    const prompt = buildFeelingsPrompt(messages, "Eos");
    expect(prompt).toContain('"feelings"');
    expect(prompt).toContain("grief|shame|joy|fear|anger|love|loneliness|hope|anxiety|pride|guilt|relief|sadness|other");
    expect(prompt).toContain("intensity");
  });
});
