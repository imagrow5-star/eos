import { Router, type IRouter } from "express";
import { eq, desc, asc, sql, and } from "drizzle-orm";
import { db } from "@workspace/db";
import { messagesTable, profileTable, commitmentsTable, habitsTable, moodScoresTable, habitCompletionsTable, personalizationStateTable, storyThreadsTable, chapterQuoteDismissalsTable } from "@workspace/db";
import type { StoryRetelling } from "@workspace/db";
import {
  GetMessagesResponse,
  SendMessageBody,
  SendMessageResponse,
  GenerateMorningNoteResponse,
} from "@workspace/api-zod";
import { buildSystemPrompt } from "../services/systemPrompt.js";
import {
  streamCompanionReply,
  getCompanionReply,
  runConversationExtractions,
  generateMorningNoteContent,
  generateContextualGreeting,
  appendRecentPhrase,
  buildVoiceCallAddendum,
} from "../services/ai.js";
import { calculateStage, todayInTimezone, getTimeContext, describeCommitmentTiming } from "../services/stage.js";
import { getOrCreateProfileForUser } from "./profile.js";
import { chatUsageLimits } from "../middleware/usageLimits.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// zod's .message is a JSON dump of every issue — user-facing 400s should show
// the first issue's human-written message (see SendMessageBody's min/max copy).
function firstIssueMessage(error: { issues: Array<{ message: string }> }): string {
  return error.issues[0]?.message ?? "That message couldn't be sent — please try again.";
}

router.get("/chat/messages", async (req, res): Promise<void> => {
  const userId = req.userId;
  const messages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.userId, userId))
    .orderBy(asc(messagesTable.createdAt));

  res.json(GetMessagesResponse.parse(messages));
});

// ─── Forget this (Phase A privacy) ───────────────────────────────────────────
// Hard-deletes ONE message and scrubs everywhere its words could resurface:
//   • the messages row itself (which also removes it from the verbatim quote
//     pool future weekly chapters draw from — generation reads messages live)
//   • story_threads retellings that quote it verbatim (question text nulled,
//     summary/framing stay — they are neutral paraphrases, never quotes)
//   • chapter_quote_dismissals rows that reference it (housekeeping)
// One transaction — a message must never vanish while a thread still quotes
// it. Already-written chapters keep their wording (documented on /privacy).
router.delete("/chat/messages/:id", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const deleted = await tx
      .delete(messagesTable)
      .where(and(eq(messagesTable.id, id), eq(messagesTable.userId, userId)))
      .returning({ id: messagesTable.id });
    if (deleted.length === 0) return { ok: false };

    await tx
      .delete(chapterQuoteDismissalsTable)
      .where(
        and(
          eq(chapterQuoteDismissalsTable.userId, userId),
          eq(chapterQuoteDismissalsTable.messageId, id),
        ),
      );

    const threads = await tx
      .select()
      .from(storyThreadsTable)
      .where(eq(storyThreadsTable.userId, userId));
    for (const thread of threads) {
      const retellings = (thread.retellings ?? []) as StoryRetelling[];
      let touched = false;
      const scrubbed = retellings.map((r) => {
        if (r.questionMessageId === id) {
          touched = true;
          return { ...r, question: null, questionMessageId: null };
        }
        return r;
      });
      if (touched) {
        await tx
          .update(storyThreadsTable)
          .set({ retellings: scrubbed, updatedAt: new Date() })
          .where(eq(storyThreadsTable.id, thread.id));
      }
    }
    return { ok: true };
  });
  if (!result.ok) {
    res.status(404).json({ error: "not found" });
    return;
  }
  logger.info({ userId, messageId: id }, "Message forgotten on request");
  res.json({ ok: true });
});

// ─── Streaming chat endpoint ─────────────────────────────────────────────────
// Uses SSE to push tokens as they arrive from Anthropic.
// Events: delta { text }, done { messageId, content }, error { error }

router.post("/chat/stream", ...chatUsageLimits, async (req, res): Promise<void> => {
  const userId = req.userId;
  const parsed = SendMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssueMessage(parsed.error) });
    return;
  }

  const { content } = parsed.data;
  // Voice fallback mode: the client flags spoken turns so replies stay short
  // enough to listen to (the realtime path handles this in voice-llm.ts).
  const voiceMode = (req.body as { voice?: unknown } | undefined)?.voice === true;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (typeof (res as any).flush === "function") (res as any).flush();
  };

  try {
    const profile = await getOrCreateProfileForUser(userId);

    // Insert the user message and compute stage in parallel — system prompt
    // doesn't depend on the insert, so these two round-trips overlap.
    const [stage] = await Promise.all([
      calculateStage(profile),
      db.insert(messagesTable).values({ userId, role: "user", content, isMorningNote: false }),
    ]);

    // Build system prompt (stage already known — no redundant DB call inside)
    // and fetch the context window in parallel.
    const [systemPrompt, recentMessages] = await Promise.all([
      buildSystemPrompt(profile, stage),
      db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.userId, userId))
        .orderBy(desc(messagesTable.createdAt))
        .limit(21),
    ]);

    // Drop the just-inserted user message from context window
    const contextMessages = [...recentMessages].reverse().slice(0, -1);

    // ── Stream tokens to the client ─────────────────────────────────────────
    let aiContent = "";
    aiContent = await streamCompanionReply(
      systemPrompt,
      contextMessages,
      content,
      stage,
      (chunk) => sendEvent("delta", { text: chunk }),
      {
        // Classic voice engine has no ElevenLabs system tools — never include
        // the listening/skip_turn rules here.
        systemExtra: voiceMode ? buildVoiceCallAddendum(false) : undefined,
        callType: voiceMode ? "voice_fallback" : "chat",
      },
    );

    // Persist assistant message
    const [assistantMsg] = await db
      .insert(messagesTable)
      .values({ userId, role: "assistant", content: aiContent, isMorningNote: false })
      .returning();

    sendEvent("done", { messageId: assistantMsg!.id, content: aiContent });
    res.end();

    // ── Background extractions — fire-and-forget after response is sent ─────
    // Shared pipeline (commitments, habits, periodic memory) — same one the
    // voice-call route uses, so text and voice feed the same systems.
    (async () => {
      appendRecentPhrase(userId, aiContent).catch((err) =>
        logger.error({ err }, "Background phrase tracking failed"),
      );
      await runConversationExtractions(profile, content, aiContent);
    })().catch((err) => logger.error({ err }, "Background extraction wrapper failed"));

  } catch (err) {
    logger.error({ err }, "Chat stream error");
    try {
      sendEvent("error", { error: "Something went wrong. Please try again." });
      res.end();
    } catch {
      // Response may already be closed
    }
  }
});

router.post("/chat/send", ...chatUsageLimits, async (req, res): Promise<void> => {
  const userId = req.userId;
  const parsed = SendMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssueMessage(parsed.error) });
    return;
  }

  const { content } = parsed.data;
  const profile = await getOrCreateProfileForUser(userId);

  const [userMsg] = await db
    .insert(messagesTable)
    .values({ userId, role: "user", content, isMorningNote: false })
    .returning();

  const [countRow] = await db
    .select({ count: sql<string>`count(*)` })
    .from(messagesTable)
    .where(and(eq(messagesTable.userId, userId), eq(messagesTable.role, "user")));
  const userMsgCount = Number(countRow?.count ?? "0");

  const [systemPrompt, stage] = await Promise.all([
    buildSystemPrompt(profile),
    calculateStage(profile),
  ]);

  const recentMessages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.userId, userId))
    .orderBy(desc(messagesTable.createdAt))
    .limit(21);

  const contextMessages = recentMessages.reverse().slice(0, -1);
  const aiContent = await getCompanionReply(systemPrompt, contextMessages, content, stage);

  // Fire-and-forget phrase tracking (anti-repetition — non-blocking)
  appendRecentPhrase(userId, aiContent).catch((err) =>
    logger.error({ err }, "Phrase tracking failed"),
  );

  const [assistantMsg] = await db
    .insert(messagesTable)
    .values({ userId, role: "assistant", content: aiContent, isMorningNote: false })
    .returning();

  // Shared background extraction dispatcher — the same path stream + voice
  // use, so commitments/habits/goals/memory behave identically on every chat
  // API (including goal dedup context, which this route used to skip).
  runConversationExtractions(profile, content, aiContent).catch((err) =>
    logger.error({ err }, "Background extractions failed"),
  );

  // Mirrors the dispatcher's own every-4th-user-message memory trigger.
  const memoryExtracted = userMsgCount % 4 === 0 && userMsgCount > 0;

  req.log.info({ userMsgCount, memoryExtracted }, "Message sent");

  res.json(
    SendMessageResponse.parse({
      userMessage: userMsg,
      assistantMessage: assistantMsg,
      memoryExtracted,
    }),
  );
});

// ─── Contextual greeting (time-aware, slot-based proactive care) ─────────────
// Returns { message: MessageObject } or { message: null } when no greeting is
// needed right now (too recent, or it's midday and the user hasn't been absent).

function getGreetingSlot(partOfDay: string): "morning" | "evening" | "night" | null {
  switch (partOfDay) {
    case "early morning":
    case "morning":   return "morning";
    case "evening":   return "evening";
    case "night":     return "night";
    default:          return null; // afternoon — no proactive greeting unless absent
  }
}

router.post("/chat/contextual-greeting", async (req, res): Promise<void> => {
  const userId = req.userId;
  const profile = await getOrCreateProfileForUser(userId);
  const tz = (profile as any).timezone ?? "UTC";
  const timeCtx = getTimeContext(tz);
  const today = todayInTimezone(tz);

  const slot = getGreetingSlot(timeCtx.partOfDay);
  const rawTs = (profile as any).lastGreetingAt;
  const lastGreetingAt: Date | null = rawTs ? new Date(rawTs) : null;

  const hoursSinceLast = lastGreetingAt
    ? (Date.now() - lastGreetingAt.getTime()) / (1000 * 60 * 60)
    : 999;
  const daysSinceLast = hoursSinceLast / 24;

  const isAbsent   = daysSinceLast >= 2;
  const tooRecent  = hoursSinceLast < 6;

  // Too recent: suppress regardless of time
  if (tooRecent) { res.json({ message: null }); return; }
  // No natural slot (afternoon) and not a comeback after absence: suppress
  if (!slot && !isAbsent) { res.json({ message: null }); return; }

  const effectiveSlot = isAbsent ? "absent" : slot!;
  const stage = await calculateStage(profile);

  // Fetch greeting context in parallel
  const [pendingFollowUps, activeHabits, todayCompletions, recentMoods, greetingPersonalizationRows] = await Promise.all([
    // Commitments overdue for follow-up
    db.select({
      id: commitmentsTable.id,
      content: commitmentsTable.content,
      cue: commitmentsTable.cue,
      scheduledDate: commitmentsTable.scheduledDate,
      scheduledTime: commitmentsTable.scheduledTime,
    })
      .from(commitmentsTable)
      .where(and(
        eq(commitmentsTable.userId, userId),
        sql`${commitmentsTable.state} = 'open'`,
        sql`${commitmentsTable.scheduledFollowupDate} IS NOT NULL
            AND ${commitmentsTable.scheduledFollowupDate} <= ${today}`,
      ))
      .limit(2),
    db.select({ id: habitsTable.id, name: habitsTable.name, streak: habitsTable.streak })
      .from(habitsTable)
      .where(and(eq(habitsTable.userId, userId), eq(habitsTable.isActive, true))),
    db.select({ habitId: habitCompletionsTable.habitId })
      .from(habitCompletionsTable)
      .where(and(eq(habitCompletionsTable.userId, userId), eq(habitCompletionsTable.completedDate, today))),
    db.select({ score: moodScoresTable.score })
      .from(moodScoresTable)
      .where(eq(moodScoresTable.userId, userId))
      .orderBy(desc(moodScoresTable.createdAt))
      .limit(5),
    db.select({ recentPhrases: personalizationStateTable.recentPhrases })
      .from(personalizationStateTable)
      .where(eq(personalizationStateTable.userId, userId)),
  ]);

  const greetingRecentPhrases = greetingPersonalizationRows[0]?.recentPhrases ?? [];

  const completedToday = new Set(todayCompletions.map((c) => c.habitId));
  const habitsForGreeting = activeHabits.map((h) => ({
    name: h.name,
    streak: h.streak ?? 0,
    doneToday: completedToday.has(h.id),
  }));

  const avgMood = recentMoods.length > 0
    ? recentMoods.reduce((s, m) => s + m.score, 0) / recentMoods.length
    : null;
  const moodSummary = avgMood !== null
    ? avgMood >= 7 ? "doing well lately"
    : avgMood >= 5 ? "somewhere in the middle"
    : "going through a harder stretch"
    : null;

  const greetingContent = await generateContextualGreeting(profile, stage, {
    slot: effectiveSlot,
    absentDays: Math.round(daysSinceLast),
    pendingFollowUp: pendingFollowUps.map((c) => ({
      content: c.content,
      cue: c.cue ?? "",
      when: describeCommitmentTiming(c.scheduledDate, c.scheduledTime, (profile as any).timezone ?? "UTC"),
    })),
    habits: habitsForGreeting,
    moodSummary,
    recentPhrases: greetingRecentPhrases,
  });

  const [greetingMsg] = await db
    .insert(messagesTable)
    .values({ userId, role: "assistant", content: greetingContent, isMorningNote: true })
    .returning();

  // Update last-greeting timestamp (as any until lib/db is rebuilt)
  await db.update(profileTable)
    .set({ lastGreetingAt: new Date() } as any)
    .where(eq(profileTable.userId, userId));

  req.log.info({ slot: effectiveSlot }, "Contextual greeting generated");
  res.json({ message: greetingMsg });
});

router.post("/chat/morning-note", async (req, res): Promise<void> => {
  const userId = req.userId;
  const profile = await getOrCreateProfileForUser(userId);
  const today = todayInTimezone((profile as any).timezone ?? "UTC");

  if (profile.morningNoteDate === today) {
    const existing = await db
      .select()
      .from(messagesTable)
      .where(and(eq(messagesTable.userId, userId), eq(messagesTable.isMorningNote, true)))
      .orderBy(desc(messagesTable.createdAt))
      .limit(1);

    if (existing.length > 0) {
      res.json(GenerateMorningNoteResponse.parse(existing[0]));
      return;
    }
  }

  const stage = await calculateStage(profile);
  const noteContent = await generateMorningNoteContent(profile, stage);

  const [noteMsg] = await db
    .insert(messagesTable)
    .values({ userId, role: "assistant", content: noteContent, isMorningNote: true })
    .returning();

  await db
    .update(profileTable)
    .set({ morningNoteDate: today })
    .where(and(eq(profileTable.id, profile.id), eq(profileTable.userId, userId)));

  req.log.info("Morning note generated");
  res.json(GenerateMorningNoteResponse.parse(noteMsg));
});

export default router;
