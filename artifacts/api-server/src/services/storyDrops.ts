/**
 * Story drops — every card the gates refused, and why.
 *
 * A card is never rewritten or retried: it is dropped, the attempt is stored
 * (text encrypted — it can quote the user), and one log line carries the
 * gate names only, never the text (logs must never hold a user's words).
 * Read the drops with scripts/story-drops.ts.
 */

import { desc, eq } from "drizzle-orm";
import { db, storyDropsTable, type StoryDrop } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";
import type { StoryKind } from "./stories.js";

export type DropStage = "gate" | "kind_truth" | "reflection" | "schema";

export interface DropInput {
  userId: number;
  kind: StoryKind;
  subjectId?: number | null;
  stage: DropStage;
  text: string;
  reasons: string[];
}

export async function recordStoryDrop(input: DropInput): Promise<void> {
  try {
    await db.insert(storyDropsTable).values({
      userId: input.userId,
      kind: input.kind,
      subjectId: input.subjectId ?? null,
      stage: input.stage,
      text: input.text,
      reasons: input.reasons,
    });
  } catch (err) {
    logger.error({ err }, "story drop: could not be recorded");
  }
  try {
    const uh = hashUserIdForLog(input.userId);
    if (uh) {
      logger.info(
        { uh, kind: input.kind, subjectId: input.subjectId ?? null, stage: input.stage, reasons: input.reasons, textLength: input.text.length },
        "story card dropped",
      );
    }
  } catch { /* logging must never crash the caller */ }
}

export async function listStoryDrops(userId: number, limit = 100): Promise<StoryDrop[]> {
  return db
    .select()
    .from(storyDropsTable)
    .where(eq(storyDropsTable.userId, userId))
    .orderBy(desc(storyDropsTable.createdAt))
    .limit(limit);
}
