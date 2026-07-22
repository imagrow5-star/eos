// ─── Web push routes ──────────────────────────────────────────────────────────
// User-facing: VAPID public key, subscribe/unsubscribe (which also flip the
// profile.pushOptIn flag), and a "send me a test" endpoint so the Settings
// toggle can prove the pipe works end-to-end.
//
// Internal: POST /internal/push/morning-run — called hourly by the daily-email
// scheduled job, authenticated by the same HMAC-over-hour-stamp scheme as the
// chapter sweep (shared secret = SESSION_SECRET; current and previous UTC hour
// accepted; timing-safe compare).

import { Router, type IRouter } from "express";
import crypto from "crypto";
import { and, eq } from "drizzle-orm";
import { db, profileTable, pushSubscriptionsTable } from "@workspace/db";
import { getVapidPublicKey, sendPushToUser, runMorningPushSweep } from "../services/push.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ─── GET /push/vapid-public-key ───────────────────────────────────────────────

router.get("/push/vapid-public-key", async (_req, res): Promise<void> => {
  const publicKey = await getVapidPublicKey();
  res.json({ publicKey });
});

// ─── POST /push/subscribe ─────────────────────────────────────────────────────

router.post("/push/subscribe", async (req, res): Promise<void> => {
  const userId = req.userId;
  const sub = (req.body ?? {}).subscription;
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (
    typeof endpoint !== "string" ||
    !/^https:\/\//.test(endpoint) ||
    endpoint.length > 1000 ||
    typeof p256dh !== "string" ||
    p256dh.length === 0 ||
    p256dh.length > 300 ||
    typeof auth !== "string" ||
    auth.length === 0 ||
    auth.length > 300
  ) {
    res.status(400).json({ error: "A valid push subscription is required" });
    return;
  }

  const userAgent = (req.headers["user-agent"] ?? "").toString().slice(0, 300) || null;
  // Upsert by endpoint: a device that re-subscribes (or switches account)
  // simply re-binds — endpoints are globally unique per browser profile.
  await db
    .insert(pushSubscriptionsTable)
    .values({ userId, endpoint, p256dh, auth, userAgent })
    .onConflictDoUpdate({
      target: pushSubscriptionsTable.endpoint,
      set: { userId, p256dh, auth, userAgent, failureCount: 0 },
    });
  await db.update(profileTable).set({ pushOptIn: true }).where(eq(profileTable.userId, userId));
  logger.info({ userId }, "push: subscribed");
  res.json({ ok: true });
});

// ─── POST /push/unsubscribe ───────────────────────────────────────────────────

router.post("/push/unsubscribe", async (req, res): Promise<void> => {
  const userId = req.userId;
  const endpoint = (req.body ?? {}).endpoint;
  if (endpoint !== undefined && (typeof endpoint !== "string" || endpoint.length > 1000)) {
    res.status(400).json({ error: "endpoint must be a string" });
    return;
  }

  if (typeof endpoint === "string" && endpoint.length > 0) {
    await db
      .delete(pushSubscriptionsTable)
      .where(and(eq(pushSubscriptionsTable.userId, userId), eq(pushSubscriptionsTable.endpoint, endpoint)));
  } else {
    await db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.userId, userId));
  }

  const remaining = await db
    .select({ id: pushSubscriptionsTable.id })
    .from(pushSubscriptionsTable)
    .where(eq(pushSubscriptionsTable.userId, userId));
  if (remaining.length === 0) {
    await db.update(profileTable).set({ pushOptIn: false }).where(eq(profileTable.userId, userId));
  }
  logger.info({ userId, remaining: remaining.length }, "push: unsubscribed");
  res.json({ ok: true, remaining: remaining.length });
});

// ─── POST /push/test ──────────────────────────────────────────────────────────

router.post("/push/test", async (req, res): Promise<void> => {
  const userId = req.userId;
  const outcome = await sendPushToUser(userId, "test", {
    title: "Eos",
    body: "Notifications are on. I'll keep them rare and kind — a chapter, a morning note, nothing more.",
    url: "/",
  });
  res.json({ outcome });
});

export default router;

// ─── Internal machine endpoint (mounted BEFORE auth) ──────────────────────────

function hourStamp(d: Date): string {
  return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

export function pushRunToken(secret: string, d: Date): string {
  return crypto.createHmac("sha256", secret).update(`push-morning:${hourStamp(d)}`).digest("hex");
}

function tokenMatches(provided: string, secret: string, now: Date): boolean {
  const candidates = [pushRunToken(secret, now), pushRunToken(secret, new Date(now.getTime() - 3600_000))];
  const providedBuf = Buffer.from(provided);
  for (const c of candidates) {
    const candidateBuf = Buffer.from(c);
    if (providedBuf.length === candidateBuf.length && crypto.timingSafeEqual(providedBuf, candidateBuf)) return true;
  }
  return false;
}

const internalRouter: IRouter = Router();

internalRouter.post("/internal/push/morning-run", async (req, res): Promise<void> => {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    res.status(500).json({ error: "Server not configured" });
    return;
  }
  const provided = (req.headers["x-internal-token"] ?? "").toString();
  if (!provided || !tokenMatches(provided, secret, new Date())) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const result = await runMorningPushSweep();
  logger.info(result, "push: morning sweep complete");
  res.json(result);
});

export { internalRouter as pushInternalRouter };
