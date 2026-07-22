/**
 * Weekly growth chapters — unit + integration tests.
 *
 * Layers under test:
 *  1. Pure helpers: verbatim-quote gate (validateExcerpt), near-duplicate
 *     collapse, crisis lexicon, kind-truth deterministic floor, offer
 *     eligibility, verdicts, digit-free phrasing, week math.
 *  2. Routes with hand-inserted chapter rows: list/unread, threshold reveal
 *     (idempotent), one-tap quote dismissal (permanent + scrubs every stored
 *     chapter), offer accept (creates a real goal) / decline (records the
 *     14-day cooldown both in chapter land and personalization_state).
 *  3. The internal HMAC-authed sweep endpoint the daily-email job calls.
 *  4. E2E generation against the real model (skipped without a key): a user
 *     seeded with ~4 weeks of backdated messages, including a crisis line
 *     that must NEVER be quoted, gets a chapter whose every quote is a
 *     verbatim substring of a stored message.
 */

import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import pg from "pg";
import { eq, and } from "drizzle-orm";
import {
  db,
  usersTable,
  profileTable,
  goalsTable,
  goalTasksTable,
  messagesTable,
  weeklyChaptersTable,
  chapterQuoteDismissalsTable,
  chapterOfferEventsTable,
  personalizationStateTable,
} from "@workspace/db";
import app from "../app.js";
import { validateExcerpt, nearIdentical, type QuoteSource } from "../services/chapters/quotes.js";
import { isCrisisText } from "../services/chapters/crisis.js";
import { deterministicViolations } from "../services/chapters/kindTruth.js";
import { computeSignals, describeSignalShift } from "../services/chapters/signals.js";
import {
  isOfferEligible,
  habitVerdict,
  goalVerdict,
  countToPhrase,
  weekBoundsFor,
  localYmd,
  ymdAddDays,
  runWeeklySweep,
  type ChapterTheme,
  type MicroOffer,
} from "../services/chapters/generate.js";
import { chaptersRunToken } from "../routes/chapters.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const HAS_AI = Boolean(process.env.ANTHROPIC_API_KEY);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const createdEmails: string[] = [];

async function makeUser(tag: string) {
  const email = `chapter-test-${tag}-${Date.now()}@example.com`;
  createdEmails.push(email);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email, password: "Password123!" });
  expect([200, 201]).toContain(res.status);

  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  const userId = r.rows[0]!.id;

  // Verified + onboarded — the same bar the sweep uses for eligibility.
  await pool.query(`UPDATE users SET email_verified_at = NOW() WHERE id = $1`, [userId]);
  await pool.query(
    `INSERT INTO profile (user_id, user_name, companion_name, is_onboarding_complete, country, timezone)
     VALUES ($1, 'Sam', 'Eos', true, 'US', 'UTC')
     ON CONFLICT DO NOTHING`,
    [userId],
  );
  await db
    .update(profileTable)
    .set({ userName: "Sam", isOnboardingComplete: true, timezone: "UTC" })
    .where(eq(profileTable.userId, userId));

  return { agent, userId, email };
}

async function seedMsg(userId: number, content: string, at: Date, role: "user" | "assistant" = "user") {
  const [row] = await db
    .insert(messagesTable)
    .values({ userId, role, content, createdAt: at })
    .returning({ id: messagesTable.id });
  return row!.id;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

async function cleanupUser(email: string): Promise<void> {
  const r = await pool.query<{ id: number }>("SELECT id FROM users WHERE email = $1", [email]);
  if (r.rowCount === 0) return;
  const uid = r.rows[0]!.id;
  await pool.query(`DELETE FROM chapter_quote_dismissals WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM chapter_offer_events WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM weekly_chapters WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM goal_tasks WHERE goal_id IN (SELECT id FROM goals WHERE user_id = ${uid})`);
  await pool.query(`DELETE FROM goals WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM habit_completions WHERE habit_id IN (SELECT id FROM habits WHERE user_id = ${uid})`);
  await pool.query(`DELETE FROM habits WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM messages WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM ai_usage WHERE user_id = ${uid}`).catch(() => {});
  await pool.query(`DELETE FROM personalization_state WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM email_verification_tokens WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM profile WHERE user_id = ${uid}`);
  await pool.query(`DELETE FROM users WHERE id = ${uid}`);
}

afterEach(async () => {
  while (createdEmails.length > 0) {
    await cleanupUser(createdEmails.pop()!);
  }
});

// ─── 1. Pure helpers ─────────────────────────────────────────────────────────

describe("quote gate (the anti-fabrication floor)", () => {
  const content = "I actually went a whole day without checking her profile and it felt lighter.";
  const quotePool = new Map<number, QuoteSource>([
    [1, { id: 1, content, localDate: "2026-07-15", createdAt: new Date("2026-07-15T12:00:00Z") } as QuoteSource],
  ]);

  it("accepts only verbatim substrings of the stored message", () => {
    const ok = validateExcerpt(1, "went a whole day without checking her profile", quotePool);
    expect(ok).not.toBeNull();
    expect(ok!.messageId).toBe(1);
    expect(ok!.date).toBe("2026-07-15");
  });

  it("rejects paraphrases, unknown ids, wrong types, and out-of-bounds lengths", () => {
    // Paraphrase — the classic fabrication failure
    expect(validateExcerpt(1, "I feel so much better now about her profile", quotePool)).toBeNull();
    // Unknown message id (wrong era pool / dismissed / crisis-filtered)
    expect(validateExcerpt(99, "went a whole day without checking", quotePool)).toBeNull();
    // Non-integer id
    expect(validateExcerpt("1", "went a whole day without checking", quotePool)).toBeNull();
    // Too short to stand alone as a quote
    expect(validateExcerpt(1, "went a", quotePool)).toBeNull();
    // Too long
    expect(validateExcerpt(1, "x".repeat(400), quotePool)).toBeNull();
  });

  it("collapses near-identical then/now pairs", () => {
    expect(nearIdentical("I just want to feel okay again.", "i just want to feel okay again")).toBe(true);
    expect(nearIdentical("I just want to feel okay again.", "I started running this morning.")).toBe(false);
  });
});

describe("crisis lexicon (never quoted, only soft era references)", () => {
  it("flags explicit crisis language", () => {
    expect(isCrisisText("Some nights I think about killing myself just so it stops hurting.")).toBe(true);
    expect(isCrisisText("I've been having thoughts of suicide again")).toBe(true);
  });
  it("does not flag ordinary hard days", () => {
    expect(isCrisisText("I had such a hard day at work today, everything went wrong.")).toBe(false);
    expect(isCrisisText("I miss her so much it aches, but I got through the evening.")).toBe(false);
  });
});

describe("kind-truth deterministic floor (Eos prose only)", () => {
  it("rejects behaviour counts, clock times, and percentages", () => {
    expect(deterministicViolations("You checked her profile 14 times this week.").length).toBeGreaterThan(0);
    expect(deterministicViolations("At 2am you were still awake, scrolling.").length).toBeGreaterThan(0);
    expect(deterministicViolations("That's 40% fewer mentions than before.").length).toBeGreaterThan(0);
  });
  it("passes warm, digit-free observation", () => {
    expect(
      deterministicViolations("The way you talked about the quiet evenings changed — softer, less braced."),
    ).toEqual([]);
    expect(
      deterministicViolations("You brought it up twice, and both times something in you leaned toward morning."),
    ).toEqual([]);
  });
});

describe("language signals (internal-only)", () => {
  it("computes without throwing and describes shifts as plain text", () => {
    const before = computeSignals([
      "I always ruin everything and nobody wants me around.",
      "It's never going to get better.",
    ]);
    const now = computeSignals(["I went for a walk this morning and it helped a little."]);
    expect(before).toBeTruthy();
    expect(typeof describeSignalShift(before, now)).toBe("string");
  });
});

describe("offer eligibility + verdicts + digit-free phrasing", () => {
  it("offers only when there is truly nothing active and no recent decline", () => {
    const base = { activeGoalCount: 0, activeHabitCount: 0, lastDeclineAt: null as Date | null };
    expect(isOfferEligible({ ...base })).toBe(true);
    expect(isOfferEligible({ ...base, activeGoalCount: 1 })).toBe(false);
    expect(isOfferEligible({ ...base, activeHabitCount: 2 })).toBe(false);
    expect(isOfferEligible({ ...base, lastDeclineAt: daysAgo(3) })).toBe(false);
    expect(isOfferEligible({ ...base, lastDeclineAt: daysAgo(20) })).toBe(true);
  });

  it("habit/goal verdicts follow the deterministic thresholds", () => {
    expect(habitVerdict(5, 30)).toBe("working");
    expect(habitVerdict(2, 30)).toBe("wobbly");
    expect(habitVerdict(0, 30)).toBe("resting");
    expect(habitVerdict(0, 3)).toBe("wobbly"); // brand new — never shamed as resting
    expect(goalVerdict(3, 4, 30)).toBe("working");
    expect(goalVerdict(1, 5, 30)).toBe("wobbly");
    expect(goalVerdict(0, 5, 30)).toBe("resting");
    expect(goalVerdict(0, 5, 5)).toBe("wobbly"); // young goal
  });

  it("count phrases never contain digits", () => {
    for (let n = 0; n <= 10; n++) {
      const phrase = countToPhrase(n);
      expect(phrase.length).toBeGreaterThan(0);
      expect(/\d/.test(phrase)).toBe(false);
    }
  });
});

describe("week math", () => {
  it("analyzed week is the most recent Mon→Sun", () => {
    // Wednesday July 22 2026 → week of Mon 13th–Sun 19th
    expect(weekBoundsFor("UTC", new Date("2026-07-22T12:00:00Z"))).toEqual({
      weekStart: "2026-07-13",
      weekEnd: "2026-07-19",
    });
    // Sunday evening (inside the delivery window) → the week ending that day
    expect(weekBoundsFor("UTC", new Date("2026-07-19T20:00:00Z"))).toEqual({
      weekStart: "2026-07-13",
      weekEnd: "2026-07-19",
    });
    // Monday early morning → still the week that just ended
    expect(weekBoundsFor("UTC", new Date("2026-07-20T08:00:00Z"))).toEqual({
      weekStart: "2026-07-13",
      weekEnd: "2026-07-19",
    });
  });

  it("ymd helpers handle rollovers and timezones", () => {
    expect(ymdAddDays("2026-06-30", 1)).toBe("2026-07-01");
    expect(ymdAddDays("2026-07-19", -6)).toBe("2026-07-13");
    expect(localYmd("UTC", new Date("2026-07-22T05:00:00Z"))).toBe("2026-07-22");
    expect(localYmd("America/Los_Angeles", new Date("2026-07-22T05:00:00Z"))).toBe("2026-07-21");
  });
});

// ─── 2. Routes with hand-inserted chapters ───────────────────────────────────

const THEN_TEXT = "I can't stop checking her instagram even though it hurts every time.";
const NOW_TEXT = "I actually went a whole day without checking and it felt lighter.";
const SEED_TEXT = "I want to start running again, even if it's only ten minutes.";

async function insertChapter(userId: number, msgIds: { then: number; now: number; seed: number }) {
  const themes: ChapterTheme[] = [
    {
      key: "letting-go",
      title: "Loosening the checking",
      kind: "standard",
      stillTrue: false,
      quotes: [
        { messageId: msgIds.then, text: THEN_TEXT, date: "2026-07-02", kind: "then" },
        { messageId: msgIds.now, text: NOW_TEXT, date: "2026-07-16", kind: "now" },
      ],
      reflection: "The pull is still there, but it no longer decides your whole evening.",
    },
  ];
  const microOffer: MicroOffer = {
    seedMessageId: msgIds.seed,
    seedQuote: SEED_TEXT,
    seedDate: "2026-07-15",
    text: "You said this yourself — want to make it a small promise?",
    goalTitle: "Start running again",
    goalDescription: "Ten minutes counts. Built from your own words on July 15.",
    status: "pending",
  };
  const [row] = await db
    .insert(weeklyChaptersTable)
    .values({
      userId,
      weekStart: "2026-07-13",
      weekEnd: "2026-07-19",
      status: "ready",
      threadOpening: "Last week left a thread hanging — the quiet evenings. This week you picked it up differently.",
      thresholdQuestion: "Before you open this — what took up the most room in your head this week?",
      themes,
      goalReview: null,
      microOffer,
    })
    .returning();
  return row!;
}

async function seedChapterFixture(tag: string) {
  const u = await makeUser(tag);
  const thenId = await seedMsg(u.userId, THEN_TEXT, daysAgo(20));
  const nowId = await seedMsg(u.userId, NOW_TEXT, daysAgo(4));
  const seedId = await seedMsg(u.userId, SEED_TEXT, daysAgo(5));
  const chapter = await insertChapter(u.userId, { then: thenId, now: nowId, seed: seedId });
  return { ...u, thenId, nowId, seedId, chapter };
}

describe("chapter routes", () => {
  it("requires a session", async () => {
    const res = await request(app).get("/api/chapters");
    expect(res.status).toBe(401);
  });

  it("lists the current chapter as unread, then reveals it through the threshold (idempotently)", async () => {
    const { agent, chapter } = await seedChapterFixture("threshold");

    const list = await agent.get("/api/chapters");
    expect(list.status).toBe(200);
    expect(list.body.unread).toBe(true);
    expect(list.body.coldStart).toBe(false);
    expect(list.body.current.id).toBe(chapter.id);
    expect(list.body.current.status).toBe("ready");

    // Invalid scale rejected
    const bad = await agent.post(`/api/chapters/${chapter.id}/threshold`).send({ mood: 0 });
    expect(bad.status).toBe(400);

    // Reveal with answer + one scale
    const open = await agent
      .post(`/api/chapters/${chapter.id}/threshold`)
      .send({ answer: "Mostly the job search.", mood: 6 });
    expect(open.status).toBe(200);
    expect(open.body.status).toBe("revealed");
    expect(open.body.thresholdAnswer).toBe("Mostly the job search.");
    expect(open.body.thresholdMood).toBe(6);
    expect(open.body.thresholdSkipped).toBe(false);

    // Second call is a no-op read, not a re-reveal
    const again = await agent.post(`/api/chapters/${chapter.id}/threshold`).send({ skip: true });
    expect(again.status).toBe(200);
    expect(again.body.thresholdAnswer).toBe("Mostly the job search.");

    const after = await agent.get("/api/chapters");
    expect(after.body.unread).toBe(false);
    expect(after.body.current.status).toBe("revealed");
  });

  it("dismissing a quote scrubs it everywhere, permanently", async () => {
    const { agent, userId, thenId, nowId, seedId, chapter } = await seedChapterFixture("dismiss");

    // Someone else's message id → 404
    const notMine = await agent.post(`/api/chapters/${chapter.id}/quotes/dismiss`).send({ messageId: 99999999 });
    expect(notMine.status).toBe(404);

    // Dismiss the "now" quote — theme survives with the remaining quote
    const d1 = await agent.post(`/api/chapters/${chapter.id}/quotes/dismiss`).send({ messageId: nowId });
    expect(d1.status).toBe(200);
    let [row] = await db.select().from(weeklyChaptersTable).where(eq(weeklyChaptersTable.id, chapter.id));
    let themes = row!.themes as ChapterTheme[];
    expect(themes).toHaveLength(1);
    expect(themes[0]!.quotes.map((q) => q.messageId)).toEqual([thenId]);

    // Dismiss the last quote — the whole theme goes
    await agent.post(`/api/chapters/${chapter.id}/quotes/dismiss`).send({ messageId: thenId });
    [row] = await db.select().from(weeklyChaptersTable).where(eq(weeklyChaptersTable.id, chapter.id));
    expect(row!.themes as ChapterTheme[]).toHaveLength(0);

    // Dismiss the seed of the pending offer — offer is withdrawn
    await agent.post(`/api/chapters/${chapter.id}/quotes/dismiss`).send({ messageId: seedId });
    [row] = await db.select().from(weeklyChaptersTable).where(eq(weeklyChaptersTable.id, chapter.id));
    expect(row!.microOffer).toBeNull();

    // Idempotent re-dismiss
    const dAgain = await agent.post(`/api/chapters/${chapter.id}/quotes/dismiss`).send({ messageId: seedId });
    expect(dAgain.status).toBe(200);

    // Permanent exclusion rows exist for all three
    const dismissals = await db
      .select()
      .from(chapterQuoteDismissalsTable)
      .where(eq(chapterQuoteDismissalsTable.userId, userId));
    expect(dismissals.map((d) => d.messageId).sort()).toEqual([thenId, nowId, seedId].sort());
  });

  it("accepting the offer creates a real goal with steps", async () => {
    const { agent, userId, chapter } = await seedChapterFixture("accept");

    const res = await agent.post(`/api/chapters/${chapter.id}/offer`).send({ action: "accept" });
    expect(res.status).toBe(200);
    expect(res.body.goal.title).toBe("Start running again");
    expect(res.body.goal.tasks.length).toBeGreaterThan(0);
    expect(res.body.chapter.microOffer.status).toBe("accepted");

    const goals = await db.select().from(goalsTable).where(eq(goalsTable.userId, userId));
    expect(goals).toHaveLength(1);
    expect(goals[0]!.isComplete).toBe(false);
    const tasks = await db.select().from(goalTasksTable).where(eq(goalTasksTable.goalId, goals[0]!.id));
    expect(tasks.length).toBeGreaterThan(0);

    const events = await db
      .select()
      .from(chapterOfferEventsTable)
      .where(and(eq(chapterOfferEventsTable.userId, userId), eq(chapterOfferEventsTable.action, "accepted")));
    expect(events).toHaveLength(1);

    // A second respond attempt hits the no-pending-offer guard
    const again = await agent.post(`/api/chapters/${chapter.id}/offer`).send({ action: "decline" });
    expect(again.status).toBe(409);
  });

  it("declining records the cooldown in both systems and creates nothing", async () => {
    const { agent, userId, chapter } = await seedChapterFixture("decline");

    const res = await agent.post(`/api/chapters/${chapter.id}/offer`).send({ action: "decline" });
    expect(res.status).toBe(200);
    expect(res.body.chapter.microOffer.status).toBe("declined");

    const goals = await db.select().from(goalsTable).where(eq(goalsTable.userId, userId));
    expect(goals).toHaveLength(0);

    const events = await db
      .select()
      .from(chapterOfferEventsTable)
      .where(and(eq(chapterOfferEventsTable.userId, userId), eq(chapterOfferEventsTable.action, "declined")));
    expect(events).toHaveLength(1);

    // Chat-side cooldown stays coherent
    const [ps] = await db
      .select()
      .from(personalizationStateTable)
      .where(eq(personalizationStateTable.userId, userId));
    expect(ps?.goalOfferDeclinedAt).toBeTruthy();

    // And the engine would now refuse a fresh offer for ~14 days
    expect(
      isOfferEligible({ activeGoalCount: 0, activeHabitCount: 0, lastDeclineAt: ps!.goalOfferDeclinedAt }),
    ).toBe(false);

    const bogus = await agent.post(`/api/chapters/${chapter.id}/offer`).send({ action: "maybe" });
    expect(bogus.status).toBe(400);
  });

  it("cold-start users get the letters-not-ready framing", async () => {
    const { agent } = await makeUser("coldget");
    const res = await agent.get("/api/chapters");
    expect(res.status).toBe(200);
    expect(res.body.coldStart).toBe(true);
    expect(res.body.current).toBeNull();
    expect(res.body.weeksTogether).toBe(0);
  });
});

// ─── 3. Internal sweep endpoint (HMAC) ───────────────────────────────────────

describe("internal sweep endpoint", () => {
  it("rejects missing or wrong tokens", async () => {
    const noToken = await request(app).post("/api/internal/chapters/run").send({});
    expect(noToken.status).toBe(401);
    const badToken = await request(app)
      .post("/api/internal/chapters/run")
      .set("x-internal-token", "deadbeef")
      .send({});
    expect(badToken.status).toBe(401);
  });

  it("runs a scoped sweep with a valid token (fresh user → cold_start skip)", async () => {
    const { userId } = await makeUser("sweep");
    const token = chaptersRunToken(process.env.SESSION_SECRET!, new Date());
    const res = await request(app)
      .post("/api/internal/chapters/run")
      .set("x-internal-token", token)
      .send({ userId, ignoreWindow: true });
    expect(res.status).toBe(200);
    expect(typeof res.body.generated).toBe("number");
    expect(res.body.generated).toBe(0);

    const rows = await db.select().from(weeklyChaptersTable).where(eq(weeklyChaptersTable.userId, userId));
    expect(rows).toHaveLength(0);
  });

  it("accepts the previous hour's token (clock-edge tolerance)", async () => {
    const token = chaptersRunToken(process.env.SESSION_SECRET!, new Date(Date.now() - 3_600_000));
    // Scope to a non-existent user so nothing actually generates
    const res = await request(app)
      .post("/api/internal/chapters/run")
      .set("x-internal-token", token)
      .send({ userId: 999999999 });
    expect(res.status).toBe(200);
  });
});

// ─── 4. E2E generation against the real model ────────────────────────────────

const CRISIS_LINE = "Some nights I think about killing myself just so it stops hurting.";

async function seedFourWeeks(userId: number) {
  const { weekStart } = weekBoundsFor("UTC", new Date());
  const ws = new Date(`${weekStart}T12:00:00Z`);
  const at = (dayOffset: number, hour = 12) =>
    new Date(ws.getTime() + dayOffset * 86_400_000 + (hour - 12) * 3_600_000);

  // "Then" era — three-plus weeks back (also starts the cold-start clock)
  await seedMsg(userId, "I keep replaying the breakup over and over. I can't stop checking her instagram even though it hurts every time.", at(-23));
  await seedMsg(userId, "I turned down drinks with the guys again. They probably only invited me out of pity anyway.", at(-22));
  await seedMsg(userId, "Nights are the worst part. The apartment is so quiet it feels like the walls are listening.", at(-21));

  // Crisis line — soft era reference at most, NEVER quotable
  const crisisId = await seedMsg(userId, CRISIS_LINE, at(-10));

  // Analyzed week — six quotable user messages, including seed-quote material
  await seedMsg(userId, "I actually went a whole day without checking her profile and it felt lighter than I expected.", at(1));
  await seedMsg(userId, "Work was heavy but I cooked a real dinner instead of ordering again. Small thing, felt decent.", at(2));
  await seedMsg(userId, "I want to start running again, even if it's only ten minutes in the morning before work.", at(3, 9));
  await seedMsg(userId, "Saw the guys posted photos from Saturday. Old me would have spiraled. I mostly just felt left out, which is different.", at(4));
  await seedMsg(userId, "I said yes to lunch with my sister this weekend instead of making an excuse.", at(5));
  await seedMsg(userId, "The quiet in the evenings is still there, but it feels less like drowning and more like just quiet.", at(6, 20));
  // Assistant messages are never quotable
  await seedMsg(userId, "That shift you're describing — from drowning to just quiet — is worth marking.", at(6, 21), "assistant");

  return { crisisId, weekStart };
}

describe.skipIf(!HAS_AI)("E2E chapter generation (real model)", () => {
  it(
    "writes a chapter whose every quote is verbatim, never touches the crisis line, and stays idempotent",
    async () => {
      const { userId } = await makeUser("e2e");
      const { crisisId, weekStart } = await seedFourWeeks(userId);

      const result = await runWeeklySweep({ onlyUserId: userId, ignoreWindow: true });
      expect(result.generated).toBe(1);

      const [chapter] = await db
        .select()
        .from(weeklyChaptersTable)
        .where(and(eq(weeklyChaptersTable.userId, userId), eq(weeklyChaptersTable.weekStart, weekStart)));
      expect(chapter).toBeTruthy();
      expect(chapter!.status).toBe("ready");
      expect(chapter!.threadOpening.length).toBeGreaterThan(20);
      expect(/\d/.test(chapter!.threadOpening)).toBe(false); // zero numbers, per spec
      expect(chapter!.thresholdQuestion.length).toBeGreaterThan(10);

      const themes = chapter!.themes as ChapterTheme[];
      expect(themes.length).toBeGreaterThanOrEqual(1);
      expect(themes.length).toBeLessThanOrEqual(4);

      // THE hard gate: every quote is a verbatim substring of that exact
      // stored user message, and the crisis line is never among them.
      for (const theme of themes) {
        expect(theme.quotes.length).toBeGreaterThan(0);
        expect(theme.reflection.length).toBeGreaterThan(0);
        expect(deterministicViolations(theme.reflection)).toEqual([]);
        for (const q of theme.quotes) {
          expect(q.messageId).not.toBe(crisisId);
          expect(q.text).not.toContain("killing myself");
          const [src] = await db.select().from(messagesTable).where(eq(messagesTable.id, q.messageId));
          expect(src).toBeTruthy();
          expect(src!.userId).toBe(userId);
          expect(src!.role).toBe("user");
          expect(src!.content).toContain(q.text);
        }
      }

      // No goals/habits → review is empty/null; offer (if any) must be seed-anchored
      const offer = chapter!.microOffer as MicroOffer | null;
      if (offer) {
        expect(offer.status).toBe("pending");
        const [seedSrc] = await db.select().from(messagesTable).where(eq(messagesTable.id, offer.seedMessageId));
        expect(seedSrc!.content).toContain(offer.seedQuote);
        expect(seedSrc!.userId).toBe(userId);
      }

      // Idempotent: a second sweep never writes a second row for the week
      const rerun = await runWeeklySweep({ onlyUserId: userId, ignoreWindow: true });
      expect(rerun.generated).toBe(0);
      const rows = await db.select().from(weeklyChaptersTable).where(eq(weeklyChaptersTable.userId, userId));
      expect(rows).toHaveLength(1);
    },
    240_000,
  );

  it(
    "a user with an active goal gets a review, never a competing offer",
    async () => {
      const { userId } = await makeUser("e2e-review");
      await seedFourWeeks(userId);

      const [goal] = await db
        .insert(goalsTable)
        .values({ userId, title: "Apply to three marketing jobs", description: "", isComplete: false, createdAt: daysAgo(20) })
        .returning();
      await db.insert(goalTasksTable).values([
        { goalId: goal!.id, content: "Update resume", isComplete: true },
        { goalId: goal!.id, content: "Draft cover letter", isComplete: false },
      ]);

      const result = await runWeeklySweep({ onlyUserId: userId, ignoreWindow: true });
      expect(result.generated).toBe(1);

      const [chapter] = await db
        .select()
        .from(weeklyChaptersTable)
        .where(eq(weeklyChaptersTable.userId, userId));
      const review = chapter!.goalReview as { items: Array<{ title: string; text: string; verdict: string }> } | null;
      expect(review).toBeTruthy();
      expect(review!.items.length).toBeGreaterThanOrEqual(1);
      expect(review!.items[0]!.title).toBe("Apply to three marketing jobs");
      for (const item of review!.items) {
        expect(deterministicViolations(item.text)).toEqual([]); // kind, digit-free
      }
      expect(chapter!.microOffer).toBeNull(); // review-before-offer rule
    },
    240_000,
  );

  it("skips cold-start and quiet-week users without calling the model", async () => {
    // Cold start: only a few days of history
    const cold = await makeUser("e2e-cold");
    await seedMsg(cold.userId, "First week here. The breakup is still very fresh and everything aches.", daysAgo(3));
    await seedMsg(cold.userId, "Didn't sleep much. Kept rereading old texts even though I know better.", daysAgo(2));

    // Quiet week: long history, but almost nothing said in the analyzed week
    const quiet = await makeUser("e2e-quiet");
    await seedMsg(quiet.userId, "It's been over a month and I still flinch when my phone buzzes.", daysAgo(35));
    await seedMsg(quiet.userId, "Some days are fine, some days the smallest song wrecks me completely.", daysAgo(30));
    await seedMsg(quiet.userId, "Quick check-in, busy stretch at work.", daysAgo(4));

    for (const u of [cold, quiet]) {
      const result = await runWeeklySweep({ onlyUserId: u.userId, ignoreWindow: true });
      expect(result.generated).toBe(0);
      const rows = await db.select().from(weeklyChaptersTable).where(eq(weeklyChaptersTable.userId, u.userId));
      expect(rows).toHaveLength(0);
    }
  }, 60_000);
});
