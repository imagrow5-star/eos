import { Router, type IRouter } from "express";
import { listWeeklyReviews, markWeeklyReviewViewed } from "../services/weeklyReview.js";

/**
 * Weekly review — the Journey markers and the story they open.
 *
 *   GET  /weekly-reviews            the most recent 6, newest first, with
 *                                   cards and the persisted viewed flag
 *   POST /weekly-reviews/:id/viewed marks one viewed (own stories only;
 *                                   idempotent — the ring never comes back)
 *
 * Mounted behind requireAuth + requireVerified with the other user routes.
 * Labels ("This week", "Last week", "August", "14 Aug") and the date range
 * are the client's job: "this week" is relative to the person's own clock.
 */

const router: IRouter = Router();

router.get("/weekly-reviews", async (req, res): Promise<void> => {
  const reviews = await listWeeklyReviews(req.userId);
  res.json({ reviews });
});

router.post("/weekly-reviews/:id/viewed", async (req, res): Promise<void> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid review id" });
    return;
  }
  const ok = await markWeeklyReviewViewed(req.userId, id);
  if (!ok) {
    res.status(404).json({ error: "Review not found" });
    return;
  }
  res.json({ ok: true });
});

export default router;
