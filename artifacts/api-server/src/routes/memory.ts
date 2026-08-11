import { Router, type IRouter } from "express";
import { eq, desc, asc, and } from "drizzle-orm";
import { db, pool } from "@workspace/db";
import {
  memoryFactsTable,
  memoryFeelingsTable,
  personalitySignalsTable,
  winsTable,
  habitsTable,
  habitCompletionsTable,
  commitmentsTable,
  goalsTable,
  moodScoresTable,
  usersTable,
  profileTable,
  reflectionReportsTable,
} from "@workspace/db";
import { fetchExportPayload } from "./account.js";
import { memoryExportUsageLimits, memoryResetUsageLimits } from "../middleware/usageLimits.js";
import { resetAllowlistDecision } from "../services/memory/resetGate.js";
import { rankFactsByImportance } from "../services/memory/importance.js";
import type { RequestHandler } from "express";
import {
  shapeMemoryExport,
  renderMemoryMarkdown,
  memoryExportFilename,
  type AccountBasics,
} from "../services/memoryExport.js";
import { logger } from "../lib/logger.js";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";
import {
  GetMemoryFactsResponse,
  GetMemoryFactsResponseItem,
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

// ─── Export ("download your journal") ─────────────────────────────────────────
// GET /memory/export?format=json|markdown
//
// The single user-triggered memory export. Auth is already enforced upstream
// (requireAuth + requireVerified set req.userId), so this only ever returns the
// caller's OWN data — every query inside fetchExportPayload is keyed on
// req.userId. Read-only: it never mutates user state.
//
// Rate limited to 1/hour/user (memoryExportUsageLimits) to swallow accidental
// double-clicks and guard the heavy full-account read. Every encrypted column
// is decrypted for the user's own plaintext (that is the point of an export);
// the shaping/formatting lives in services/memoryExport.ts (pure, unit-tested).

/** Load the account-level bits that live on the users row, not the profile. */
async function fetchAccountBasics(userId: number): Promise<AccountBasics> {
  const r = await pool.query<{
    email: string | null;
    companion_name: string | null;
    is_onboarding_complete: boolean | null;
  }>(
    `SELECT u.email,
            p.companion_name,
            p.is_onboarding_complete
       FROM users u
       LEFT JOIN profile p ON p.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  );
  const row = r.rows[0];
  return {
    email: row?.email ?? null,
    companionName: row?.companion_name ?? "Eos",
    onboardingComplete: row?.is_onboarding_complete ?? false,
  };
}

router.get(
  "/memory/export",
  ...memoryExportUsageLimits,
  async (req, res): Promise<void> => {
    const userId = req.userId;
    const format =
      (req.query.format as string | undefined)?.toLowerCase() === "markdown" ||
      (req.query.format as string | undefined)?.toLowerCase() === "md"
        ? "markdown"
        : "json";

    try {
      // Reuse the single export loader (routes/account.ts) — every encrypted
      // column arrives already decrypted. No date range: the journal export is
      // always the whole history.
      const [payload, basics] = await Promise.all([
        fetchExportPayload(userId),
        fetchAccountBasics(userId),
      ]);

      const filename = memoryExportFilename(format, new Date());

      if (format === "markdown") {
        const md = renderMemoryMarkdown(payload, basics);
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.send(md);
      } else {
        const json = shapeMemoryExport(payload, basics);
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.json(json);
      }

      // Log the ACTION only — hashed user id + format. Never the payload
      // (Tier 3 guardrail: no raw userId, no content, in any log line).
      try {
        const uh = hashUserIdForLog(userId);
        if (uh) logger.info({ uh, format }, "Memory export downloaded");
      } catch {
        /* logging must never crash the caller */
      }
    } catch (err) {
      try {
        const uh = hashUserIdForLog(userId);
        if (uh) logger.error({ err, uh }, "Memory export failed");
      } catch {
        /* logging must never crash the caller */
      }
      res
        .status(500)
        .json({ error: "Couldn't generate your export — try again in a minute." });
    }
  },
);

// ─── Reset ("reset my memory (dev)", founder-gated) ───────────────────────────
// Wipes the authenticated user's memory tables for clean testing. Feature-gated
// to an operator allowlist (MEMORY_RESET_ALLOWLIST): the endpoint doesn't exist
// (404) unless the env var is set, and returns 403 for anyone not on the list.
// Rate-limited to 1/hour. Read the header comment in services/memory/resetGate.ts
// for the gate semantics.

/** The user's email — the allowlist key. Null if the row somehow vanished. */
async function fetchUserEmail(userId: number): Promise<string | null> {
  const [row] = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  return row?.email ?? null;
}

// GET /memory/reset-eligible — the UI calls this on load and only renders the
// dev reset button when it returns { eligible: true }.
router.get("/memory/reset-eligible", async (req, res): Promise<void> => {
  const email = await fetchUserEmail(req.userId);
  res.json({ eligible: resetAllowlistDecision(email) === "allowed" });
});

// Feature-gate middleware — runs BEFORE the rate limiter so a 404/403 never
// consumes the hourly budget (only real wipes are limited).
const resetFeatureGate: RequestHandler = async (req, res, next) => {
  const email = await fetchUserEmail((req as any).userId as number);
  const decision = resetAllowlistDecision(email);
  if (decision === "not_configured") {
    // Endpoint effectively doesn't exist when the feature isn't configured.
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (decision === "forbidden") {
    res.status(403).json({ error: "This feature isn't available for your account." });
    return;
  }
  next();
};

router.post(
  "/memory/reset",
  resetFeatureGate,
  ...memoryResetUsageLimits,
  async (req, res): Promise<void> => {
    const userId = req.userId;
    try {
      // Single transaction. Wipes ONLY memory tables — conversations (messages),
      // chapters, sealed notes, profile, and subscription are deliberately left
      // intact. habit_completions before habits (references habit_id); deleting
      // goals cascades goal_tasks.
      const deleted = await db.transaction(async (tx) => {
        const hc = await tx
          .delete(habitCompletionsTable)
          .where(eq(habitCompletionsTable.userId, userId))
          .returning({ id: habitCompletionsTable.id });
        const habits = await tx
          .delete(habitsTable)
          .where(eq(habitsTable.userId, userId))
          .returning({ id: habitsTable.id });
        const goals = await tx
          .delete(goalsTable)
          .where(eq(goalsTable.userId, userId))
          .returning({ id: goalsTable.id });
        const commitments = await tx
          .delete(commitmentsTable)
          .where(eq(commitmentsTable.userId, userId))
          .returning({ id: commitmentsTable.id });
        const moodScores = await tx
          .delete(moodScoresTable)
          .where(eq(moodScoresTable.userId, userId))
          .returning({ id: moodScoresTable.id });
        const memoryFacts = await tx
          .delete(memoryFactsTable)
          .where(eq(memoryFactsTable.userId, userId))
          .returning({ id: memoryFactsTable.id });
        const memoryFeelings = await tx
          .delete(memoryFeelingsTable)
          .where(eq(memoryFeelingsTable.userId, userId))
          .returning({ id: memoryFeelingsTable.id });
        // Reflection reports are DERIVED from memory/conversation, so a memory
        // reset (for clean testing) wipes them too.
        const reflectionReports = await tx
          .delete(reflectionReportsTable)
          .where(eq(reflectionReportsTable.userId, userId))
          .returning({ id: reflectionReportsTable.id });
        return {
          memory_facts: memoryFacts.length,
          memory_feelings: memoryFeelings.length,
          reflection_reports: reflectionReports.length,
          habits: habits.length,
          habit_completions: hc.length,
          commitments: commitments.length,
          goals: goals.length,
          mood_scores: moodScores.length,
        };
      });

      try {
        const uh = hashUserIdForLog(userId);
        if (uh) logger.info({ uh, deleted }, "Memory reset (dev)");
      } catch { /* logging must never crash the caller */ }

      res.json({ ok: true, deleted });
    } catch (err) {
      try {
        const uh = hashUserIdForLog(userId);
        if (uh) logger.error({ err, uh }, "Memory reset failed");
      } catch { /* logging must never crash the caller */ }
      res.status(500).json({ error: "Couldn't reset your memory — please try again." });
    }
  },
);

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

// ─── Feelings-in-context (Sprint 2C) ──────────────────────────────────────────
// Read-only. Returns the user's feelings ranked by the SAME importance scorer as
// facts (most-important first), so the Memory Manifest's "How things have felt"
// section leads with what matters. Plain JSON (no api-zod) — a small, additive
// read that doesn't warrant regenerating the client types.
router.get("/memory/feelings", async (req, res): Promise<void> => {
  const userId = req.userId;
  const rows = await db
    .select()
    .from(memoryFeelingsTable)
    .where(eq(memoryFeelingsTable.userId, userId));
  const ranked = rankFactsByImportance(rows, Date.now(), 50);
  res.json(
    ranked.map((f) => ({
      id: f.id,
      feeling: f.feeling,
      category: f.category,
      createdAt: f.createdAt,
      emotionalWeight: f.emotionalWeight,
      userMarkedImportant: f.userMarkedImportant,
    })),
  );
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

// ─── Mark important (Sprint 2B "remember this") ──────────────────────────────
// Star toggle from the Memory Manifest. Sets user_marked_important, which the
// Sprint 2A ranker turns into a +10 boost so the fact holds near the top.
// Ownership-checked; never touches any other field.
router.patch("/memory/facts/:factId", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = Number(req.params.factId);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const body = req.body as { userMarkedImportant?: unknown } | undefined;
  if (typeof body?.userMarkedImportant !== "boolean") {
    res.status(400).json({ error: "userMarkedImportant must be a boolean" });
    return;
  }
  const [updated] = await db
    .update(memoryFactsTable)
    .set({ userMarkedImportant: body.userMarkedImportant })
    .where(and(eq(memoryFactsTable.id, id), eq(memoryFactsTable.userId, userId)))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(GetMemoryFactsResponseItem.parse(updated));
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
