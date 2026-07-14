import { Router, type IRouter } from "express";
import { eq, desc, and } from "drizzle-orm";
import { db } from "@workspace/db";
import { commitmentsTable } from "@workspace/db";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ─── GET /commitments ─────────────────────────────────────────────────────────

router.get("/commitments", async (req, res): Promise<void> => {
  const userId = req.userId;
  const commitments = await db
    .select()
    .from(commitmentsTable)
    .where(eq(commitmentsTable.userId, userId))
    .orderBy(desc(commitmentsTable.createdAt));

  res.json(commitments);
});

// ─── PUT /commitments/:id ─────────────────────────────────────────────────────

router.put("/commitments/:id", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = parseInt(req.params.id ?? "0", 10);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const { state, qualityNote } = req.body ?? {};

  const validStates = ["open", "done", "partial", "missed"];
  if (state && !validStates.includes(state)) {
    res.status(400).json({ error: "state must be one of: " + validStates.join(", ") });
    return;
  }

  const updates: Partial<typeof commitmentsTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (state) updates.state = state;
  if (typeof qualityNote === "string") updates.qualityNote = qualityNote;

  const [updated] = await db
    .update(commitmentsTable)
    .set(updates)
    .where(and(eq(commitmentsTable.id, id), eq(commitmentsTable.userId, userId)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Commitment not found" });
    return;
  }

  logger.info({ id, state }, "Commitment updated manually");
  res.json(updated);
});

// ─── DELETE /commitments/:id ──────────────────────────────────────────────────

router.delete("/commitments/:id", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = parseInt(req.params.id ?? "0", 10);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  await db
    .delete(commitmentsTable)
    .where(and(eq(commitmentsTable.id, id), eq(commitmentsTable.userId, userId)));
  res.status(204).send();
});

export default router;
