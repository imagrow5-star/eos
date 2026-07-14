import { Router, type IRouter } from "express";
import { eq, desc, asc, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  profileTable,
  winsTable,
  habitsTable,
  habitCompletionsTable,
  moodScoresTable,
  messagesTable,
} from "@workspace/db";
import { GetJourneyResponse, GetMoodHistoryResponse } from "@workspace/api-zod";
import { calculateStage, stageMeta, todayString, formatDate } from "../services/stage.js";

const router: IRouter = Router();

async function getOrCreateProfile() {
  const profiles = await db.select().from(profileTable).limit(1);
  if (profiles.length > 0) return profiles[0]!;
  const [profile] = await db
    .insert(profileTable)
    .values({ userName: "", companionName: "Aanya" })
    .returning();
  return profile!;
}

function calculateStreak(visitDates: string[]): number {
  if (visitDates.length === 0) return 0;

  const dateSet = new Set(visitDates);
  const today = todayString();
  const yesterday = formatDate(
    new Date(new Date(today).setDate(new Date(today).getDate() - 1)),
  );

  const anchor = dateSet.has(today) ? today : dateSet.has(yesterday) ? yesterday : null;
  if (!anchor) return 0;

  let streak = 0;
  let checkDate = anchor;
  while (dateSet.has(checkDate)) {
    streak++;
    const d = new Date(checkDate);
    d.setDate(d.getDate() - 1);
    checkDate = formatDate(d);
  }
  return streak;
}

interface MilestoneCheck {
  id: string;
  label: string;
  check: (params: {
    messageCount: number;
    winCount: number;
    streak: number;
    daysSinceStart: number;
    visitDates: string[];
  }) => boolean;
}

const MILESTONE_DEFINITIONS: MilestoneCheck[] = [
  { id: "first_conversation", label: "First conversation", check: ({ messageCount }) => messageCount >= 2 },
  { id: "first_win", label: "First win logged", check: ({ winCount }) => winCount >= 1 },
  { id: "streak_3", label: "3 days in a row", check: ({ streak }) => streak >= 3 },
  { id: "one_week", label: "One week", check: ({ daysSinceStart }) => daysSinceStart >= 7 },
  { id: "five_wins", label: "5 wins", check: ({ winCount }) => winCount >= 5 },
  { id: "streak_7", label: "7-day streak", check: ({ streak }) => streak >= 7 },
  { id: "fifteen_wins", label: "15 wins", check: ({ winCount }) => winCount >= 15 },
  { id: "thirty_days", label: "30 days", check: ({ daysSinceStart }) => daysSinceStart >= 30 },
];

// ─── Growth score ──────────────────────────────────────────────────────────────
// Compounds gently with each habit completion, win, and mood check-in.
// NEVER decreases on missed days — just plateaus. Framed as "1% better."
// Formula gives a curve: 1% at start, approaches 99% asymptotically so it
// always has room to grow and never feels punitive.

function computeGrowthScore(
  totalHabitCompletions: number,
  winCount: number,
  moodDayCount: number,
): number {
  // Each completion = 2pts, each win = 3pts, each mood check-in = 1pt
  const raw = totalHabitCompletions * 2 + winCount * 3 + moodDayCount;
  if (raw === 0) return 1;
  // Smooth S-curve capped at 99 — always room to grow
  return Math.min(99, Math.round(1 + (raw / (raw + 40)) * 98));
}

// ─── Habit-mood insight ────────────────────────────────────────────────────────
// Finds the habit with the clearest mood-lift correlation in historical data.
// Returns a gentle one-liner the Journey view can display.

async function computeHabitMoodInsight(
  habits: Array<{ id: number; name: string }>,
  moodByDate: Map<string, number>,
): Promise<string | null> {
  if (habits.length === 0 || moodByDate.size < 4) return null;

  let bestInsight: string | null = null;
  let bestDiff = 0;

  for (const habit of habits) {
    const completions = await db
      .select({ date: habitCompletionsTable.completedDate })
      .from(habitCompletionsTable)
      .where(eq(habitCompletionsTable.habitId, habit.id));

    const doneSet = new Set(completions.map((c) => c.date));
    const doneScores: number[] = [];
    const notDoneScores: number[] = [];

    for (const [date, score] of moodByDate) {
      if (doneSet.has(date)) doneScores.push(score);
      else notDoneScores.push(score);
    }

    if (doneScores.length < 2 || notDoneScores.length < 2) continue;

    const avgDone = doneScores.reduce((s, v) => s + v, 0) / doneScores.length;
    const avgNotDone = notDoneScores.reduce((s, v) => s + v, 0) / notDoneScores.length;
    const diff = avgDone - avgNotDone;

    if (diff > bestDiff && diff > 0.5) {
      bestDiff = diff;
      bestInsight = `on days you ${habit.name.toLowerCase()}, your mood tends to be higher — that's not a coincidence.`;
    }
  }

  return bestInsight;
}

router.get("/journey", async (req, res): Promise<void> => {
  const profile = await getOrCreateProfile();
  const stage = await calculateStage(profile);
  const { label } = stageMeta(stage);

  const daysSinceStart = Math.floor(
    (Date.now() - profile.createdAt.getTime()) / (1000 * 60 * 60 * 24),
  );
  const streak = calculateStreak(profile.visitDates);

  // Fetch all counts in parallel
  const [
    winCountRow,
    habitCountRow,
    msgCountRow,
    recentMoods,
    allHabitCompletions,
    allMoodDays,
    allHabits,
    allMoodHistory,
  ] = await Promise.all([
    db.select({ count: sql<string>`count(*)` }).from(winsTable).then((r) => r[0]),
    db.select({ count: sql<string>`count(*)` }).from(habitsTable).where(eq(habitsTable.isActive, true)).then((r) => r[0]),
    db.select({ count: sql<string>`count(*)` }).from(messagesTable).then((r) => r[0]),
    db.select().from(moodScoresTable).orderBy(desc(moodScoresTable.createdAt)).limit(5),
    db.select({ date: habitCompletionsTable.completedDate }).from(habitCompletionsTable),
    db.select({ date: moodScoresTable.date }).from(moodScoresTable),
    db.select({ id: habitsTable.id, name: habitsTable.name }).from(habitsTable).where(eq(habitsTable.isActive, true)),
    db.select().from(moodScoresTable).orderBy(asc(moodScoresTable.date)),
  ]);

  const winCount = Number(winCountRow?.count ?? "0");
  const habitCount = Number(habitCountRow?.count ?? "0");
  const messageCount = Number(msgCountRow?.count ?? "0");

  // Growth score — compounds with every completion, never drops
  const growthScore = computeGrowthScore(
    allHabitCompletions.length,
    winCount,
    allMoodDays.length,
  );

  // Mood caption
  const oldestMood = recentMoods.length > 0 ? recentMoods[recentMoods.length - 1]?.score : null;
  const newestMood = recentMoods.length > 0 ? recentMoods[0]?.score : null;
  const avgMoodRecent =
    recentMoods.length > 0
      ? recentMoods.reduce((s, m) => s + m.score, 0) / recentMoods.length
      : null;

  let moodCaption: string | null = null;
  if (newestMood != null && oldestMood != null && recentMoods.length >= 3) {
    const diff = newestMood - oldestMood;
    if (diff > 0) {
      moodCaption = `Up ${diff.toFixed(0)} ${diff === 1 ? "point" : "points"} from where you started — that's real.`;
    } else if (diff < 0) {
      moodCaption = "Healing moves in waves. The low moments are part of it too.";
    } else {
      moodCaption = "Holding steady. That takes more than people think.";
    }
  }

  // Habit-mood insight (async, doesn't block other data)
  const moodByDate = new Map<string, number>(allMoodHistory.map((m) => [m.date, m.score]));
  const habitMoodInsight = await computeHabitMoodInsight(allHabits, moodByDate);

  // Milestones
  const params = { messageCount, winCount, streak, daysSinceStart, visitDates: profile.visitDates };
  const milestones = MILESTONE_DEFINITIONS.map((m) => ({
    id: m.id,
    label: m.label,
    isUnlocked: m.check(params),
    unlockedAt: null as string | null,
  }));

  res.json(
    GetJourneyResponse.parse({
      stage,
      stageLabel: label,
      dayCounter: daysSinceStart,
      streak,
      winCount,
      habitCount,
      averageMoodRecent: avgMoodRecent,
      milestones,
      moodCaption,
      growthScore,
      habitMoodInsight,
    }),
  );
});

router.get("/journey/mood", async (req, res): Promise<void> => {
  const moods = await db
    .select()
    .from(moodScoresTable)
    .orderBy(asc(moodScoresTable.date));
  res.json(GetMoodHistoryResponse.parse(moods));
});

export default router;
