import { Router, type IRouter } from "express";
import { eq, desc, asc, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  profileTable,
  winsTable,
  habitsTable,
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

  // Anchor: if neither today nor yesterday visited, streak is 0
  let anchor = dateSet.has(today) ? today : dateSet.has(yesterday) ? yesterday : null;
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
  {
    id: "first_conversation",
    label: "First conversation",
    check: ({ messageCount }) => messageCount >= 2,
  },
  {
    id: "first_win",
    label: "First win logged",
    check: ({ winCount }) => winCount >= 1,
  },
  {
    id: "streak_3",
    label: "3 days in a row",
    check: ({ streak }) => streak >= 3,
  },
  {
    id: "one_week",
    label: "One week",
    check: ({ daysSinceStart }) => daysSinceStart >= 7,
  },
  {
    id: "five_wins",
    label: "5 wins",
    check: ({ winCount }) => winCount >= 5,
  },
  {
    id: "streak_7",
    label: "7-day streak",
    check: ({ streak }) => streak >= 7,
  },
  {
    id: "fifteen_wins",
    label: "15 wins",
    check: ({ winCount }) => winCount >= 15,
  },
  {
    id: "thirty_days",
    label: "30 days",
    check: ({ daysSinceStart }) => daysSinceStart >= 30,
  },
];

router.get("/journey", async (req, res): Promise<void> => {
  const profile = await getOrCreateProfile();
  const stage = await calculateStage(profile);
  const { label } = stageMeta(stage);

  const daysSinceStart = Math.floor(
    (Date.now() - profile.createdAt.getTime()) / (1000 * 60 * 60 * 24),
  );
  const streak = calculateStreak(profile.visitDates);

  const [winCountRow] = await db
    .select({ count: sql<string>`count(*)` })
    .from(winsTable);
  const winCount = Number(winCountRow?.count ?? "0");

  const [habitCountRow] = await db
    .select({ count: sql<string>`count(*)` })
    .from(habitsTable)
    .where(eq(habitsTable.isActive, true));
  const habitCount = Number(habitCountRow?.count ?? "0");

  const [msgCountRow] = await db
    .select({ count: sql<string>`count(*)` })
    .from(messagesTable);
  const messageCount = Number(msgCountRow?.count ?? "0");

  // Recent mood for caption
  const recentMoods = await db
    .select()
    .from(moodScoresTable)
    .orderBy(desc(moodScoresTable.createdAt))
    .limit(5);

  const oldestMood =
    recentMoods.length > 0 ? recentMoods[recentMoods.length - 1]?.score : null;
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

  // Milestones
  const params = {
    messageCount,
    winCount,
    streak,
    daysSinceStart,
    visitDates: profile.visitDates,
  };

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
