/**
 * Voice-minute metering (phase 3).
 *
 * MEASUREMENT is always on: every voice call gets a voice_usage row at
 * session start, a provisional "last activity" timestamp on every spoken
 * turn, and a close (client beacon, or the abandoned-call sweeper). One
 * structured `voice_usage_closed` log line per closed call feeds tier-sizing
 * decisions during the free period.
 *
 * ENFORCEMENT is dormant: the call-start gate and the 75%/90% warnings run
 * ONLY when VOICE_CAPS_ENFORCED=true (default off — nobody is ever blocked
 * until launch day flips the flag). Two invariants hold even flag-on:
 *   - a call in progress is NEVER ended by the meter (gate at start only);
 *   - a user in crisis is NEVER paywalled (crisis bypass below).
 */

import { and, eq, gte, isNull, lt, sql, desc } from "drizzle-orm";
import {
  db,
  voiceUsageTable,
  subscriptionsTable,
  personalizationStateTable,
  messagesTable,
  sealedNotesTable,
} from "@workspace/db";
import { TIERS, type UserTierResult } from "./tiers.js";
import { isCrisisText } from "./chapters/crisis.js";
import { logger } from "../lib/logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hard per-call maximum — matches the guardrail sizing (2400 turns/day ≈ 4h
 * of calling, but a SINGLE call beyond an hour is not a realistic session and
 * is almost always an abandoned tab). The sweeper closes rows at this age;
 * durations are clamped to it. The live call itself is never touched. */
export const MAX_CALL_SECONDS = 60 * 60;

/** A session that produced no spoken turn and no beacon (e.g. an unused
 * hover-prefetch or a connect that never completed) is closed at this token
 * duration rather than the sweep maximum. */
export const NO_ACTIVITY_GRACE_SECONDS = 60;

/** Trial allowance: 30 total voice minutes across the 7-day trial —
 * enough to fall in love with the voice, not enough to consume a month's
 * allowance and cancel. */
export const TRIAL_ALLOWANCE_MINUTES = 30;

export const WARN_THRESHOLDS = [75, 90] as const;

export function isVoiceCapsEnforced(): boolean {
  return process.env.VOICE_CAPS_ENFORCED === "true";
}

// ─── Row lifecycle ────────────────────────────────────────────────────────────

/** Opens a usage row at session issuance. Returns its id (the client's
 * call-ended beacon references it). */
export async function startVoiceUsage(userId: number): Promise<number> {
  const [row] = await db
    .insert(voiceUsageTable)
    .values({ userId, callStartedAt: new Date(), source: "client_report" })
    .returning({ id: voiceUsageTable.id });
  return row!.id;
}

/** Marks live activity on the user's open call(s): call_ended_at becomes a
 * rolling provisional end, so a lost beacon costs the user nothing beyond
 * their last spoken turn. Fire-and-forget cheap (one UPDATE per turn). */
export async function noteVoiceActivity(userId: number): Promise<void> {
  await db
    .update(voiceUsageTable)
    .set({ callEndedAt: new Date() })
    .where(and(eq(voiceUsageTable.userId, userId), isNull(voiceUsageTable.durationSeconds)));
}

function clampDuration(seconds: number): number {
  return Math.max(0, Math.min(MAX_CALL_SECONDS, Math.round(seconds)));
}

export interface CloseResult {
  closed: boolean;
  durationSeconds: number | null;
}

/**
 * Closes ONE open row (idempotent — a second close is a no-op) and runs the
 * post-close bookkeeping: observability line + threshold warnings (flag-on).
 */
export async function closeVoiceUsage(
  usageId: number,
  userId: number,
  source: "client_report" | "sweeper",
  endAt: Date = new Date(),
): Promise<CloseResult> {
  const [row] = await db
    .select()
    .from(voiceUsageTable)
    .where(and(eq(voiceUsageTable.id, usageId), eq(voiceUsageTable.userId, userId)))
    .limit(1);
  if (!row) return { closed: false, durationSeconds: null };
  if (row.durationSeconds !== null) return { closed: false, durationSeconds: row.durationSeconds };

  const duration = clampDuration((endAt.getTime() - row.callStartedAt.getTime()) / 1000);
  // Atomic claim: only the FIRST closer wins (duration IS NULL guard), so a
  // beacon racing the sweeper can't double-close.
  const updated = await db
    .update(voiceUsageTable)
    .set({ callEndedAt: endAt, durationSeconds: duration, source })
    .where(and(eq(voiceUsageTable.id, usageId), isNull(voiceUsageTable.durationSeconds)))
    .returning({ id: voiceUsageTable.id });
  if (updated.length === 0) return { closed: false, durationSeconds: null };

  // Measure AFTER the claim: while the row was open, getMonthlyVoiceUsage
  // already counted its live elapsed time, so a before-close measurement
  // would double-count this call and hide the very threshold crossing it
  // caused. After the claim the row contributes exactly `duration`.
  const after = await getMonthlyVoiceUsage(userId);
  const usedBefore = Math.max(0, after.usedSeconds - duration);
  await afterCallClosed(userId, duration, usedBefore, source);
  return { closed: true, durationSeconds: duration };
}

/**
 * Closes rows still open past MAX_CALL_SECONDS. End time = the last recorded
 * activity when we have one, else start + a small grace — never "the full
 * hour" for a call we have no evidence ran that long. Runs on an interval
 * from app.ts; safe to run concurrently (same duration-IS-NULL claim).
 */
export async function sweepAbandonedVoiceCalls(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - MAX_CALL_SECONDS * 1000);
  const stale = await db
    .select()
    .from(voiceUsageTable)
    .where(and(isNull(voiceUsageTable.durationSeconds), lt(voiceUsageTable.callStartedAt, cutoff)));

  let closed = 0;
  for (const row of stale) {
    const lastEvidence =
      row.callEndedAt ?? new Date(row.callStartedAt.getTime() + NO_ACTIVITY_GRACE_SECONDS * 1000);
    const result = await closeVoiceUsage(row.id, row.userId, "sweeper", lastEvidence);
    if (result.closed) closed++;
  }
  if (closed > 0) logger.info({ closed }, "voice-metering: sweeper closed abandoned call rows");
  return closed;
}

// ─── Monthly aggregation ──────────────────────────────────────────────────────

export interface MonthlyVoiceUsage {
  usedSeconds: number;
  windowStart: Date;
  /** When the allowance refreshes — shown to users as the reset date. */
  windowEnd: Date;
}

function calendarMonthWindow(now: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * The user's current billing window: anchored to the subscription's current
 * period when one exists and is current, else the calendar month (UTC).
 */
export async function getUsageWindow(userId: number, now: Date = new Date()): Promise<{ start: Date; end: Date }> {
  const [sub] = await db
    .select({
      currentPeriodEndsAt: subscriptionsTable.currentPeriodEndsAt,
      createdAt: subscriptionsTable.createdAt,
    })
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  const end = sub?.currentPeriodEndsAt;
  if (end && end.getTime() > now.getTime()) {
    // Period start = one month before its end (Paddle bills monthly), never
    // earlier than the subscription itself.
    const start = new Date(end);
    start.setUTCMonth(start.getUTCMonth() - 1);
    const floor = sub.createdAt;
    return { start: start.getTime() < floor.getTime() ? floor : start, end };
  }
  const cal = calendarMonthWindow(now);
  return cal;
}

/**
 * Seconds of voice used in the current billing window — closed calls PLUS the
 * live elapsed time of any open call, so one marathon call can't dodge the
 * meter. Each open call's contribution is clamped to the per-call maximum.
 */
export async function getMonthlyVoiceUsage(
  userId: number,
  now: Date = new Date(),
): Promise<MonthlyVoiceUsage> {
  const { start, end } = await getUsageWindow(userId, now);

  const [closedRow] = await db
    .select({ total: sql<string>`COALESCE(SUM(${voiceUsageTable.durationSeconds}), 0)` })
    .from(voiceUsageTable)
    .where(
      and(
        eq(voiceUsageTable.userId, userId),
        gte(voiceUsageTable.callStartedAt, start),
        lt(voiceUsageTable.callStartedAt, end),
      ),
    );

  const openRows = await db
    .select({ callStartedAt: voiceUsageTable.callStartedAt })
    .from(voiceUsageTable)
    .where(
      and(
        eq(voiceUsageTable.userId, userId),
        isNull(voiceUsageTable.durationSeconds),
        gte(voiceUsageTable.callStartedAt, start),
        lt(voiceUsageTable.callStartedAt, end),
      ),
    );
  const openSeconds = openRows.reduce(
    (sum, r) => sum + clampDuration((now.getTime() - r.callStartedAt.getTime()) / 1000),
    0,
  );

  return {
    usedSeconds: Number(closedRow?.total ?? 0) + openSeconds,
    windowStart: start,
    windowEnd: end,
  };
}

// ─── The gate (flag-on only) ──────────────────────────────────────────────────

/** The minute cap that applies to this entitlement, or null = unlimited. */
export function capMinutesFor(entitlements: UserTierResult): number | null {
  if (entitlements.kind === "legacy_full_access") return null;
  if (entitlements.status === "trialing") return TRIAL_ALLOWANCE_MINUTES;
  return TIERS[entitlements.tier].voiceMinutesPerMonth;
}

/**
 * Crisis bypass: a user whose recent context carries crisis language is
 * NEVER paywalled. Signals checked (both app-code checks — the crisis flag
 * is encrypted at rest by design and cannot be SQL-filtered):
 *   - any of their last 10 user messages within 48h matches the crisis
 *     screen (services/chapters/crisis.ts);
 *   - any sealed note from the last 14 days is crisis-flagged.
 */
export async function shouldBypassVoiceCap(userId: number): Promise<boolean> {
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const recentMessages = await db
    .select({ content: messagesTable.content, role: messagesTable.role })
    .from(messagesTable)
    .where(and(eq(messagesTable.userId, userId), gte(messagesTable.createdAt, twoDaysAgo)))
    .orderBy(desc(messagesTable.createdAt))
    .limit(20);
  if (
    recentMessages.some((m) => m.role === "user" && isCrisisText(m.content))
  ) {
    return true;
  }

  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const recentNotes = await db
    .select({ crisisFlagged: sealedNotesTable.crisisFlagged })
    .from(sealedNotesTable)
    .where(and(eq(sealedNotesTable.userId, userId), gte(sealedNotesTable.createdAt, twoWeeksAgo)))
    .orderBy(desc(sealedNotesTable.createdAt))
    .limit(5);
  return recentNotes.some((n) => n.crisisFlagged === true);
}

export interface VoiceGateResult {
  blocked: boolean;
  message?: string;
  resetAt?: Date;
  usedMinutes?: number;
  capMinutes?: number;
  crisisBypass?: boolean;
}

/**
 * Call-START gate. Flag-off or unlimited → never blocks. Blocking response
 * copy is warm and non-shaming, and always says text never stops.
 */
export async function evaluateVoiceGate(
  userId: number,
  entitlements: UserTierResult,
): Promise<VoiceGateResult> {
  if (!isVoiceCapsEnforced()) return { blocked: false };

  const capMinutes = capMinutesFor(entitlements);
  if (capMinutes === null) return { blocked: false };

  const usage = await getMonthlyVoiceUsage(userId);
  const usedMinutes = Math.floor(usage.usedSeconds / 60);
  if (usage.usedSeconds < capMinutes * 60) {
    return { blocked: false, usedMinutes, capMinutes };
  }

  if (await shouldBypassVoiceCap(userId)) {
    logger.warn({ userId }, "voice-metering: cap reached but CRISIS BYPASS applied — connecting");
    return { blocked: false, crisisBypass: true, usedMinutes, capMinutes };
  }

  const resetDate = usage.windowEnd.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
  });
  return {
    blocked: true,
    usedMinutes,
    capMinutes,
    resetAt: usage.windowEnd,
    message:
      `Her voice is resting until your minutes refresh on ${resetDate} — you've used this ` +
      `month's ${capMinutes} minutes together, which is nothing to apologize for. ` +
      `Text never stops: she's right here, reading every word.`,
  };
}

// ─── Warnings + observability (post-close) ────────────────────────────────────

async function afterCallClosed(
  userId: number,
  durationSeconds: number,
  usedSecondsBefore: number,
  source: string,
): Promise<void> {
  const enforced = isVoiceCapsEnforced();
  let tierLabel = "legacy_full_access";
  let capMinutes: number | null = null;
  try {
    const { getUserTier } = await import("./tiers.js");
    const tier = await getUserTier(userId);
    tierLabel = tier.kind === "subscribed" ? `${tier.tier}:${tier.status}` : tier.kind;
    capMinutes = capMinutesFor(tier);
  } catch {
    // observability must never fail a close
  }

  const usedSecondsAfter = usedSecondsBefore + durationSeconds;
  // THE tier-sizing dataset: one line per closed call — grep "voice_usage_closed".
  logger.info(
    {
      voiceUsage: {
        userId,
        seconds: durationSeconds,
        monthlySecondsAfter: usedSecondsAfter,
        tier: tierLabel,
        capMinutes,
        enforced,
        source,
      },
    },
    "voice_usage_closed",
  );

  if (!enforced || capMinutes === null) return;

  // First crossing of 75% / 90% this window → queue the gentle note for the
  // next app open (never mid-conversation: a call JUST ended, so now is by
  // definition not a calm moment — delivery happens via /chat/messages).
  const capSeconds = capMinutes * 60;
  for (const pct of WARN_THRESHOLDS) {
    const line = (capSeconds * pct) / 100;
    if (usedSecondsBefore < line && usedSecondsAfter >= line) {
      await recordThresholdCrossing(userId, pct);
    }
  }
}

async function recordThresholdCrossing(userId: number, pct: 75 | 90): Promise<void> {
  const markCol = pct === 75 ? "voiceNotice75At" : "voiceNotice90At";
  const [existing] = await db
    .select()
    .from(personalizationStateTable)
    .where(eq(personalizationStateTable.userId, userId))
    .limit(1);

  // Once per window: an existing mark inside the current window means the
  // note already fired; a mark from a previous window is stale and reusable.
  const { start } = await getUsageWindow(userId);
  const priorMark = existing?.[markCol] ?? null;
  if (priorMark && priorMark.getTime() >= start.getTime()) return;

  const set = {
    [markCol]: new Date(),
    voiceNoticePending: String(pct),
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(personalizationStateTable).set(set).where(eq(personalizationStateTable.userId, userId));
  } else {
    await db.insert(personalizationStateTable).values({ userId, ...set });
  }
  logger.info({ userId, pct }, "voice-metering: usage threshold crossed — note queued");
}

const NOTICE_COPY: Record<string, (resetDate: string) => string> = {
  "75": (resetDate) =>
    `A small heads-up, just between us — you've used about three-quarters of this month's voice time. ` +
    `No pressure at all: text with me never runs out, and your voice minutes refresh on ${resetDate}.`,
  "90": (resetDate) =>
    `Gentle note: your voice minutes for this month are nearly used — they refresh on ${resetDate}. ` +
    `Until then I'm right here in text, same as always, no limits.`,
};

/**
 * Delivers a queued voice notice as a quiet in-app note (the morning-note
 * surface) — called from GET /chat/messages, i.e. on app open. The pending
 * flag is claimed atomically so the note appears exactly once.
 */
export async function deliverPendingVoiceNotice(userId: number): Promise<boolean> {
  // Read the queued value, then claim it with an equality-guarded UPDATE —
  // two concurrent fetches can both read "75", but only one clears it (the
  // WHERE pins the exact value), so exactly one inserts the note.
  const [state] = await db
    .select({ pending: personalizationStateTable.voiceNoticePending })
    .from(personalizationStateTable)
    .where(eq(personalizationStateTable.userId, userId))
    .limit(1);
  const pct = state?.pending;
  if (pct !== "75" && pct !== "90") return false;

  const claimed = await db
    .update(personalizationStateTable)
    .set({ voiceNoticePending: null, updatedAt: new Date() })
    .where(
      and(
        eq(personalizationStateTable.userId, userId),
        eq(personalizationStateTable.voiceNoticePending, pct),
      ),
    )
    .returning({ userId: personalizationStateTable.userId });
  if (claimed.length === 0) return false; // someone else claimed it

  const { windowEnd } = await getMonthlyVoiceUsage(userId);
  const resetDate = windowEnd.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  await db.insert(messagesTable).values({
    userId,
    role: "assistant",
    content: NOTICE_COPY[pct]!(resetDate),
    isMorningNote: true, // renders with the quiet badge, not as a chat reply
  });
  logger.info({ userId, pct }, "voice-metering: usage note delivered on app open");
  return true;
}
