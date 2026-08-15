/**
 * One-shot migration for the retired romantic companion persona (persona
 * refinement, 2026-08): Eos is a supportive friend, never a romantic partner.
 * Any profile still carrying relationship_type = 'romantic' is moved to the
 * standard 'friend' persona.
 *
 * Idempotent — a plain UPDATE that matches zero rows after the first pass —
 * and safe to fail: buildSystemPrompt no longer branches on 'romantic', so an
 * unmigrated row already behaves as 'friend'; this just makes the stored data
 * tell the truth.
 */

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../../lib/logger.js";

export async function migrateRomanticPersona(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE profile
    SET relationship_type = 'friend'
    WHERE relationship_type = 'romantic'
  `);
  const count = (result as { rowCount?: number }).rowCount ?? 0;
  if (count > 0) logger.info({ count }, "romantic persona rows migrated to friend");
  return count;
}
