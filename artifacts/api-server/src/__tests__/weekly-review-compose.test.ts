/**
 * Weekly review — stage 3 composer (pure, no DB, no model).
 *
 * Pins the hard rules structurally:
 *  - fewer than five messages → no story; fewer than three cards → no story;
 *  - the grief/crisis guardrail suppresses "forward" but keeps "did";
 *  - the moment card is rejected when it names a feeling, praises, or reads
 *    between the lines;
 *  - the fragment is verbatim or nothing;
 *  - wins flip from the user's first person to second person, nothing else
 *    changes; commitments read as the promise they made;
 *  - the pattern card counts their own word and needs a real recurrence.
 */

import { describe, it, expect } from "vitest";
import {
  composeStory,
  toSecondPerson,
  commitmentAsPromise,
  validateMoment,
  validateFragment,
  fallbackFragment,
  recurringWord,
  relativeStamp,
  formatWeekRange,
  type WeekSources,
} from "../services/weeklyReviewCompose.js";

const WEEK = { weekStart: "2026-08-31", weekEnd: "2026-09-06" }; // Mon → Sun

function msg(id: number, localDate: string, content: string) {
  return { id, localDate, content };
}

const WEEK_MESSAGES = [
  msg(1, "2026-08-31", "Quiet start. Work was fine, the flat is too quiet though."),
  msg(2, "2026-09-01", "Talked to my dad about the garden again, he wants me to come and see the roses."),
  msg(3, "2026-09-02", "Feeling steady today. Steady is the word I keep coming back to."),
  msg(4, "2026-09-03", "Walked again, two days running now. Steady."),
  msg(5, "2026-09-04", "I texted my sister back. She just said finally."),
  msg(6, "2026-09-05", "Still steady. Not great, not bad, just steady."),
];

function sources(overrides: Partial<WeekSources> = {}): WeekSources {
  return {
    ...WEEK,
    userName: "Sam",
    companionName: "Eos",
    messages: WEEK_MESSAGES,
    monthMessages: WEEK_MESSAGES,
    wins: [{ content: "I walked two days running, even though it felt heavy.", localDate: "2026-09-03" }],
    quotePairs: [
      {
        then: { text: "I don't want to be a burden to anyone", date: "2026-08-14" },
        now: { text: "I texted my sister back. She just said finally.", date: "2026-09-04" },
      },
    ],
    openCommitments: [{ content: "I'll call my brother on Sunday", localDate: "2026-09-02", scheduledDate: "2026-09-06" }],
    pendingNoteDate: "2026-08-14",
    firstMessageDate: "2026-07-15",
    guardrail: false,
    ...overrides,
  };
}

// ── Voice ───────────────────────────────────────────────────────────────────

describe("toSecondPerson", () => {
  it("flips the pronouns of a first-person win and nothing else", () => {
    expect(toSecondPerson("I walked two days running, even though it felt heavy.")).toBe(
      "You walked two days running, even though it felt heavy.",
    );
    expect(toSecondPerson("I'm back at the gym and my knee held up")).toBe("You're back at the gym and your knee held up.");
    expect(toSecondPerson("I've finally sorted myself out")).toBe("You've finally sorted yourself out.");
    expect(toSecondPerson("Sarah called me and I let her")).toBe("Sarah called you and you let her.");
  });

  it("normalises legacy third-person and bare-verb entries", () => {
    expect(toSecondPerson("User went for a walk")).toBe("You went for a walk.");
    expect(toSecondPerson("Went for a walk")).toBe("You went for a walk.");
    expect(toSecondPerson("Called Mum back.")).toBe("You called Mum back.");
  });
});

describe("commitmentAsPromise", () => {
  it("drops the first-person opener so the sentence reads 'you said you'd …'", () => {
    expect(commitmentAsPromise("I'll call the GP on Tuesday morning.")).toBe("call the GP on Tuesday morning");
    expect(commitmentAsPromise("I'm going to call my brother on Sunday")).toBe("call your brother on Sunday");
    expect(commitmentAsPromise("Text Sam tomorrow after my coffee")).toBe("text Sam tomorrow after your coffee");
  });
});

// ── Moment card gate ────────────────────────────────────────────────────────

describe("validateMoment", () => {
  it("accepts one plain second-person sentence about what they talked about", () => {
    expect(validateMoment("You talked about your dad's garden again on Tuesday.")).toBe(
      "You talked about your dad's garden again on Tuesday.",
    );
  });

  it("rejects feelings, praise, verdicts and interpretation", () => {
    for (const bad of [
      "You seemed lighter on Tuesday.",
      "You felt proud of the walk on Thursday.",
      "Well done on Tuesday.",
      "You made real progress this week.",
      "You must have missed him on Tuesday.",
      "You were clearly struggling on Monday.",
    ]) {
      expect(validateMoment(bad)).toBeNull();
    }
  });

  it("rejects the wrong shape: not second person, two sentences, too long, not a string", () => {
    expect(validateMoment("Sam talked about the garden on Tuesday.")).toBeNull();
    expect(validateMoment("You talked about the garden. It was Tuesday.")).toBeNull();
    expect(validateMoment(`You ${"talked and talked ".repeat(10)}on Tuesday.`)).toBeNull();
    expect(validateMoment(null)).toBeNull();
    expect(validateMoment(42)).toBeNull();
  });
});

// ── Fragment ────────────────────────────────────────────────────────────────

describe("fragment", () => {
  it("accepts a verbatim excerpt of the named message, wrapped in quotes", () => {
    expect(validateFragment({ messageId: 5, excerpt: "She just said finally" }, WEEK_MESSAGES)).toBe("“She just said finally”");
  });

  it("rejects a paraphrase, an unknown message, and anything too long or too short", () => {
    expect(validateFragment({ messageId: 5, excerpt: "she said finally" }, WEEK_MESSAGES)).toBeNull(); // case changed
    expect(validateFragment({ messageId: 99, excerpt: "She just said finally" }, WEEK_MESSAGES)).toBeNull();
    expect(validateFragment({ messageId: 2, excerpt: "Talked to my dad about the garden again, he wants me" }, WEEK_MESSAGES)).toBeNull();
    expect(validateFragment({ messageId: 5, excerpt: "She" }, WEEK_MESSAGES)).toBeNull();
    expect(validateFragment(null, WEEK_MESSAGES)).toBeNull();
  });

  it("falls back to a short clause from their most recent message", () => {
    const f = fallbackFragment(WEEK_MESSAGES);
    expect(f).not.toBeNull();
    expect(f!.startsWith("“") && f!.endsWith("”")).toBe(true);
    const inner = f!.slice(1, -1);
    expect(WEEK_MESSAGES[5]!.content).toContain(inner); // verbatim, from the last message
    expect(inner.length).toBeLessThanOrEqual(38);
  });
});

// ── Pattern ─────────────────────────────────────────────────────────────────

describe("recurringWord", () => {
  it("finds the word they keep using, counted across days", () => {
    const w = recurringWord(WEEK_MESSAGES, ["Sam", "Eos"]);
    expect(w).toEqual({ word: "steady", count: 5, days: 3 });
  });

  it("needs a real recurrence and ignores names and filler", () => {
    expect(recurringWord(WEEK_MESSAGES.slice(0, 2), ["Sam", "Eos"])).toBeNull();
    const named = [
      msg(1, "2026-09-01", "Eos Eos Eos Eos"),
      msg(2, "2026-09-02", "Eos really really"),
      msg(3, "2026-09-03", "Eos really really really"),
    ];
    expect(recurringWord(named, ["Sam", "Eos"])).toBeNull();
  });
});

// ── Dates ───────────────────────────────────────────────────────────────────

describe("stamps", () => {
  it("relativeStamp: weekday inside the week, then last week, weeks ago, then the date", () => {
    expect(relativeStamp("2026-09-04", WEEK.weekStart, WEEK.weekEnd)).toBe("Friday");
    expect(relativeStamp("2026-08-27", WEEK.weekStart, WEEK.weekEnd)).toBe("Last week");
    expect(relativeStamp("2026-08-10", WEEK.weekStart, WEEK.weekEnd)).toBe("Three weeks ago");
    expect(relativeStamp("2026-06-08", WEEK.weekStart, WEEK.weekEnd)).toBe("8 June");
  });

  it("formatWeekRange", () => {
    expect(formatWeekRange("2026-09-07", "2026-09-13")).toBe("7–13 September");
    expect(formatWeekRange("2026-08-31", "2026-09-06")).toBe("31 August – 6 September");
  });
});

// ── Compose ─────────────────────────────────────────────────────────────────

describe("composeStory", () => {
  it("a quiet week (fewer than five messages) is no story", () => {
    const r = composeStory(sources({ messages: WEEK_MESSAGES.slice(0, 4) }));
    expect(r.skipped).toBe("quiet_week");
  });

  it("builds the six cards in order from real sources, with the moment from a valid proposal", () => {
    const r = composeStory(sources(), {
      moment: "You talked about your dad's garden again on Tuesday.",
      fragment: { messageId: 5, excerpt: "She just said finally" },
    });
    expect(r.skipped).toBeUndefined();
    const { fragment, cards } = r.story!;
    expect(fragment).toBe("“She just said finally”");
    expect(cards.map((c) => c.kind)).toEqual(["moment", "did", "thenNow", "open", "pattern", "forward"]);

    expect(cards[0]).toEqual({ kind: "moment", eyebrow: "31 August – 6 September", text: "You talked about your dad's garden again on Tuesday." });
    expect(cards[1]).toEqual({ kind: "did", eyebrow: "And on Thursday", text: "You walked two days running, even though it felt heavy." });
    expect(cards[2]).toEqual({
      kind: "thenNow",
      eyebrow: "Your words",
      then: { stamp: "Two weeks ago", quote: "“I don't want to be a burden to anyone”" },
      now: { stamp: "Friday", quote: "“I texted my sister back. She just said finally.”" },
    });
    expect(cards[3]).toEqual({ kind: "open", eyebrow: "Still sitting there", text: "You said you’d call your brother on Sunday. You haven’t yet." });
    expect(cards[4]).toEqual({ kind: "pattern", eyebrow: "Something you keep saying", phrase: "“steady”", said: "Five times this month." });
    expect(cards[5]).toEqual({
      kind: "forward",
      text: "You’re not who you were in July.",
      sub: "There’s a note here you wrote to yourself on the 14th. It isn’t time yet.",
    });
  });

  it("a bad moment proposal is dropped, not stored — the story goes on without it", () => {
    const r = composeStory(sources(), { moment: "You seemed so much happier this week." });
    expect(r.story!.cards[0]!.kind).toBe("did");
    expect((r.story!.cards[0] as { eyebrow: string }).eyebrow).toBe("On Thursday");
  });

  it("the grief/crisis guardrail suppresses 'forward' but keeps 'did' — their own account of what they did", () => {
    const r = composeStory(sources({ guardrail: true }));
    expect(r.story!.cards.map((c) => c.kind)).toEqual(["did", "thenNow", "open", "pattern"]);
  });

  it("under the guardrail, a week with a win and a recurring word still makes a story", () => {
    const r = composeStory(sources({ guardrail: true, quotePairs: [] }));
    expect(r.story!.cards.map((c) => c.kind)).toEqual(["did", "open", "pattern"]);
  });

  it("fewer than three real cards is no story — never padded", () => {
    const r = composeStory(
      sources({ wins: [], quotePairs: [], openCommitments: [], monthMessages: WEEK_MESSAGES.slice(0, 2) }),
    );
    expect(r.skipped).toBe("too_few_cards");
  });

  it("a then/now pair that says the same thing twice is not shown", () => {
    const r = composeStory(
      sources({
        quotePairs: [{ then: { text: "the flat is too quiet", date: "2026-08-14" }, now: { text: "The flat is too quiet.", date: "2026-09-01" } }],
      }),
    );
    expect(r.story!.cards.some((c) => c.kind === "thenNow")).toBe(false);
  });

  it("the open card prefers what was due and not done, oldest first", () => {
    const r = composeStory(
      sources({
        openCommitments: [
          { content: "I'll sort the spare room", localDate: "2026-08-20", scheduledDate: null },
          { content: "I'll call the GP on Tuesday", localDate: "2026-09-01", scheduledDate: "2026-09-01" },
        ],
      }),
    );
    const open = r.story!.cards.find((c) => c.kind === "open") as { text: string };
    expect(open.text).toBe("You said you’d call the GP on Tuesday. You haven’t yet.");
  });

  it("forward: a newer account gets the plain continuity line and no note sub", () => {
    const r = composeStory(sources({ firstMessageDate: "2026-08-20", pendingNoteDate: null }));
    const fwd = r.story!.cards.find((c) => c.kind === "forward") as { text: string; sub: string | null };
    expect(fwd.text).toBe("There’ll be another of these next Sunday.");
    expect(fwd.sub).toBeNull();
  });

  it("no card ever carries a mood, score, streak or feeling field", () => {
    const r = composeStory(sources(), { moment: "You talked about the roses on Tuesday." });
    for (const c of r.story!.cards) {
      for (const key of Object.keys(c)) {
        expect(["kind", "eyebrow", "text", "then", "now", "phrase", "said", "sub"]).toContain(key);
      }
    }
  });
});
