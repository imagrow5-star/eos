/**
 * Crisis reinforcement (services/crisis/reinforcement.ts): the card carries
 * the helpline numbers, so Eos points to it and never restates the numbers in
 * her own sentences. The card itself is unchanged — it still appends on every
 * crisis turn (crisis-floor.test.ts owns that behaviour).
 */
import { describe, it, expect } from "vitest";
import { CRISIS_REINFORCEMENT_BLOCK, CRISIS_REINFORCEMENT_BLOCK_VOICE } from "../services/crisis/reinforcement.js";

describe("crisis reinforcement — don't recite the numbers in prose", () => {
  it("text block: point to the card, never restate the numbers", () => {
    expect(CRISIS_REINFORCEMENT_BLOCK).toContain("that card is what carries them");
    expect(CRISIS_REINFORCEMENT_BLOCK).toContain("Never restate the numbers, names, or hours in your own sentences");
    // The old "append below, then recite" framing is gone.
    expect(CRISIS_REINFORCEMENT_BLOCK).not.toContain("refer to the helpline resources that the system will append below");
  });

  it("voice block still forbids reading the numbers aloud", () => {
    expect(CRISIS_REINFORCEMENT_BLOCK_VOICE).toContain("never read numbers, names, or hours aloud");
  });
});
