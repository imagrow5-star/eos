// ─── voice_gender boot backfill ──────────────────────────────────────────────
// One idempotent UPDATE, run at every boot (like the encryption migration —
// cheap no-op once done): rows that predate the voice_gender column get it
// stamped from their companion gender, so the VOICE GENDER chips show the
// right selection for every legacy user without them touching anything.
//   man    → male
//   woman  → female
//   nonbinary (or anything else) → stays NULL — reads display "female" as the
//   picker default but nothing is saved until the user actually picks.

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../../lib/logger.js";

export async function backfillVoiceGender(): Promise<number> {
  const result = await db.execute(sql`
    UPDATE profile
    SET voice_gender = CASE companion_gender
      WHEN 'man' THEN 'male'
      WHEN 'woman' THEN 'female'
    END
    WHERE voice_gender IS NULL
      AND companion_gender IN ('man', 'woman')
  `);
  const count = (result as { rowCount?: number }).rowCount ?? 0;
  if (count > 0) logger.info({ count }, "voice_gender backfilled from companion_gender");
  return count;
}
