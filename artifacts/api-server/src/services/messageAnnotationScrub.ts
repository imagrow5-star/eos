// ─── One-off scrub: EVI {expression} annotations in persisted messages ───────
// User messages persisted BEFORE the live normalizer stripped them
// (routes/humeLlm.ts quirk 3) can still carry Hume's expression annotation:
//   "Rato. {very slightly excited, very slightly amused}"
// content is ENCRYPTED at rest, so SQL regexp can't see it — rows are
// decrypted through drizzle in id-ordered pages, tested, and only changed
// rows are rewritten (re-encrypted on write). Idempotent like the other boot
// backfills; the created_at cutoff bounds the scan to rows that could
// possibly carry an annotation (the normalizer strip shipped 2026-09-04), so
// the per-boot cost never grows with new traffic.
//
// A message that is NOTHING but an annotation is left untouched: blanking a
// user's message row is worse than an ugly one, and those rows stopped being
// created the moment the normalizer began dropping annotation-only turns.

import { and, asc, eq, gt, lt } from "drizzle-orm";
import { db, messagesTable } from "@workspace/db";
import { stripExpressionTags } from "../lib/expressionTags.js";
import { logger } from "../lib/logger.js";

const ANNOTATION = /\{[^{}]*\}/;
/** First boot after the normalizer strip deployed — no later row can carry
 *  an EVI annotation, so the scan window is fixed forever. */
const CUTOFF = new Date("2026-09-06T00:00:00Z");
const PAGE = 500;

export async function scrubMessageAnnotations(): Promise<number> {
  let cursor = 0;
  let scrubbed = 0;
  for (;;) {
    const rows = await db
      .select({ id: messagesTable.id, content: messagesTable.content })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.role, "user"),
          gt(messagesTable.id, cursor),
          lt(messagesTable.createdAt, CUTOFF),
        ),
      )
      .orderBy(asc(messagesTable.id))
      .limit(PAGE);
    if (rows.length === 0) break;
    for (const row of rows) {
      cursor = row.id;
      if (!ANNOTATION.test(row.content)) continue;
      const cleaned = stripExpressionTags(row.content);
      if (!cleaned || cleaned === row.content) continue;
      await db.update(messagesTable).set({ content: cleaned }).where(eq(messagesTable.id, row.id));
      scrubbed++;
    }
  }
  if (scrubbed > 0) {
    logger.info({ scrubbed }, "message annotation scrub: EVI braces removed from persisted user messages");
  }
  return scrubbed;
}
