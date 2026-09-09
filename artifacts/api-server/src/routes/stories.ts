import { Router, type IRouter } from "express";
import crypto from "crypto";
import { logger } from "../lib/logger.js";
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

function legacyRunToken(secret: string, d: Date): string {
  const stamp = d.toISOString().slice(0, 13);
  return crypto.createHmac("sha256", secret).update(`weekly-review-run:${stamp}`).digest("hex");
}

function tokenMatches(provided: string, secret: string, now: Date): boolean {
  const a = Buffer.from(provided);
  for (const d of [now, new Date(now.getTime() - 3_600_000)]) {
    for (const expected of [storiesRunToken(secret, d), legacyRunToken(secret, d)]) {
      const b = Buffer.from(expected);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
    }
  }
  return false;
}

export const storiesInternalRouter: IRouter = Router();

async function runStorySweeps(req: import("express").Request, res: import("express").Response): Promise<void> {
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
  let onlyUserId = Number.isInteger(body.userId) ? (body.userId as number) : undefined;
  // Operators know emails, not ids: an email scopes the run the same way.
  if (onlyUserId === undefined && typeof body.email === "string" && body.email.trim()) {
    const [u] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.email, body.email.trim().toLowerCase())).limit(1);
    if (!u) {
      res.status(404).json({ error: "no user with that email" });
      return;
    }
    onlyUserId = u.id;
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
}

storiesInternalRouter.post("/internal/stories/run", runStorySweeps);
// The stage-3 endpoint name, kept as an alias: a scheduled-job deployment
// built before the rename still triggers every sweep. Same token scheme,
// but with the old prefix — the alias accepts either.
storiesInternalRouter.post("/internal/weekly-reviews/run", runStorySweeps);

export default router;
