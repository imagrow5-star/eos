import { Router, type IRouter } from "express";
import { eq, desc, asc, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { messagesTable, profileTable } from "@workspace/db";
import {
  GetMessagesResponse,
  SendMessageBody,
  SendMessageResponse,
  GenerateMorningNoteResponse,
} from "@workspace/api-zod";
import { buildSystemPrompt } from "../services/systemPrompt.js";
import { getCompanionReply, extractMemory, generateMorningNoteContent } from "../services/ai.js";
import { calculateStage, todayString } from "../services/stage.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

async function getOrCreateProfile() {
  const profiles = await db.select().from(profileTable).limit(1);
  if (profiles.length > 0) return profiles[0]!;
  const [profile] = await db
    .insert(profileTable)
    .values({ userName: "", companionName: "Aanya" })
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

  // Build system prompt and get context
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

  // Reverse and exclude the most recent (which is the user's message we just saved)
  const contextMessages = recentMessages.reverse().slice(0, -1);

  // Get AI reply
  const aiContent = await getCompanionReply(systemPrompt, contextMessages, content, stage);

  // Save assistant message
  const [assistantMsg] = await db
    .insert(messagesTable)
    .values({ role: "assistant", content: aiContent, isMorningNote: false })
    .returning();

  // Trigger memory extraction every 4 user messages (background)
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

  // Check if already generated today
  if (profile.morningNoteDate === today) {
    // Return existing morning note
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

  // Generate new morning note
  const stage = await calculateStage(profile);
  const noteContent = await generateMorningNoteContent(profile, stage);

  const [noteMsg] = await db
    .insert(messagesTable)
    .values({ role: "assistant", content: noteContent, isMorningNote: true })
    .returning();

  // Mark that morning note was generated today
  await db
    .update(profileTable)
    .set({ morningNoteDate: today })
    .where(eq(profileTable.id, profile.id));

  req.log.info("Morning note generated");

  res.json(GenerateMorningNoteResponse.parse(noteMsg));
});

export default router;
