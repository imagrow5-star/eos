import { Router, type IRouter } from "express";
import crypto from "crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  db,
  weeklyChaptersTable,
  chapterQuoteDismissalsTable,
  chapterOfferEventsTable,
  messagesTable,
  personalizationStateTable,
  sealedNotesTable,
  profileTable,
} from "@workspace/db";
import { createGoalWithTasks } from "../services/ai.js";
import { isCrisisText } from "../services/chapters/crisis.js";
import { crisisCareMessage, NOTE_MAX_LENGTH } from "../services/chapters/sealedNotes.js";
import { getCrisisLine } from "../services/systemPrompt.js";
import {
  runWeeklySweep,
  type ChapterTheme,
  type MicroOffer,
  type GoalReviewItem,
} from "../services/chapters/generate.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ─── GET /chapters — current chapter + archive + cold-start flags ─────────────

router.get("/chapters", async (req, res): Promise<void> => {
  const userId = req.userId;

  const [rows, firstMsgRows] = await Promise.all([
    db
      .select()
      .from(weeklyChaptersTable)
      .where(eq(weeklyChaptersTable.userId, userId))
      .orderBy(desc(weeklyChaptersTable.weekStart)),
    db
      .select({ createdAt: messagesTable.createdAt })
      .from(messagesTable)
      .where(and(eq(messagesTable.userId, userId), eq(messagesTable.role, "user")))
      .orderBy(asc(messagesTable.createdAt))
      .limit(1),
  ]);

  const firstAt = firstMsgRows[0]?.createdAt ?? null;
  const weeksTogether = firstAt
    ? Math.max(0, Math.floor((Date.now() - new Date(firstAt).getTime()) / (7 * 86_400_000)))
    : 0;

  const current = rows[0] ?? null;

  // Whether the reader already sealed a note on the current chapter — drives
  // the end-of-letter invite (one note per chapter, enforced by UNIQUE too).
  let noteSealed = false;
  if (current) {
    const [noteRow] = await db
      .select({ id: sealedNotesTable.id })
      .from(sealedNotesTable)
      .where(eq(sealedNotesTable.chapterId, current.id))
      .limit(1);
    noteSealed = !!noteRow;
  }

  res.json({
    coldStart: !current && weeksTogether < 3,
    weeksTogether,
    unread: current?.status === "ready",
    current: current ? { ...current, noteSealed } : null,
    archive: rows.slice(1).map((r) => ({
      id: r.id,
      weekStart: r.weekStart,
      weekEnd: r.weekEnd,
      status: r.status,
      generatedAt: r.generatedAt,
      revealedAt: r.revealedAt,
    })),
  });
});

// ─── GET /chapters/:id — full single chapter ──────────────────────────────────

router.get("/chapters/:id", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = parseInt(req.params.id ?? "0", 10);
  if (!id) {
    res.status(400).json({ error: "Invalid chapter id" });
    return;
  }
  const [chapter] = await db
    .select()
    .from(weeklyChaptersTable)
    .where(and(eq(weeklyChaptersTable.id, id), eq(weeklyChaptersTable.userId, userId)));
  if (!chapter) {
    res.status(404).json({ error: "Chapter not found" });
    return;
  }
  const [noteRow] = await db
    .select({ id: sealedNotesTable.id })
    .from(sealedNotesTable)
    .where(eq(sealedNotesTable.chapterId, chapter.id))
    .limit(1);
  res.json({ ...chapter, noteSealed: !!noteRow });
});

// ─── POST /chapters/:id/threshold — answer (or skip) the one-question gate ────
// The chapter never expires: answering/skipping just reveals it. Idempotent —
// once revealed, further calls return the chapter unchanged.

router.post("/chapters/:id/threshold", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = parseInt(req.params.id ?? "0", 10);
  if (!id) {
    res.status(400).json({ error: "Invalid chapter id" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const rawAnswer = typeof body.answer === "string" ? body.answer.trim().slice(0, 2000) : "";
  const skip = body.skip === true;

  const parseScale = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 10) return NaN as unknown as number;
    return n;
  };
  const mood = parseScale(body.mood);
  const loneliness = parseScale(body.loneliness);
  if (Number.isNaN(mood as number) || Number.isNaN(loneliness as number)) {
    res.status(400).json({ error: "mood and loneliness must be whole numbers from 1 to 10" });
    return;
  }

  const [chapter] = await db
    .select()
    .from(weeklyChaptersTable)
    .where(and(eq(weeklyChaptersTable.id, id), eq(weeklyChaptersTable.userId, userId)));
  if (!chapter) {
    res.status(404).json({ error: "Chapter not found" });
    return;
  }
  if (chapter.status === "revealed") {
    res.json(chapter);
    return;
  }

  const [updated] = await db
    .update(weeklyChaptersTable)
    .set({
      status: "revealed",
      revealedAt: new Date(),
      readAt: new Date(),
      thresholdAnswer: rawAnswer || null,
      thresholdMood: mood,
      thresholdLoneliness: loneliness,
      thresholdSkipped: skip && !rawAnswer,
    })
    .where(and(eq(weeklyChaptersTable.id, id), eq(weeklyChaptersTable.userId, userId)))
    .returning();

  res.json(updated);
});

// ─── POST /chapters/:id/note — seal one sentence for next-week's you ─────────
// Crisis language is checked IMMEDIATELY at write time: a flagged note still
// saves (their words are never rejected), but the response carries a caring
// message + crisis line for the UI to show right now — never a seven-day
// timer. Flagged notes are never quoted back at resolution time.

router.post("/chapters/:id/note", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = parseInt(req.params.id ?? "0", 10);
  if (!id) {
    res.status(400).json({ error: "Invalid chapter id" });
    return;
  }
  const body = (req.body ?? {}) as { kind?: unknown; text?: unknown };
  const kind = body.kind === "prediction" ? "prediction" : body.kind === "free" ? "free" : null;
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!kind) {
    res.status(400).json({ error: "kind must be 'free' or 'prediction'" });
    return;
  }
  if (text.length < 3 || text.length > NOTE_MAX_LENGTH) {
    res.status(400).json({ error: `Your note should be one sentence — up to ${NOTE_MAX_LENGTH} characters` });
    return;
  }

  const [chapter] = await db
    .select()
    .from(weeklyChaptersTable)
    .where(and(eq(weeklyChaptersTable.id, id), eq(weeklyChaptersTable.userId, userId)));
  if (!chapter) {
    res.status(404).json({ error: "Chapter not found" });
    return;
  }
  if (chapter.status !== "revealed") {
    res.status(409).json({ error: "Read the chapter before sealing a note" });
    return;
  }

  const crisisFlagged = isCrisisText(text);
  const notePrompt = kind === "prediction" ? ((chapter.noteInvite as { prompt?: string } | null)?.prompt ?? null) : null;

  let note: typeof sealedNotesTable.$inferSelect | undefined;
  try {
    [note] = await db
      .insert(sealedNotesTable)
      .values({ userId, chapterId: chapter.id, weekStart: chapter.weekStart, kind, prompt: notePrompt, text, crisisFlagged })
      .returning();
  } catch (err) {
    // UNIQUE(chapter_id) — one note per chapter (pg SQLSTATE sits at cause.code).
    if ((err as { cause?: { code?: string } })?.cause?.code === "23505") {
      res.status(409).json({ error: "A note is already sealed on this chapter" });
      return;
    }
    throw err;
  }

  let care: { message: string; crisisLine: string } | null = null;
  if (crisisFlagged) {
    const [prof] = await db
      .select({ userName: profileTable.userName, country: profileTable.country })
      .from(profileTable)
      .where(eq(profileTable.userId, userId));
    const line = getCrisisLine(prof?.country ?? "");
    care = { message: crisisCareMessage(prof?.userName ?? "", line), crisisLine: line };
    logger.warn({ userId, chapterId: id }, "sealed-note: crisis language at write time — caring response returned");
  }

  res.json({ note: { id: note!.id, kind: note!.kind, status: note!.status, createdAt: note!.createdAt }, care });
});

// ─── POST /chapters/:id/seal/defer — "keep it sealed another week" ────────────
// Un-resolves atomically: clears THIS chapter's sealResolution and returns the
// note to 'sealed', so next week's chapter picks it up again. The conditional
// UPDATE on the chapter row is the claim — double-clicks collapse to one defer.

router.post("/chapters/:id/seal/defer", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = parseInt(req.params.id ?? "0", 10);
  if (!id) {
    res.status(400).json({ error: "Invalid chapter id" });
    return;
  }

  const [chapter] = await db
    .select()
    .from(weeklyChaptersTable)
    .where(and(eq(weeklyChaptersTable.id, id), eq(weeklyChaptersTable.userId, userId)));
  if (!chapter) {
    res.status(404).json({ error: "Chapter not found" });
    return;
  }
  const seal = chapter.sealResolution as { noteId?: number } | null;
  if (!seal?.noteId) {
    res.status(409).json({ error: "This chapter has no sealed note to defer" });
    return;
  }
  const noteId = seal.noteId; // narrowed copy — the tx closure below can't see the guard

  // Chapter un-claim + note un-resolve move together or not at all: if the
  // note update can't land, the claim rolls back too, so the two rows can
  // never disagree about whether the resolution happened.
  const outcome = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(weeklyChaptersTable)
      .set({ sealResolution: null })
      .where(
        and(
          eq(weeklyChaptersTable.id, id),
          eq(weeklyChaptersTable.userId, userId),
          sql`${weeklyChaptersTable.sealResolution} IS NOT NULL`,
        ),
      )
      .returning({ id: weeklyChaptersTable.id });
    if (claimed.length === 0) return "already" as const;

    const reverted = await tx
      .update(sealedNotesTable)
      .set({ status: "sealed", resolvedChapterId: null, resolvedAt: null, deferrals: sql`${sealedNotesTable.deferrals} + 1` })
      .where(and(eq(sealedNotesTable.id, noteId), eq(sealedNotesTable.userId, userId)))
      .returning({ id: sealedNotesTable.id });
    if (reverted.length === 0) throw new Error(`sealed note ${noteId} missing during defer`);
    return "deferred" as const;
  });
  if (outcome === "already") {
    res.status(409).json({ error: "Already kept sealed" });
    return;
  }

  logger.info({ userId, chapterId: id, noteId: seal.noteId }, "sealed-note: deferred another week");
  res.json({ ok: true });
});

// ─── POST /chapters/:id/quotes/dismiss — one-tap permanent dismissal ──────────
// Stored forever (trains future selection: the engine excludes dismissed
// messageIds from every future candidate pool) and scrubbed from every stored
// chapter so the line never renders again.

router.post("/chapters/:id/quotes/dismiss", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = parseInt(req.params.id ?? "0", 10);
  const messageId = (req.body ?? {}).messageId;
  if (!id || !Number.isInteger(messageId) || messageId <= 0) {
    res.status(400).json({ error: "messageId is required" });
    return;
  }

  const [msg] = await db
    .select({ id: messagesTable.id })
    .from(messagesTable)
    .where(and(eq(messagesTable.id, messageId), eq(messagesTable.userId, userId)));
  if (!msg) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  await db
    .insert(chapterQuoteDismissalsTable)
    .values({ userId, messageId })
    .onConflictDoNothing();

  // Scrub the quote from ALL of this user's stored chapters.
  const chapters = await db
    .select()
    .from(weeklyChaptersTable)
    .where(eq(weeklyChaptersTable.userId, userId));

  for (const ch of chapters) {
    const themes = (ch.themes as ChapterTheme[] | null) ?? [];
    const offer = ch.microOffer as MicroOffer | null;
    const touchesThemes = themes.some((t) => t.quotes.some((q) => q.messageId === messageId));
    const touchesOffer = offer?.status === "pending" && offer.seedMessageId === messageId;
    if (!touchesThemes && !touchesOffer) continue;

    const scrubbed = themes
      .map((t) => ({ ...t, quotes: t.quotes.filter((q) => q.messageId !== messageId) }))
      .filter((t) => t.quotes.length > 0);

    await db
      .update(weeklyChaptersTable)
      .set({
        themes: scrubbed,
        ...(touchesOffer ? { microOffer: null } : {}),
      })
      .where(eq(weeklyChaptersTable.id, ch.id));
  }

  const [updated] = await db
    .select()
    .from(weeklyChaptersTable)
    .where(and(eq(weeklyChaptersTable.id, id), eq(weeklyChaptersTable.userId, userId)));
  res.json(updated ?? { ok: true });
});

// ─── POST /chapters/:id/offer — accept or decline the micro-goal offer ────────
// Accept hands off to the EXISTING goals system (createGoalWithTasks — same
// code path as conversational and form-created goals). Decline is honored
// silently for ~14 days (chapter_offer_events) and also nudges the existing
// chat-side offer cooldown so the companion doesn't re-offer in conversation
// right after a chapter decline.

router.post("/chapters/:id/offer", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = parseInt(req.params.id ?? "0", 10);
  const action = (req.body ?? {}).action;
  if (!id || (action !== "accept" && action !== "decline")) {
    res.status(400).json({ error: "action must be 'accept' or 'decline'" });
    return;
  }

  const [chapter] = await db
    .select()
    .from(weeklyChaptersTable)
    .where(and(eq(weeklyChaptersTable.id, id), eq(weeklyChaptersTable.userId, userId)));
  if (!chapter) {
    res.status(404).json({ error: "Chapter not found" });
    return;
  }
  const offer = chapter.microOffer as MicroOffer | null;
  if (!offer || offer.status !== "pending") {
    res.status(409).json({ error: "No pending offer on this chapter" });
    return;
  }

  // Atomic claim: the conditional update below only wins while the stored
  // offer is still 'pending', so two concurrent requests (double-tap, two
  // tabs) can't both act on the same offer — the loser gets a 409. A
  // concurrent quote-dismissal that nulls the offer also makes the claim fail.
  const claimOffer = async (updatedOffer: MicroOffer) => {
    const [claimed] = await db
      .update(weeklyChaptersTable)
      .set({ microOffer: updatedOffer })
      .where(
        and(
          eq(weeklyChaptersTable.id, id),
          eq(weeklyChaptersTable.userId, userId),
          sql`${weeklyChaptersTable.microOffer}->>'status' = 'pending'`,
        ),
      )
      .returning();
    return claimed;
  };

  if (action === "accept") {
    const claimed = await claimOffer({ ...offer, status: "accepted" });
    if (!claimed) {
      res.status(409).json({ error: "No pending offer on this chapter" });
      return;
    }
    const created = await createGoalWithTasks(userId, offer.goalTitle, offer.goalDescription, {
      dedupeActive: true,
    });
    if (!created) {
      // Hand the offer back so the user can retry instead of losing it.
      await db
        .update(weeklyChaptersTable)
        .set({ microOffer: offer })
        .where(and(eq(weeklyChaptersTable.id, id), eq(weeklyChaptersTable.userId, userId)));
      res.status(500).json({ error: "Failed to create goal" });
      return;
    }
    await db.insert(chapterOfferEventsTable).values({ userId, chapterId: id, action: "accepted" });
    logger.info({ userId, chapterId: id, goalId: created.goal.id }, "chapter offer accepted");
    res.json({ chapter: claimed, goal: { ...created.goal, tasks: created.tasks } });
    return;
  }

  // decline
  const updated = await claimOffer({ ...offer, status: "declined" });
  if (!updated) {
    res.status(409).json({ error: "No pending offer on this chapter" });
    return;
  }
  await db.insert(chapterOfferEventsTable).values({ userId, chapterId: id, action: "declined" });

  // Align the conversational offer cooldown (select-then-write, same pattern
  // as appendRecentPhrase — personalization_state may not have a row yet).
  try {
    const existing = await db
      .select({ userId: personalizationStateTable.userId })
      .from(personalizationStateTable)
      .where(eq(personalizationStateTable.userId, userId));
    if (existing.length > 0) {
      await db
        .update(personalizationStateTable)
        .set({ goalOfferDeclinedAt: new Date() })
        .where(eq(personalizationStateTable.userId, userId));
    } else {
      await db.insert(personalizationStateTable).values({ userId, goalOfferDeclinedAt: new Date() });
    }
  } catch (err) {
    logger.warn({ err, userId }, "chapter decline: could not sync goalOfferDeclinedAt");
  }

  logger.info({ userId, chapterId: id }, "chapter offer declined");
  res.json({ chapter: updated });
});

// ─── Internal machine endpoint (mounted BEFORE auth) ──────────────────────────
// Called hourly by the daily-email scheduled job. Authenticated by an
// HMAC token derived from SESSION_SECRET and the current UTC hour — same
// shared-secret style as the unsubscribe/voice-token links, no session needed.

function hourStamp(d: Date): string {
  return d.toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

export function chaptersRunToken(secret: string, d: Date): string {
  return crypto.createHmac("sha256", secret).update(`chapters-run:${hourStamp(d)}`).digest("hex");
}

function tokenMatches(provided: string, secret: string, now: Date): boolean {
  for (const d of [now, new Date(now.getTime() - 3_600_000)]) {
    const expected = chaptersRunToken(secret, d);
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

export const chaptersInternalRouter: IRouter = Router();

chaptersInternalRouter.post("/internal/chapters/run", async (req, res): Promise<void> => {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    res.status(500).json({ error: "SESSION_SECRET not configured" });
    return;
  }
  const token = req.header("x-internal-token") ?? "";
  if (!token || !tokenMatches(token, secret, new Date())) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const isProd = process.env.NODE_ENV === "production";
  const onlyUserId = Number.isInteger(body.userId) ? (body.userId as number) : undefined;
  // force/ignoreWindow are operator/testing affordances: force never in prod;
  // ignoreWindow in prod only when scoped to a single user. Reject explicitly
  // rather than silently ignoring, so a misconfigured caller finds out.
  if (body.force === true && isProd) {
    res.status(400).json({ error: "force is not allowed in production" });
    return;
  }
  if (body.ignoreWindow === true && isProd && onlyUserId === undefined) {
    res.status(400).json({ error: "ignoreWindow in production requires a userId scope" });
    return;
  }
  const force = body.force === true;
  const ignoreWindow = body.ignoreWindow === true;

  const result = await runWeeklySweep({ onlyUserId, force, ignoreWindow });
  logger.info(result, "chapter sweep finished");
  res.json(result);
});

export type { ChapterTheme, MicroOffer, GoalReviewItem };
export default router;
