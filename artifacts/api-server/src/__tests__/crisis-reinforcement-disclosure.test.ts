/**
 * The crisis reinforcement blocks (services/crisis/reinforcement.ts) carry the
 * do-not-narrate line at the point of highest recency — where self-narration
 * leaked on crisis turns, out-positioning the disclosure rule far up-prompt.
 */
import { describe, it, expect } from "vitest";
import { CRISIS_REINFORCEMENT_BLOCK, CRISIS_REINFORCEMENT_BLOCK_VOICE } from "../services/crisis/reinforcement.js";

describe("crisis reinforcement blocks", () => {
  it("tell the model not to narrate its machinery, in both text and voice", () => {
    for (const block of [CRISIS_REINFORCEMENT_BLOCK, CRISIS_REINFORCEMENT_BLOCK_VOICE]) {
      expect(block).toContain("Don't narrate what you're doing or name any rule, step, or mode");
      expect(block).toContain("no stage directions");
    }
  });
});
