/**
 * Billing routes (phase 2) — everything except the webhook, which lives in
 * billingWebhook.ts because it needs a raw-body mount.
 *
 *   GET  /billing/config  (public)   — tier metadata + Paddle price ids for
 *                                      the /pricing page. NEVER secrets: the
 *                                      response is built ONLY from the tier
 *                                      config + PADDLE_PRICE_* values, which
 *                                      are public identifiers by design
 *                                      (they ship inside Paddle.js checkout
 *                                      calls anyway).
 *   GET  /billing/me      (protected) — the caller's tier/status/dates, read
 *                                      fresh from the subscriptions table
 *                                      (the /pricing success screen polls
 *                                      this until the webhook lands).
 *   POST /billing/cancel  (protected) — schedules the caller's OWN
 *                                      subscription to cancel at period end
 *                                      via Paddle's API.
 *
 * Phase 2 gates nothing: these routes read and manage billing state, but no
 * feature checks it yet (voice caps are phase 3).
 */

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, subscriptionsTable } from "@workspace/db";
import { TIERS, getPaddlePriceId, getUserTier, type TierId } from "../services/tiers.js";
import { cancelPaddleSubscription } from "../services/paddle.js";
import { logger } from "../lib/logger.js";

// ─── Public: checkout configuration ──────────────────────────────────────────

export const billingPublicRouter: IRouter = Router();

billingPublicRouter.get("/billing/config", (_req, res): void => {
  const tiers = (Object.keys(TIERS) as TierId[]).map((id) => {
    const t = TIERS[id];
    return {
      id: t.id,
      displayName: t.displayName,
      monthlyPriceCents: t.monthlyPriceCents,
      voiceMinutesPerMonth: t.voiceMinutesPerMonth,
      trialDays: t.trialDays,
      priceId: getPaddlePriceId(id), // null until the env var is set
    };
  });
  // Checkout is only offered when every tier has a live price id.
  const checkoutAvailable = tiers.every((t) => Boolean(t.priceId));
  res.json({ checkoutAvailable, tiers });
});

// ─── Protected: own-subscription state + cancel ──────────────────────────────

const router: IRouter = Router();

router.get("/billing/me", async (req, res): Promise<void> => {
  const tier = await getUserTier(req.userId);
  if (tier.kind === "legacy_full_access") {
    res.json({ kind: "legacy_full_access" });
    return;
  }
  res.json({
    kind: "subscribed",
    tier: tier.tier,
    displayName: tier.config.displayName,
    status: tier.status,
    voiceMinutesPerMonth: tier.voiceMinutesPerMonth,
    trialEndsAt: tier.trialEndsAt,
    currentPeriodEndsAt: tier.currentPeriodEndsAt,
  });
});

// ── GET /billing/usage — voice minutes this billing month (always on) ────────
// Settings shows used/total + reset date. Legacy users see their real usage
// with an unlimited total. `enforced` tells the UI whether caps are live.
router.get("/billing/usage", async (req, res): Promise<void> => {
  const { getMonthlyVoiceUsage, capMinutesFor, isVoiceCapsEnforced } = await import(
    "../services/voiceMetering.js"
  );
  const [tier, usage] = await Promise.all([
    getUserTier(req.userId),
    getMonthlyVoiceUsage(req.userId),
  ]);
  const capMinutes = capMinutesFor(tier);
  res.json({
    usedSeconds: usage.usedSeconds,
    usedMinutes: Math.floor(usage.usedSeconds / 60),
    capMinutes, // null = unlimited (legacy full access)
    unlimited: capMinutes === null,
    resetAt: usage.windowEnd,
    enforced: isVoiceCapsEnforced(),
  });
});

router.post("/billing/cancel", async (req, res): Promise<void> => {
  const userId = req.userId; // own subscription only — no ids accepted from the body
  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  if (!sub || !sub.paddleSubscriptionId) {
    res.status(404).json({ error: "You don't have an active subscription to cancel." });
    return;
  }
  if (sub.status === "canceled") {
    res.json({ ok: true, alreadyCanceled: true, accessUntil: sub.currentPeriodEndsAt });
    return;
  }

  try {
    await cancelPaddleSubscription(sub.paddleSubscriptionId);
  } catch (err) {
    logger.error({ err, userId }, "billing: Paddle cancel API call failed");
    res.status(502).json({
      error:
        "We couldn't reach our payment partner just now — nothing was changed. Please try again in a moment.",
    });
    return;
  }

  // Paddle's subscription.updated/canceled webhooks are the source of truth
  // for the row; the response tells the user what to expect meanwhile.
  logger.info({ userId }, "billing: user scheduled cancellation at period end");
  res.json({ ok: true, accessUntil: sub.currentPeriodEndsAt });
});

export default router;
