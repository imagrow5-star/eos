// ─── Web push service ─────────────────────────────────────────────────────────
// Real web-push (VAPID) delivery with three hard product rules:
//   • opt-in only — profile.pushOptIn defaults to false and is only flipped by
//     the user's own subscribe/unsubscribe actions;
//   • HARD cap of 2 pushes per user per rolling 24h, enforced ATOMICALLY via a
//     conditional insert into push_events (concurrent senders can't blow past);
//   • chapter-ready is naturally ≤1/week (fires only on fresh chapter insert).
//
// VAPID keys: generated once per environment on first use and persisted in the
// single-row push_config table (id=1 + ON CONFLICT DO NOTHING makes generation
// race-safe). Dev and prod each get their own keypair — correct, since
// subscriptions are only valid against the keys they were created with.

import { and, eq, sql } from "drizzle-orm";
import {
  db,
  profileTable,
  usersTable,
  pushSubscriptionsTable,
  pushEventsTable,
} from "@workspace/db";
import { isNotNull } from "drizzle-orm";
import { logger } from "../lib/logger.js";

export const PUSH_DAILY_CAP = 2; // per user, rolling 24h, ALL kinds combined

// Transient delivery failures tolerated before a subscription is pruned.
// Bounded so a permanently-broken device can't sit behind an ON toggle
// forever, but wide enough that one flaky push-service day never unsubscribes
// anyone (with the 2/day cap this is ~2.5 days of consecutive failures).
export const MAX_CONSECUTIVE_FAILURES = 5;

export type PushKind = "chapter_ready" | "morning_note" | "test";

export interface PushPayload {
  title: string;
  body: string;
  url: string; // app path to open on tap, e.g. "/chapters"
}

// ─── web-push module (lazy + injectable for tests) ───────────────────────────

type WebPushSubscription = { endpoint: string; keys: { p256dh: string; auth: string } };
type WebPushLike = {
  generateVAPIDKeys: () => { publicKey: string; privateKey: string };
  setVapidDetails: (subject: string, publicKey: string, privateKey: string) => void;
  sendNotification: (sub: WebPushSubscription, payload: string, options?: Record<string, unknown>) => Promise<unknown>;
};

let _webpush: WebPushLike | null = null;
function getWebPush(): WebPushLike {
  if (!_webpush) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _webpush = require("web-push") as WebPushLike;
  }
  return _webpush;
}

/** Test hook — inject a mock transport. Pass null to restore the real module. */
export function _setWebPushForTests(mock: WebPushLike | null): void {
  _webpush = mock;
}

// ─── VAPID keys ───────────────────────────────────────────────────────────────

let _keys: { publicKey: string; privateKey: string } | null = null;

export async function ensureVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  if (_keys) return _keys;
  // Privacy (Phase A): VAPID signing keys live in environment secrets, NOT in
  // the database. Database access must never be enough to push notifications
  // to users' devices. Each environment (dev / prod) has its own pair.
  // Legacy note: keys used to live in the push_config table; that row is now
  // ignored (dev row removed; prod table dropped in a later cleanup pass).
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    throw new Error(
      "VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set for this environment. " +
        "Web push cannot start without them — add them as environment secrets.",
    );
  }
  _keys = { publicKey, privateKey };
  logger.info("push: VAPID keys ready (env)");
  return _keys;
}

/** Test hook — clear the in-process key cache. */
export function _clearVapidCacheForTests(): void {
  _keys = null;
}

export async function getVapidPublicKey(): Promise<string> {
  return (await ensureVapidKeys()).publicKey;
}

// ─── Rate cap (atomic) ────────────────────────────────────────────────────────

/**
 * Claims one send slot for the user. Returns false when the cap is spent.
 *
 * A conditional INSERT alone is NOT safe here: under READ COMMITTED each
 * racing statement's snapshot misses the others' uncommitted rows, so N
 * concurrent sends could all pass the count check. A per-user advisory
 * xact-lock serializes claimers; the lock releases at commit, so the next
 * claimer's count subquery (fresh snapshot) sees the prior committed row.
 */
async function claimSendSlot(userId: number, kind: PushKind): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`push-cap-${userId}`}))`);
    // morning_note additionally claims the once-per-day slot HERE, inside the
    // lock — the sweep's pre-check is only a cheap skip, so racing sweeps
    // must be stopped by the claim itself, not by check-then-send.
    const morningDedup =
      kind === "morning_note"
        ? sql` AND NOT EXISTS (
            SELECT 1 FROM push_events
            WHERE user_id = ${userId} AND kind = 'morning_note' AND sent_at > now() - interval '20 hours'
          )`
        : sql``;
    const res = await tx.execute(sql`
      INSERT INTO push_events (user_id, kind)
      SELECT ${userId}, ${kind}
      WHERE (
        SELECT COUNT(*) FROM push_events
        WHERE user_id = ${userId} AND sent_at > now() - interval '24 hours'
      ) < ${PUSH_DAILY_CAP}${morningDedup}
      RETURNING id
    `);
    return (res.rows?.length ?? 0) > 0;
  });
}

// ─── Sending ──────────────────────────────────────────────────────────────────

export type SendOutcome = "sent" | "opted_out" | "no_subscriptions" | "capped" | "all_failed";

export async function sendPushToUser(userId: number, kind: PushKind, payload: PushPayload): Promise<SendOutcome> {
  const [prof] = await db
    .select({ pushOptIn: profileTable.pushOptIn })
    .from(profileTable)
    .where(eq(profileTable.userId, userId));
  if (!prof?.pushOptIn) return "opted_out";

  const subs = await db
    .select()
    .from(pushSubscriptionsTable)
    .where(eq(pushSubscriptionsTable.userId, userId));
  if (subs.length === 0) return "no_subscriptions";

  if (!(await claimSendSlot(userId, kind))) {
    logger.info({ userId, kind }, "push: daily cap reached — skipped");
    return "capped";
  }

  const keys = await ensureVapidKeys();
  const wp = getWebPush();
  wp.setVapidDetails("mailto:hello@eoscompanion.com", keys.publicKey, keys.privateKey);
  const body = JSON.stringify({ title: payload.title, body: payload.body, url: payload.url, kind });

  let delivered = 0;
  for (const sub of subs) {
    try {
      await wp.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, body, { TTL: 12 * 3600 });
      delivered++;
      await db.update(pushSubscriptionsTable).set({ lastSuccessAt: new Date(), failureCount: 0 }).where(eq(pushSubscriptionsTable.id, sub.id));
    } catch (err) {
      const statusCode = (err as { statusCode?: number })?.statusCode;
      // Guard every prune/update with the credentials we actually failed to
      // deliver to. If the device re-subscribed mid-send, the row now holds
      // FRESH p256dh/auth under the same id — a stale-snapshot delete must
      // not kill it.
      const sameRowWeFailed = and(
        eq(pushSubscriptionsTable.id, sub.id),
        eq(pushSubscriptionsTable.p256dh, sub.p256dh),
        eq(pushSubscriptionsTable.auth, sub.auth),
      );
      if (statusCode === 404 || statusCode === 410) {
        // Subscription is gone (browser revoked / app uninstalled) — prune it.
        await db.delete(pushSubscriptionsTable).where(sameRowWeFailed);
        logger.info({ userId, subId: sub.id, statusCode }, "push: pruned dead subscription");
      } else if (statusCode === 403) {
        // Signature rejected — this subscription was created under a
        // DIFFERENT VAPID keypair (key rotation) and can never succeed under
        // the current one. Prune it; the client re-subscribes under the new
        // key next time the user enables the toggle. (401 is NOT pruned here:
        // push services also return it for transient JWT problems like clock
        // skew — those fall through to the bounded-retry path below.)
        await db.delete(pushSubscriptionsTable).where(sameRowWeFailed);
        logger.info({ userId, subId: sub.id, statusCode }, "push: pruned key-mismatch subscription");
      } else {
        // Transient (5xx, network, 401 skew): bounded retry. SQL-side
        // increment so concurrent senders can't lose counts; prune once the
        // ceiling is hit so a permanently-broken subscription can't linger
        // as an invisible ON toggle forever.
        const [updated] = await db
          .update(pushSubscriptionsTable)
          .set({ failureCount: sql`${pushSubscriptionsTable.failureCount} + 1` })
          .where(sameRowWeFailed)
          .returning({ failureCount: pushSubscriptionsTable.failureCount });
        logger.warn({ err, userId, subId: sub.id, statusCode }, "push: delivery failed");
        if (updated && updated.failureCount >= MAX_CONSECUTIVE_FAILURES) {
          await db.delete(pushSubscriptionsTable).where(sameRowWeFailed);
          logger.info(
            { userId, subId: sub.id, failures: updated.failureCount },
            "push: pruned persistently-failing subscription",
          );
        }
      }
    }
  }

  if (delivered === 0) {
    // If every device is gone (revoked, uninstalled, or invalidated by a key
    // rotation), reflect reality in the profile so the Settings toggle shows
    // OFF and the user can simply re-enable — mirrors the unsubscribe route's
    // "remaining === 0" rule. Single statement with NOT EXISTS: a concurrent
    // re-subscribe either already inserted its row (we skip) or will set
    // pushOptIn = true after we run (their write wins) — no separate
    // check-then-update window that could strand a fresh opt-in at false.
    const reset = await db.execute(sql`
      UPDATE profile SET push_opt_in = false
      WHERE user_id = ${userId} AND push_opt_in = true
        AND NOT EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id = ${userId})
      RETURNING user_id
    `);
    if ((reset.rows?.length ?? 0) > 0) {
      logger.info({ userId }, "push: no devices remain — opt-in reset");
    }
  }
  return delivered > 0 ? "sent" : "all_failed";
}

// ─── Morning-note nudge sweep (called hourly via internal endpoint) ───────────

function localHour(tz: string, d: Date): number {
  try {
    return parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(d), 10) % 24;
  } catch {
    return d.getUTCHours();
  }
}

const MORNING_LINES = [
  "There's a morning note waiting for you.",
  "I left you a few words for this morning.",
  "Your morning note is ready when you are.",
];

export interface MorningSweepResult {
  considered: number;
  sent: number;
  skipped: Record<string, number>;
}

/**
 * Sends the morning-note nudge to opted-in users whose local clock is inside
 * the 6–9 AM window and who haven't received one in the last 20 hours.
 * Mirrors the daily-email window so app note + email + push feel like one
 * morning ritual, not three systems.
 */
export async function runMorningPushSweep(now: Date = new Date()): Promise<MorningSweepResult> {
  const users = await db
    .select({ userId: profileTable.userId, timezone: profileTable.timezone, userName: profileTable.userName })
    .from(profileTable)
    .innerJoin(usersTable, eq(usersTable.id, profileTable.userId))
    .where(and(isNotNull(usersTable.emailVerifiedAt), eq(profileTable.isOnboardingComplete, true), eq(profileTable.pushOptIn, true)));

  const result: MorningSweepResult = { considered: 0, sent: 0, skipped: {} };
  for (const u of users) {
    if (!u.userId) continue;
    const hour = localHour(u.timezone || "UTC", now);
    if (hour < 6 || hour > 9) continue;
    result.considered++;

    // Once per day: skip if a morning_note push went out in the last 20h.
    // Advisory only — the authoritative, race-proof gate is the NOT EXISTS
    // clause inside claimSendSlot's locked transaction.
    const recent = await db.execute(sql`
      SELECT 1 FROM push_events
      WHERE user_id = ${u.userId} AND kind = 'morning_note' AND sent_at > now() - interval '20 hours'
      LIMIT 1
    `);
    if ((recent.rows?.length ?? 0) > 0) {
      result.skipped.already_sent = (result.skipped.already_sent ?? 0) + 1;
      continue;
    }

    const line = MORNING_LINES[(u.userId + now.getUTCDate()) % MORNING_LINES.length]!;
    const outcome = await sendPushToUser(u.userId, "morning_note", { title: "Eos", body: line, url: "/" });
    if (outcome === "sent") result.sent++;
    else result.skipped[outcome] = (result.skipped[outcome] ?? 0) + 1;
  }
  return result;
}
