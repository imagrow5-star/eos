/**
 * Goals and Routines stories — the three-state content model.
 *
 * Pure decisions first (states, who speaks, cadence, the let-go offer, the
 * routine pattern phrase, the gates on model output), then an end-to-end run
 * against the database with a FAKE model so the test controls exactly what
 * the model "writes" — including a card that must be dropped and recorded.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import pg from "pg";
import { eq } from "drizzle-orm";
import { db, goalsTable, goalTasksTable, habitsTable, habitCompletionsTable, messagesTable, profileTable, storyDropsTable } from "@workspace/db";
import app from "../app.js";
import {
  decideGoalStates,
  planGoalSpeakers,
  decideRoutineStates,
  planRoutineSpeakers,
  patternPhrase,
  gateCards,
  fragmentFor,
  generateSubjectStoriesForUser,
  runSubjectStoriesSweep,
  inSubjectWindow,
  MISSED_DAY_TEXT,
  REENTRY_TEXT,
  letGoOfferText,
  type GoalInput,
  type HabitInput,
  type StoryModel,
  type Speaker,
} from "../services/goalStories.js";
import { listStoriesOfKind } from "../services/stories.js";

const TODAY = "2026-09-09"; // Wednesday

function goal(over: Partial<GoalInput> = {}): GoalInput {
  return {
    id: 1,
    title: "Run again",
    description: "Get back to running before winter",
    createdOn: "2026-08-01",
    lastReferencedOn: null,
    lastSpokeOn: null,
    letGoOfferedOn: null,
    tasks: [],
    ...over,
  };
}

const passAll = async (sections: Array<{ name: string; text: string }>) => sections.map((s) => ({ name: s.name, pass: true, reasons: [] as string[] }));

describe("decideGoalStates", () => {
  const messages = [
    { id: 10, content: "got the first run done and my legs hated me for it", localDate: "2026-09-08" },
    { id: 11, content: "the spanish app is still on my phone I guess", localDate: "2026-09-06" },
  ];

  it("a ticked step this week is action, whatever the model says", () => {
    const g = goal({ tasks: [{ content: "Buy shoes", isComplete: true, completedOn: "2026-09-07" }] });
    const [d] = decideGoalStates([g], [{ goalId: 1, state: "quiet" }], messages, TODAY);
    expect(d!.state).toBe("happened");
    expect(d!.evidenceKind).toBe("action");
    expect(d!.tasksDone).toEqual(["Buy shoes"]);
  });

  it("the model's 'happened' counts only with their verbatim words", () => {
    const withWords = decideGoalStates([goal()], [{ goalId: 1, state: "happened", messageId: 10, excerpt: "got the first run done and my legs hated me for it", kind: "action" }], messages, TODAY)[0]!;
    expect(withWords.state).toBe("happened");
    expect(withWords.excerpt?.text).toBe("got the first run done and my legs hated me for it");
    const paraphrased = decideGoalStates([goal()], [{ goalId: 1, state: "happened", messageId: 10, excerpt: "did the first run, legs hurt", kind: "action" }], messages, TODAY)[0]!;
    expect(paraphrased.state).toBe("live"); // the claim survives as "mentioned", the fake quote does not
    expect(paraphrased.excerpt).toBeNull();
  });

  it("recent reference or creation keeps a goal live; otherwise it is quiet", () => {
    expect(decideGoalStates([goal({ lastReferencedOn: "2026-09-01" })], [], messages, TODAY)[0]!.state).toBe("live");
    expect(decideGoalStates([goal({ createdOn: "2026-09-05" })], [], messages, TODAY)[0]!.state).toBe("live");
    expect(decideGoalStates([goal({ lastReferencedOn: "2026-08-01" })], [], messages, TODAY)[0]!.state).toBe("quiet");
  });
});

describe("planGoalSpeakers", () => {
  it("state A goals speak (at most two); nothing else speaks that morning", () => {
    const decisions = decideGoalStates(
      [goal({ id: 1 }), goal({ id: 2, title: "Spanish" }), goal({ id: 3, title: "Write" }), goal({ id: 4, title: "Sleep", lastReferencedOn: "2026-09-08" })],
      [
        { goalId: 1, state: "happened", messageId: 10, excerpt: "got the first run done", kind: "action" },
        { goalId: 2, state: "happened", messageId: 11, excerpt: "spanish app is still on my phone", kind: "mention" },
        { goalId: 3, state: "happened", messageId: 10, excerpt: "got the first run done", kind: "action" },
      ],
      [
        { id: 10, content: "got the first run done and my legs hated me for it", localDate: "2026-09-08" },
        { id: 11, content: "the spanish app is still on my phone I guess", localDate: "2026-09-06" },
      ],
      TODAY,
    );
    const plan = planGoalSpeakers(decisions, TODAY, null);
    expect(plan.speakers.map((s) => s.subjectId)).toEqual([1, 2]);
    expect(plan.speakers[0]!.excerpt).toEqual({ text: "got the first run done", weekday: "Tuesday" });
  });

  it("state B: one goal, only every few days, rotating by longest-since-spoke", () => {
    const decisions = decideGoalStates(
      [goal({ id: 1, lastReferencedOn: "2026-09-01", lastSpokeOn: "2026-09-07" }), goal({ id: 2, title: "Spanish", lastReferencedOn: "2026-09-01", lastSpokeOn: "2026-09-01" }), goal({ id: 3, title: "Write", lastReferencedOn: "2026-09-01" })],
      [],
      [],
      TODAY,
    );
    // The last Goals story was yesterday → nothing today.
    expect(planGoalSpeakers(decisions, TODAY, "2026-09-08").speakers).toEqual([]);
    // Due: the never-spoken goal goes first, then the one longest since it spoke.
    const plan = planGoalSpeakers(decisions, TODAY, "2026-09-05");
    expect(plan.speakers.map((s) => s.subjectId)).toEqual([3]);
    expect(plan.speakers[0]!.state).toBe("live");
  });

  it("state C is silence, except a one-time let-go offer on the first of the month", () => {
    const quiet = decideGoalStates([goal({ id: 1, lastReferencedOn: "2026-07-01" })], [], [], TODAY);
    expect(planGoalSpeakers(quiet, TODAY, null)).toEqual({ speakers: [], letGoOffers: [] });
    const first = decideGoalStates([goal({ id: 1, lastReferencedOn: "2026-07-01" })], [], [], "2026-10-01");
    expect(planGoalSpeakers(first, "2026-10-01", null).letGoOffers.map((g) => g.id)).toEqual([1]);
    const offered = decideGoalStates([goal({ id: 1, lastReferencedOn: "2026-07-01", letGoOfferedOn: "2026-09-01" })], [], [], "2026-10-01");
    expect(planGoalSpeakers(offered, "2026-10-01", null).letGoOffers).toEqual([]);
  });
});

describe("routines", () => {
  function habit(over: Partial<HabitInput> = {}): HabitInput {
    return { id: 7, name: "Morning walk", whenThen: "After coffee, I will walk", createdOn: "2026-08-01", completions: [], lastSpokeOn: null, ...over };
  }

  it("patternPhrase shows a pattern, never a chain", () => {
    expect(patternPhrase(["2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09"], TODAY)).toBe("Every day this week");
    expect(patternPhrase(["2026-09-04", "2026-09-05", "2026-09-07", "2026-09-08", "2026-09-09"], TODAY)).toBe("Most days this week");
    expect(patternPhrase(["2026-09-04", "2026-09-06", "2026-09-08", "2026-09-09"], TODAY)).toBe("Four of the last seven");
    expect(patternPhrase(["2026-09-08"], TODAY)).toBe("One of the last seven");
    expect(patternPhrase(["2026-08-20"], TODAY)).toBeNull();
  });

  it("states: logged recently → happened; one missed day of an established routine → missed; else live / quiet", () => {
    expect(decideRoutineStates([habit({ completions: ["2026-09-09"] })], TODAY)[0]!.kind).toBe("happened");
    expect(decideRoutineStates([habit({ completions: ["2026-09-08"] })], TODAY)[0]!.kind).toBe("happened");
    expect(decideRoutineStates([habit({ completions: ["2026-09-03", "2026-09-05", "2026-09-07"] })], TODAY)[0]!.kind).toBe("missed");
    expect(decideRoutineStates([habit({ completions: ["2026-09-07"] })], TODAY)[0]!.kind).toBe("live"); // not yet established
    expect(decideRoutineStates([habit({ completions: ["2026-09-01"] })], TODAY)[0]!.kind).toBe("live");
    expect(decideRoutineStates([habit({ completions: [] })], TODAY)[0]!.kind).toBe("quiet");
  });

  it("the morning after a miss deflates it; otherwise one routine speaks every few days; re-entry on the first", () => {
    const missed = decideRoutineStates([habit({ completions: ["2026-09-03", "2026-09-05", "2026-09-07"] })], TODAY);
    const plan = planRoutineSpeakers(missed, TODAY, "2026-09-08");
    expect(plan.missed.map((h) => h.id)).toEqual([7]);
    expect(plan.speakers).toEqual([]);

    const logged = decideRoutineStates([habit({ completions: ["2026-09-05", "2026-09-07", "2026-09-09"] })], TODAY);
    expect(planRoutineSpeakers(logged, TODAY, "2026-09-08").speakers).toEqual([]); // not due yet
    const due = planRoutineSpeakers(logged, TODAY, "2026-09-05");
    expect(due.speakers).toHaveLength(1);
    expect(due.speakers[0]).toMatchObject({ subjectId: 7, state: "happened", pattern: "Three of the last seven", tasksDone: ["logged on Wednesday"] });

    const quiet = decideRoutineStates([habit({ completions: [] })], "2026-10-01");
    expect(planRoutineSpeakers(quiet, "2026-10-01", null).reentry.map((h) => h.id)).toEqual([7]);
    expect(planRoutineSpeakers(decideRoutineStates([habit()], TODAY), TODAY, null).reentry).toEqual([]);
  });
});

describe("gateCards", () => {
  const speakers: Speaker[] = [
    { subjectId: 1, name: "Run again", state: "happened", excerpt: { text: "got the first run done and my legs hated me for it", weekday: "Tuesday" }, evidenceKind: "action", tasksDone: [] },
    { subjectId: 2, name: "Spanish", state: "live", excerpt: null, evidenceKind: null, tasksDone: [] },
  ];

  it("keeps clean cards, drops gated ones with reasons, drops a state-A card that lost their words", async () => {
    const out = await gateCards(
      speakers,
      [
        { subjectId: 1, text: "You said you got the first run done and your legs hated you for it. That's the one that counts. Same time Thursday?" },
        { subjectId: 2, text: "You haven't opened the Spanish app in a while, you should try to get back to it." },
      ],
      passAll,
    );
    expect(out.kept.map((k) => k.subjectId)).toEqual([1]);
    expect(out.dropped).toHaveLength(1);
    expect(out.dropped[0]).toMatchObject({ subjectId: 2, stage: "gate" });
    expect(out.dropped[0]!.reasons).toEqual(expect.arrayContaining(["references absence of action", "controlling language"]));

    const lostWords = await gateCards(speakers, [{ subjectId: 1, text: "You went for a run this week and it was hard on the legs. Same time Thursday?" }], passAll);
    expect(lostWords.kept).toEqual([]);
    expect(lostWords.dropped[0]).toMatchObject({ subjectId: 1, stage: "reflection", reasons: ["does not carry their own words"] });
  });

  it("a kind-truth failure is a drop too, with the checker's reasons", async () => {
    const failAll = async (sections: Array<{ name: string; text: string }>) => sections.map((s) => ({ name: s.name, pass: false, reasons: ["generic advice"] }));
    const out = await gateCards(speakers, [{ subjectId: 2, text: "The Spanish is still here whenever you want to pick it back up." }], failAll);
    expect(out.kept).toEqual([]);
    expect(out.dropped[0]).toMatchObject({ subjectId: 2, stage: "kind_truth", reasons: ["generic advice"] });
  });

  it("fragmentFor fits the disc", () => {
    expect(fragmentFor("Run again")).toBe("Run again");
    expect(fragmentFor("A".repeat(60))).toHaveLength(26);
    expect(fragmentFor("Ten minutes outside before work")).toBe("Ten minutes outside befor…");
  });
});

// ── End to end, with a fake model ─────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const DB = Boolean(process.env.DATABASE_URL);
const email = `goal-stories-${Date.now()}@example.com`;
let userId = 0;
let runGoalId = 0;
let spanishGoalId = 0;
let walkId = 0;
const NOW = new Date("2026-09-09T08:00:00Z"); // Wednesday 08:00 UTC

const fakeModel: StoryModel = {
  async classifyGoals({ goals, messages }) {
    const run = goals.find((g) => g.title === "Run again");
    const msg = messages.find((m) => m.content.includes("first run"));
    return run && msg ? [{ goalId: run.id, state: "happened", messageId: msg.id, excerpt: "got the first run done and my legs hated me for it", kind: "action" }] : [];
  },
  async writeCards({ kind, speakers }) {
    if (kind === "goals") {
      return speakers.map((s) =>
        s.name === "Run again"
          ? { subjectId: s.subjectId, text: "You said you got the first run done and your legs hated you for it. That's the one that counts. Same time Thursday?" }
          : { subjectId: s.subjectId, text: "You haven't touched the Spanish in ages, you should get back to it." },
      );
    }
    return speakers.map((s) => ({ subjectId: s.subjectId, text: `You logged the ${s.name.toLowerCase()} again this morning. ${s.pattern ?? ""}`.trim() }));
  },
};

beforeAll(async () => {
  if (!DB) return;
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/signup").send({ email, password: "Sup3r-secret!pw" });
  expect(res.status).toBeLessThan(300);
  const { rows } = await pool.query(`SELECT id FROM users WHERE email = $1`, [email]);
  userId = rows[0].id;
  await pool.query(`UPDATE users SET email_verified_at = NOW() WHERE id = $1`, [userId]);
  await agent.get("/api/profile");
  await db.update(profileTable).set({ isOnboardingComplete: true, timezone: "UTC", userName: "Sam", userPath: "breakup" }).where(eq(profileTable.userId, userId));

  const [run] = await db.insert(goalsTable).values({ userId, title: "Run again", description: "", createdAt: new Date("2026-08-01T10:00:00Z") }).returning({ id: goalsTable.id });
  runGoalId = run!.id;
  await db.insert(goalTasksTable).values({ goalId: runGoalId, content: "Buy shoes", order: 0, isComplete: false });
  const [spanish] = await db.insert(goalsTable).values({ userId, title: "Spanish", description: "", createdAt: new Date("2026-08-01T10:00:00Z"), lastReferencedAt: new Date("2026-09-02T10:00:00Z") }).returning({ id: goalsTable.id });
  spanishGoalId = spanish!.id;
  await db.insert(messagesTable).values({ userId, role: "user", content: "I got the first run done and my legs hated me for it", createdAt: new Date("2026-09-08T18:00:00Z") });

  const [walk] = await db.insert(habitsTable).values({ userId, name: "Morning walk", whenThen: "After coffee, I will walk", reason: "air", createdAt: new Date("2026-08-01T10:00:00Z") }).returning({ id: habitsTable.id });
  walkId = walk!.id;
  await db.insert(habitCompletionsTable).values(["2026-09-03", "2026-09-05", "2026-09-07"].map((d) => ({ userId, habitId: walkId, completedDate: d })));
});

afterAll(async () => {
  if (DB && userId) {
    await pool.query(`DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = $1`, [String(userId)]);
    await pool.query(`DELETE FROM goal_tasks WHERE goal_id IN (SELECT id FROM goals WHERE user_id = $1)`, [userId]);
    for (const t of ["stories", "story_drops", "habit_completions", "habits", "goals", "messages", "email_verification_tokens", "profile"]) {
      await pool.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
    }
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  }
  await pool.end();
});

describe.skipIf(!DB)("generateSubjectStoriesForUser", () => {
  it("writes a Goals story from real evidence, a Routines deflation card, and records the dropped card", async () => {
    const r = await generateSubjectStoriesForUser(userId, { now: NOW, model: fakeModel, kindTruth: passAll });
    expect(r.goalsStoryId).toBeTypeOf("number");
    expect(r.routinesStoryId).toBeTypeOf("number");

    const [goals] = await listStoriesOfKind(userId, "goals", 1);
    expect(goals!.periodStart).toBe("2026-09-09");
    expect(goals!.subjectId).toBe(runGoalId);
    expect(goals!.fragment).toBe("Run again");
    expect(goals!.viewed).toBe(false);
    expect(goals!.cards).toEqual([
      { kind: "goal", eyebrow: "Run again", text: "You said you got the first run done and your legs hated you for it. That's the one that counts. Same time Thursday?" },
    ]);

    const [routines] = await listStoriesOfKind(userId, "routines", 1);
    expect(routines!.fragment).toBe("Morning walk");
    expect(routines!.cards).toEqual([{ kind: "routine", eyebrow: "Morning walk", text: MISSED_DAY_TEXT, pattern: "Three of the last seven" }]);

    // The goal that spoke is stamped; the one that didn't is not.
    const [runRow] = await db.select({ lastSpokeAt: goalsTable.lastSpokeAt }).from(goalsTable).where(eq(goalsTable.id, runGoalId));
    expect(runRow!.lastSpokeAt).not.toBeNull();
    const [spanishRow] = await db.select({ lastSpokeAt: goalsTable.lastSpokeAt }).from(goalsTable).where(eq(goalsTable.id, spanishGoalId));
    expect(spanishRow!.lastSpokeAt).toBeNull();
    // Nothing was dropped: only the state-A goal spoke this morning.
    expect(r.dropped).toBe(0);
  });

  it("is one story per kind per day; force replaces", async () => {
    const again = await generateSubjectStoriesForUser(userId, { now: NOW, model: fakeModel, kindTruth: passAll });
    expect(again.goalsSkipped).toBe("exists");
    expect(again.routinesSkipped).toBe("exists");
    const all = await listStoriesOfKind(userId, "goals", 10);
    expect(all).toHaveLength(1);
  });

  it("a state-B card that fails the gates is dropped and recorded with its reasons, and no story is written", async () => {
    // A week on, the run message has aged out of the evidence window and
    // nothing new happened: the still-live Spanish goal is due to speak. The
    // fake model writes a card the gates refuse.
    const later = new Date("2026-09-16T08:00:00Z");
    const r = await generateSubjectStoriesForUser(userId, { now: later, model: fakeModel, kindTruth: passAll });
    expect(r.goalsStoryId).toBeUndefined();
    expect(r.goalsSkipped).toBe("all_dropped");
    expect(r.dropped).toBe(1);
    const drops = await db.select().from(storyDropsTable).where(eq(storyDropsTable.userId, userId));
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({ kind: "goals", subjectId: spanishGoalId, stage: "gate" });
    expect(drops[0]!.reasons).toEqual(expect.arrayContaining(["references absence of action", "controlling language"]));
    expect(drops[0]!.text).toContain("Spanish"); // decrypted by the ORM…
    const { rows } = await pool.query<{ text: string }>(`SELECT text FROM story_drops WHERE user_id = $1`, [userId]);
    expect(rows[0]!.text).not.toContain("Spanish"); // …and encrypted at rest
  });

  it("bereavement suppresses state-A (celebratory) cards", async () => {
    await db.update(profileTable).set({ userPath: "bereavement" }).where(eq(profileTable.userId, userId));
    const r = await generateSubjectStoriesForUser(userId, { now: NOW, model: fakeModel, kindTruth: passAll, force: true });
    expect(r.goalsStoryId).toBeUndefined();
    expect(r.goalsSkipped).toBe("nothing_to_say");
    await db.update(profileTable).set({ userPath: "breakup" }).where(eq(profileTable.userId, userId));
  });

  it("without a model, only the template cards (deflation, re-entry, let-go) can appear", async () => {
    const first = new Date("2026-10-01T08:00:00Z");
    const r = await generateSubjectStoriesForUser(userId, { now: first, model: null, kindTruth: passAll });
    const [goals] = await listStoriesOfKind(userId, "goals", 1);
    expect(r.goalsStoryId).toBeTypeOf("number");
    // Both goals are quiet by October; exactly one gets the one-time offer.
    expect(goals!.cards).toHaveLength(1);
    const offer = goals!.cards[0] as { kind: string; eyebrow: string; text: string };
    expect(["Run again", "Spanish"]).toContain(offer.eyebrow);
    expect(offer).toEqual({ kind: "goal", eyebrow: offer.eyebrow, text: letGoOfferText(offer.eyebrow) });
    const [routines] = await listStoriesOfKind(userId, "routines", 1);
    expect(routines!.cards).toEqual([{ kind: "routine", eyebrow: "Morning walk", text: REENTRY_TEXT, pattern: null }]);
  });
});

describe.skipIf(!DB)("sweep", () => {
  it("runs from 06:00 user-local and counts what it wrote", async () => {
    expect(inSubjectWindow("UTC", new Date("2026-09-10T05:00:00Z"))).toBe(false);
    expect(inSubjectWindow("UTC", new Date("2026-09-10T06:00:00Z"))).toBe(true);
    const early = await runSubjectStoriesSweep({ now: new Date("2026-09-10T05:00:00Z"), onlyUserId: userId, model: fakeModel, kindTruth: passAll });
    expect(early.considered).toBe(0);
    const morning = await runSubjectStoriesSweep({ now: new Date("2026-09-10T07:00:00Z"), onlyUserId: userId, model: fakeModel, kindTruth: passAll });
    expect(morning.considered).toBe(1);
  });

  it("let go: the goal stops speaking and stays retrievable", async () => {
    const agent = request.agent(app);
    const login = await agent.post("/api/auth/login").send({ email, password: "Sup3r-secret!pw" });
    expect(login.status).toBeLessThan(300);
    const gone = await agent.post(`/api/goals/${runGoalId}/let-go`);
    expect(gone.status).toBe(200);
    const list = await agent.get("/api/goals");
    const run = (list.body as Array<{ id: number; letGoAt: string | null }>).find((g) => g.id === runGoalId);
    expect(run?.letGoAt).not.toBeNull();
    const r = await generateSubjectStoriesForUser(userId, { now: new Date("2026-09-20T08:00:00Z"), model: fakeModel, kindTruth: passAll, force: true });
    expect(r.goalsStoryId).toBeUndefined(); // Run again no longer speaks; Spanish is quiet by now
    const back = await agent.post(`/api/goals/${runGoalId}/bring-back`);
    expect(back.status).toBe(200);
  });
});
