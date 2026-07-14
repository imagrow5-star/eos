import { Router, type IRouter } from "express";
import { eq, asc, desc, and } from "drizzle-orm";
import { db } from "@workspace/db";
import { goalsTable, goalTasksTable } from "@workspace/db";
import { breakGoalIntoTasks } from "../services/ai.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ─── GET /goals ───────────────────────────────────────────────────────────────

router.get("/goals", async (req, res): Promise<void> => {
  const userId = req.userId;
  const goals = await db
    .select()
    .from(goalsTable)
    .where(eq(goalsTable.userId, userId))
    .orderBy(desc(goalsTable.createdAt));

  const goalsWithTasks = await Promise.all(
    goals.map(async (goal) => {
      const tasks = await db
        .select()
        .from(goalTasksTable)
        .where(eq(goalTasksTable.goalId, goal.id))
        .orderBy(asc(goalTasksTable.order));
      return { ...goal, tasks };
    }),
  );

  res.json(goalsWithTasks);
});

// ─── POST /goals ──────────────────────────────────────────────────────────────

router.post("/goals", async (req, res): Promise<void> => {
  const userId = req.userId;
  const { title, description } = req.body ?? {};

  if (!title || typeof title !== "string" || title.trim().length === 0) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  if (title.length > 200) {
    res.status(400).json({ error: "title is too long (max 200 chars)" });
    return;
  }

  const cleanTitle = title.trim();
  const cleanDesc = typeof description === "string" ? description.trim().slice(0, 500) : "";

  const [goal] = await db
    .insert(goalsTable)
    .values({ userId, title: cleanTitle, description: cleanDesc })
    .returning();

  if (!goal) {
    res.status(500).json({ error: "Failed to create goal" });
    return;
  }

  const taskStrings = await breakGoalIntoTasks(cleanTitle, cleanDesc);

  const tasks = await Promise.all(
    taskStrings.map((content, order) =>
      db
        .insert(goalTasksTable)
        .values({ goalId: goal.id, content, order })
        .returning()
        .then((r) => r[0]!),
    ),
  );

  logger.info({ goalId: goal.id, taskCount: tasks.length }, "Goal created with AI sub-tasks");
  res.status(201).json({ ...goal, tasks });
});

// ─── DELETE /goals/:id ────────────────────────────────────────────────────────

router.delete("/goals/:id", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = parseInt(req.params.id ?? "0", 10);
  if (!id) {
    res.status(400).json({ error: "Invalid goal id" });
    return;
  }

  await db.delete(goalsTable).where(and(eq(goalsTable.id, id), eq(goalsTable.userId, userId)));
  res.status(204).send();
});

// ─── PUT /goals/:id/tasks/:taskId ─────────────────────────────────────────────

router.put("/goals/:id/tasks/:taskId", async (req, res): Promise<void> => {
  const userId = req.userId;
  const goalId = parseInt(req.params.id ?? "0", 10);
  const taskId = parseInt(req.params.taskId ?? "0", 10);
  if (!goalId || !taskId) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const { isComplete } = req.body ?? {};
  if (typeof isComplete !== "boolean") {
    res.status(400).json({ error: "isComplete must be a boolean" });
    return;
  }

  // Verify goal belongs to this user
  const [goal] = await db
    .select({ id: goalsTable.id })
    .from(goalsTable)
    .where(and(eq(goalsTable.id, goalId), eq(goalsTable.userId, userId)))
    .limit(1);

  if (!goal) {
    res.status(404).json({ error: "Goal not found" });
    return;
  }

  const [task] = await db
    .update(goalTasksTable)
    .set({ isComplete })
    .where(eq(goalTasksTable.id, taskId))
    .returning();

  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }

  // Auto-complete goal when all tasks are done
  const allTasks = await db
    .select()
    .from(goalTasksTable)
    .where(eq(goalTasksTable.goalId, goalId));

  if (allTasks.length > 0 && allTasks.every((t) => t.isComplete)) {
    await db
      .update(goalsTable)
      .set({ isComplete: true })
      .where(and(eq(goalsTable.id, goalId), eq(goalsTable.userId, userId)));
  }

  res.json(task);
});

export default router;
