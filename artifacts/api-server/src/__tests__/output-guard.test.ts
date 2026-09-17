/**
 * Rule 1 output guard (services/outputGuard.ts): the "I'm here for …" family
 * is detected and rewritten to "I'm right here", and the crisis-scripted bare
 * lines are left alone.
 */
import { describe, it, expect } from "vitest";
import { detectBannedComfort, stripBannedComfort } from "../services/outputGuard.js";

describe("detectBannedComfort", () => {
  it("flags the banned I'm-here-for family, in either contraction form", () => {
    expect(detectBannedComfort("I'm here for you, always.")).toEqual(["here_for_you"]);
    expect(detectBannedComfort("i am here for that if you want.")).toEqual(["here_for_that"]);
    expect(detectBannedComfort("I'm here for whatever you're actually exploring.")).toEqual(["here_for_whatever"]);
  });

  it("leaves the crisis-scripted and ordinary lines untouched", () => {
    expect(detectBannedComfort("I'm here.")).toEqual([]);
    expect(detectBannedComfort("I'm not going anywhere. Take your time.")).toEqual([]);
    expect(detectBannedComfort("I'm here too, if you want to keep talking.")).toEqual([]);
    expect(detectBannedComfort("There's a bench here for the garden.")).toEqual([]);
  });
});

describe("stripBannedComfort", () => {
  it("rewrites to a plain in-register line and reports the hit", () => {
    expect(stripBannedComfort("I'm here for you.")).toEqual({ text: "I'm right here.", hits: ["here_for_you"] });
    expect(stripBannedComfort("Okay. I'm here for that if you want to talk.")).toEqual({
      text: "Okay. I'm right here if you want to talk.",
      hits: ["here_for_that"],
    });
    expect(stripBannedComfort("I'm here for whatever you're actually exploring, honestly.")).toEqual({
      text: "I'm right here.",
      hits: ["here_for_whatever"],
    });
  });

  it("is a no-op on clean text", () => {
    const clean = "Three years with Sam doesn't just vanish. Of course tonight is heavy.";
    expect(stripBannedComfort(clean)).toEqual({ text: clean, hits: [] });
    expect(stripBannedComfort("I'm here.")).toEqual({ text: "I'm here.", hits: [] });
  });
});
