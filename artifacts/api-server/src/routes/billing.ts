/**
 * Billing routes (phase 2) — everything except the webhook, which lives in
 * billingWebhook.ts because it needs a raw-body mount.
 *
 *   GET  /billing/config  (public)   — tier metadata + Dodo product ids for
 *                                      the /pricing page. NEVER secrets: the
 *                                      response is built ONLY from the tier
 *                                      config + DODO_PRODUCT_* values, which
 *                                      are public identifiers by design
 *                                      (they ship inside checkout calls
 *                                      anyway).
 *   GET  /billing/me      (protected) — the caller's tier/status/dates, read
 *                                      fresh from the subscriptions table
 *                                      (the /pricing success screen polls
 *                                      this until the webhook lands).
 *   POST /billing/cancel  (protected) — schedules the caller's OWN
 *                                      subscription to cancel at period end
 *                                      via Dodo's API.
 *
 * Phase 2 gates nothing: these routes read and manage billing state, but no
 * feature checks it yet (voice caps are phase 3).
 */

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, subscriptionsTable, usersTable } from "@workspace/db";
import { TIERS, getDodoProductId, getUserTier, isTierId, type TierId } from "../services/tiers.js";
import { cancelDodoSubscription, createDodoCheckoutSession } from "../services/dodo.js";
import { getAppBaseUrl } from "./auth.js";
import { logger } from "../lib/logger.js";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";

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
      priceId: getDodoProductId(id), // null until the env var is set
    };
  });
  // Checkout is only offered when every tier has a live price id.
  const checkoutAvailable = tiers.every((t) => Boolean(t.priceId));
  res.json({ checkoutAvailable, tiers });
});

// ─── Protected: own-subscription state + cancel ──────────────────────────────

const router: IRouter = Router();

// Stage 4: the server creates the Dodo checkout session so metadata.user_id
// is ALWAYS set from the authenticated session — the webhook's primary user
// matcher — and the API key never touches the client. The body names only
// the tier; everything else comes from the session and the tier config.
router.post("/billing/checkout-session", async (req, res): Promise<void> => {
  const tierId = (req.body as { tier?: unknown } | undefined)?.tier;
  if (!isTierId(tierId)) {
    res.status(400).json({ error: "Unknown plan." });
    return;
  }
  const productId = getDodoProductId(tierId);
  if (!productId) {
    res.status(503).json({ error: "Checkout isn't switched on yet." });
    return;
  }

  const [u] = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(eq(usersTable.id, req.userId))
    .limit(1);
  if (!u) {
    res.status(401).json({ error: "Not authenticated." });
    return;
  }

  try {
    const url = await createDodoCheckoutSession({
      productId,
      userId: req.userId,
      email: u.email,
      trialPeriodDays: TIERS[tierId].trialDays,
      // The ?checkout=return marker is what /pricing watches for to start
      // polling /billing/me after the redirect back (Dodo appends its own
      // status params alongside).
      returnUrl: `${getAppBaseUrl()}/pricing?checkout=return`,
    });
    res.json({ url });
  } catch (err) {
    try {
      const uh = hashUserIdForLog(req.userId);
      if (uh) logger.error({ err, uh, tierId }, "billing: Dodo checkout-session create failed");
    } catch { /* logging must never crash the caller */ }
    res.status(502).json({
      error: "We couldn't reach our payment partner just now. Please try again in a moment.",
    });
  }
});

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

router.post("/billing/cancel", async (req, res): Promise<void> => {
  const userId = req.userId; // own subscription only — no ids accepted from the body
  const [sub] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  if (!sub || !sub.dodoSubscriptionId) {
    res.status(404).json({ error: "You don't have an active subscription to cancel." });
    return;
  }
  if (sub.status === "canceled") {
    res.json({ ok: true, alreadyCanceled: true, accessUntil: sub.currentPeriodEndsAt });
    return;
  }

  try {
    await cancelDodoSubscription(sub.dodoSubscriptionId);
  } catch (err) {
    try {
      const uh = hashUserIdForLog(userId);
      if (uh) logger.error({ err, uh }, "billing: Dodo cancel API call failed");
    } catch { /* logging must never crash the caller */ }
    res.status(502).json({
      error:
        "We couldn't reach our payment partner just now — nothing was changed. Please try again in a moment.",
    });
    return;
  }

  // Dodo's subscription webhooks are the source of truth for the row; the
  // response tells the user what to expect meanwhile.
  try {
    const uh = hashUserIdForLog(userId);
    if (uh) logger.info({ uh }, "billing: user scheduled cancellation at period end");
  } catch { /* logging must never crash the caller */ }
  res.json({ ok: true, accessUntil: sub.currentPeriodEndsAt });
});

export default router;
