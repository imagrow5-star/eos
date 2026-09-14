import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { fetchExportPayload } from "./account.js";
import {
  generateReflectionReport,
  MIN_USER_MESSAGES_FOR_AUTO,
} from "../services/reflection/generateReport.js";
import { logger } from "../lib/logger.js";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";
import { requireInternalToken, internalBodyProblem, isProduction } from "../lib/internalAuth.js";

// ─── Weekly reflection sweep (internal machine endpoint, mounted BEFORE auth) ──
// Called on the hourly daily-email ticker (autoscale servers can't run their
// own cron). Idempotent per (user, week): a user gets at most one AUTO reflection
// per rolling 7 days, so calling this every hour is safe — it just generates for
// whoever has become due since last time.
//
// Authenticated by lib/internalAuth.ts, the same scheme as the chapter and
// story sweeps: HMAC under INTERNAL_SWEEP_SECRET over the prefix, the UTC hour
// and the body. Reuses the SAME data loader (fetchExportPayload) and
// generation service as the on-demand path — no parallel pipeline.

const PERIOD_DAYS = 7;

// Cost/fan-out guard: never generate for more than this many users in a single
// sweep invocation. Due users spill to the next hourly tick. Env-overridable.
function maxPerRun(): number {
  const n = Number(process.env.REFLECTION_SWEEP_MAX_PER_RUN);
  return Number.isInteger(n) && n > 0 ? n : 25;
}

/** YYYY-MM-DD (UTC) — the inclusive-date shape fetchExportPayload expects. */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Users who are DUE for an auto reflection: email-verified, with at least the
 * minimum-content bar of their OWN messages in the last period, and no
 * reflection report already created in that period. Pre-filtering on the
 * message count here avoids paying for an LLM call the service's gate would
 * only skip. `onlyUserId` scopes the sweep to one user (local/test hook).
 */
async function findDueUsers(onlyUserId: number | undefined, limit: number): Promise<number[]> {
  const params: unknown[] = [PERIOD_DAYS, MIN_USER_MESSAGES_FOR_AUTO];
  let scope = "";
  if (onlyUserId !== undefined) {
    params.push(onlyUserId);
    scope = `AND m.user_id = $${params.length}`;
  }
  params.push(limit);
  const limitPlaceholder = `$${params.length}`;

  const r = await pool.query<{ user_id: number }>(
    `SELECT m.user_id
       FROM messages m
       JOIN users u ON u.id = m.user_id AND u.email_verified_at IS NOT NULL
      WHERE m.role = 'user'
        AND m.created_at >= now() - ($1 || ' days')::interval
        ${scope}
        AND NOT EXISTS (
          SELECT 1 FROM reflection_reports rr
           WHERE rr.user_id = m.user_id
             AND rr.created_at >= now() - ($1 || ' days')::interval
        )
      GROUP BY m.user_id
     HAVING count(*) >= $2
      ORDER BY m.user_id
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return r.rows.map((row) => row.user_id);
}

export interface ReflectionSweepResult {
  candidates: number;
  generated: number;
  skipped: number;
  unavailable: number;
  dryRun: boolean;
  decisions?: { userId: number; decision: string }[];
}

/**
 * Run the weekly reflection sweep. `dryRun` selects candidates and reports what
 * WOULD happen without generating or calling the model.
 */
export async function runReflectionSweep(opts: {
  onlyUserId?: number;
  dryRun?: boolean;
}): Promise<ReflectionSweepResult> {
  const users = await findDueUsers(opts.onlyUserId, maxPerRun());
  const result: ReflectionSweepResult = {
    candidates: users.length,
    generated: 0,
    skipped: 0,
    unavailable: 0,
    dryRun: !!opts.dryRun,
    decisions: [],
  };

  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - PERIOD_DAYS * 24 * 60 * 60 * 1000);

  for (const userId of users) {
    if (opts.dryRun) {
      result.decisions!.push({ userId, decision: "would_generate" });
      continue;
    }
    try {
      const payload = await fetchExportPayload(userId, { from: ymd(periodStart), to: ymd(periodEnd) });
      const outcome = await generateReflectionReport({
        userId,
        payload,
        periodStart,
        periodEnd,
        generatedBy: "auto",
      });
      if (outcome.status === "generated") result.generated++;
      else if (outcome.status === "skipped_insufficient") result.skipped++;
      else result.unavailable++;
      result.decisions!.push({ userId, decision: outcome.status });
    } catch (err) {
      result.unavailable++;
      result.decisions!.push({ userId, decision: "error" });
      logger.error({ err }, "reflection sweep: per-user generation failed");
    }
  }
  return result;
}

export const reflectionInternalRouter: IRouter = Router();

const REFLECTION_RUN_FIELDS = ["userId", "dryRun"] as const;

reflectionInternalRouter.post("/internal/reflection/weekly-run", requireInternalToken("reflection-run"), async (req, res): Promise<void> => {
  const bodyProblem = internalBodyProblem(req.body, REFLECTION_RUN_FIELDS);
  if (bodyProblem) {
    res.status(400).json({ error: bodyProblem });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const onlyUserId = Number.isInteger(body.userId) ? (body.userId as number) : undefined;
  const dryRun = body.dryRun === true;

  const result = await runReflectionSweep({ onlyUserId, dryRun });
  // Privacy (Tier 3): decisions[] carries raw userIds — hashed for the log,
  // and not returned at all in production (the counts are the answer).
  try {
    logger.info(
      {
        candidates: result.candidates,
        generated: result.generated,
        skipped: result.skipped,
        unavailable: result.unavailable,
        dryRun: result.dryRun,
        decisions: result.decisions?.map((d) => ({ uh: hashUserIdForLog(d.userId), decision: d.decision })),
      },
      "reflection sweep finished",
    );
  } catch {
    /* logging must never crash the caller */
  }
  res.json(isProduction() ? { ...result, decisions: undefined } : result);
});
