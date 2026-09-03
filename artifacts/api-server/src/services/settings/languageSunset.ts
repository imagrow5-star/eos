// ─── Language sunset boot backfill (ElevenLabs removal, 2026-09) ─────────────
// The supported language set shrank to English + Spanish (see languages.ts).
// One idempotent UPDATE, run at every boot (same shape as backfillVoiceGender —
// cheap no-op once done): profiles stored on a removed code move to English so
// nobody is pinned to a selection the picker no longer offers. English is the
// safe landing: every removed-language profile was already CONVERSING with the
// full English fallback whenever a piece of their language was missing, and
// all reads default unknown codes to English behavior anyway — this makes the
// stored value match reality instead of leaving a dead code in the row.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../../lib/logger.js";

export async function backfillLanguageSunset(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE profile
    SET preferred_language = 'en'
    WHERE preferred_language IS NOT NULL
      AND preferred_language NOT IN ('en', 'es')
  `);
  const count = (result as { rowCount?: number }).rowCount ?? 0;
  if (count > 0) logger.info({ count }, "language sunset: removed-language profiles moved to English");
  return count;
}
