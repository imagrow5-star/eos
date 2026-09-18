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
