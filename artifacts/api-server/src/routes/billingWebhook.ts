/**
 * POST /api/billing/webhook — billing webhook receiver (Dodo Payments).
 *
 * MOUNTING (see app.ts): this router is mounted with express.raw() BEFORE the
 * global express.json() parser, because the Standard Webhooks signature is an
 * HMAC over the RAW body bytes — a parsed-and-reserialized body would never
 * verify. (The exact trap flagged in the payment-readiness review.)
 *
 * Processing contract:
 *  - invalid/missing/stale webhook-id/-timestamp/-signature → 401, logged loudly;
 *  - idempotency: Dodo's envelope carries NO event id (confirmed against a
 *    real sandbox delivery), so the ledger key is the `webhook-id` HEADER —
 *    which is authenticated, because the signature covers it. The id is
 *    inserted into billing_events INSIDE the same transaction as the
 *    processing. A duplicate delivery hits the unique index, skips
 *    processing, and returns 200. A processing FAILURE rolls the ledger row
 *    back and returns 500 — so Dodo retries and the event is never marked
 *    done-but-not-done;
 *  - payload_summary stores a short label (type + subscription id + status),
 *    never the payload itself (it contains personal data);
 *  - user matching: checkout sets metadata.user_id (stage 4); fallbacks are
 *    the customer email EMBEDDED in the payload (confirmed present in the
 *    sandbox delivery), then a Dodo API customer lookup. No match → loud
 *    warning, nothing stored, 200 (retrying won't help);
 *  - always answers fast; our volume is tiny so the trivial DB writes happen
 *    synchronously.
 *
 * STATUS MAPPING (approved table — all seven Dodo statuses, no gaps; the row
 * only ever stores our five known values, so getUserTier's unknown-status
 * fail-open path is unreachable from here):
 *   pending   → no write (new: don't create; existing: keep untouched)
 *   active    → trialing while inside the trial window, else active
 *               (Dodo has no trialing status: a trial is active +
 *               trial_period_days > 0; next_billing_date is the trial end
 *               during the trial — confirmed from a real sandbox payload)
 *   on_hold   → past_due   (failed renewal — replaces the old
 *               transaction.payment_failed special case entirely)
 *   paused    → paused     (subscription.unpaused arrives as active)
 *   cancelled → canceled
 *   failed    → canceled   (terminal, never entitled)
 *   expired   → canceled   (terminal natural end)
 * Anything else → treated like unknown: refuse to create, never overwrite.
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
  verifyDodoWebhookSignature,
  isDodoWebhookConfigured,
  getDodoCustomerEmail,
} from "../services/dodo.js";
import {
  getDodoProductId,
  TIERS,
  type SubscriptionStatus,
  type TierId,
} from "../services/tiers.js";
import { logger } from "../lib/logger.js";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";

const router: IRouter = Router();

// ─── Payload shapes (only the fields we read; everything else ignored) ───────
// Shape confirmed against a captured sandbox subscription.active delivery:
// flat data object, payload_type "Subscription", top-level product_id and
// subscription_id, embedded customer, metadata object, ISO date strings.

interface DodoSubscriptionData {
  payload_type?: string;
  subscription_id?: string;
  customer?: { customer_id?: string; email?: string | null } | null;
  status?: string;
  metadata?: Record<string, unknown> | null;
  product_id?: string;
  created_at?: string;
  next_billing_date?: string | null;
  previous_billing_date?: string | null;
  trial_period_days?: number;
}

interface DodoWebhookPayload {
  business_id?: string;
  type?: string;
  timestamp?: string;
  data?: DodoSubscriptionData;
}

function resolveTierFromProductId(productId: string | undefined): TierId | null {
  if (!productId) return null;
  for (const tierId of Object.keys(TIERS) as TierId[]) {
    const configured = getDodoProductId(tierId);
    if (configured && configured === productId) return tierId;
  }
  return null;
}

function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The approved Dodo → internal status mapping. Returns null for `pending`
 * and for anything unrecognized — the caller then refuses to create a row
 * and never overwrites an existing one (a webhook must never corrupt a good
 * row, and an unmapped status must never be stored where getUserTier could
 * fail open on it).
 */
function mapDodoStatus(data: DodoSubscriptionData, nowMs: number): SubscriptionStatus | null {
  switch (data.status) {
    case "pending":
      return null;
    case "active": {
      const trialDays = typeof data.trial_period_days === "number" ? data.trial_period_days : 0;
      if (trialDays > 0) {
        const created = parseDate(data.created_at);
        if (created && nowMs < created.getTime() + trialDays * 86_400_000) return "trialing";
      }
      return "active";
    }
    case "on_hold":
      return "past_due";
    case "paused":
      return "paused";
    case "cancelled":
    case "failed":
    case "expired":
      return "canceled";
    default:
      return null;
  }
}

/** metadata.user_id arrives as a number or numeric string (set at checkout). */
function parseMetadataUserId(metadata: Record<string, unknown> | null | undefined): number | null {
  const raw = metadata?.user_id;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function findUserByEmail(email: string): Promise<number | null> {
  const normalized = email.toLowerCase().trim();
  if (!normalized) return null;
  const [u] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.email, normalized))
    .limit(1);
  return u?.id ?? null;
}

/** Resolve which Eos user a subscription belongs to. */
async function matchUser(data: DodoSubscriptionData): Promise<number | null> {
  const metadataId = parseMetadataUserId(data.metadata);
  if (metadataId !== null) {
    const [u] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.id, metadataId))
      .limit(1);
    if (u) return u.id;
    logger.warn({ metadataId }, "billing-webhook: metadata.user_id matches no user — trying email");
  }
  // The payload embeds the customer's email (confirmed in the sandbox
  // capture) — try it before spending an API call.
  const embeddedEmail = data.customer?.email;
  if (typeof embeddedEmail === "string" && embeddedEmail) {
    const id = await findUserByEmail(embeddedEmail);
    if (id !== null) return id;
  }
  if (data.customer?.customer_id) {
    const email = await getDodoCustomerEmail(data.customer.customer_id).catch(() => null);
    if (email) {
      const id = await findUserByEmail(email);
      if (id !== null) return id;
    }
  }
  return null;
}

/** Applies a subscription.* event to our subscriptions table. */
async function applySubscriptionEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  eventType: string,
  data: DodoSubscriptionData,
  userId: number,
): Promise<void> {
  const tier = resolveTierFromProductId(data.product_id);
  const status = mapDodoStatus(data, Date.now());
  // During the trial, next_billing_date IS the trial end (confirmed from the
  // sandbox payload: created_at + trial_period_days, and the first charge).
  const currentPeriodEndsAt = parseDate(data.next_billing_date);
  // previous_billing_date is the current period's START (during the trial it
  // equals created_at — confirmed from the same capture). Voice-minute
  // metering sums voice_usage between these two boundaries.
  const currentPeriodStartedAt = parseDate(data.previous_billing_date);
  const trialEndsAt = status === "trialing" ? currentPeriodEndsAt : null;

  const [existing] = await tx
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  if (!existing) {
    if (!tier || !status) {
      // A brand-new subscription we can't classify (or a `pending` one) must
      // not guess — log SO loudly it gets noticed, and let a later
      // (activated/corrected) event create it.
      try {
        const uh = hashUserIdForLog(userId);
        if (uh)
          logger.error(
            { eventType, productId: data.product_id, status: data.status, uh },
            "billing-webhook: cannot create subscription row — pending, unknown product id, or " +
              "unknown status. Check DODO_PRODUCT_* env vars match the live Dodo products.",
          );
      } catch { /* logging must never crash the caller */ }
      return;
    }
    await tx.insert(subscriptionsTable).values({
      userId,
      dodoCustomerId: data.customer?.customer_id ?? null,
      dodoSubscriptionId: data.subscription_id ?? null,
      tier,
      status,
      trialEndsAt,
      currentPeriodStartedAt,
      currentPeriodEndsAt,
    });
    try {
      const uh = hashUserIdForLog(userId);
      if (uh) logger.info({ uh, tier, status, eventType }, "billing-webhook: subscription row created");
    } catch { /* logging must never crash the caller */ }
    return;
  }

  // Update path: unmapped status (pending/unknown) and unknown tier leave the
  // existing values untouched (a webhook must never corrupt a good row),
  // everything else refreshes.
  await tx
    .update(subscriptionsTable)
    .set({
      dodoCustomerId: data.customer?.customer_id ?? existing.dodoCustomerId,
      dodoSubscriptionId: data.subscription_id ?? existing.dodoSubscriptionId,
      ...(tier ? { tier } : {}),
      ...(status ? { status } : {}),
      trialEndsAt: trialEndsAt ?? existing.trialEndsAt,
      currentPeriodStartedAt: currentPeriodStartedAt ?? existing.currentPeriodStartedAt,
      currentPeriodEndsAt: currentPeriodEndsAt ?? existing.currentPeriodEndsAt,
      updatedAt: new Date(),
    })
    .where(eq(subscriptionsTable.userId, userId));
  try {
    const uh = hashUserIdForLog(userId);
    if (uh)
      logger.info(
        { uh, tier: tier ?? existing.tier, status: status ?? existing.status, eventType },
        "billing-webhook: subscription row updated",
      );
  } catch { /* logging must never crash the caller */ }
}

router.post("/billing/webhook", async (req, res): Promise<void> => {
  if (!isDodoWebhookConfigured()) {
    logger.error("billing-webhook: DODO_WEBHOOK_SECRET not set — rejecting delivery");
    res.status(503).json({ error: "webhook not configured" });
    return;
  }

  const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ""), "utf8");
  const sigHeaders = {
    id: req.header("webhook-id"),
    timestamp: req.header("webhook-timestamp"),
    signature: req.header("webhook-signature"),
  };
  if (!verifyDodoWebhookSignature(rawBody, sigHeaders, process.env.DODO_WEBHOOK_SECRET!.trim())) {
    logger.error(
      { hasSignature: Boolean(sigHeaders.signature), bodyBytes: rawBody.length },
      "billing-webhook: INVALID SIGNATURE — delivery rejected. If this repeats, verify " +
        "DODO_WEBHOOK_SECRET matches the webhook's secret in the Dodo Payments dashboard.",
    );
    res.status(401).json({ error: "invalid signature" });
    return;
  }

  let payload: DodoWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as DodoWebhookPayload;
  } catch {
    logger.error("billing-webhook: signed body is not valid JSON");
    res.status(400).json({ error: "invalid payload" });
    return;
  }

  // Dodo's envelope has no event id — the ledger key is the webhook-id
  // header, which the (already verified) signature covers. Verification
  // guarantees it is present; the guard below is defense in depth.
  const eventId = sigHeaders.id;
  const eventType = payload.type ?? "unknown";
  if (!eventId) {
    logger.error({ eventType }, "billing-webhook: delivery has no webhook-id");
    res.status(400).json({ error: "missing webhook-id" });
    return;
  }

  try {
    const outcome = await db.transaction(async (tx) => {
      // Idempotency claim — same transaction as the processing, so a failure
      // below rolls this back and Dodo's retry gets a clean second attempt.
      const claimed = await tx
        .insert(billingEventsTable)
        .values({
          eventId,
          eventType,
          payloadSummary: `${eventType} sub=${payload.data?.subscription_id ?? "?"} status=${payload.data?.status ?? "?"}`,
        })
        .onConflictDoNothing()
        .returning({ id: billingEventsTable.id });
      if (claimed.length === 0) return "duplicate" as const;

      // Every subscription.* event (active, renewed, on_hold, paused,
      // unpaused, cancelled, failed, expired, plan_changed, updated, …)
      // carries the full subscription object, so one upsert handles them
      // all. subscription.on_hold covers failed renewals — the old
      // transaction.payment_failed special case is gone with Paddle.
      if (eventType.startsWith("subscription.")) {
        const data = payload.data ?? {};
        const userId = await matchUser(data);
        if (userId === null) {
          logger.error(
            { eventType, dodoSubscriptionId: data.subscription_id, dodoCustomerId: data.customer?.customer_id },
            "billing-webhook: could NOT match this subscription to any user — nothing stored. " +
              "A paying customer may not be linked to their account; investigate promptly.",
          );
          return "unmatched" as const;
        }
        await applySubscriptionEvent(tx, eventType, data, userId);
        return "processed" as const;
      }

      // payment.* and anything else subscribed later: the subscription.*
      // events carry the state we mirror — record and move on.
      logger.info({ eventType }, "billing-webhook: event recorded (no state change needed)");
      return "processed" as const;
    });

    if (outcome === "duplicate") {
      logger.info({ eventId, eventType }, "billing-webhook: duplicate delivery — already processed");
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    // Ledger row rolled back with the failed work — Dodo will retry.
    logger.error({ err, eventId, eventType }, "billing-webhook: processing failed — returning 500 for retry");
    res.status(500).json({ error: "processing failed" });
  }
});

export default router;
