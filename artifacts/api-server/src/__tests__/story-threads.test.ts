/**
 * Story threads — the processing-vs-stuck engine.
 *
 * Pure state machine (advanceThreadState): evolving resets are instant,
 * frozen verdicts need FROZEN_STREAK_MIN consecutive high-confidence
 * same-framing weeks spanning FROZEN_MIN_SPAN_DAYS.
 *
 * updateStoryThreads (with a stubbed model): creation, per-week idempotency,
 * verbatim question validation (Map pool), paraphrase downgrade, crisis skip.
 */

import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import type { StoryRetelling, StoryThread } from "@workspace/db";
import {
  advanceThreadState,
  weekLabelFor,
  pickWorkingThroughThread,
  buildWorkingThroughEntries,
  updateStoryThreads,
  FROZEN_STREAK_MIN,
  SAME_CONFIDENCE_MIN,
} from "../services/chapters/storyThreads.js";
import type { QuoteSource } from "../services/chapters/quotes.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function retelling(overrides: Partial<StoryRetelling> = {}): StoryRetelling {
  return {
    weekStart: "2026-06-01",
    summary: "told the story",
    question: null,
    questionMessageId: null,
    framing: "same angle",
    sameAsPrior: true,
    confidence: 0.9,
    ...overrides,
  };
}

// ─── advanceThreadState ──────────────────────────────────────────────────────

describe("advanceThreadState", () => {
  it("stays watch on the very first retelling", () => {
    const out = advanceThreadState({
      state: "watch",
      frozenStreak: 0,
      retellings: [retelling({ sameAsPrior: false, confidence: 0 })],
    });
    expect(out).toEqual({ state: "watch", frozenStreak: 0 });
  });

  it("turns evolving when a later retelling brings a new angle", () => {
    const out = advanceThreadState({
      state: "watch",
      frozenStreak: 1,
      retellings: [retelling(), retelling({ weekStart: "2026-06-08", sameAsPrior: false, confidence: 0.9 })],
    });
    expect(out).toEqual({ state: "evolving", frozenStreak: 0 });
  });

  it("treats low-confidence sameness as NOT same (paraphrase noise can't freeze)", () => {
    const out = advanceThreadState({
      state: "watch",
      frozenStreak: 2,
      retellings: [
        retelling(),
        retelling({ weekStart: "2026-06-08" }),
        retelling({ weekStart: "2026-06-15", sameAsPrior: true, confidence: SAME_CONFIDENCE_MIN - 0.1 }),
      ],
    });
    expect(out.state).toBe("evolving");
    expect(out.frozenStreak).toBe(0);
  });

  it("freezes only after the streak spans real time", () => {
    const spanning = advanceThreadState({
      state: "watch",
      frozenStreak: FROZEN_STREAK_MIN - 1,
      retellings: [
        retelling({ weekStart: "2026-06-01" }),
        retelling({ weekStart: "2026-06-08" }),
        retelling({ weekStart: "2026-06-15" }),
      ],
    });
    expect(spanning).toEqual({ state: "frozen", frozenStreak: FROZEN_STREAK_MIN });

    // Same streak count crammed into 9 days — cannot freeze.
    const crammed = advanceThreadState({
      state: "watch",
      frozenStreak: FROZEN_STREAK_MIN - 1,
      retellings: [
        retelling({ weekStart: "2026-06-01" }),
        retelling({ weekStart: "2026-06-05" }),
        retelling({ weekStart: "2026-06-10" }),
      ],
    });
    expect(crammed.state).toBe("watch");
    expect(crammed.frozenStreak).toBe(FROZEN_STREAK_MIN);
  });

  it("recovers from frozen instantly on one evolving retelling", () => {
    const out = advanceThreadState({
      state: "frozen",
      frozenStreak: 4,
      retellings: [retelling(), retelling({ weekStart: "2026-07-01", sameAsPrior: false, confidence: 0.95 })],
    });
    expect(out).toEqual({ state: "evolving", frozenStreak: 0 });
  });
});

// ─── weekLabelFor ────────────────────────────────────────────────────────────

describe("weekLabelFor", () => {
  const current = "2026-07-20";
  it("maps week offsets to digit-free words", () => {
    expect(weekLabelFor("2026-07-20", current)).toBe("this week");
    expect(weekLabelFor("2026-07-13", current)).toBe("last week");
    expect(weekLabelFor("2026-07-06", current)).toBe("two weeks ago");
    expect(weekLabelFor("2026-05-25", current)).toBe("a while back");
    expect(weekLabelFor("2026-07-27", current)).toBe("this week"); // future-safe
  });
});

// ─── pickWorkingThroughThread / buildWorkingThroughEntries ──────────────────

function fakeThread(overrides: Partial<StoryThread>): StoryThread {
  return {
    id: 1,
    userId: 1,
    slug: "t",
    label: "t",
    state: "evolving",
    frozenStreak: 0,
    retellings: [],
    firstSeenWeek: "2026-06-01",
    lastSeenWeek: "2026-07-13",
    raisedAt: null,
    supportSuggestedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as StoryThread;
}

describe("pickWorkingThroughThread", () => {
  const questioned = (week: string, q: string, mid: number | null) =>
    retelling({ weekStart: week, question: q, questionMessageId: mid, sameAsPrior: false });

  it("never surfaces frozen threads — structural, not prompt-level", () => {
    const frozen = fakeThread({
      state: "frozen",
      retellings: [questioned("2026-06-01", "why?", 1), questioned("2026-06-08", "why me?", 2)],
    });
    expect(pickWorkingThroughThread([frozen])).toBeNull();
  });

  it("requires at least two questioned retellings", () => {
    const thin = fakeThread({ retellings: [questioned("2026-06-01", "why?", 1)] });
    expect(pickWorkingThroughThread([thin])).toBeNull();
  });

  it("prefers the thread with the richest retelling history", () => {
    const a = fakeThread({
      id: 10,
      slug: "a",
      retellings: [questioned("2026-06-01", "q1", 1), questioned("2026-06-08", "q2", 2)],
    });
    const b = fakeThread({
      id: 11,
      slug: "b",
      retellings: [
        questioned("2026-06-01", "q1", 3),
        questioned("2026-06-08", "q2", 4),
        questioned("2026-06-15", "q3", 5),
      ],
    });
    expect(pickWorkingThroughThread([a, b])?.slug).toBe("b");
  });
});

describe("buildWorkingThroughEntries", () => {
  it("keeps the last three questioned retellings and marks paraphrases non-verbatim", () => {
    const thread = fakeThread({
      retellings: [
        retelling({ weekStart: "2026-06-08", question: "old q", questionMessageId: 1 }),
        retelling({ weekStart: "2026-06-15", question: "q A", questionMessageId: 2 }),
        retelling({ weekStart: "2026-06-22", question: null }), // unquestioned — dropped
        retelling({ weekStart: "2026-06-29", question: "q B (paraphrase)", questionMessageId: null }),
        retelling({ weekStart: "2026-07-06", question: "q C", questionMessageId: 3 }),
      ],
    });
    const entries = buildWorkingThroughEntries(thread, "2026-07-13");
    expect(entries.map((e) => e.text)).toEqual(["q A", "q B (paraphrase)", "q C"]);
    expect(entries.map((e) => e.verbatim)).toEqual([true, false, true]);
    expect(entries[0]!.weekLabel).toBe("four weeks ago");
  });
});

// ─── updateStoryThreads (stubbed model, real DB) ─────────────────────────────

describe("updateStoryThreads", () => {
  const email = `story-threads-${Date.now()}@example.invalid`;
  let userId: number;

  async function ensureUser(): Promise<number> {
    if (userId) return userId;
    const r = await pool.query<{ id: number }>(
      `INSERT INTO users (email, hashed_password, email_verified_at) VALUES ($1, 'x', NOW()) RETURNING id`,
      [email],
    );
    userId = r.rows[0]!.id;
    return userId;
  }

  afterAll(async () => {
    if (userId) {
      await pool.query("DELETE FROM story_threads WHERE user_id = $1", [userId]);
      await pool.query("DELETE FROM users WHERE id = $1", [userId]);
    }
    await pool.end();
  });

  const parseJson = <T,>(raw: string): T | null => {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  };

  const weekMessages: QuoteSource[] = [
    {
      id: 101,
      content: "i keep going back to the airport goodbye. why did he leave that day without a word",
      createdAt: new Date("2026-07-15T10:00:00Z"),
      localDate: "2026-07-15",
    },
  ];

  const llmReturning = (payload: unknown) => async () => JSON.stringify(payload);

  it("creates a thread with a verbatim-validated question", async () => {
    const uid = await ensureUser();
    const res = await updateStoryThreads({
      userId: uid,
      weekStart: "2026-07-13",
      weekMessages,
      llm: llmReturning({
        updates: [
          {
            slug: null,
            label: "the airport goodbye",
            weekSummary: "retold the goodbye",
            centralQuestion: { messageId: 101, excerpt: "why did he leave that day without a word" },
            framing: "cause-hunting",
            sameAsPrior: false,
            confidence: 0.3,
          },
        ],
      }),
      parseJson,
    });

    expect(res.updatedSlugs).toEqual(["the-airport-goodbye"]);
    const thread = res.threads.find((t) => t.slug === "the-airport-goodbye")!;
    expect(thread.state).toBe("watch");
    const rts = thread.retellings as StoryRetelling[];
    expect(rts).toHaveLength(1);
    expect(rts[0]!.question).toBe("why did he leave that day without a word");
    expect(rts[0]!.questionMessageId).toBe(101);
  });

  it("is idempotent within the same week", async () => {
    const uid = await ensureUser();
    const res = await updateStoryThreads({
      userId: uid,
      weekStart: "2026-07-13",
      weekMessages,
      llm: llmReturning({
        updates: [
          {
            slug: "the-airport-goodbye",
            label: "the airport goodbye",
            weekSummary: "again",
            centralQuestion: null,
            framing: "cause-hunting",
            sameAsPrior: true,
            confidence: 0.9,
          },
        ],
      }),
      parseJson,
    });
    expect(res.updatedSlugs).toEqual([]);
    const thread = res.threads.find((t) => t.slug === "the-airport-goodbye")!;
    expect(thread.retellings as StoryRetelling[]).toHaveLength(1);
  });

  it("downgrades an unverifiable excerpt to a paraphrase (no message id)", async () => {
    const uid = await ensureUser();
    const res = await updateStoryThreads({
      userId: uid,
      weekStart: "2026-07-20",
      weekMessages,
      llm: llmReturning({
        updates: [
          {
            slug: "the-airport-goodbye",
            label: "the airport goodbye",
            weekSummary: "new angle this week",
            centralQuestion: { messageId: 101, excerpt: "what was I supposed to understand from that" },
            framing: "meaning-seeking, present tense",
            sameAsPrior: false,
            confidence: 0.2,
          },
        ],
      }),
      parseJson,
    });
    const thread = res.threads.find((t) => t.slug === "the-airport-goodbye")!;
    const rts = thread.retellings as StoryRetelling[];
    expect(rts).toHaveLength(2);
    expect(rts[1]!.question).toBe("what was I supposed to understand from that");
    expect(rts[1]!.questionMessageId).toBeNull();
    expect(thread.state).toBe("evolving"); // two retellings, new angle
  });

  it("never stores crisis language as a question", async () => {
    const uid = await ensureUser();
    const crisisMessages: QuoteSource[] = [
      {
        id: 201,
        content: "some nights i just want to die thinking about it",
        createdAt: new Date("2026-07-21T22:00:00Z"),
        localDate: "2026-07-21",
      },
    ];
    const res = await updateStoryThreads({
      userId: uid,
      weekStart: "2026-07-27",
      weekMessages: crisisMessages,
      llm: llmReturning({
        updates: [
          {
            slug: "the-airport-goodbye",
            label: "the airport goodbye",
            weekSummary: "a very heavy retelling",
            centralQuestion: { messageId: 201, excerpt: "i just want to die thinking about it" },
            framing: "despair",
            sameAsPrior: true,
            confidence: 0.9,
          },
        ],
      }),
      parseJson,
    });
    const thread = res.threads.find((t) => t.slug === "the-airport-goodbye")!;
    const rts = thread.retellings as StoryRetelling[];
    expect(rts[rts.length - 1]!.question).toBeNull();
    expect(rts[rts.length - 1]!.questionMessageId).toBeNull();
  });

  it("skips the week quietly when the model call fails", async () => {
    const uid = await ensureUser();
    const res = await updateStoryThreads({
      userId: uid,
      weekStart: "2026-08-03",
      weekMessages,
      llm: async () => {
        throw new Error("model down");
      },
      parseJson,
    });
    expect(res.updatedSlugs).toEqual([]);
  });
});
