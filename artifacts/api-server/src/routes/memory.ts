import { Router, type IRouter } from "express";
import { eq, desc, asc, and } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  memoryFactsTable,
  personalitySignalsTable,
  winsTable,
  habitsTable,
  habitCompletionsTable,
  profileTable,
} from "@workspace/db";
import {
  GetMemoryFactsResponse,
  GetPersonalitySignalsResponse,
  GetWinsResponse,
  CreateWinBody,
  CreateWinResponse,
  GetHabitsResponse,
  CreateHabitBody,
  CreateHabitResponse,
  UpdateHabitParams,
  UpdateHabitBody,
  UpdateHabitResponse,
  CompleteHabitParams,
  CompleteHabitResponse,
} from "@workspace/api-zod";
import { todayInTimezone, formatDate } from "../services/stage.js";

const router: IRouter = Router();

// ─── Timezone helper ──────────────────────────────────────────────────────────

async function getUserTimezone(userId: number): Promise<string> {
  const [row] = await db
    .select({ timezone: profileTable.timezone })
    .from(profileTable)
    .where(eq(profileTable.userId, userId))
    .limit(1);
  return (row as any)?.timezone ?? "UTC";
}

// ─── Facts ───────────────────────────────────────────────────────────────────

router.get("/memory/facts", async (req, res): Promise<void> => {
  const userId = req.userId;
  const facts = await db
    .select()
    .from(memoryFactsTable)
    .where(eq(memoryFactsTable.userId, userId))
    .orderBy(desc(memoryFactsTable.createdAt));
  res.json(GetMemoryFactsResponse.parse(facts));
});

// ─── Forget this (Phase A privacy) ───────────────────────────────────────────
// Permanently deletes ONE remembered fact. Hard delete, ownership-checked —
// it disappears from the system prompt on the very next message.
router.delete("/memory/facts/:id", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const deleted = await db
    .delete(memoryFactsTable)
    .where(and(eq(memoryFactsTable.id, id), eq(memoryFactsTable.userId, userId)))
    .returning({ id: memoryFactsTable.id });
  if (deleted.length === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true });
});

// ─── Personality signals ─────────────────────────────────────────────────────

router.get("/memory/signals", async (req, res): Promise<void> => {
  const userId = req.userId;
  const signals = await db
    .select()
    .from(personalitySignalsTable)
    .where(eq(personalitySignalsTable.userId, userId))
    .orderBy(desc(personalitySignalsTable.observedCount));
  res.json(GetPersonalitySignalsResponse.parse(signals));
});

// ─── Wins ─────────────────────────────────────────────────────────────────────

router.get("/memory/wins", async (req, res): Promise<void> => {
  const userId = req.userId;
  const wins = await db
    .select()
    .from(winsTable)
    .where(eq(winsTable.userId, userId))
    .orderBy(desc(winsTable.createdAt));
  res.json(GetWinsResponse.parse(wins));
});

router.post("/memory/wins", async (req, res): Promise<void> => {
  const userId = req.userId;
  const parsed = CreateWinBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [win] = await db
    .insert(winsTable)
    .values({ userId, content: parsed.data.content })
    .returning();
  res.status(201).json(CreateWinResponse.parse(win));
});

// ─── Habits ──────────────────────────────────────────────────────────────────

async function buildHabitWithCompletions(habitId: number, userId: number) {
  const [habit] = await db
    .select()
    .from(habitsTable)
    .where(and(eq(habitsTable.id, habitId), eq(habitsTable.userId, userId)));
  if (!habit) return null;

  // Get last 7 days of completions
  const today = new Date();
  const last7Dates: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    last7Dates.push(formatDate(d));
  }

  const completions = await db
    .select({ date: habitCompletionsTable.completedDate })
    .from(habitCompletionsTable)
    .where(eq(habitCompletionsTable.habitId, habitId));

  const completedDates = new Set(completions.map((c) => c.date));
  const recentCompletions = last7Dates.filter((d) => completedDates.has(d));

  return {
    ...habit,
    recentCompletions,
    lastCompleted: habit.lastCompleted ?? null,
  };
}

router.get("/memory/habits", async (req, res): Promise<void> => {
  const userId = req.userId;
  const habits = await db
    .select()
    .from(habitsTable)
    .where(and(eq(habitsTable.isActive, true), eq(habitsTable.userId, userId)))
    .orderBy(asc(habitsTable.createdAt));

  const habitsWithCompletions = await Promise.all(
    habits.map((h) => buildHabitWithCompletions(h.id, userId)),
  );

  res.json(GetHabitsResponse.parse(habitsWithCompletions.filter(Boolean)));
});

router.post("/memory/habits", async (req, res): Promise<void> => {
  const userId = req.userId;
  const parsed = CreateHabitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [habit] = await db
    .insert(habitsTable)
    .values({
      userId,
      name: parsed.data.name,
      whenThen: parsed.data.whenThen,
      reason: parsed.data.reason,
      isActive: true,
      streak: 0,
    })
    .returning();

  const withCompletions = await buildHabitWithCompletions(habit!.id, userId);
  res.status(201).json(CreateHabitResponse.parse(withCompletions));
});

router.put("/memory/habits/:id", async (req, res): Promise<void> => {
  const userId = req.userId;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = UpdateHabitParams.safeParse({ id: rawId });
  if (!params.success) {
    res.status(400).json({ error: "Invalid habit id" });
    return;
  }

  const parsed = UpdateHabitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const updates: Partial<typeof habitsTable.$inferInsert> = {};
  const data = parsed.data;
  if (data.name != null) updates.name = data.name;
  if (data.whenThen != null) updates.whenThen = data.whenThen;
  if (data.reason != null) updates.reason = data.reason;
  if (data.isActive != null) updates.isActive = data.isActive;

  const [updated] = await db
    .update(habitsTable)
    .set(updates)
    .where(and(eq(habitsTable.id, params.data.id), eq(habitsTable.userId, userId)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }

  const withCompletions = await buildHabitWithCompletions(updated.id, userId);
  res.json(UpdateHabitResponse.parse(withCompletions));
});

router.post("/memory/habits/:id/complete", async (req, res): Promise<void> => {
  const userId = req.userId;
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = CompleteHabitParams.safeParse({ id: rawId });
  if (!params.success) {
    res.status(400).json({ error: "Invalid habit id" });
    return;
  }

  const habitId = params.data.id;
  const tz = await getUserTimezone(userId);
  const today = todayInTimezone(tz);

  const [habit] = await db
    .select()
    .from(habitsTable)
    .where(and(eq(habitsTable.id, habitId), eq(habitsTable.userId, userId)));

  if (!habit) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }

  // Check if already completed today
  const todayCompletions = await db
    .select()
    .from(habitCompletionsTable)
    .where(eq(habitCompletionsTable.habitId, habitId));

  const alreadyCompletedToday = todayCompletions.some((c) => c.completedDate === today);

  if (!alreadyCompletedToday) {
    await db.insert(habitCompletionsTable).values({
      userId,
      habitId,
      completedDate: today,
    });
  }

  // Recalculate streak
  const allCompletions = await db
    .select({ date: habitCompletionsTable.completedDate })
    .from(habitCompletionsTable)
    .where(eq(habitCompletionsTable.habitId, habitId));

  const completedDates = new Set(allCompletions.map((c) => c.date));

  let streak = 0;
  let checkDate = today;

  if (!completedDates.has(today)) {
    const yesterday = formatDate(new Date(new Date(today + "T12:00:00").getTime() - 86_400_000));
    if (!completedDates.has(yesterday)) {
      streak = 0;
    } else {
      checkDate = yesterday;
    }
  }

  if (completedDates.has(checkDate)) {
    while (completedDates.has(checkDate)) {
      streak++;
      const d = new Date(checkDate);
      d.setDate(d.getDate() - 1);
      checkDate = formatDate(d);
    }
  }

  await db
    .update(habitsTable)
    .set({ streak, lastCompleted: today })
    .where(and(eq(habitsTable.id, habitId), eq(habitsTable.userId, userId)));

  const withCompletions = await buildHabitWithCompletions(habitId, userId);
  res.json(CompleteHabitResponse.parse(withCompletions));
});

export default router;
