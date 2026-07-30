// ─── crisis_events persistence helpers ───────────────────────────────────────
// Event rows record that the crisis floor fired — pattern name + country
// served, never content. Shared by the chat route (message-linked events), the
// voice route (message-less events; the on-call overlay polls them), and the
// two dismiss endpoints.

import { and, eq, gte, sql, desc } from "drizzle-orm";
import { db, crisisEventsTable, messagesTable } from "@workspace/db";
import { logger } from "../../lib/logger.js";

/** Dismissals inside this rolling window count toward the review flag. */
export const DISMISSAL_REVIEW_WINDOW_DAYS = 7;
/** This many dismissals inside the window logs a review flag. */
export const DISMISSAL_REVIEW_THRESHOLD = 3;

// Voice: ElevenLabs fires several completion requests per spoken turn (rolling
// ASR finals, interruption regenerations), so the same sentence can be
// detected more than once. Collapse repeats of the same pattern within this
// window into one event so the log stays honest.
const VOICE_EVENT_DEDUP_MS = 45_000;

export async function recordChatCrisisEvent(args: {
  userId: number;
  messageId: number;
  patternMatched: string;
  countryServed: string;
}): Promise<void> {
  await db.insert(crisisEventsTable).values({ ...args, source: "chat" });
}

/** Fire-and-forget-safe; dedups repeated detections of one spoken turn. */
export async function recordVoiceCrisisEvent(args: {
  userId: number;
  patternMatched: string;
  countryServed: string;
}): Promise<void> {
  const since = new Date(Date.now() - VOICE_EVENT_DEDUP_MS);
  const recent = await db
    .select({ id: crisisEventsTable.id })
    .from(crisisEventsTable)
    .where(
      and(
        eq(crisisEventsTable.userId, args.userId),
        eq(crisisEventsTable.source, "voice"),
        eq(crisisEventsTable.patternMatched, args.patternMatched),
        gte(crisisEventsTable.detectedAt, since),
      ),
    )
    .limit(1);
  if (recent.length > 0) return;
  await db.insert(crisisEventsTable).values({ ...args, source: "voice" });
}

/** Newest undismissed VOICE event in the recent window — what the on-call
 *  overlay should be showing right now (null = nothing to show). */
export async function pendingVoiceCrisisEvent(
  userId: number,
  windowMs = 15 * 60 * 1000,
): Promise<{ id: number; countryServed: string; detectedAt: Date } | null> {
  const since = new Date(Date.now() - windowMs);
  const [row] = await db
    .select({
      id: crisisEventsTable.id,
      countryServed: crisisEventsTable.countryServed,
      detectedAt: crisisEventsTable.detectedAt,
    })
    .from(crisisEventsTable)
    .where(
      and(
        eq(crisisEventsTable.userId, userId),
        eq(crisisEventsTable.source, "voice"),
        eq(crisisEventsTable.blockDismissed, false),
        gte(crisisEventsTable.detectedAt, since),
      ),
    )
    .orderBy(desc(crisisEventsTable.detectedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Count dismissals in the rolling review window and log the review flag when
 * the threshold is met. Returns whether this call crossed/holds the flag so
 * routes can surface it (and tests can assert it).
 */
export async function checkDismissalReviewFlag(userId: number): Promise<boolean> {
  const since = new Date(Date.now() - DISMISSAL_REVIEW_WINDOW_DAYS * 24 * 3600 * 1000);
  const [row] = await db
    .select({ count: sql<string>`count(*)` })
    .from(crisisEventsTable)
    .where(
      and(
        eq(crisisEventsTable.userId, userId),
        eq(crisisEventsTable.blockDismissed, true),
        gte(crisisEventsTable.dismissedAt, since),
      ),
    );
  const dismissals = Number(row?.count ?? "0");
  if (dismissals >= DISMISSAL_REVIEW_THRESHOLD) {
    // Review flag: repeated dismissal of crisis resources is a signal a human
    // should look at supportively — it is NEVER an enforcement action.
    logger.warn(
      { userId, dismissals, windowDays: DISMISSAL_REVIEW_WINDOW_DAYS },
      "crisis_review_flag: user dismissed multiple crisis helpline cards in the review window",
    );
    return true;
  }
  return false;
}

/**
 * Dismiss the helpline card attached to one chat message. Ownership-checked.
 * Returns null when the message isn't the user's; otherwise whether the
 * review flag fired.
 */
export async function dismissChatCrisisBlock(
  userId: number,
  messageId: number,
): Promise<{ reviewFlagged: boolean } | null> {
  const updated = await db
    .update(messagesTable)
    .set({ crisisBlockDismissed: true })
    .where(and(eq(messagesTable.id, messageId), eq(messagesTable.userId, userId)))
    .returning({ id: messagesTable.id });
  if (updated.length === 0) return null;

  await db
    .update(crisisEventsTable)
    .set({ blockDismissed: true, dismissedAt: new Date() })
    .where(and(eq(crisisEventsTable.userId, userId), eq(crisisEventsTable.messageId, messageId)));

  return { reviewFlagged: await checkDismissalReviewFlag(userId) };
}

/** Dismiss a voice-overlay card by event id. Ownership-checked. */
export async function dismissVoiceCrisisEvent(
  userId: number,
  eventId: number,
): Promise<{ reviewFlagged: boolean } | null> {
  const updated = await db
    .update(crisisEventsTable)
    .set({ blockDismissed: true, dismissedAt: new Date() })
    .where(and(eq(crisisEventsTable.id, eventId), eq(crisisEventsTable.userId, userId)))
    .returning({ id: crisisEventsTable.id });
  if (updated.length === 0) return null;
  return { reviewFlagged: await checkDismissalReviewFlag(userId) };
}
