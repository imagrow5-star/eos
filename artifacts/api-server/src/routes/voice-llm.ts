import { Router, type IRouter } from "express";
import crypto from "node:crypto";
import { eq, desc, and, lt, gte } from "drizzle-orm";
import { db, messagesTable, type Profile } from "@workspace/db";
import { buildSystemPrompt, type SystemPromptParts } from "../services/systemPrompt.js";
import {
  streamCompanionReply,
  appendRecentPhrase,
  runConversationExtractions,
  buildVoiceCallAddendum,
} from "../services/ai.js";
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

// ─── Voice model (latency-tuned) ─────────────────────────────────────────────
// Realtime voice defaults to Claude Haiku 4.5: 4-5x faster than Sonnet 4.5 at
// ~90% of its capability — spoken replies are short (max_tokens 600) and the
// personality lives entirely in the system prompt, which is identical either
// way. ROLLBACK SWITCH: set VOICE_LLM_MODEL=claude-sonnet-4-5-20250929 on the
// service (restarts apply it) — no code change needed. Text chat, morning
// notes, chapters, and extraction are untouched; they never pass a model
// override. Resolved per request purely for testability; the env is constant
// within a process, so a call's prompt-cache prefix never switches models
// mid-call. Exported for tests.
export function resolveVoiceLlmModel(): string {
  return process.env.VOICE_LLM_MODEL?.trim() || "claude-haiku-4-5";
}

// Only known ElevenLabs SYSTEM tools may reach Claude. The endpoint is
// internet-facing (HMAC-gated), so request-body tool definitions are otherwise
// caller-controllable prompt surface, and an allowlist keeps the per-call tool
// prefix byte-identical for prompt caching. Enabling a new system tool on the
// agent requires adding it here DELIBERATELY (each needs prompt + persistence
// thought, e.g. end_call).
const VOICE_SYSTEM_TOOL_ALLOWLIST = new Set(["skip_turn"]);

// ElevenLabs sends enabled system tools (skip_turn, …) as OpenAI function
// definitions; Claude needs the Anthropic shape. Non-function entries,
// malformed items, and non-allowlisted names are dropped. Exported for tests.
export function openAiToolsToAnthropic(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const t of raw) {
    const fn = (t as { type?: unknown; function?: unknown })?.type === "function"
      ? ((t as { function?: unknown }).function as {
          name?: unknown;
          description?: unknown;
          parameters?: unknown;
        } | null)
      : null;
    if (!fn || typeof fn.name !== "string" || !fn.name) continue;
    if (!VOICE_SYSTEM_TOOL_ALLOWLIST.has(fn.name)) continue;
    out.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      input_schema:
        fn.parameters && typeof fn.parameters === "object"
          ? fn.parameters
          : { type: "object", properties: {} },
    });
  }
  return out;
}

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

// streamCompanionReply appends the final user turn itself, so the context must
// not also end on user turns (Claude alternation). Trailing user turns are the
// NORM after skip_turn — the agent said nothing between utterances, so the
// transcript arrives as consecutive user messages. Fold them into the
// MODEL-facing content only; the caller must persist just the fresh utterance
// (earlier ones were persisted by their own requests). Exported for tests.
export function mergeTrailingUserTurns(
  context: ChatMsg[],
  fresh: string,
): { context: ChatMsg[]; content: string } {
  const ctx = [...context];
  let content = fresh;
  while (ctx.length && ctx[ctx.length - 1]!.role === "user") {
    content = `${ctx.pop()!.content}\n${content}`;
  }
  return { context: ctx, content };
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

// ─── Per-call frozen system prompt ───────────────────────────────────────────
// A live call hits this endpoint every few seconds. Rebuilding the system
// prompt per turn changes the dynamic context block (clock time, phrases…),
// which would void Anthropic's prompt cache mid-call. Freezing both parts for
// the duration of one call — keyed by the token's issuedAt, i.e. call start —
// keeps the whole prefix byte-identical, so stable + context + transcript all
// hit the cache from turn 2 on. Mid-call profile/memory changes apply on the
// NEXT call; a live conversation doesn't need them sooner. The TTL slides on
// every hit — an active call touches its entry every few seconds, so entries
// outlive even very long calls and are swept only after ~15 min of silence.

// "How Eos speaks" — one delivery instruction per tone preference, injected
// into the per-call frozen system extra so the whole call keeps ONE consistent
// delivery and the prompt-cache prefix stays byte-identical. "auto" adds
// nothing — the persona's situational adaptation leads.
const TONE_DELIVERY: Record<string, string> = {
  gentle:
    "\n- DELIVERY STYLE (user preference — gentle & empathetic): extra-soft, tender pacing. Validate the feeling in warm, simple words before anything else; let sentences breathe.",
  calm:
    "\n- DELIVERY STYLE (user preference — calm & steady): slow, grounded, unhurried. Short steady sentences, small pauses, quiet reassurance — never rushed, never excitable.",
  upbeat:
    "\n- DELIVERY STYLE (user preference — warm & upbeat): warm with gentle brightness. Encouraging, hopeful phrasing and light energy — still soft and caring, never loud.",
};

const frozenSystems = new Map<string, { parts: SystemPromptParts; toneExtra: string; at: number }>();
const FROZEN_SYSTEM_TTL_MS = 15 * 60 * 1000;

async function getFrozenSystem(
  userId: number,
  issuedAt: number,
  profile: Profile,
  stage: number,
): Promise<{ parts: SystemPromptParts; toneExtra: string }> {
  const now = Date.now();
  for (const [k, v] of frozenSystems) {
    if (now - v.at > FROZEN_SYSTEM_TTL_MS) frozenSystems.delete(k);
  }
  const key = `${userId}:${issuedAt}`;
  const hit = frozenSystems.get(key);
  if (hit) {
    hit.at = now; // sliding TTL — keep the frozen prompt alive for the whole call
    return { parts: hit.parts, toneExtra: hit.toneExtra };
  }
  const parts = await buildSystemPrompt(profile, stage);
  // Tone freezes with the prompt: a mid-call Settings change applies on the
  // NEXT call, keeping this call's cached prefix byte-identical.
  const toneExtra = TONE_DELIVERY[profile.voiceTone ?? "auto"] ?? "";
  frozenSystems.set(key, { parts, toneExtra, at: now });
  return { parts, toneExtra };
}

// ─── Voice-turn persistence with in-call dedup ────────────────────────────────
// ElevenLabs fires MULTIPLE completion requests per spoken turn: rolling ASR
// finals revise the user's sentence, interruptions regenerate replies, and
// double-fires arrive in the same second. Persisting once per request wrote
// duplicate rows (the tester-visible "echo"). Three defenses:
//   1. per-user promise chain — concurrent requests persist strictly in order,
//      closing the check-then-insert race (single-process server);
//   2. user turns dedup by exact content since call start (issuedAt) — survives
//      A→B→A transcript revisions, which defeated the old "latest row" check;
//   3. assistant replies dedup the same way — exact duplicates are dropped,
//      genuinely different regenerations still save (both were partly spoken).

const persistChains = new Map<number, Promise<void>>();

export async function persistVoiceTurn(args: {
  userId: number;
  issuedAt: number;
  synthetic: boolean;
  userContent: string;
  fullText: string;
  profile: Profile;
}): Promise<{ savedUser: boolean; savedAssistant: boolean }> {
  const { userId, issuedAt, synthetic, userContent, fullText, profile } = args;
  const callStart = new Date(issuedAt);

  let savedUser = false;
  let savedAssistant = false;
  const job = async () => {
    if (!synthetic) {
      // content is encrypted at rest with a random IV per row, so SQL
      // equality (eq(content, x)) can never match — fetch the call window's
      // rows (drizzle decrypts on read) and compare in app code instead.
      const recentUserRows = await db
        .select({ content: messagesTable.content })
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.userId, userId),
            eq(messagesTable.role, "user"),
            gte(messagesTable.createdAt, callStart),
          ),
        );
      const userDupe = recentUserRows.some((r) => r.content === userContent);
      if (!userDupe) {
        await db
          .insert(messagesTable)
          .values({ userId, role: "user", content: userContent, isMorningNote: false });
        savedUser = true;
      }
    }

    // A skip_turn reply is intentional silence — fullText is empty and there
    // is nothing to store. Never insert empty assistant rows.
    if (fullText.trim().length > 0) {
      // Same as above: content equality must happen on decrypted rows.
      const recentAssistantRows = await db
        .select({ content: messagesTable.content })
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.userId, userId),
            eq(messagesTable.role, "assistant"),
            gte(messagesTable.createdAt, callStart),
          ),
        );
      const assistantDupe = recentAssistantRows.some((r) => r.content === fullText);
      if (!assistantDupe) {
        await db
          .insert(messagesTable)
          .values({ userId, role: "assistant", content: fullText, isMorningNote: false });
        // Anti-repetition state only for genuinely new replies — duplicate
        // completions were double-appending phrases too.
        await appendRecentPhrase(userId, fullText);
        savedAssistant = true;
      }
    }

    // Extraction (commitments, habits, goals, memory) only on genuinely new
    // user turns — re-sent history must not extract twice.
    if (savedUser) {
      await runConversationExtractions(profile, userContent, fullText);
    }
  };

  const prev = persistChains.get(userId) ?? Promise.resolve();
  const tail = prev.then(job, job); // run even if the predecessor failed
  persistChains.set(userId, tail);
  tail
    .catch(() => {})
    .finally(() => {
      if (persistChains.get(userId) === tail) persistChains.delete(userId);
    });
  await tail;
  return { savedUser, savedAssistant };
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
    // Persist/extract the utterance AS SPOKEN. After skip_turn silences, the
    // model-facing userContent below becomes a merge of several utterances —
    // persisting that would write cumulative "A", "A\nB", "A\nB\nC" rows.
    const freshUserContent = userContent;
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
    const { parts: systemPrompt, toneExtra } = await getFrozenSystem(userId, issuedAt, profile, stage);

    // Pre-call chat history (token issuedAt = call start, so in-call turns we
    // persist below are never double-counted) + the call transcript itself.
    const preCall: ChatMsg[] = preCallRows.reverse().map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "user" | "assistant",
      content: m.content,
    }));
    // Stepped history window: the window START moves in strides of 10 turns
    // (window size floats 20–29) instead of sliding by one each turn — a
    // per-turn slide changes the first message and would void the cached
    // conversation prefix on every request.
    const allTurns = sanitizeTurns([...preCall, ...callContext]);
    const windowStart = allTurns.length > 29 ? Math.floor((allTurns.length - 20) / 10) * 10 : 0;
    const merged = mergeTrailingUserTurns(allTurns.slice(windowStart), userContent);
    const contextMessages = merged.context;
    userContent = merged.content;

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

    const flushRes = () => {
      if (typeof (res as { flush?: () => void }).flush === "function") {
        (res as unknown as { flush: () => void }).flush();
      }
    };

    // System tools ElevenLabs exposes for this agent (skip_turn today). When
    // Claude invokes one, echo it back in OpenAI streaming format — ElevenLabs
    // executes it (skip_turn = agent stays silent this turn).
    const tools = openAiToolsToAnthropic(body.tools);
    const toolCalls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }> = [];

    const fullText = await streamCompanionReply(
      systemPrompt,
      contextMessages,
      userContent,
      stage,
      (chunk) => {
        if (wantStream) {
          res.write(`data: ${chunkPayload({ content: chunk }, null)}\n\n`);
          flushRes();
        }
      },
      {
        // Listening rules only when skip_turn actually arrived with the
        // request (allowlist admits nothing else, so length>0 ⇔ skip_turn).
        // Constant within a call → cached prompt prefix stays byte-identical.
        systemExtra: buildVoiceCallAddendum(tools.length > 0) + toneExtra,
        callType: "voice",
        cacheConversation: true,
        model: resolveVoiceLlmModel(),
        ...(tools.length
          ? {
              tools,
              onToolCall: (id: string, name: string, argsJson: string) => {
                const call = {
                  id,
                  type: "function" as const,
                  function: { name, arguments: argsJson },
                };
                toolCalls.push(call);
                if (wantStream) {
                  res.write(
                    `data: ${chunkPayload({ tool_calls: [{ index: toolCalls.length - 1, ...call }] }, null)}\n\n`,
                  );
                  flushRes();
                }
              },
            }
          : {}),
      },
    );

    const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
    if (wantStream) {
      res.write(`data: ${chunkPayload({}, finishReason)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.json({
        id: completionId,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: fullText || (toolCalls.length ? null : fullText),
              ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: finishReason,
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    // ── Persist the exchange (fire-and-forget, mirrors the text pipeline) so
    // voice turns land in chat history and future memory extraction. Dedup +
    // per-user serialization live in persistVoiceTurn.
    void persistVoiceTurn({
      userId,
      issuedAt,
      synthetic,
      userContent: freshUserContent,
      fullText,
      profile,
    }).catch((err) => logger.error({ err }, "voice-llm: persisting voice turn failed"));
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
