import { Router, type IRouter } from "express";
import { eq, desc, asc } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  memoryFactsTable,
  personalitySignalsTable,
  winsTable,
  habitsTable,
  habitCompletionsTable,
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
import { todayString, formatDate } from "../services/stage.js";

const router: IRouter = Router();

// ─── Facts ───────────────────────────────────────────────────────────────────

router.get("/memory/facts", async (req, res): Promise<void> => {
  const facts = await db
    .select()
    .from(memoryFactsTable)
    .orderBy(desc(memoryFactsTable.createdAt));
  res.json(GetMemoryFactsResponse.parse(facts));
});

// ─── Personality signals ─────────────────────────────────────────────────────

router.get("/memory/signals", async (req, res): Promise<void> => {
  const signals = await db
    .select()
    .from(personalitySignalsTable)
    .orderBy(desc(personalitySignalsTable.observedCount));
  res.json(GetPersonalitySignalsResponse.parse(signals));
});

// ─── Wins ─────────────────────────────────────────────────────────────────────

router.get("/memory/wins", async (req, res): Promise<void> => {
  const wins = await db
    .select()
    .from(winsTable)
    .orderBy(desc(winsTable.createdAt));
  res.json(GetWinsResponse.parse(wins));
});

router.post("/memory/wins", async (req, res): Promise<void> => {
  const parsed = CreateWinBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [win] = await db
    .insert(winsTable)
    .values({ content: parsed.data.content })
    .returning();
  res.status(201).json(CreateWinResponse.parse(win));
});

// ─── Habits ──────────────────────────────────────────────────────────────────

async function buildHabitWithCompletions(habitId: number) {
  const [habit] = await db
    .select()
    .from(habitsTable)
    .where(eq(habitsTable.id, habitId));
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
  const habits = await db
    .select()
    .from(habitsTable)
    .where(eq(habitsTable.isActive, true))
    .orderBy(asc(habitsTable.createdAt));

  const habitsWithCompletions = await Promise.all(
    habits.map((h) => buildHabitWithCompletions(h.id)),
  );

  res.json(
    GetHabitsResponse.parse(habitsWithCompletions.filter(Boolean)),
  );
});

router.post("/memory/habits", async (req, res): Promise<void> => {
  const parsed = CreateHabitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [habit] = await db
    .insert(habitsTable)
    .values({
      name: parsed.data.name,
      whenThen: parsed.data.whenThen,
      reason: parsed.data.reason,
      isActive: true,
      streak: 0,
    })
    .returning();

  const withCompletions = await buildHabitWithCompletions(habit!.id);
  res.status(201).json(CreateHabitResponse.parse(withCompletions));
});

router.put("/memory/habits/:id", async (req, res): Promise<void> => {
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
    .where(eq(habitsTable.id, params.data.id))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }

  const withCompletions = await buildHabitWithCompletions(updated.id);
  res.json(UpdateHabitResponse.parse(withCompletions));
});

router.post("/memory/habits/:id/complete", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = CompleteHabitParams.safeParse({ id: rawId });
  if (!params.success) {
    res.status(400).json({ error: "Invalid habit id" });
    return;
  }

  const habitId = params.data.id;
  const today = todayString();

  const [habit] = await db
    .select()
    .from(habitsTable)
    .where(eq(habitsTable.id, habitId));

  if (!habit) {
    res.status(404).json({ error: "Habit not found" });
    return;
  }

  // Check if already completed today
  const todayCompletions = await db
    .select()
    .from(habitCompletionsTable)
    .where(eq(habitCompletionsTable.habitId, habitId));

  const alreadyCompletedToday = todayCompletions.some(
    (c) => c.completedDate === today,
  );

  if (!alreadyCompletedToday) {
    await db.insert(habitCompletionsTable).values({
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

  // Walk backwards counting consecutive days (forgiving: today or yesterday is the anchor)
  if (!completedDates.has(today)) {
    const yesterdayDate = new Date(today);
    yesterdayDate.setDate(yesterdayDate.getDate() - 1);
    const yesterday = formatDate(yesterdayDate);
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
    .where(eq(habitsTable.id, habitId));

  const withCompletions = await buildHabitWithCompletions(habitId);
  res.json(CompleteHabitResponse.parse(withCompletions));
});

export default router;
