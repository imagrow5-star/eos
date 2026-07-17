import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { eq, desc, and, lt } from "drizzle-orm";
import { db, messagesTable } from "@workspace/db";
import { buildSystemPrompt } from "../services/systemPrompt.js";
import { streamCompanionReply, appendRecentPhrase, VOICE_CALL_ADDENDUM } from "../services/ai.js";
import { calculateStage } from "../services/stage.js";
import { getOrCreateProfileForUser } from "./profile.js";
import { verifyVoiceToken } from "../lib/voiceToken.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

// ─── ElevenLabs custom-LLM endpoint (OpenAI chat-completions compatible) ─────
// The Conversational AI agent handles audio (mic streaming, transcription,
// turn-taking, barge-in, TTS) and calls THIS endpoint for the words — so the
// brain stays our existing Claude care-system persona with the user's real
// memory, stage, habits, and anti-repetition state.
//
// Auth: no session cookie (calls come from ElevenLabs servers). The browser
// passes a per-call HMAC token via the agent's "custom LLM extra body", which
// arrives here as body.elevenlabs_extra_body.user_token.

type ChatMsg = { role: "user" | "assistant"; content: string };

// OpenAI message content may be a plain string or an array of typed parts.
function contentToText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p: unknown) =>
        typeof (p as { text?: unknown })?.text === "string" ? (p as { text: string }).text : "",
      )
      .join(" ")
      .trim();
  }
  return "";
}

// Claude requires strict user/assistant alternation starting with "user".
// Agent transcripts can violate both (the agent greets first; duplicate roles
// appear after interruptions) — merge consecutive same-role turns and drop a
// leading assistant greeting.
function sanitizeTurns(turns: ChatMsg[]): ChatMsg[] {
  const merged: ChatMsg[] = [];
  for (const t of turns) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === t.role) prev.content += `\n${t.content}`;
    else merged.push({ ...t });
  }
  while (merged.length && merged[0]!.role !== "user") merged.shift();
  return merged;
}

router.post("/voice-llm/v1/chat/completions", async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, any>;

  // ── Identify which logged-in user this call belongs to ──
  const rawToken = body?.elevenlabs_extra_body?.user_token ?? body?.user_token ?? null;
  const auth = typeof rawToken === "string" ? verifyVoiceToken(rawToken) : null;
  if (!auth) {
    logger.warn("voice-llm: missing or invalid user token");
    res.status(401).json({
      error: { message: "Invalid or missing user token", type: "invalid_request_error" },
    });
    return;
  }
  const { userId, issuedAt } = auth;

  const model = typeof body.model === "string" && body.model ? body.model : "eos-claude";
  const wantStream = body.stream !== false;

  try {
    // ── In-call transcript from the agent ──
    const rawMessages: unknown[] = Array.isArray(body.messages) ? body.messages : [];
    const turns: ChatMsg[] = rawMessages
      .map((m) => m as { role?: unknown; content?: unknown })
      .filter((m) => m?.role === "user" || m?.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: contentToText(m.content) }))
      .filter((m) => m.content.trim().length > 0);

    let lastUserIdx = -1;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i]!.role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    const synthetic = lastUserIdx === -1;
    let userContent = synthetic
      ? "(The user just joined the voice call and hasn't spoken yet. Greet them briefly and warmly — one short sentence.)"
      : turns[lastUserIdx]!.content;
    const callContext = synthetic ? [...turns] : turns.slice(0, lastUserIdx);

    // ── Same brain as text chat: persona + this user's real memory ──
    const profile = await getOrCreateProfileForUser(userId);
    const [stage, preCallRows] = await Promise.all([
      calculateStage(profile),
      db
        .select()
        .from(messagesTable)
        .where(and(eq(messagesTable.userId, userId), lt(messagesTable.createdAt, new Date(issuedAt))))
        .orderBy(desc(messagesTable.createdAt))
        .limit(12),
    ]);
    const systemPrompt = await buildSystemPrompt(profile, stage);

    // Pre-call chat history (token issuedAt = call start, so in-call turns we
    // persist below are never double-counted) + the call transcript itself.
    const preCall: ChatMsg[] = preCallRows.reverse().map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: m.content,
    }));
    let contextMessages = sanitizeTurns([...preCall, ...callContext]).slice(-20);
    // streamCompanionReply appends the final user turn itself — the context
    // must not also end on a user turn (alternation).
    while (contextMessages.length && contextMessages[contextMessages.length - 1]!.role === "user") {
      userContent = `${contextMessages.pop()!.content}\n${userContent}`;
    }

    // ── OpenAI-compatible response: streaming SSE or plain JSON ──
    const completionId = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const chunkPayload = (delta: Record<string, unknown>, finish: string | null) =>
      JSON.stringify({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      });

    if (wantStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      res.write(`data: ${chunkPayload({ role: "assistant" }, null)}\n\n`);
    }

    const fullText = await streamCompanionReply(
      systemPrompt,
      contextMessages,
      userContent,
      stage,
      (chunk) => {
        if (wantStream) {
          res.write(`data: ${chunkPayload({ content: chunk }, null)}\n\n`);
          if (typeof (res as { flush?: () => void }).flush === "function") {
            (res as unknown as { flush: () => void }).flush();
          }
        }
      },
      VOICE_CALL_ADDENDUM,
    );

    if (wantStream) {
      res.write(`data: ${chunkPayload({}, "stop")}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.json({
        id: completionId,
        object: "chat.completion",
        created,
        model,
        choices: [
          { index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    // ── Persist the exchange (fire-and-forget, mirrors the text pipeline) so
    // voice turns land in chat history and future memory extraction.
    void (async () => {
      if (!synthetic) {
        const [lastUserMsg] = await db
          .select()
          .from(messagesTable)
          .where(and(eq(messagesTable.userId, userId), eq(messagesTable.role, "user")))
          .orderBy(desc(messagesTable.createdAt))
          .limit(1);
        // The agent re-sends history after interruptions — don't double-insert.
        if (!lastUserMsg || lastUserMsg.content !== userContent) {
          await db
            .insert(messagesTable)
            .values({ userId, role: "user", content: userContent, isMorningNote: false });
        }
      }
      await db
        .insert(messagesTable)
        .values({ userId, role: "assistant", content: fullText, isMorningNote: false });
      await appendRecentPhrase(userId, fullText);
    })().catch((err) => logger.error({ err }, "voice-llm: persisting voice turn failed"));
  } catch (err) {
    logger.error({ err }, "voice-llm: completion failed");
    if (res.headersSent) {
      try {
        res.write("data: [DONE]\n\n");
        res.end();
      } catch {
        // connection already closed
      }
    } else {
      res.status(500).json({ error: { message: "Internal error", type: "server_error" } });
    }
  }
});

export default router;
