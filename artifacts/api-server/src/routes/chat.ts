import { Router, type IRouter } from "express";
import { eq, desc, asc, sql, and } from "drizzle-orm";
import { db } from "@workspace/db";
import { messagesTable, profileTable, commitmentsTable, habitsTable } from "@workspace/db";
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
  extractMemory,
  extractCommitments,
  detectHabitMentions,
  generateMorningNoteContent,
} from "../services/ai.js";
import { calculateStage, todayInTimezone } from "../services/stage.js";
import { getOrCreateProfileForUser } from "./profile.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

router.get("/chat/messages", async (req, res): Promise<void> => {
  const userId = req.userId;
  const messages = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.userId, userId))
    .orderBy(asc(messagesTable.createdAt));

  res.json(GetMessagesResponse.parse(messages));
});

// ─── Streaming chat endpoint ─────────────────────────────────────────────────
// Uses SSE to push tokens as they arrive from Anthropic.
// Events: delta { text }, done { messageId, content }, error { error }

router.post("/chat/stream", async (req, res): Promise<void> => {
  const userId = req.userId;
  const parsed = SendMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { content } = parsed.data;

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

    // Save user message (scoped to this user)
    await db.insert(messagesTable).values({ userId, role: "user", content, isMorningNote: false });

    // Count user messages for memory extraction trigger
    const [countRow] = await db
      .select({ count: sql<string>`count(*)` })
      .from(messagesTable)
      .where(and(eq(messagesTable.userId, userId), eq(messagesTable.role, "user")));
    const userMsgCount = Number(countRow?.count ?? "0");

    // Build system prompt, stage, and context window in parallel
    const [systemPrompt, stage, recentMessages] = await Promise.all([
      buildSystemPrompt(profile),
      calculateStage(profile),
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
    );

    // Persist assistant message
    const [assistantMsg] = await db
      .insert(messagesTable)
      .values({ userId, role: "assistant", content: aiContent, isMorningNote: false })
      .returning();

    sendEvent("done", { messageId: assistantMsg!.id, content: aiContent });
    req.log.info({ userMsgCount }, "Message streamed");
    res.end();

    // ── Background extractions — fire-and-forget after response is sent ─────
    (async () => {
      const [openCommitments, activeHabits] = await Promise.all([
        db
          .select({ id: commitmentsTable.id, content: commitmentsTable.content, cue: commitmentsTable.cue })
          .from(commitmentsTable)
          .where(and(sql`${commitmentsTable.state} = 'open'`, eq(commitmentsTable.userId, userId)))
          .limit(10),
        db
          .select({ id: habitsTable.id, name: habitsTable.name, whenThen: habitsTable.whenThen })
          .from(habitsTable)
          .where(and(eq(habitsTable.isActive, true), eq(habitsTable.userId, userId)))
          .limit(20),
      ]);

      extractCommitments(profile, content, aiContent, openCommitments).catch((err) =>
        logger.error({ err }, "Background commitment extraction failed"),
      );
      detectHabitMentions(profile, content, aiContent, activeHabits).catch((err) =>
        logger.error({ err }, "Background habit detection failed"),
      );

      if (userMsgCount % 4 === 0 && userMsgCount > 0) {
        const last8 = await db
          .select()
          .from(messagesTable)
          .where(eq(messagesTable.userId, userId))
          .orderBy(desc(messagesTable.createdAt))
          .limit(8);
        extractMemory(profile, last8.reverse()).catch((err) =>
          logger.error({ err }, "Background memory extraction failed"),
        );
      }
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

router.post("/chat/send", async (req, res): Promise<void> => {
  const userId = req.userId;
  const parsed = SendMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
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

  const [assistantMsg] = await db
    .insert(messagesTable)
    .values({ userId, role: "assistant", content: aiContent, isMorningNote: false })
    .returning();

  const [openCommitments, activeHabits] = await Promise.all([
    db
      .select({ id: commitmentsTable.id, content: commitmentsTable.content, cue: commitmentsTable.cue })
      .from(commitmentsTable)
      .where(and(sql`${commitmentsTable.state} = 'open'`, eq(commitmentsTable.userId, userId)))
      .limit(10),
    db
      .select({ id: habitsTable.id, name: habitsTable.name, whenThen: habitsTable.whenThen })
      .from(habitsTable)
      .where(and(eq(habitsTable.isActive, true), eq(habitsTable.userId, userId)))
      .limit(20),
  ]);

  extractCommitments(profile, content, aiContent, openCommitments).catch((err) =>
    logger.error({ err }, "Commitment extraction failed"),
  );
  detectHabitMentions(profile, content, aiContent, activeHabits).catch((err) =>
    logger.error({ err }, "Habit detection failed"),
  );

  let memoryExtracted = false;
  if (userMsgCount % 4 === 0 && userMsgCount > 0) {
    memoryExtracted = true;
    const last8 = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.userId, userId))
      .orderBy(desc(messagesTable.createdAt))
      .limit(8);
    extractMemory(profile, last8.reverse()).catch((err) =>
      logger.error({ err }, "Memory extraction failed"),
    );
  }

  req.log.info({ userMsgCount, memoryExtracted }, "Message sent");

  res.json(
    SendMessageResponse.parse({
      userMessage: userMsg,
      assistantMessage: assistantMsg,
      memoryExtracted,
    }),
  );
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
