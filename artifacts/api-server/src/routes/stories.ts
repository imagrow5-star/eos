import { Router, type IRouter } from "express";
import { logger } from "../lib/logger.js";
import { requireInternalToken, internalBodyProblem, isProduction } from "../lib/internalAuth.js";
import { listMarkerStories, markStoryViewed } from "../services/stories.js";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { runWeeklyReviewSweep } from "../services/weeklyReviewGenerate.js";
import { runSubjectStoriesSweep } from "../services/goalStories.js";

/**
 * Stories — the Journey markers and what they open.
 *
 *   GET  /stories            what the marker row shows, in row order: the
 *                            newest Goals story, the newest Routines story,
 *                            then the recent weekly stories, newest first;
 *                            each with cards and the persisted viewed flag
 *   POST /stories/:id/viewed marks one viewed (own stories only; idempotent —
 *                            the ring never comes back)
 *
 * Mounted behind requireAuth + requireVerified with the other user routes.
 * Labels ("This week", "Last week", "August") are the client's job: "this
 * week" is relative to the person's own clock.
 */

const router: IRouter = Router();

router.get("/stories", async (req, res): Promise<void> => {
  const stories = await listMarkerStories(req.userId);
  res.json({ stories });
});

// ─── POST /stories/refresh — generate today's stories for the signed-in user ──
// The hourly job is the normal ticker, but it is a separate scheduled
// deployment and can lag or be stale; Journey calls this on its first load
// of the day so the ring appears when someone opens the page, not an hour
// later. Idempotent per (user, kind, day) — a story that exists today is
// "exists", so at most one model round per kind per day — and throttled per
// user so a reload can't spend model calls when there was nothing to say.
// The window is ignored (the person is looking at the row now); force never.

const REFRESH_THROTTLE_MS = 10 * 60 * 1000;
const lastRefresh = new Map<number, number>();

router.post("/stories/refresh", async (req, res): Promise<void> => {
  const userId = req.userId;
  const now = Date.now();
  const last = lastRefresh.get(userId) ?? 0;
  if (now - last < REFRESH_THROTTLE_MS) {
    res.json({ throttled: true, retryAfterSeconds: Math.ceil((REFRESH_THROTTLE_MS - (now - last)) / 1000) });
    return;
  }
  lastRefresh.set(userId, now);
  const opts = { onlyUserId: userId, ignoreWindow: true };
  const [week, subjects] = await Promise.all([runWeeklyReviewSweep(opts), runSubjectStoriesSweep(opts)]);
  res.json({ throttled: false, week, subjects });
});

router.post("/stories/:id/viewed", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid story id" });
    return;
  }
  const ok = await markStoryViewed(req.userId, id);
  if (!ok) {
    res.status(404).json({ error: "Story not found" });
    return;
  }
  res.json({ ok: true });
});

// ─── Internal machine endpoint (mounted BEFORE auth) ──────────────────────────
// Called hourly by the scheduler, right after the chapter sweep (the weekly
// story's then/now card reads this week's chapter). Runs both sweeps: the
// weekly story (Sunday evening window) and the daily Goals / Routines cards
// (from 06:00 user-local). Authenticated by lib/internalAuth.ts: an HMAC
// under INTERNAL_SWEEP_SECRET over the prefix, the UTC hour and the body.

const STORIES_RUN_FIELDS = ["userId", "email", "force", "ignoreWindow"] as const;

export const storiesInternalRouter: IRouter = Router();

storiesInternalRouter.post("/internal/stories/run", requireInternalToken("stories-run"), async (req, res): Promise<void> => {
  const bodyProblem = internalBodyProblem(req.body, STORIES_RUN_FIELDS);
  if (bodyProblem) {
    res.status(400).json({ error: bodyProblem });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const isProd = isProduction();
  let onlyUserId = Number.isInteger(body.userId) ? (body.userId as number) : undefined;
  // Operators know emails, not ids: an email scopes the run the same way. An
  // address with no account scopes the run to nobody and answers exactly like
  // an account with nothing due — this endpoint must not say which addresses
  // exist, even to a token holder. (An operator who typo'd the address sees
  // zero considered, and tries again.)
  if (onlyUserId === undefined && typeof body.email === "string" && body.email.trim()) {
    const [u] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, body.email.trim().toLowerCase())).limit(1);
    onlyUserId = u?.id ?? NO_SUCH_USER;
  }
  // Operator affordances, same policy as the chapter sweep: force never in
  // production; ignoreWindow in production only when scoped to one user.
  if (body.force === true && isProd) {
    res.status(400).json({ error: "force is not allowed in production" });
    return;
  }
  if (body.ignoreWindow === true && isProd && onlyUserId === undefined) {
    res.status(400).json({ error: "ignoreWindow in production requires a userId scope" });
    return;
  }
  const opts = { onlyUserId, force: body.force === true, ignoreWindow: body.ignoreWindow === true };
  const [week, subjects] = await Promise.all([runWeeklyReviewSweep(opts), runSubjectStoriesSweep(opts)]);
  const result = { week, subjects };
  try {
    logger.info(result, "story sweeps finished");
  } catch { /* logging must never crash the caller */ }
  res.json(result);
});

/** A user id no row can have: scopes a sweep to nobody. */
const NO_SUCH_USER = -1;

export default router;
