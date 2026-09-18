/**
 * The "where care has edges" safety boundaries (services/systemPrompt.ts):
 * minors, professional-advice, and abuse-disclosure guidance live in the
 * cached stable prompt, present on every turn and both modes.
 */
import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../services/systemPrompt.js";
import { evalProfile, evalMemory } from "../services/eval/fixtures.js";

describe("safety-boundaries section", () => {
  it("carries the minors, professional-advice, and abuse rules in the stable prompt", async () => {
    const profile = evalProfile({ name: "Sam", companionName: "Eos", path: "support", energy: "calm", country: "", ageBand: "", timezone: "UTC", language: "en", daysSinceJoined: 5 });
    const { stable } = await buildSystemPrompt(profile, 1, { memory: evalMemory([], []) });
    expect(stable).toContain("WHERE CARE HAS EDGES");
    expect(stable).toContain("IF THEY TELL YOU THEY'RE UNDER 18");
    expect(stable).toContain("Eos is built for adults");
    expect(stable).toContain("MEDICAL, LEGAL, OR MONEY DECISIONS");
    expect(stable).toContain("not a doctor, lawyer, or financial adviser");
    expect(stable).toContain("IF SOMEONE IS HURTING THEM");
    expect(stable).toContain("this isn't their fault");
  });
});

describe("product-integrity boundaries and transparency", () => {
  it("carries the romantic-advance and privacy blocks, and the transparency line", async () => {
    const { buildSystemPrompt } = await import("../services/systemPrompt.js");
    const { evalProfile, evalMemory } = await import("../services/eval/fixtures.js");
    const profile = evalProfile({ name: "Sam", companionName: "Eos", path: "support", energy: "calm", country: "", ageBand: "", timezone: "UTC", language: "en", daysSinceJoined: 5 });
    const { stable } = await buildSystemPrompt(profile, 1, { memory: evalMemory([], []) });
    // Romantic / sexual advances
    expect(stable).toContain("IF THEY MAKE A ROMANTIC OR SEXUAL ADVANCE");
    expect(stable).toContain("You're a friend, not a partner");
    expect(stable).toContain("never describe a body or a sexual scene");
    // Privacy / data — matches the security page, no overreach
    expect(stable).toContain("IF THEY ASK WHAT HAPPENS TO WHAT THEY TELL YOU");
    expect(stable).toContain("nothing trains any AI model");
    expect(stable).toContain("end-to-end encrypted");
    // Transparency: acknowledge a boundary, never describe the machinery
    expect(stable).toContain("you may tell them a request is outside what you'll help with");
    expect(stable).toContain("never do is name, number, or quote a rule, step, or mode");
  });
});
