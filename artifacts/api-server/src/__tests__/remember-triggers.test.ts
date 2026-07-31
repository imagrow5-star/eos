/**
 * Sprint 2B — "remember this" detection, the +10 ranking boost, and the
 * acknowledgment guidance. All deterministic (no DB, no model).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectRememberIntent,
  REMEMBER_TRIGGERS_EN,
} from "../services/memory/rememberTriggers.js";
import { rankFactsByImportance, scoreFactImportance, type ScorableFact } from "../services/memory/importance.js";
// NOTE: REMEMBER_ACK_GUIDANCE lives in systemPrompt.ts, which hard-imports the
// db module (throws at import time without DATABASE_URL). The acknowledgment
// wording + guidance-only-when-flag assertions therefore live in the DB-gated
// integration suite (remember-this-integration.test.ts), not here — this file
// must stay runnable with no DB.

const en = (s: string) => detectRememberIntent(s, "en");

describe("detectRememberIntent — positive matches", () => {
  const positives: Array<[string, string]> = [
    ["bare trigger", "remember this"],
    ["trigger + fact", "Remember this: my appointment is Tuesday at 3"],
    ["please remember", "please remember my mom's birthday is next week"],
    ["case-insensitive", "Please Remember to water the plants"],
    ["don't forget", "don't forget my therapy is on Wednesdays"],
    ["dont forget (no apostrophe)", "dont forget the dentist"],
    ["don’t forget (curly apostrophe)", "don’t forget to call Sam"],
    ["make a note", "can you make a note of this for me"],
    ["important to me", "that's really important to me"],
    ["keep this in mind", "keep this in mind for later"],
    ["whitespace tolerant", "   remember    this   "],
    ["mid-sentence", "Hey, remember this — my sister's wedding is in June."],
    ["can you remember this (a request, not a question)", "can you remember this for me?"],
  ];
  for (const [name, input] of positives) {
    it(`triggers: ${name}`, () => expect(en(input)).toBe(true));
  }
});

describe("detectRememberIntent — false-positive guards (must NOT trigger)", () => {
  const negatives: Array<[string, string]> = [
    ["remember when (past reference)", "remember when we went to the beach?"],
    ["do you remember (question)", "do you remember this song?"],
    ["I remember (recalling)", "I remember this place fondly"],
    ["I don't remember", "honestly I don't remember"],
    ["no trigger at all", "what did we talk about yesterday?"],
    ["empty string", ""],
    ["unrelated", "tell me a joke"],
    ["remember alone, no 'this'", "I'll remember"],
  ];
  for (const [name, input] of negatives) {
    it(`does not trigger: ${name}`, () => expect(en(input)).toBe(false));
  }
});

describe("i18n guardrail", () => {
  it("English trigger list is paired with an i18n TODO for the other languages", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = fs.readFileSync(
      path.resolve(here, "../services/memory/rememberTriggers.ts"),
      "utf8",
    );
    // If someone adds/edits English triggers, the TODO(i18n) block must remain,
    // naming the 10 other active languages so it's obvious translations are owed.
    expect(src).toMatch(/TODO\(i18n\)/);
    for (const code of ["nl", "de", "fr", "es", "it", "pt", "sv", "no", "da", "pl"]) {
      expect(src, `TODO must name language "${code}"`).toContain(`(${code})`);
    }
    // Every phrase in the exported list should actually be detected — keeps the
    // list honest if a phrase is added there but the matcher isn't updated.
    for (const phrase of REMEMBER_TRIGGERS_EN) {
      expect(en(phrase), `"${phrase}" is listed but not detected`).toBe(true);
    }
  });
});

describe("ranking: user_marked_important fires the +10 boost (Sprint 2A ranker)", () => {
  const now = 1_700_000_000_000;
  const base: ScorableFact = {
    createdAt: new Date(now - 30 * 86_400_000), // both 30 days old
    timesReferenced: 1,
    lastReferencedAt: new Date(now - 30 * 86_400_000),
    emotionalWeight: 0.2,
    userMarkedImportant: false,
  };

  it("a marked fact ranks above a same-age unmarked fact", () => {
    const unmarked = { ...base };
    const marked = { ...base, userMarkedImportant: true };
    const ranked = rankFactsByImportance([unmarked, marked], now, 40);
    expect(ranked[0]).toBe(marked);
    expect(scoreFactImportance(marked, now) - scoreFactImportance(unmarked, now)).toBeCloseTo(10.0, 5);
  });

  it("marking outweighs recency: a marked OLD fact beats an unmarked NEW fact", () => {
    const oldMarked = { ...base, createdAt: new Date(now - 180 * 86_400_000), userMarkedImportant: true };
    const newUnmarked = { ...base, createdAt: new Date(now - 1 * 86_400_000) };
    const ranked = rankFactsByImportance([newUnmarked, oldMarked], now, 40);
    expect(ranked[0]).toBe(oldMarked);
  });
});
