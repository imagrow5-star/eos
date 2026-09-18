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

import { detectSelfNarration, stripSelfNarration, guardReply } from "../services/outputGuard.js";

describe("self-narration guard", () => {
  it("detects and strips a wrapped stage direction whole", () => {
    const r = stripSelfNarration("*(Now shifts to SAFE HAVEN mode — pure presence)* Talk to me.");
    expect(r.hits).toContain("stage_direction");
    expect(r.text).toBe("Talk to me.");
  });

  it("detects and strips a (Rule N) citation, leaving clean text", () => {
    expect(stripSelfNarration("I stay with the feeling (Rule 8).")).toEqual({
      text: "I stay with the feeling.",
      hits: ["rule_citation"],
    });
    expect(stripSelfNarration("Okay (Care System Step 1), tell me more.")).toMatchObject({
      text: "Okay, tell me more.",
    });
  });

  it("strips a citation parenthetical that carries trailing content", () => {
    // The scenario-12 leak forms: a parenthetical opening with a machinery
    // citation but not closing straight after it.
    expect(stripSelfNarration("Immediate care (Rule 8, Safe Haven): I stay.")).toMatchObject({
      text: "Immediate care: I stay.",
    });
    expect(stripSelfNarration("Receive the feeling fully (Rule 8 dominates) tonight.")).toMatchObject({
      text: "Receive the feeling fully tonight.",
    });
  });

  it("drops a whole sentence that names the machinery in bare prose", () => {
    // The scenario-7 leak: a bare-prose mode name, no parentheses. Excising the
    // token alone would leave "This is : pure presence" — so the sentence goes.
    const r = stripSelfNarration("I hear you. This is Safe Haven mode: pure presence, zero fixing. Fifteen years, gone.");
    expect(r.hits).toContain("mode_name");
    expect(r.text).toBe("I hear you. Fifteen years, gone.");
    expect(r.flagged).toBeUndefined();
  });

  it("strips a bare 'Rule N' sentence too", () => {
    const r = stripSelfNarration("Fifteen years is not nothing. Rule 8 says stay with it. That loss is real.");
    expect(r.text).toBe("Fifteen years is not nothing. That loss is real.");
  });

  it("does not touch an ordinary short reply that is simply brief", () => {
    // "Talk to me." is only 11 chars but nothing was removed, so it stands.
    expect(stripSelfNarration("*(safe-haven mode)* Talk to me.")).toMatchObject({ text: "Talk to me." });
  });

  it("leaves a gutted reply through, flagged, rather than returning near-nothing", () => {
    // The reply is ENTIRELY narration — dropping it would leave "" (or under
    // the floor). A slightly broken reply beats an empty one, so it passes
    // through unchanged and flagged.
    const only = "This is Safe Haven mode: pure presence, zero fixing.";
    const r = stripSelfNarration(only);
    expect(r.text).toBe(only);
    expect(r.flagged).toBe(true);
    expect(r.hits).toContain("mode_name");
  });

  it("flags an all-stage-direction reply instead of emptying it", () => {
    const only = "*(Now shifts into safe-haven mode — pure presence, zero fixing)*";
    const r = stripSelfNarration(only);
    expect(r.text).toBe(only);
    expect(r.flagged).toBe(true);
  });

  it("does not drop ordinary sentences about a 'care system' or a 'rule'", () => {
    // "care system" in bare prose is almost always the healthcare/social sense —
    // never sentence-stripped. "rule" without a number is not a citation.
    const care = "The mental health care system failed you, and that wasn't your fault.";
    expect(stripSelfNarration(care).text).toBe(care);
    const rule = "The golden rule is to be kind to yourself first.";
    expect(stripSelfNarration(rule)).toEqual({ text: rule, hits: [] });
  });

  it("is a no-op on ordinary text and does not touch bare mode words in prose", () => {
    const clean = "step by step, we'll get through tonight.";
    expect(stripSelfNarration(clean)).toEqual({ text: clean, hits: [] });
    expect(detectSelfNarration("I'm here.")).toEqual([]);
  });
});

describe("guardReply", () => {
  it("applies both guards and reports each family", () => {
    const r = guardReply("*(shifts to safe-haven mode)* I'm here for you. (Rule 8)");
    expect(r.bannedComfort).toEqual(["here_for_you"]);
    expect(r.selfNarration).toContain("stage_direction");
    expect(r.text).not.toMatch(/\*\(/);
    expect(r.text).not.toMatch(/here for you/i);
    expect(r.text).not.toMatch(/Rule 8/);
  });

  it("is a clean pass-through on a good reply", () => {
    const good = "Three years with Sam doesn't just vanish. Of course tonight is heavy.";
    expect(guardReply(good)).toEqual({ text: good, bannedComfort: [], selfNarration: [] });
  });
});
