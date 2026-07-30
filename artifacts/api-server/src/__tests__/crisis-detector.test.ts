/**
 * Crisis floor — detector + helpline unit tests (no DB, no HTTP).
 *
 * Every named pattern gets a POSITIVE sample (must fire) and a nearby
 * FALSE-POSITIVE sample (must NOT fire — same words in an innocent shape),
 * plus a 20-crisis / 50-normal sweep, country → helpline routing, and the
 * exact block format the frontend splits on.
 */

import { describe, it, expect } from "vitest";
import {
  CRISIS_PATTERNS,
  detectCrisis,
  isCrisisText,
} from "../services/crisis/detector.js";
import {
  resolveHelplines,
  buildHelplineBlockText,
  HELPLINE_BLOCK_MARKER,
} from "../services/crisis/helplines.js";
import { FALLBACK_HELPLINES, HELPLINE_DIRECTORY } from "../services/crisis/helplineDirectory.js";
import {
  CRISIS_REINFORCEMENT_BLOCK,
  CRISIS_REINFORCEMENT_BLOCK_VOICE,
} from "../services/crisis/reinforcement.js";

// ─── Per-pattern positive + false-positive samples ───────────────────────────
// Keyed by pattern name so a renamed/removed pattern fails loudly.

const SAMPLES: Record<string, { fires: string; doesNot: string }> = {
  explicit_suicidal_ideation: {
    fires: "Some nights I think about killing myself just so it stops hurting.",
    doesNot: "I need to kill this deadline before Friday or my boss will flip.",
  },
  suicide_reference: {
    fires: "I've been having thoughts of suicide again",
    doesNot: "the su chef made an incredible soup yesterday",
  },
  self_harm: {
    fires: "I went back to self-harm last night",
    doesNot: "no harm done — myself and the team recovered the file",
  },
  self_harm_intent: {
    fires: "I want to hurt myself tonight",
    doesNot: "I didn't mean to hurt my sister's feelings",
  },
  self_injury: {
    fires: "I've been cutting myself again",
    doesNot: "I cut my hair myself yesterday and it shows",
  },
  want_to_die: {
    fires: "most mornings I just want to die",
    doesNot: "my phone is so old it wants to die dramatically every hour",
  },
  wish_dead: {
    fires: "sometimes I wish I was dead",
    doesNot: "I wish I was there when you got the news",
  },
  wish_not_alive: {
    fires: "I wish I wasn't here anymore",
    doesNot: "I wish I wasn't late to the meeting again",
  },
  passive_ideation: {
    fires: "I don't want to be here anymore",
    doesNot: "I don't want to be dramatic but the pizza was cold",
  },
  no_reason_to_live: {
    fires: "there's no point in living like this",
    doesNot: "there's no reason to worry about the exam",
  },
  end_it_all: {
    fires: "I just want to end it all",
    doesNot: "let's end the meeting early and get lunch",
  },
  burden_belief: {
    fires: "they'd all be better off without me",
    doesNot: "honestly we're better off without meetings on Fridays",
  },
  cant_go_on: {
    fires: "I can't go on like this",
    doesNot: "I can't go to the party this weekend",
  },
  overdose: {
    fires: "I keep thinking about overdosing",
    doesNot: "the sauce was overdone and too salty",
  },
  overdose_slang: {
    fires: "I nearly OD'd last year",
    doesNot: "that's odd, the lights were on when I left",
  },
  life_not_worth_living: {
    fires: "a life like this is not worth living",
    doesNot: "the sequel was not worth watching twice",
  },
  stop_existing: {
    fires: "I just want to stop existing for a while",
    doesNot: "that discount code stopped existing last week",
  },
  disappear_forever: {
    fires: "I want to disappear forever",
    doesNot: "my keys always disappear somewhere in this flat",
  },
  no_way_out: {
    fires: "I feel trapped, like there's no way out",
    doesNot: "the maze exit was clearly marked so we walked right through",
  },
};

describe("crisis detector — per-pattern coverage", () => {
  it("has a sample pair for every pattern (and no stale samples)", () => {
    const names = CRISIS_PATTERNS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length); // names unique
    expect(Object.keys(SAMPLES).sort()).toEqual([...names].sort());
  });

  for (const p of CRISIS_PATTERNS) {
    it(`${p.name}: fires on its positive sample`, () => {
      const s = SAMPLES[p.name]!;
      expect(p.re.test(s.fires)).toBe(true);
      const overall = detectCrisis(s.fires);
      expect(overall.matched).toBe(true);
      expect(overall.pattern).toBeDefined();
    });

    it(`${p.name}: does NOT fire on its false-positive sample`, () => {
      const s = SAMPLES[p.name]!;
      // The whole detector stays silent — not just this one pattern.
      expect(detectCrisis(s.doesNot)).toEqual({ matched: false });
    });
  }

  it("returns the name of the matching pattern", () => {
    expect(detectCrisis("I think about killing myself")).toEqual({
      matched: true,
      pattern: "explicit_suicidal_ideation",
    });
    expect(detectCrisis("they'd be better off without me").pattern).toBe("burden_belief");
  });

  it("handles null-ish and empty input", () => {
    expect(detectCrisis("")).toEqual({ matched: false });
    expect(detectCrisis(null as unknown as string)).toEqual({ matched: false });
    expect(isCrisisText("")).toBe(false);
  });

  it("matches the original chapter detector's documented samples", () => {
    // Same assertions weekly-chapters.test.ts makes — behavior preserved.
    expect(isCrisisText("Some nights I think about killing myself just so it stops hurting.")).toBe(true);
    expect(isCrisisText("I've been having thoughts of suicide again")).toBe(true);
    expect(isCrisisText("I had such a hard day at work today, everything went wrong.")).toBe(false);
    expect(isCrisisText("I miss her so much it aches, but I got through the evening.")).toBe(false);
  });
});

// ─── Sweep: 20 crisis messages fire, 50 normal messages don't ────────────────

const CRISIS_MESSAGES = [
  "I can't stop thinking about killing myself",
  "honestly I've been suicidal all week",
  "I went back to self harm last night",
  "I'm scared I'll hurt myself if I'm alone tonight",
  "I started cutting myself again",
  "I just want to die",
  "I wanted to die all through dinner",
  "I wish I were dead",
  "some days I wish I wasn't alive",
  "I don't want to wake up tomorrow",
  "there's no point in going on",
  "I want to end my life",
  "everyone would be better off without me",
  "I can't do this anymore",
  "I keep thinking about an overdose",
  "I almost OD'd on my meds",
  "my life is not worth living",
  "I want to stop existing",
  "I'd like to disappear forever",
  "I'm trapped and there's no way out for me",
];

const NORMAL_MESSAGES = [
  "I had such a hard day at work today, everything went wrong.",
  "I miss her so much it aches, but I got through the evening.",
  "that's odd, my streak reset overnight",
  "can we talk about my sister's wedding?",
  "the gym was packed this morning",
  "I finally finished that book you mentioned",
  "work has been brutal this week",
  "I cooked dinner for the first time in ages",
  "my boss praised the report I wrote",
  "I slept badly but the coffee helped",
  "the traffic made me late again",
  "I'm nervous about the interview tomorrow",
  "we watched a documentary about the ocean",
  "my mum called and we talked for an hour",
  "I want to get back into running",
  "the weather was gorgeous at lunch",
  "I need to kill some time before my flight",
  "let's end the meeting early on Friday",
  "the movie was not worth watching",
  "I cut my hair myself and I regret it",
  "I didn't mean to hurt my friend's feelings",
  "I wish I was there for the party",
  "I don't want to be late tomorrow",
  "there's no reason to worry about rent this month",
  "we're better off without meetings on Fridays",
  "I can't go to the concert anymore",
  "the pasta sauce was overdone",
  "my keys always disappear somewhere",
  "the sale ended before I could buy the jacket",
  "I'm proud of how the presentation went",
  "my cat knocked over the plant again",
  "the new album is on repeat all day",
  "I tried yoga for the first time",
  "the wifi kept dropping during the call",
  "I'm thinking about repainting the bedroom",
  "we got lost on the hike but found a lake",
  "my phone update broke the camera app",
  "the bakery ran out of croissants",
  "I organized my closet finally",
  "the meeting ran long but it was useful",
  "I planted basil on the balcony",
  "my nephew learned to ride a bike",
  "the dentist appointment went fine",
  "I found a great podcast about history",
  "the bus was early for once",
  "I'm learning to make sourdough",
  "we played board games until midnight",
  "the printer jammed right before the deadline",
  "I swapped shifts so I can see the game",
  "the library extended its hours this month",
];

describe("crisis detector — sweep", () => {
  it("fires on all 20 crisis samples", () => {
    expect(CRISIS_MESSAGES).toHaveLength(20);
    for (const m of CRISIS_MESSAGES) {
      expect(detectCrisis(m).matched, `should fire: "${m}"`).toBe(true);
    }
  });

  it("stays silent on all 50 normal samples", () => {
    expect(NORMAL_MESSAGES).toHaveLength(50);
    for (const m of NORMAL_MESSAGES) {
      expect(detectCrisis(m).matched, `should NOT fire: "${m}"`).toBe(false);
    }
  });
});

// ─── Country → helpline routing ──────────────────────────────────────────────

describe("helpline routing", () => {
  it("serves India's three lines for country=IN", () => {
    const r = resolveHelplines("IN");
    expect(r.countryServed).toBe("IN");
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]!.name).toContain("AASRA");
    expect(r.lines.map((l) => l.name).join(" ")).toContain("Vandrevala");
  });

  it("serves Samaritans for the legacy UK code and for GB", () => {
    for (const code of ["UK", "GB", "uk"]) {
      const r = resolveHelplines(code);
      expect(r.countryServed).toBe("GB");
      expect(r.lines[0]!.name).toBe("Samaritans");
    }
  });

  it("serves 988 for the US", () => {
    const r = resolveHelplines("US");
    expect(r.countryServed).toBe("US");
    expect(r.lines[0]!.number).toBe("988");
  });

  it("falls back for unknown, empty, 'other', and null countries", () => {
    for (const code of ["ZZ", "", "other", null, undefined]) {
      const r = resolveHelplines(code as string | null | undefined);
      expect(r.countryServed, `code=${String(code)}`).toBe("fallback");
      expect(r.lines).toEqual(FALLBACK_HELPLINES);
      expect(r.lines.map((l) => l.number).join(" ")).toContain("befrienders.org");
    }
  });

  it("covers 30 countries (plus the UK alias)", () => {
    // 30 distinct country entries; "UK" aliases the GB entry.
    const distinct = new Set([...HELPLINE_DIRECTORY.values()].map((e) => e.country));
    expect(distinct.size).toBe(30);
    expect(HELPLINE_DIRECTORY.get("UK")).toBe(HELPLINE_DIRECTORY.get("GB"));
    for (const entry of HELPLINE_DIRECTORY.values()) {
      expect(entry.lines.length).toBeGreaterThan(0);
      expect(entry.lines.length).toBeLessThanOrEqual(3);
      for (const l of entry.lines) {
        expect(l.name.length).toBeGreaterThan(0);
        expect(l.number.length).toBeGreaterThan(0);
        expect(l.hours.length).toBeGreaterThan(0);
        expect(l.modality.length).toBeGreaterThan(0);
      }
    }
  });
});

// ─── Block format ────────────────────────────────────────────────────────────

describe("helpline block format", () => {
  it("starts with the exact marker, lists lines, ends with the closing sentence", () => {
    const { lines } = resolveHelplines("IN");
    const block = buildHelplineBlockText(lines);
    expect(block.startsWith(HELPLINE_BLOCK_MARKER)).toBe(true);
    const rows = block.split("\n");
    expect(rows[0]).toBe("—");
    expect(rows[1]).toBe("Someone who can be with you right now, if you want to reach:");
    expect(rows[rows.length - 1]).toBe("I'm not going anywhere. Take your time.");
    expect(rows.filter((r) => r.startsWith("- "))).toHaveLength(3);
  });
});

// ─── Reinforcement blocks ────────────────────────────────────────────────────

describe("crisis reinforcement blocks", () => {
  it("chat block carries the hard rules verbatim", () => {
    expect(CRISIS_REINFORCEMENT_BLOCK).toContain("CRISIS DETECTED IN THIS MESSAGE");
    expect(CRISIS_REINFORCEMENT_BLOCK).toContain("Are you thinking about ending your life?");
    expect(CRISIS_REINFORCEMENT_BLOCK).toContain("the system will append below");
    expect(CRISIS_REINFORCEMENT_BLOCK).toContain("Never end by disappearing.");
  });

  it("voice block never asks the model to speak numbers and points at the on-screen card", () => {
    expect(CRISIS_REINFORCEMENT_BLOCK_VOICE).toContain("CRISIS DETECTED IN THIS MESSAGE");
    expect(CRISIS_REINFORCEMENT_BLOCK_VOICE).toContain("on their screen");
    expect(CRISIS_REINFORCEMENT_BLOCK_VOICE).toContain("never read numbers");
    expect(CRISIS_REINFORCEMENT_BLOCK_VOICE).not.toContain("append below");
  });
});
