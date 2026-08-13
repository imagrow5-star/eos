/**
 * LIVE proof for the semantic crisis backstop — calls the real Haiku
 * classifier. Key-gated: skipped whenever ANTHROPIC_API_KEY is absent (CI
 * deliberately omits it, so this never hits the network there). Run locally
 * with a key to confirm the layer actually works in practice:
 *
 *   ANTHROPIC_API_KEY=sk-... pnpm --filter @workspace/api-server test crisis-semantic.live
 *
 * Asserts the exact reviewed corpus: every paraphrase the regex MISSES is
 * caught as YES, and every ordinary-distress / figure-of-speech line is NO.
 */

import { describe, it, expect } from "vitest";
import { detectCrisisSemantic } from "../services/crisis/semanticDetector.js";
import { REGEX_MISSED_CRISIS_PHRASES, NON_CRISIS_PHRASES } from "./crisis-semantic.test.js";

const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!HAS_KEY)("semantic backstop — LIVE model", () => {
  it.each(REGEX_MISSED_CRISIS_PHRASES)(
    "catches paraphrased crisis as YES: %s",
    async (phrase) => {
      const r = await detectCrisisSemantic(phrase);
      expect(r.available, `classifier unavailable for: ${phrase}`).toBe(true);
      expect(r.matched, `expected YES for: ${phrase}`).toBe(true);
    },
    20_000,
  );

  it.each(NON_CRISIS_PHRASES)(
    "does NOT fire on ordinary distress / figure of speech: %s",
    async (phrase) => {
      const r = await detectCrisisSemantic(phrase);
      expect(r.available, `classifier unavailable for: ${phrase}`).toBe(true);
      expect(r.matched, `expected NO for: ${phrase}`).toBe(false);
    },
    20_000,
  );
});
