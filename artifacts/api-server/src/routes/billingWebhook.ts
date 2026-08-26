/**
 * POST /api/billing/webhook — Paddle Billing webhook receiver (phase 2).
 *
 * MOUNTING (see app.ts): this router is mounted with express.raw() BEFORE the
 * global express.json() parser, because Paddle's signature is an HMAC over
 * the RAW body bytes — a parsed-and-reserialized body would never verify.
 * (The exact trap flagged in the payment-readiness review.)
 *
 * Processing contract:
 *  - invalid/missing/stale Paddle-Signature → 401, logged loudly;
 *  - idempotency: the event_id is inserted into billing_events INSIDE the
 *    same transaction as the processing. A duplicate delivery hits the
 *    unique index, skips processing, and returns 200. A processing FAILURE
 *    rolls the ledger row back and returns 500 — so Paddle retries and the
 *    event is never marked done-but-not-done;
 *  - payload_summary stores a short label (type + subscription id + status),
 *    never the payload itself (it contains personal data);
 *  - user matching: checkout sends custom_data.user_id (see the /pricing
 *    page); fallback is the Paddle customer's email matched against users.
 *    No match → loud warning, nothing stored, 200 (retrying won't help);
 *  - always answers fast; our volume is tiny so the trivial DB writes happen
 *    synchronously.
 */

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  db,
  usersTable,
  subscriptionsTable,
  billingEventsTable,
} from "@workspace/db";
import {
  verifyPaddleSignature,
  isPaddleWebhookConfigured,
  getPaddleCustomerEmail,
} from "../services/paddle.js";
import {
  getPaddlePriceId,
  isSubscriptionStatus,
  isTierId,
  TIERS,
  type TierId,
} from "../services/tiers.js";
import { logger } from "../lib/logger.js";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";

const router: IRouter = Router();

// ─── Payload shapes (only the fields we read; everything else ignored) ───────

interface PaddleSubscriptionData {
  id?: string;
  customer_id?: string;
  status?: string;
  custom_data?: { user_id?: unknown } | null;
  items?: Array<{
    price?: { id?: string } | null;
    trial_dates?: { ends_at?: string | null } | null;
  } | null> | null;
  current_billing_period?: { ends_at?: string | null } | null;
}

interface PaddleTransactionData {
  subscription_id?: string | null;
  status?: string;
}

interface PaddleWebhookPayload {
  event_id?: string;
  event_type?: string;
  data?: PaddleSubscriptionData & PaddleTransactionData;
}

function resolveTierFromPriceIds(priceIds: string[]): TierId | null {
  for (const tierId of Object.keys(TIERS) as TierId[]) {
    const configured = getPaddlePriceId(tierId);
    if (configured && priceIds.includes(configured)) return tierId;
  }
  return null;
}

function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** custom_data.user_id arrives as a number or numeric string. */
function parseCustomUserId(customData: { user_id?: unknown } | null | undefined): number | null {
  const raw = customData?.user_id;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Resolve which Eos user a subscription belongs to. */
async function matchUser(data: PaddleSubscriptionData): Promise<number | null> {
  const customId = parseCustomUserId(data.custom_data);
  if (customId !== null) {
    const [u] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, customId))
      .limit(1);
    if (u) return u.id;
    logger.warn({ customId }, "billing-webhook: custom_data.user_id matches no user — trying email");
  }
  if (data.customer_id) {
    const email = await getPaddleCustomerEmail(data.customer_id).catch(() => null);
    if (email) {
      const [u] = await db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1);
      if (u) return u.id;
    }
  }
  return null;
}

/** Applies a subscription.* event to our subscriptions table. */
async function applySubscriptionEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  eventType: string,
  data: PaddleSubscriptionData,
  userId: number,
): Promise<void> {
  const priceIds = (data.items ?? [])
    .map((i) => i?.price?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const tier = resolveTierFromPriceIds(priceIds);
  const status = isSubscriptionStatus(data.status) ? data.status : null;
  const trialEndsAt =
    parseDate(data.items?.[0]?.trial_dates?.ends_at) ??
    (data.status === "trialing" ? parseDate(data.current_billing_period?.ends_at) : null);
  const currentPeriodEndsAt = parseDate(data.current_billing_period?.ends_at);

  const [existing] = await tx
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  if (!existing) {
    if (!tier || !status) {
      // A brand-new subscription we can't classify must not guess — log SO
      // loudly it gets noticed, and let a later (corrected) event create it.
      try {
        const uh = hashUserIdForLog(userId);
        if (uh)
          logger.error(
            { eventType, uh, priceIds, status: data.status },
            "billing-webhook: cannot create subscription row — unknown price id or status. " +
              "Check PADDLE_PRICE_* env vars match the live Paddle prices.",
          );
      } catch { /* logging must never crash the caller */ }
      return;
    }
    await tx.insert(subscriptionsTable).values({
      userId,
      dodoCustomerId: data.customer_id ?? null,
      dodoSubscriptionId: data.id ?? null,
      tier,
      status,
      trialEndsAt,
      currentPeriodEndsAt,
    });
    try {
      const uh = hashUserIdForLog(userId);
      if (uh) logger.info({ uh, tier, status, eventType }, "billing-webhook: subscription row created");
    } catch { /* logging must never crash the caller */ }
    return;
  }

  // Update path: unknown tier/status leave the existing value untouched
  // (a webhook must never corrupt a good row), everything else refreshes.
  const nextTier = tier ?? (isTierId(existing.tier) ? existing.tier : null);
  await tx
    .update(subscriptionsTable)
    .set({
      dodoCustomerId: data.customer_id ?? existing.dodoCustomerId,
      dodoSubscriptionId: data.id ?? existing.dodoSubscriptionId,
      ...(nextTier ? { tier: nextTier } : {}),
      ...(status ? { status } : {}),
      trialEndsAt: trialEndsAt ?? existing.trialEndsAt,
      currentPeriodEndsAt: currentPeriodEndsAt ?? existing.currentPeriodEndsAt,
      updatedAt: new Date(),
    })
    .where(eq(subscriptionsTable.userId, userId));
  try {
    const uh = hashUserIdForLog(userId);
    if (uh)
      logger.info(
        { uh, tier: nextTier ?? existing.tier, status: status ?? existing.status, eventType },
        "billing-webhook: subscription row updated",
      );
  } catch { /* logging must never crash the caller */ }
}

router.post("/billing/webhook", async (req, res): Promise<void> => {
  if (!isPaddleWebhookConfigured()) {
    logger.error("billing-webhook: PADDLE_WEBHOOK_SECRET not set — rejecting delivery");
    res.status(503).json({ error: "webhook not configured" });
    return;
  }

  const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""), "utf8");
  const signature = req.header("paddle-signature");
  if (!verifyPaddleSignature(rawBody, signature, process.env.PADDLE_WEBHOOK_SECRET!.trim())) {
    logger.error(
      { hasSignature: Boolean(signature), bodyBytes: rawBody.length },
      "billing-webhook: INVALID SIGNATURE — delivery rejected. If this repeats, verify " +
        "PADDLE_WEBHOOK_SECRET matches the webhook destination's secret in the Paddle dashboard.",
    );
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  let payload: PaddleWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as PaddleWebhookPayload;
  } catch {
    logger.error("billing-webhook: signed body is not valid JSON");
    res.status(400).json({ error: "invalid payload" });
    return;
  }

  const eventId = payload.event_id;
  const eventType = payload.event_type ?? "unknown";
  if (!eventId || typeof eventId !== "string") {
    logger.error({ eventType }, "billing-webhook: payload has no event_id");
    res.status(400).json({ error: "missing event_id" });
    return;
  }

  try {
    const outcome = await db.transaction(async (tx) => {
      // Idempotency claim — same transaction as the processing, so a failure
      // below rolls this back and Paddle's retry gets a clean second attempt.
      const claimed = await tx
        .insert(billingEventsTable)
        .values({
          eventId,
          eventType,
          payloadSummary: `${eventType} sub=${payload.data?.id ?? "?"} status=${payload.data?.status ?? "?"}`,
        })
        .onConflictDoNothing()
        .returning({ id: billingEventsTable.id });
      if (claimed.length === 0) return "duplicate" as const;

      if (eventType.startsWith("subscription.")) {
        const data = payload.data ?? {};
        const userId = await matchUser(data);
        if (userId === null) {
          logger.error(
            { eventType, paddleSubscriptionId: data.id, paddleCustomerId: data.customer_id },
            "billing-webhook: could NOT match this subscription to any user — nothing stored. " +
              "A paying customer may not be linked to their account; investigate promptly.",
          );
          return "unmatched" as const;
        }
        await applySubscriptionEvent(tx, eventType, data, userId);
        return "processed" as const;
      }

      if (eventType === "transaction.payment_failed") {
        const data = payload.data ?? {};
        logger.warn(
          { subscriptionId: data.subscription_id, status: data.status },
          "billing-webhook: payment failed",
        );
        if (data.subscription_id && data.status === "past_due") {
          await tx
            .update(subscriptionsTable)
            .set({ status: "past_due", updatedAt: new Date() })
            .where(eq(subscriptionsTable.dodoSubscriptionId, data.subscription_id));
        }
        return "processed" as const;
      }

      // transaction.completed and anything else subscribed later: the
      // subscription.* events carry the state we mirror — record and move on.
      logger.info({ eventType }, "billing-webhook: event recorded (no state change needed)");
      return "processed" as const;
    });

    if (outcome === "duplicate") {
      logger.info({ eventId, eventType }, "billing-webhook: duplicate delivery — already processed");
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    // Ledger row rolled back with the failed work — Paddle will retry.
    logger.error({ err, eventId, eventType }, "billing-webhook: processing failed — returning 500 for retry");
    res.status(500).json({ error: "processing failed" });
  }
});

export default router;
