/**
 * Additional safety floors (services/crisis/additionalSafety.ts): harm to
 * others and non-suicide self-endangerment. Conservative by design — the
 * detectors fire on unambiguous intent, not hyperbole, and what they miss
 * falls through to the always-on safety lines in the base prompt.
 */
import { describe, it, expect } from "vitest";
import {
  detectHarmToOthers,
  detectSelfEndangerment,
  additionalSafetyReinforcement,
  HARM_TO_OTHERS_REINFORCEMENT,
  SELF_ENDANGERMENT_REINFORCEMENT,
} from "../services/crisis/additionalSafety.js";

describe("detectHarmToOthers", () => {
  it("fires on a stated intent to hurt a person", () => {
    for (const t of [
      "I'm going to kill him.",
      "I'll murder my boss, I swear.",
      "I want to hurt her for what she did.",
      "i'm gonna beat them up",
    ]) expect(detectHarmToOthers(t), t).toBe(true);
  });

  it("does not fire on hyperbole or self-directed language", () => {
    for (const t of [
      "this deadline is killing me",
      "I could kill for a coffee right now",
      "I want to kill myself", // self-harm — the crisis detector owns this
      "my feet are killing me after that walk",
      "I'm going to see her tomorrow",
      "that show was a total murder of the book",
    ]) expect(detectHarmToOthers(t), t).toBe(false);
  });
});

describe("detectSelfEndangerment", () => {
  it("fires on eating-disorder and substance-misuse behaviour", () => {
    for (const t of [
      "I've been making myself throw up after meals.",
      "I haven't eaten in three days.",
      "I keep binging then purging.",
      "I can't stop drinking lately.",
      "I relapsed last night.",
      "I've been drinking to forget.",
    ]) expect(detectSelfEndangerment(t), t).toBe(true);
  });

  it("does not fire on ordinary mentions of food or drink", () => {
    for (const t of [
      "I ate a huge lunch and feel sleepy",
      "we went drinking with friends on Friday",
      "I'm trying to eat healthier",
      "the restaurant portions were huge",
    ]) expect(detectSelfEndangerment(t), t).toBe(false);
  });
});

describe("additionalSafetyReinforcement", () => {
  it("returns the matching block(s), or empty string when clean", () => {
    expect(additionalSafetyReinforcement("I'm going to kill him")).toBe(HARM_TO_OTHERS_REINFORCEMENT);
    expect(additionalSafetyReinforcement("I keep making myself sick after eating")).toBe(SELF_ENDANGERMENT_REINFORCEMENT);
    expect(additionalSafetyReinforcement("just a quiet day, feeling okay")).toBe("");
  });

  it("joins both when a message trips both floors", () => {
    const out = additionalSafetyReinforcement("I'm going to hurt him, and I can't stop drinking");
    expect(out).toContain("HURTING SOMEONE ELSE");
    expect(out).toContain("FOOD, DRINK, OR DRUGS");
  });
});
