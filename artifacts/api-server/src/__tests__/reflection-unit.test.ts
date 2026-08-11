/**
 * Pure unit tests for the reflection report generator — no DB, no LLM, always
 * run. These pin the parts that are the whole point of the feature:
 *  - the report prompt keeps its grounding + no-diagnosis + closing-question rules;
 *  - the minimum-content gate skips thin periods (auto-run) at the right bar;
 *  - the source-text builder feeds the model the transcript + memories + goals,
 *    labelled and traceable, with nothing invented.
 */

import { describe, it, expect } from "vitest";
import { REPORT_SYSTEM_PROMPT, SELF_CHECK_SYSTEM_PROMPT } from "../services/reflection/prompts.js";
import {
  buildReflectionSourceText,
  hasEnoughContent,
  MIN_USER_MESSAGES_FOR_AUTO,
  type ReflectionSource,
} from "../services/reflection/generateReport.js";

// Minimal structural stand-in for the export payload — the generator only reads
// these four arrays (defensively), so a partial is enough to unit-test.
function payload(parts: {
  messages?: { role: string; content: string }[];
  memoryFacts?: { fact: string }[];
  memoryFeelings?: { feeling: string }[];
  goals?: { title?: string; description?: string }[];
}): ReflectionSource {
  return {
    messages: parts.messages ?? [],
    memoryFacts: parts.memoryFacts ?? [],
    memoryFeelings: parts.memoryFeelings ?? [],
    goals: parts.goals ?? [],
  } as unknown as ReflectionSource;
}

describe("reflection prompts", () => {
  it("report prompt keeps the grounding, no-diagnosis, and closing-question rules", () => {
    expect(REPORT_SYSTEM_PROMPT).toContain("Use ONLY the provided text");
    expect(REPORT_SYSTEM_PROMPT).toContain("not enough here to reflect on yet");
    expect(REPORT_SYSTEM_PROMPT).toContain("THIS PERIOD, IN SHORT");
    expect(REPORT_SYSTEM_PROMPT).toContain("WORTH NOTICING");
    expect(REPORT_SYSTEM_PROMPT).toContain("IN YOUR OWN WORDS");
    expect(REPORT_SYSTEM_PROMPT).toContain("A QUESTION TO SIT WITH");
    expect(REPORT_SYSTEM_PROMPT).toContain("NEVER as a diagnosis");
    expect(REPORT_SYSTEM_PROMPT).toContain("NO clinical or diagnostic language");
  });

  it("self-check prompt strips unsupported claims and diagnoses", () => {
    expect(SELF_CHECK_SYSTEM_PROMPT).toContain("Remove or correct anything that is NOT");
    expect(SELF_CHECK_SYSTEM_PROMPT).toContain("Remove any diagnosis, clinical label");
    expect(SELF_CHECK_SYSTEM_PROMPT).toContain("Return the corrected");
  });
});

describe("minimum-content gate", () => {
  const userMsgs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ role: "user", content: `thing ${i}` }));

  it(`is false below ${MIN_USER_MESSAGES_FOR_AUTO} user messages`, () => {
    expect(hasEnoughContent(payload({ messages: userMsgs(MIN_USER_MESSAGES_FOR_AUTO - 1) }))).toBe(false);
  });

  it(`is true at ${MIN_USER_MESSAGES_FOR_AUTO} user messages`, () => {
    expect(hasEnoughContent(payload({ messages: userMsgs(MIN_USER_MESSAGES_FOR_AUTO) }))).toBe(true);
  });

  it("counts only the user's own non-empty messages, not the companion's", () => {
    const messages = [
      ...userMsgs(2),
      ...Array.from({ length: 20 }, () => ({ role: "assistant", content: "reply" })),
      { role: "user", content: "   " }, // blank — doesn't count
    ];
    expect(hasEnoughContent(payload({ messages }))).toBe(false);
  });

  it("an empty period is not enough", () => {
    expect(hasEnoughContent(payload({}))).toBe(false);
  });
});

describe("source-text builder", () => {
  it("includes the transcript (labelled), facts, feelings and goals", () => {
    const text = buildReflectionSourceText(
      payload({
        messages: [
          { role: "user", content: "I want to leave my job" },
          { role: "assistant", content: "tell me more" },
        ],
        memoryFacts: [{ fact: "works nights at a hospital" }],
        memoryFeelings: [{ feeling: "The night shift left a hollow tiredness" }],
        goals: [{ title: "walk daily", description: "after morning coffee" }],
      }),
    );
    expect(text).toContain("User: I want to leave my job");
    expect(text).toContain("Companion: tell me more");
    expect(text).toContain("works nights at a hospital");
    expect(text).toContain("The night shift left a hollow tiredness");
    expect(text).toContain("walk daily");
    expect(text).toContain("after morning coffee");
  });

  it("omits sections that have no content (no invented scaffolding)", () => {
    const text = buildReflectionSourceText(
      payload({ messages: [{ role: "user", content: "hello" }] }),
    );
    expect(text).toContain("User: hello");
    expect(text).not.toContain("SAVED MEMORIES");
    expect(text).not.toContain("STATED GOALS");
  });

  it("empty payload yields empty source", () => {
    expect(buildReflectionSourceText(payload({}))).toBe("");
  });
});
