import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "../lib/logger";

/**
 * Idempotent schema guard for the appearance/theme columns.
 *
 * The theme system added nullable `theme` / `theme_mode` columns to `profile`
 * (lib/db/src/schema/profile.ts). Deploys don't run `drizzle-kit push`, so a
 * production database that predates the columns makes EVERY profile read
 * throw Postgres 42703 (`column "theme" does not exist`) — drizzle selects
 * all mapped columns explicitly — which broke login with "We couldn't load
 * your profile."
 *
 * ADD COLUMN IF NOT EXISTS is non-destructive and instant on Postgres (no
 * table rewrite for nullable columns without defaults), and a no-op forever
 * after — same statement rehearsed against a seeded scratch DB before the
 * feature merged. It runs (a) at boot before the server accepts traffic and
 * (b) as a one-shot retry inside the profile read if 42703 still appears
 * (covers a mid-deploy race or a manually reverted database).
 *
 * A theme preference must never lock anyone out.
 */
export async function ensureProfileThemeColumns(): Promise<void> {
  await db.execute(sql`ALTER TABLE profile ADD COLUMN IF NOT EXISTS theme text`);
  await db.execute(sql`ALTER TABLE profile ADD COLUMN IF NOT EXISTS theme_mode text`);
  logger.info("schema guard: profile.theme / profile.theme_mode present");
}

/** True when an error is Postgres 42703 for the theme columns specifically. */
export function isMissingThemeColumnError(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  if (!err) return false;
  const msg = String(err.message ?? "");
  const undefinedColumn = err.code === "42703" || /does not exist/i.test(msg);
  return undefinedColumn && /theme(_mode)?/i.test(msg);
}
