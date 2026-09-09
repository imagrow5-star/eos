import { Router, type IRouter } from "express";
import crypto from "crypto";
import { logger } from "../lib/logger.js";
import { listMarkerStories, markStoryViewed } from "../services/stories.js";
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
// Called hourly by the daily-email scheduled job, right after the chapter
// sweep (the weekly story's then/now card reads this week's chapter). Runs
// both sweeps: the weekly story (Sunday evening window) and the daily Goals /
// Routines cards (from 06:00 user-local). Authenticated by an HMAC of
// SESSION_SECRET and the current UTC hour — same scheme as
// /internal/chapters/run; the previous hour is accepted for clock edges.

export function storiesRunToken(secret: string, d: Date): string {
  const stamp = d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  return crypto.createHmac("sha256", secret).update(`stories-run:${stamp}`).digest("hex");
}

function tokenMatches(provided: string, secret: string, now: Date): boolean {
  for (const d of [now, new Date(now.getTime() - 3_600_000)]) {
    const a = Buffer.from(provided);
    const b = Buffer.from(storiesRunToken(secret, d));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

export const storiesInternalRouter: IRouter = Router();

storiesInternalRouter.post("/internal/stories/run", async (req, res): Promise<void> => {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    res.status(500).json({ error: "SESSION_SECRET not configured" });
    return;
  }
  const token = req.header("x-internal-token") ?? "";
  if (!token || !tokenMatches(token, secret, new Date())) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const isProd = process.env.NODE_ENV === "production";
  const onlyUserId = Number.isInteger(body.userId) ? (body.userId as number) : undefined;
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

export default router;
