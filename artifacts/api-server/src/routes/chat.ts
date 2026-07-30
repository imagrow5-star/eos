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
import { detectCrisis } from "../services/crisis/detector.js";
import { CRISIS_REINFORCEMENT_BLOCK } from "../services/crisis/reinforcement.js";
import { resolveHelplines, buildHelplineBlockText } from "../services/crisis/helplines.js";
import { recordChatCrisisEvent, dismissChatCrisisBlock } from "../services/crisis/events.js";

// ─── Crisis floor (chat path) ────────────────────────────────────────────────
// Deterministic, code-level guarantee that a crisis message gets helpline
// resources with the reply — independent of the LLM honoring the prompt-level
// safety instruction. Runs on the user's text BEFORE the reply is generated;
// on a match the reinforcement block joins the system prompt for THIS TURN
// ONLY and the localized helpline block is appended AFTER generation, so it
// arrives even if the model ignores every instruction (or is down entirely).

/** systemExtra for a chat turn: voice-fallback brevity + per-turn crisis
 *  reinforcement. Exported for tests (prompt presence/absence). */
export function composeChatSystemExtra(opts: {
  voiceMode: boolean;
  crisisDetected: boolean;
}): string | undefined {
  const parts = [
    opts.voiceMode ? buildVoiceCallAddendum(false) : "",
    opts.crisisDetected ? CRISIS_REINFORCEMENT_BLOCK : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

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

    // Crisis floor: detect BEFORE generation. The user's message is stored
    // normally (encrypted) either way — detection only shapes this reply.
    // Runs the user's language pattern set PLUS English (union).
    const userLanguage = (profile as { preferredLanguage?: string }).preferredLanguage ?? "en";
    const crisis = detectCrisis(content, userLanguage);

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
    const reply = await streamCompanionReply(
      systemPrompt,
      contextMessages,
      content,
      stage,
      (chunk) => sendEvent("delta", { text: chunk }),
      {
        // Classic voice engine has no ElevenLabs system tools — never include
        // the listening/skip_turn rules here.
        systemExtra: composeChatSystemExtra({ voiceMode, crisisDetected: crisis.matched }),
        callType: voiceMode ? "voice_fallback" : "chat",
      },
    );
    const aiContent = reply.text;

    // Crisis floor: append the localized helpline block AFTER generation —
    // deterministic, so it lands even on a degraded (provider-down) reply.
    // The block is part of the persisted message (history + exports show it);
    // the `done` event also carries it separately so the client renders it as
    // a distinct, dismissible card rather than Eos's own words.
    const resolved = crisis.matched ? resolveHelplines(profile.country) : null;
    const helplineBlockText = resolved ? buildHelplineBlockText(resolved.lines, userLanguage) : null;
    const persistedContent = helplineBlockText
      ? `${aiContent}\n\n${helplineBlockText}`
      : aiContent;

    // Persist assistant message (the honest degraded line is persisted too —
    // it IS what Eos said; the flag below is what tells the client apart).
    const [assistantMsg] = await db
      .insert(messagesTable)
      .values({ userId, role: "assistant", content: persistedContent, isMorningNote: false })
      .returning();

    if (crisis.matched && resolved && assistantMsg) {
      await recordChatCrisisEvent({
        userId,
        messageId: assistantMsg.id,
        patternMatched: crisis.pattern!,
        countryServed: resolved.countryServed,
      }).catch((err) => logger.error({ err, userId }, "crisis floor: recording chat event failed"));
    }

    sendEvent("done", {
      messageId: assistantMsg!.id,
      content: persistedContent,
      ...(helplineBlockText ? { crisisHelplineBlock: helplineBlockText } : {}),
      ...(reply.degraded ? { degraded: true } : {}),
    });
    res.end();

    // ── Background extractions — fire-and-forget after response is sent ─────
    // Shared pipeline (commitments, habits, periodic memory) — same one the
    // voice-call route uses, so text and voice feed the same systems.
    // Skipped entirely on a degraded reply: the provider is down (they would
    // only fail again, at cost) and the fallback line must never feed the
    // anti-repetition phrase list or the extraction pipeline.
    if (!reply.degraded) {
      (async () => {
        appendRecentPhrase(userId, aiContent).catch((err) =>
          logger.error({ err }, "Background phrase tracking failed"),
        );
        await runConversationExtractions(profile, content, aiContent);
      })().catch((err) => logger.error({ err }, "Background extraction wrapper failed"));
    }

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

  // Crisis floor: detect BEFORE generation (same guarantee as /chat/stream).
  const userLanguage = (profile as { preferredLanguage?: string }).preferredLanguage ?? "en";
  const crisis = detectCrisis(content, userLanguage);

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
  const reply = await getCompanionReply(systemPrompt, contextMessages, content, stage, {
    systemExtra: composeChatSystemExtra({ voiceMode: false, crisisDetected: crisis.matched }),
  });
  const aiContent = reply.text;

  // Anti-repetition + extraction only for REAL replies — a degraded fallback
  // must never feed the phrase list or fire more (failing, billable) AI calls.
  if (!reply.degraded) {
    appendRecentPhrase(userId, aiContent).catch((err) =>
      logger.error({ err }, "Phrase tracking failed"),
    );
  }

  // Crisis floor: deterministic helpline append after generation (works even
  // on a degraded reply — that is the point of a floor).
  const resolved = crisis.matched ? resolveHelplines(profile.country) : null;
  const helplineBlockText = resolved ? buildHelplineBlockText(resolved.lines, userLanguage) : null;
  const persistedContent = helplineBlockText ? `${aiContent}\n\n${helplineBlockText}` : aiContent;

  const [assistantMsg] = await db
    .insert(messagesTable)
    .values({ userId, role: "assistant", content: persistedContent, isMorningNote: false })
    .returning();

  if (crisis.matched && resolved && assistantMsg) {
    await recordChatCrisisEvent({
      userId,
      messageId: assistantMsg.id,
      patternMatched: crisis.pattern!,
      countryServed: resolved.countryServed,
    }).catch((err) => logger.error({ err, userId }, "crisis floor: recording chat event failed"));
  }

  // Shared background extraction dispatcher — the same path stream + voice
  // use, so commitments/habits/goals/memory behave identically on every chat
  // API (including goal dedup context, which this route used to skip).
  if (!reply.degraded) {
    runConversationExtractions(profile, content, aiContent).catch((err) =>
      logger.error({ err }, "Background extractions failed"),
    );
  }

  // Mirrors the dispatcher's own every-4th-user-message memory trigger.
  const memoryExtracted = !reply.degraded && userMsgCount % 4 === 0 && userMsgCount > 0;

  req.log.info({ userMsgCount, memoryExtracted, degraded: reply.degraded }, "Message sent");

  res.json(
    SendMessageResponse.parse({
      userMessage: userMsg,
      assistantMessage: assistantMsg,
      memoryExtracted,
      ...(helplineBlockText ? { crisisHelplineBlock: helplineBlockText } : {}),
      ...(reply.degraded ? { degraded: true } : {}),
    }),
  );
});

// ─── Crisis helpline card dismissal ──────────────────────────────────────────
// Dismisses the helpline card on ONE assistant message (the card stays part of
// the stored message text; only its rendering is hushed). Per-message: the
// card reappears on every future crisis turn. Repeated dismissals inside the
// rolling review window log a supportive review flag server-side.

router.post("/chat/messages/:id/crisis-dismiss", async (req, res): Promise<void> => {
  const userId = req.userId;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const result = await dismissChatCrisisBlock(userId, id);
  if (!result) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true, reviewFlagged: result.reviewFlagged });
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
