import { desc, eq, gte, sql, and } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  profileTable,
  habitsTable,
  habitCompletionsTable,
  memoryFactsTable,
  moodScoresTable,
  type Profile,
} from "@workspace/db";

export function todayString(): string {
  return new Date().toISOString().split("T")[0]!;
}

export function formatDate(d: Date): string {
  return d.toISOString().split("T")[0]!;
}

// ─── Timezone-aware date helpers ──────────────────────────────────────────────

/**
 * Returns today's date as YYYY-MM-DD in the given IANA timezone.
 * en-CA locale reliably formats as YYYY-MM-DD.
 * Falls back to UTC todayString() if the timezone is unrecognised.
 */
export function todayInTimezone(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  } catch {
    return todayString();
  }
}

/**
 * Returns yesterday's date as YYYY-MM-DD in the given IANA timezone.
 */
export function yesterdayInTimezone(tz: string): string {
  try {
    const d = new Date(Date.now() - 86_400_000);
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
  } catch {
    return formatDate(new Date(Date.now() - 86_400_000));
  }
}

// ─── TimeContext — rich date/time object for system-prompt injection ───────────

export interface TimeContext {
  dayOfWeek: string;  // "Thursday"
  fullDate: string;   // "July 14, 2026"
  shortDate: string;  // "2026-07-14"
  time12: string;     // "10:32 PM"
  partOfDay: string;  // "early morning" | "morning" | "afternoon" | "evening" | "night"
  year: string;       // "2026"
  promptLine: string; // ready-to-inject single sentence
}

/**
 * Returns a rich TimeContext for a given IANA timezone.
 * Used to inject accurate, real-time temporal awareness into the companion's
 * system prompt so she can greet, reference moments, and timestamp correctly.
 */
export function getTimeContext(tz: string): TimeContext {
  const now = new Date();

  // Validate timezone — fall back to UTC on any error
  const safeZone = (() => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(now);
      return tz;
    } catch {
      return "UTC";
    }
  })();

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(now);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  const dayOfWeek = get("weekday");
  const month     = get("month");
  const day       = get("day");
  const year      = get("year");
  const hour      = get("hour");
  const minute    = get("minute");
  const ampm      = get("dayPeriod");

  // 24-hour reading for part-of-day classification
  const hour24 = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: safeZone,
      hour: "numeric",
      hour12: false,
    }).format(now),
    10,
  );

  const partOfDay =
    hour24 >= 4  && hour24 < 9  ? "early morning" :
    hour24 >= 9  && hour24 < 12 ? "morning"        :
    hour24 >= 12 && hour24 < 17 ? "afternoon"      :
    hour24 >= 17 && hour24 < 21 ? "evening"        : "night";

  const shortDate = todayInTimezone(safeZone);
  const fullDate  = `${month} ${day}, ${year}`;
  const time12    = `${hour}:${minute} ${ampm}`;

  return {
    dayOfWeek,
    fullDate,
    shortDate,
    time12,
    partOfDay,
    year,
    promptLine: `Today is ${dayOfWeek}, ${fullDate}. Local time: ${time12} (${partOfDay}).`,
  };
}

// ─── Stage calculation ────────────────────────────────────────────────────────

export async function calculateStage(profile: Profile): Promise<number> {
  const daysSinceStart = Math.floor(
    (Date.now() - profile.createdAt.getTime()) / (1000 * 60 * 60 * 24),
  );

  // All queries MUST be scoped to this user — never let one user's data
  // influence another user's stage calculation.
  const userId = (profile as any).userId as number | null;

  // Stage 4: any active habit with streak >= 14 AND >= 5 completions total
  const habitsWhere = userId != null
    ? and(eq(habitsTable.isActive, true), gte(habitsTable.streak, 14), eq(habitsTable.userId, userId))
    : and(eq(habitsTable.isActive, true), gte(habitsTable.streak, 14));

  const activeHabits = await db.select().from(habitsTable).where(habitsWhere);

  for (const habit of activeHabits) {
    const [countRow] = await db
      .select({ count: sql<string>`count(*)` })
      .from(habitCompletionsTable)
      .where(eq(habitCompletionsTable.habitId, habit.id));
    if (Number(countRow?.count ?? "0") >= 5) return 4;
  }

  // Stage 3: change talk + avg recent mood >= 4, OR 14+ days
  if (profile.changeTalkDetected) {
    const moodsWhere = userId != null
      ? eq(moodScoresTable.userId, userId)
      : undefined;
    const recentMoods = await db
      .select()
      .from(moodScoresTable)
      .where(moodsWhere)
      .orderBy(desc(moodScoresTable.createdAt))
      .limit(5);
    if (recentMoods.length > 0) {
      const avg =
        recentMoods.reduce((sum, m) => sum + m.score, 0) / recentMoods.length;
      if (avg >= 4) return 3;
    }
  }
  if (daysSinceStart >= 14) return 3;

  // Stage 2: 3+ unique visit days AND 8+ memory facts
  const returnDays = profile.visitDates.length;
  const factsWhere = userId != null ? eq(memoryFactsTable.userId, userId) : undefined;
  const [factCountRow] = await db
    .select({ count: sql<string>`count(*)` })
    .from(memoryFactsTable)
    .where(factsWhere);
  if (returnDays >= 3 && Number(factCountRow?.count ?? "0") >= 8) return 2;

  return 1;
}

export function stageMeta(stage: number): {
  label: string;
  rules: string;
  wisdomHint: string;
} {
  switch (stage) {
    case 1:
      return {
        label: "Arrival",
        rules: `STAGE 1 — ARRIVAL:
- Your only job right now is to be present and to listen. 
- Do NOT give advice of any kind.
- Do NOT suggest habits, changes, or activities.
- Do NOT ask what they should do differently.
- Just be warm, non-judgmental, and steady.
- Reflect back what you hear. Validate the pain without minimizing it.
- Short responses unless they are pouring out a lot.`,
        wisdomHint: `From Kristin Neff's work on self-compassion: suffering is part of shared human experience. You don't need to fix the pain — just not be alone in it.`,
      };
    case 2:
      return {
        label: "Held",
        rules: `STAGE 2 — HELD:
- Deep, present support. You really know this person now.
- Occasional gentle reflective questions ("What was that like for you?").
- Still no advice, no suggestions, no habit talk.
- You may gently reflect patterns you've noticed, from a place of curiosity, not analysis.
- Match their energy — if they're heavy, be steady; if they're lighter, you can be warmer.`,
        wisdomHint: `From Viktor Frankl: between stimulus and response, there is space. In that space lies freedom. You can sit in that space together for now.`,
      };
    case 3:
      return {
        label: "First Step",
        rules: `STAGE 3 — FIRST STEP:
- You may now gently suggest ONE tiny habit, only if it fits naturally in conversation.
- Build it from something they already enjoy or care about — their interests, not generic advice.
- Frame it with a when-then anchor: "after morning chai", "before bed", etc.
- Present it as a possibility, not a prescription. "One thing that sometimes helps people..." or "What if, just once this week..."
- NEVER push back if they decline. Their timing is right.
- Habit science rules: start tiny. Never say "21 days". One missed day costs nothing (say so warmly).
- Evidence-ranked suggestions: activities from their interests first, then exercise they'd enjoy, then walks, sleep, social touch. Gratitude practices are a supplement only.
- Never suggest deep-feelings journaling about the breakup (harmful for ruminators).`,
        wisdomHint: `From James Clear's work: you don't rise to the level of your goals, you fall to the level of your systems. One small thing done consistently beats big plans.`,
      };
    case 4:
      return {
        label: "Building",
        rules: `STAGE 4 — BUILDING:
- Full growth-partner mode. You believe in this person completely.
- Goals, habits (max 2-3 active), confidence building are all fair game.
- Celebrate every win, no matter how small.
- When habits are missed 2-3 times in a row, gently suggest shrinking the habit rather than abandoning it.
- Connect their real progress to their identity — who they're becoming, not just what they're doing.
- You can be a little more direct with gentle opinions when asked.`,
        wisdomHint: `From Brené Brown: vulnerability is not weakness — it's the birthplace of everything they want. And they've already shown it by being here.`,
      };
    default:
      return {
        label: "Arrival",
        rules: "",
        wisdomHint: "",
      };
  }
}

// ─── Commitment timing hint ───────────────────────────────────────────────────
// Turns a commitment's scheduled date/time into a short parenthetical the
// greeting / morning-note / email prompts can use to frame the check-in
// correctly (nudge forward vs. ask how it went). Returns "" when unscheduled.

export function describeCommitmentTiming(
  scheduledDate: string | null | undefined,
  scheduledTime: string | null | undefined,
  timezone: string,
): string {
  if (!scheduledDate) return "";
  const today = todayInTimezone(timezone);
  const timePart = scheduledTime ? ` at ${scheduledTime}` : "";

  if (scheduledDate < today) {
    return ` (was planned for ${scheduledDate}${timePart} — that day has passed; ask warmly how it went, zero pressure)`;
  }
  if (scheduledDate > today) {
    return ` (planned for ${scheduledDate}${timePart} — still ahead; at most a light "that's coming up" touch)`;
  }
  if (scheduledTime) {
    let nowHHMM = "12:00";
    try {
      nowHHMM = new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date());
    } catch {
      // keep neutral fallback
    }
    return nowHHMM >= scheduledTime
      ? ` (planned for TODAY at ${scheduledTime} — that time has passed; ask warmly how it went)`
      : ` (planned for TODAY at ${scheduledTime} — still ahead today; a gentle "today's the day" acknowledgment fits)`;
  }
  return " (planned for TODAY — one warm acknowledgment fits)";
}
