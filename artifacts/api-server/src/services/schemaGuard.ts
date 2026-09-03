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

/**
 * Idempotent schema guard for the reflection_reports table.
 *
 * Deploys don't run `drizzle-kit push` (see the note above), so a brand-new
 * TABLE — not just a column — won't exist in production unless created here.
 * CREATE TABLE IF NOT EXISTS is non-destructive and a no-op forever after the
 * first boot. Columns/constraints mirror lib/db/src/schema/reflection-reports.ts
 * exactly; `content` is a plain text column (drizzle's encryptedText writes the
 * ciphertext string into it). Runs at boot before the server accepts traffic.
 */
export async function ensureReflectionReportsTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS reflection_reports (
      id serial PRIMARY KEY,
      user_id integer REFERENCES users(id) ON DELETE CASCADE,
      content text NOT NULL,
      period_start timestamp NOT NULL,
      period_end timestamp NOT NULL,
      generated_by text NOT NULL DEFAULT 'on_demand',
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
  await db.execute(
    sql`CREATE INDEX IF NOT EXISTS reflection_reports_user_id_idx ON reflection_reports (user_id)`,
  );
  logger.info("schema guard: reflection_reports table present");
}

/**
 * Idempotent schema guard for the morning-note "last surfaced" columns.
 *
 * The morning-note/greeting staleness fix reads/writes `last_surfaced_at` on
 * memory_facts and commitments so a one-time event isn't re-asked every day.
 * Deploys don't run `drizzle-kit push`, so add the nullable columns here.
 * ADD COLUMN IF NOT EXISTS is non-destructive and a no-op after the first boot.
 */
export async function ensureMorningNoteColumns(): Promise<void> {
  await db.execute(
    sql`ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS last_surfaced_at timestamp`,
  );
  await db.execute(
    sql`ALTER TABLE commitments ADD COLUMN IF NOT EXISTS last_surfaced_at timestamp`,
  );
  logger.info("schema guard: memory_facts.last_surfaced_at / commitments.last_surfaced_at present");
}

/**
 * Idempotent schema guard for the Hume call-voice column.
 *
 * The Hume call-voice picker stores an explicit pick in profile.hume_voice_id
 * (lib/db/src/schema/profile.ts). Deploys don't run `drizzle-kit push` (see
 * ensureProfileThemeColumns), and drizzle selects all mapped columns
 * explicitly — a database missing the column would 42703 every profile read.
 * ADD COLUMN IF NOT EXISTS is non-destructive and instant for a nullable
 * column, and a no-op forever after the first boot.
 */
export async function ensureHumeVoiceColumn(): Promise<void> {
  await db.execute(sql`ALTER TABLE profile ADD COLUMN IF NOT EXISTS hume_voice_id text`);
  logger.info("schema guard: profile.hume_voice_id present");
}

/** True when an error is Postgres 42703 for the theme columns specifically. */
export function isMissingThemeColumnError(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  if (!err) return false;
  const msg = String(err.message ?? "");
  const undefinedColumn = err.code === "42703" || /does not exist/i.test(msg);
  return undefinedColumn && /theme(_mode)?/i.test(msg);
}

/**
 * Idempotent schema guard for the Dodo provider-id column rename.
 *
 * Stage 1 of the Paddle → Dodo Payments migration renamed
 * subscriptions.paddle_customer_id / paddle_subscription_id to dodo_*
 * (lib/db/src/schema/billing.ts). Deploys don't run `drizzle-kit push`, so a
 * production database created before the rename still has the paddle_* names —
 * which would make every subscriptions read throw 42703. RENAME COLUMN has no
 * IF EXISTS, so the guard checks information_schema first; both billing tables
 * were confirmed empty before the rename, and a rename is instant metadata-only
 * regardless. No-op forever once applied, and on fresh databases (safety-net
 * DDL and drizzle push both create the dodo_* names directly).
 */
export async function ensureDodoBillingColumns(): Promise<void> {
  await db.execute(sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'subscriptions' AND column_name = 'paddle_customer_id'
      ) THEN
        ALTER TABLE subscriptions RENAME COLUMN paddle_customer_id TO dodo_customer_id;
      END IF;
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'subscriptions' AND column_name = 'paddle_subscription_id'
      ) THEN
        ALTER TABLE subscriptions RENAME COLUMN paddle_subscription_id TO dodo_subscription_id;
      END IF;
    END $$;
  `);
  logger.info("schema guard: subscriptions.dodo_customer_id / dodo_subscription_id present");
}
