import { Router, type IRouter } from "express";
import { eq, desc, asc, sql } from "drizzle-orm";
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
import { calculateStage, todayString } from "../services/stage.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

async function getOrCreateProfile() {
  const profiles = await db.select().from(profileTable).limit(1);
  if (profiles.length > 0) return profiles[0]!;
  const [profile] = await db
    .insert(profileTable)
    .values({ userName: "", companionName: "Asha" })
    .returning();
  return profile!;
}

router.get("/chat/messages", async (req, res): Promise<void> => {
  const messages = await db
    .select()
    .from(messagesTable)
    .orderBy(asc(messagesTable.createdAt));

  res.json(GetMessagesResponse.parse(messages));
});

// ─── Streaming chat endpoint ─────────────────────────────────────────────────
// Uses SSE to push tokens as they arrive from Anthropic, so the user sees
// text almost instantly instead of waiting for the full reply.
// Events: delta { text }, done { messageId, content }, error { error }

router.post("/chat/stream", async (req, res): Promise<void> => {
  const parsed = SendMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { content } = parsed.data;

  // Push SSE headers immediately so the browser starts reading the stream
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // prevent nginx/proxy buffering
  res.flushHeaders();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // Flush if a compression middleware is wrapping the response
    if (typeof (res as any).flush === "function") (res as any).flush();
  };

  try {
    const profile = await getOrCreateProfile();

    // Save user message
    await db.insert(messagesTable).values({ role: "user", content, isMorningNote: false });

    // Count user messages for memory extraction trigger
    const [countRow] = await db
      .select({ count: sql<string>`count(*)` })
      .from(messagesTable)
      .where(eq(messagesTable.role, "user"));
    const userMsgCount = Number(countRow?.count ?? "0");

    // Build system prompt, calculate stage, and fetch context window in parallel
    const [systemPrompt, stage, recentMessages] = await Promise.all([
      buildSystemPrompt(profile),
      calculateStage(profile),
      db
        .select()
        .from(messagesTable)
        .orderBy(desc(messagesTable.createdAt))
        .limit(21),
    ]);

    // Drop the just-inserted user message from the context window
    // (it's passed separately as the final user turn)
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
      .values({ role: "assistant", content: aiContent, isMorningNote: false })
      .returning();

    // Signal completion — client uses messageId to anchor LiveCaption
    sendEvent("done", { messageId: assistantMsg!.id, content: aiContent });
    req.log.info({ userMsgCount }, "Message streamed");
    res.end();

    // ── Background extractions — fire-and-forget after response is sent ─────
    // Fetching commitments/habits happens here, AFTER the stream ends,
    // so it never adds to the user-facing latency.
    (async () => {
      const [openCommitments, activeHabits] = await Promise.all([
        db
          .select({ id: commitmentsTable.id, content: commitmentsTable.content, cue: commitmentsTable.cue })
          .from(commitmentsTable)
          .where(sql`${commitmentsTable.state} = 'open'`)
          .limit(10),
        db
          .select({ id: habitsTable.id, name: habitsTable.name, whenThen: habitsTable.whenThen })
          .from(habitsTable)
          .where(eq(habitsTable.isActive, true))
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
  const parsed = SendMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { content } = parsed.data;
  const profile = await getOrCreateProfile();

  // Save user message
  const [userMsg] = await db
    .insert(messagesTable)
    .values({ role: "user", content, isMorningNote: false })
    .returning();

  // Count user messages for memory extraction trigger
  const [countRow] = await db
    .select({ count: sql<string>`count(*)` })
    .from(messagesTable)
    .where(eq(messagesTable.role, "user"));
  const userMsgCount = Number(countRow?.count ?? "0");

  // Build system prompt and calculate stage (in parallel)
  const [systemPrompt, stage] = await Promise.all([
    buildSystemPrompt(profile),
    calculateStage(profile),
  ]);

  // Get recent context (last 20 messages excluding the one we just inserted)
  const recentMessages = await db
    .select()
    .from(messagesTable)
    .orderBy(desc(messagesTable.createdAt))
    .limit(21);

  const contextMessages = recentMessages.reverse().slice(0, -1);

  // Get AI reply
  const aiContent = await getCompanionReply(systemPrompt, contextMessages, content, stage);

  // Save assistant message
  const [assistantMsg] = await db
    .insert(messagesTable)
    .values({ role: "assistant", content: aiContent, isMorningNote: false })
    .returning();

  // ── Background extractions ─────────────────────────────────────────────────
  // Run after EVERY message: commitment extraction + habit mention detection.
  // Run memory extraction every 4 user messages (broader context sweep).

  // Fetch open commitments and active habits for extraction passes (in parallel)
  const [openCommitments, activeHabits] = await Promise.all([
    db
      .select({ id: commitmentsTable.id, content: commitmentsTable.content, cue: commitmentsTable.cue })
      .from(commitmentsTable)
      .where(sql`${commitmentsTable.state} = 'open'`)
      .limit(10),
    db
      .select({ id: habitsTable.id, name: habitsTable.name, whenThen: habitsTable.whenThen })
      .from(habitsTable)
      .where(eq(habitsTable.isActive, true))
      .limit(20),
  ]);

  // Fire commitment extraction + habit detection in parallel (both non-blocking)
  extractCommitments(profile, content, aiContent, openCommitments).catch((err) =>
    logger.error({ err }, "Background commitment extraction failed"),
  );

  detectHabitMentions(profile, content, aiContent, activeHabits).catch((err) =>
    logger.error({ err }, "Background habit detection failed"),
  );

  let memoryExtracted = false;
  if (userMsgCount % 4 === 0 && userMsgCount > 0) {
    memoryExtracted = true;
    const last8 = await db
      .select()
      .from(messagesTable)
      .orderBy(desc(messagesTable.createdAt))
      .limit(8);
    extractMemory(profile, last8.reverse()).catch((err) =>
      logger.error({ err }, "Background memory extraction failed"),
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
  const profile = await getOrCreateProfile();
  const today = todayString();

  if (profile.morningNoteDate === today) {
    const existing = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.isMorningNote, true))
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
    .values({ role: "assistant", content: noteContent, isMorningNote: true })
    .returning();

  await db
    .update(profileTable)
    .set({ morningNoteDate: today })
    .where(eq(profileTable.id, profile.id));

  req.log.info("Morning note generated");
  res.json(GenerateMorningNoteResponse.parse(noteMsg));
});

export default router;
