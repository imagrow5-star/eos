import { Router, type IRouter } from "express";
import { cleanupJobState } from "../app.js";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const now = Date.now();
  const msSinceSuccess =
    cleanupJobState.lastSuccessAt !== null
      ? now - cleanupJobState.lastSuccessAt.getTime()
      : null;

  const stale =
    msSinceSuccess === null || msSinceSuccess > 48 * 60 * 60 * 1000;

  res.json({
    status: "ok",
    tokenCleanup: {
      lastSuccessAt: cleanupJobState.lastSuccessAt,
      lastErrorAt: cleanupJobState.lastErrorAt,
      consecutiveFailures: cleanupJobState.consecutiveFailures,
      deletedLastRun: cleanupJobState.deletedLastRun,
      stale,
    },
  });
});

export default router;
