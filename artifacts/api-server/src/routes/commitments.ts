import { Router, type IRouter } from "express";
import { eq, desc, asc } from "drizzle-orm";
import { db } from "@workspace/db";
import { commitmentsTable } from "@workspace/db";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ─── GET /commitments ─────────────────────────────────────────────────────────

router.get("/commitments", async (req, res): Promise<void> => {
  const commitments = await db
    .select()
    .from(commitmentsTable)
    .orderBy(desc(commitmentsTable.createdAt));

  res.json(commitments);
});

// ─── PUT /commitments/:id ─────────────────────────────────────────────────────
// Allows manual state override from the Journey panel

router.put("/commitments/:id", async (req, res): Promise<void> => {
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
    .where(eq(commitmentsTable.id, id))
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
  const id = parseInt(req.params.id ?? "0", 10);
  if (!id) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  await db.delete(commitmentsTable).where(eq(commitmentsTable.id, id));
  res.status(204).send();
});

export default router;
