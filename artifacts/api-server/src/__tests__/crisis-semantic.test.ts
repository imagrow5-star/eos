/**
 * Deterministic tests for the semantic crisis backstop (services/crisis/
 * semanticDetector.ts) and the language-based helpline country fallback.
 *
 * These run in CI WITHOUT an API key — they never call the live model. The
 * classifier is exercised through an injected `runner`, and the regex-gap
 * corpus proves (deterministically) that these paraphrases are exactly the
 * cases the keyword detector misses today, which is why the backstop exists.
 *
 * The live proof that the real Haiku classifier answers YES on the paraphrases
 * and NO on the figures of speech lives in crisis-semantic.live.test.ts, which
 * is key-gated (skipped here in CI).
 */

import { describe, it, expect } from "vitest";
import { detectCrisis } from "../services/crisis/detector.js";
import {
  detectCrisisSemantic,
  parseVerdict,
  resolveCrisisOutcome,
  SEMANTIC_PATTERN_NAME,
} from "../services/crisis/semanticDetector.js";
import { resolveHelplines } from "../services/crisis/helplines.js";

// ─── The paraphrase corpus (approved) ─────────────────────────────────────────
// Crisis meaning WITHOUT any keyword the regex list matches. Exported so the
// live suite classifies the exact same phrases.
export const REGEX_MISSED_CRISIS_PHRASES = [
  "I don't see the point anymore.",
  "I've been thinking about not being around.",
  "I want the pain to stop forever.",
  "I've picked a date.",
  "Everyone would be better off if I wasn't here.",
  "I'm so tired of being alive.",
  "What's even the point of waking up tomorrow?",
  "I keep wishing I could go to sleep and not wake up.",
  "Sometimes I think everyone would be relieved if I was gone.",
  "I'm ready to check out for good.",
  "I just want it all to be over.",
  "There's no version of tomorrow I want to be in.",
  "Ich sehe einfach keinen Sinn mehr.", // DE: "I just don't see the point anymore"
] as const;

// Ordinary distress / figures of speech that must NOT trigger. Used by the live
// suite; kept here so both suites share one source of truth.
export const NON_CRISIS_PHRASES = [
  "This traffic is killing me.",
  "My phone died and I lost everything.",
  "I'm so done with this job — I want to quit.",
  "I'm exhausted and heartbroken after the breakup.",
  "I'm dying to see the new movie.",
] as const;

describe("regex-gap corpus — proves these paraphrases evade the keyword detector", () => {
  it.each(REGEX_MISSED_CRISIS_PHRASES)("regex does NOT match: %s", (phrase) => {
    // German phrase is checked against the DE set too — still a gap.
    const lang = phrase.startsWith("Ich") ? "de" : "en";
    expect(detectCrisis(phrase, lang).matched).toBe(false);
  });
});

describe("parseVerdict — YES/NO parsing, conservative on garble", () => {
  it("clean YES → matched + available", () => {
    expect(parseVerdict("YES")).toEqual({ matched: true, available: true });
    expect(parseVerdict("  yes\n")).toEqual({ matched: true, available: true });
    expect(parseVerdict("Yes.")).toEqual({ matched: true, available: true });
  });
  it("clean NO → not matched, available", () => {
    expect(parseVerdict("NO")).toEqual({ matched: false, available: true });
    expect(parseVerdict("no")).toEqual({ matched: false, available: true });
  });
  it("garbled/empty → not available (caller falls back to regex)", () => {
    expect(parseVerdict("")).toEqual({ matched: false, available: false });
    expect(parseVerdict("maybe?")).toEqual({ matched: false, available: false });
    expect(parseVerdict("I cannot help")).toEqual({ matched: false, available: false });
  });
});

describe("detectCrisisSemantic — fail-safe, never throws", () => {
  it("runner YES → matched", async () => {
    const r = await detectCrisisSemantic("anything", { runner: async () => "YES" });
    expect(r).toEqual({ matched: true, available: true });
  });
  it("runner NO → not matched but available", async () => {
    const r = await detectCrisisSemantic("anything", { runner: async () => "NO" });
    expect(r).toEqual({ matched: false, available: true });
  });
  it("runner null (no key) → not available", async () => {
    const r = await detectCrisisSemantic("anything", { runner: async () => null });
    expect(r).toEqual({ matched: false, available: false });
  });
  it("runner throws → not available (fail-safe, no throw)", async () => {
    const r = await detectCrisisSemantic("anything", {
      runner: async () => {
        throw new Error("api down");
      },
    });
    expect(r).toEqual({ matched: false, available: false });
  });
  it("runner hangs → times out → not available", async () => {
    const r = await detectCrisisSemantic("anything", {
      timeoutMs: 20,
      runner: () => new Promise<string>(() => {}), // never resolves
    });
    expect(r).toEqual({ matched: false, available: false });
  });
  it("empty message → not available, no call", async () => {
    let called = false;
    const r = await detectCrisisSemantic("   ", {
      runner: async () => {
        called = true;
        return "YES";
      },
    });
    expect(r).toEqual({ matched: false, available: false });
    expect(called).toBe(false);
  });
});

describe("resolveCrisisOutcome — union; semantic never suppresses regex", () => {
  it("regex hit alone → active, keeps the regex pattern name", () => {
    expect(resolveCrisisOutcome({ matched: true, pattern: "want_to_die" }, { matched: false })).toEqual({
      active: true,
      pattern: "want_to_die",
    });
  });
  it("semantic-only hit → active, recorded as semantic_backstop", () => {
    expect(resolveCrisisOutcome({ matched: false }, { matched: true })).toEqual({
      active: true,
      pattern: SEMANTIC_PATTERN_NAME,
    });
  });
  it("regex hit + semantic 'no' → STILL active (semantic can't suppress)", () => {
    expect(resolveCrisisOutcome({ matched: true, pattern: "suicide_reference" }, { matched: false })).toEqual({
      active: true,
      pattern: "suicide_reference",
    });
  });
  it("both negative → inactive", () => {
    expect(resolveCrisisOutcome({ matched: false }, { matched: false })).toEqual({ active: false });
  });
  it("regex pattern wins over semantic when BOTH fire", () => {
    expect(resolveCrisisOutcome({ matched: true, pattern: "self_harm" }, { matched: true })).toEqual({
      active: true,
      pattern: "self_harm",
    });
  });
});

describe("country fallback — language inference when country is missing", () => {
  it("no country + German → DE (not the US/UK global set)", () => {
    expect(resolveHelplines(null, "de").countryServed).toBe("DE");
    expect(resolveHelplines("", "fr").countryServed).toBe("FR");
    expect(resolveHelplines("other", "pt").countryServed).toBe("PT");
    expect(resolveHelplines(undefined, "nl").countryServed).toBe("NL");
  });

  it("all activated non-English languages resolve to a same-language directory", () => {
    const expected: Record<string, string> = {
      de: "DE", nl: "NL", fr: "FR", es: "ES", it: "IT",
      pt: "PT", sv: "SE", no: "NO", da: "DK", pl: "PL",
    };
    for (const [lang, country] of Object.entries(expected)) {
      expect(resolveHelplines(null, lang).countryServed, `lang=${lang}`).toBe(country);
    }
  });

  it("English or unknown language → global fallback (unchanged behavior)", () => {
    expect(resolveHelplines(null, "en").countryServed).toBe("fallback");
    expect(resolveHelplines(null, "xx").countryServed).toBe("fallback");
    expect(resolveHelplines(null, undefined).countryServed).toBe("fallback");
    expect(resolveHelplines(null).countryServed).toBe("fallback");
  });

  it("a real, resolvable country ALWAYS wins over language", () => {
    // German-speaking user who DID set country=IN gets India's lines.
    expect(resolveHelplines("IN", "de").countryServed).toBe("IN");
    expect(resolveHelplines("US", "fr").countryServed).toBe("US");
    // Legacy "UK" alias still resolves to GB regardless of language.
    expect(resolveHelplines("UK", "pl").countryServed).toBe("GB");
  });
});
