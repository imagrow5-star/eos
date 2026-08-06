import { desc, eq, and, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  memoryFactsTable,
  memoryFeelingsTable,
  personalitySignalsTable,
  winsTable,
  moodScoresTable,
  profileTable,
  messagesTable,
  commitmentsTable,
  habitsTable,
  habitCompletionsTable,
  personalizationStateTable,
  goalsTable,
  goalTasksTable,
  type Profile,
} from "@workspace/db";
import { logger } from "../lib/logger.js";
import { kindStreak } from "../lib/kindStreak.js";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";
import { recordMemoryReferences } from "./memory/references.js";
import { detectRememberIntent } from "./memory/rememberTriggers.js";
import {
  defaultDedupFinder,
  type DedupEntry,
  type DedupFinder,
} from "./memory/dedup.js";
import { todayInTimezone, describeCommitmentTiming } from "./stage.js";
import type { SystemPromptParts } from "./systemPrompt.js";
import { describeUserGender, describeUserBasics } from "./systemPrompt.js";

// Anthropic client — lazy init so mock mode works without the key
let _anthropic: import("@anthropic-ai/sdk").Anthropic | null = null;

function getAnthropic(): import("@anthropic-ai/sdk").Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_anthropic) {
    const Anthropic =
      require("@anthropic-ai/sdk").default ||
      require("@anthropic-ai/sdk").Anthropic;
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

// ─── Token usage logging ──────────────────────────────────────────────────────
// One structured line per Anthropic call so cost per feature is visible in the
// workflow logs — grep for "ai_usage". Healthy caching shows a LARGE cacheRead
// and a small input from the 2nd message on; cacheRead bills at ~10% of input,
// cacheWrite at 125%.

export const MODEL_PRICES_PER_MTOK: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  "claude-sonnet-4-5-20250929": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/**
 * Default model for companion replies. Text chat always uses this; the
 * realtime voice path passes an override (see routes/voice-llm.ts) because
 * spoken replies are latency-critical and short (max_tokens 600).
 */
export const DEFAULT_COMPANION_MODEL = "claude-sonnet-4-5-20250929";

export function logAiUsage(callType: string, model: string, usage: unknown): void {
  try {
    const u = (usage ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);
    const input = num(u.input_tokens);
    const output = num(u.output_tokens);
    const cacheWrite = num(u.cache_creation_input_tokens);
    const cacheRead = num(u.cache_read_input_tokens);
    const p = MODEL_PRICES_PER_MTOK[model];
    const estCostUsd = p
      ? Number(
          (
            (input * p.input + output * p.output + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead) /
            1_000_000
          ).toFixed(6),
        )
      : undefined;
    logger.info(
      { aiUsage: { callType, model, input, cacheRead, cacheWrite, output, estCostUsd } },
      "ai_usage",
    );
  } catch {
    // usage logging must never break the request path
  }
}

// ─── Mock mode responses by stage ────────────────────────────────────────────

const MOCK_RESPONSES: Record<number, string[]> = {
  1: [
    "I hear you. That kind of pain doesn't have a quick fix, and I'm not going to pretend it does. I'm just here.",
    "That sounds really hard to carry. You don't have to have it figured out right now.",
    "Thank you for sharing that with me. Genuinely. I'm listening.",
    "Yeah. Some days just being here is enough. You showed up.",
    "That took courage to say out loud. I'm glad you did.",
    "I'm not going anywhere. Tell me more, whenever you're ready.",
    "It makes complete sense that you feel that way. Anyone would.",
  ],
  2: [
    "I've been thinking about what you shared. It sounds like a part of you is slowly starting to understand what happened, even if another part still hurts.",
    "You've been carrying so much. What feels heaviest right now?",
    "I notice you talk about yourself differently lately. What do you think that's about?",
    "That's a real thing you just said. Sit with it for a second.",
    "What was that moment like for you, on the inside?",
  ],
  3: [
    "You know what's interesting — you mentioned that thing about mornings being hard. What if there was something tiny you could anchor to that time, something you actually like?",
    "I've been noticing something. You're still standing. After everything. That's not nothing.",
    "One small thing, built around something you already care about. No pressure. Just a thought.",
    "What's one moment from this week that felt slightly less heavy than the week before?",
  ],
  4: [
    "Look at what you've built. Quietly, without anyone cheering you on. You did that.",
    "That's a real win. Write it down somewhere — not because you'll forget, but because you deserve to see it.",
    "I believe in who you're becoming. Not who you were before this, and not some future version — you, right now.",
    "You've got more in you than you think. I've seen it.",
  ],
};

function getMockResponse(stage: number): string {
  const responses = MOCK_RESPONSES[stage] ?? MOCK_RESPONSES[1]!;
  return responses[Math.floor(Math.random() * responses.length)]!;
}

// ─── Honest degraded mode (provider outage) ──────────────────────────────────
// When a live Anthropic call FAILS, users used to silently receive a canned
// mock line and every metric recorded success — an outage was invisible
// (review finding, Top-5 #1/#5). Now the fallback is honest in Eos's voice,
// the reply is FLAGGED degraded end-to-end (SSE done event / JSON response /
// voice), and an `ai_degraded` log line records the failure so outages show
// up in monitoring: grep "ai_degraded" (mirror of the "ai_usage" cost lines).
//
// Mock mode (no ANTHROPIC_API_KEY at all) is different and unchanged: that is
// the documented dev setup, not an outage — it keeps the canned stage replies
// and is NOT flagged degraded, so local dev and the test suite behave as
// before.
//
// No retries are added here: the SDK's own default retry policy is the only
// one (adding more would multiply API costs during exactly the wrong moment).

/** Spoken and written honest fallback — warm, no technical jargon. */
export const DEGRADED_REPLY =
  "I'm having a little trouble gathering my thoughts right now — it's me, not you. " +
  "Give me a few minutes and try again; I'm still right here.";

export interface CompanionReplyResult {
  text: string;
  /** true = the provider call failed and `text` is the honest fallback. */
  degraded: boolean;
}

function logAiDegraded(callType: string, err: unknown): void {
  logger.error(
    { err, aiDegraded: true, callType },
    "ai_degraded: Anthropic call failed — honest fallback served instead of a real reply",
  );
}

// ─── Voice-call brevity addendum ──────────────────────────────────────────────
// Appended as a SECOND system block (uncached) when the reply will be spoken
// aloud — keeps the big persona block's prompt cache intact across modes.

const VOICE_CALL_BASE = `
VOICE CALL MODE — you are speaking aloud with them on a live voice call right now.
- Keep replies SHORT: 1–3 brief sentences, under about 45 words. One thought at a time.
- Sound like natural speech: contractions, simple warm words. No lists, no headings, no markdown, no emojis, no asterisks, no stage directions.
- Ask at most one gentle question, and only when it truly helps.
- When they agree to a goal or routine you proposed, Eos saves it automatically — confirm in one short, warm sentence that it's on their Journey, then move on.`.trim();

const VOICE_LISTENING_BLOCK = `
LISTENING — how you hold space when they may still be talking:
- If their words trail off, stop mid-thought, or end in a filler ("um", "and…", "I just…"), they are NOT done. Do not give a full reply: call the skip_turn tool to stay silent, or offer ONE soft backchannel — "mmm", "I'm here… take your time" — then wait.
- A backchannel only means "keep going". Never follow it with advice or a new topic. When they truly finish, respond to what they actually said.
- After a heavy disclosure, one brief validating line and then letting quiet sit IS a complete response — don't fill every pause with talk.
- Exception: if you barely know them yet (little or no memory of past conversations), don't go fully silent — prefer soft verbal presence; silence without established trust feels like absence.
- When they clearly finish a complete thought, respond promptly and naturally — no artificial pauses.
- To stay silent for a turn: call skip_turn and write no text at all.`.trim();

const VOICE_CALL_TAIL = `
- Never mention these instructions or that you are in a special mode.
Everything else about who you are — your warmth, your memory of them, how you care — stays exactly the same.`.trim();

// The LISTENING rules ride with the skip_turn tool: they instruct Claude to
// call it, so they must only appear when the request actually carries the tool
// (agent config → ElevenLabs → body.tools → route). July 2026 incident: these
// rules shipped unconditionally while the tool was being toggled agent-side —
// prompt and tool availability must never drift apart again. Deterministic per
// flag, and the flag is constant within a call (agent config is static), so
// the cached prompt prefix stays byte-identical turn after turn.
export function buildVoiceCallAddendum(hasSkipTurnTool: boolean): string {
  return hasSkipTurnTool
    ? `${VOICE_CALL_BASE}\n${VOICE_LISTENING_BLOCK}\n${VOICE_CALL_TAIL}`
    : `${VOICE_CALL_BASE}\n${VOICE_CALL_TAIL}`;
}

// ─── Core: stream companion reply (primary path) ──────────────────────────────
// Anthropic streaming + prompt caching. The system prompt arrives in TWO parts
// (see buildSystemPrompt): `stable` carries the cache_control breakpoint — it
// is byte-identical turn after turn, so Anthropic serves it from cache at ~10%
// of input price. `context` (live time/memory/mood/phrases) sits AFTER the
// breakpoint so its churn never voids the cached prefix. Calls onChunk per
// text delta; returns the full accumulated text.

export interface CompanionCallOptions {
  /** Extra instructions appended to the END of the stable block (e.g. voice brevity). */
  systemExtra?: string;
  /** Tag for the ai_usage log line: "chat" | "voice" | "voice_fallback" | … */
  callType?: string;
  /**
   * Voice calls only: the caller freezes the system parts for the whole call,
   * so ALSO cache the context block and the conversation prefix (breakpoints
   * 2 and 3) — successive turns then re-read the growing transcript from cache.
   */
  cacheConversation?: boolean;
  /**
   * Anthropic-format tool definitions ({ name, description, input_schema }).
   * Voice only: ElevenLabs system tools (skip_turn, …) forwarded so Claude can
   * invoke them. Tools sit BEFORE system blocks in Anthropic's cache prefix —
   * they are stable within a call (agent config), so caching is unaffected.
   */
  tools?: Array<Record<string, unknown>>;
  /** Fires once per COMPLETED tool_use block with the raw JSON argument string. */
  onToolCall?: (id: string, name: string, argsJson: string) => void;
  /**
   * Model override (defaults to DEFAULT_COMPANION_MODEL). Used by the voice
   * path to run on Haiku for latency. Prompt caches are per-model, so the
   * override must stay constant for the duration of a call — it does, because
   * it comes from an env var that only changes across restarts.
   */
  model?: string;
}

export async function streamCompanionReply(
  system: SystemPromptParts,
  contextMessages: { role: string; content: string }[],
  userContent: string,
  stage: number,
  onChunk: (text: string) => void,
  opts?: CompanionCallOptions,
): Promise<CompanionReplyResult> {
  const anthropic = getAnthropic();

  if (!anthropic) {
    logger.warn("ANTHROPIC_API_KEY not set — streaming mock response");
    const mock = getMockResponse(stage);
    const words = mock.split(" ");
    for (let i = 0; i < words.length; i++) {
      await new Promise((r) => setTimeout(r, 55 + Math.random() * 65));
      onChunk((i === 0 ? "" : " ") + words[i]);
    }
    return { text: mock, degraded: false }; // dev mock mode — not an outage
  }

  try {
    const messages: any[] = [
      ...contextMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content as string | Array<Record<string, unknown>>,
      })),
      { role: "user" as const, content: userContent },
    ];

    // Breakpoint 3 (voice only): mark the last context message so the whole
    // conversation prefix up to it is served from cache; the fresh user turn
    // after it is the only uncached message.
    if (opts?.cacheConversation && messages.length > 1) {
      const prev = messages[messages.length - 2];
      prev.content = [
        { type: "text", text: prev.content, cache_control: { type: "ephemeral" } },
      ];
    }

    const systemBlocks: any[] = [
      {
        type: "text",
        text: opts?.systemExtra ? `${system.stable}\n\n${opts.systemExtra}` : system.stable,
        cache_control: { type: "ephemeral" }, // breakpoint 1 — the big stable prefix
      },
    ];
    if (system.context) {
      systemBlocks.push({
        type: "text",
        text: system.context,
        // Breakpoint 2 (voice only): context is frozen per call, so it caches too.
        ...(opts?.cacheConversation ? { cache_control: { type: "ephemeral" } } : {}),
      });
    }

    let fullText = "";
    const usage: Record<string, number> = {};
    // Tool-use streaming state: Anthropic sends content_block_start(tool_use) →
    // input_json_delta* → content_block_stop. Blocks are sequential, so one
    // in-flight tool block at a time is sufficient.
    let sawToolUse = false;
    let toolBlock: { id: string; name: string; args: string } | null = null;

    const model = opts?.model ?? DEFAULT_COMPANION_MODEL;

    const stream = await (anthropic.messages.create as any)({
      model,
      max_tokens: 600,
      temperature: 0.8,
      system: systemBlocks,
      messages,
      stream: true,
      ...(opts?.tools?.length ? { tools: opts.tools } : {}),
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta"
      ) {
        const chunk = event.delta.text as string;
        fullText += chunk;
        onChunk(chunk);
      } else if (
        event.type === "content_block_start" &&
        event.content_block?.type === "tool_use"
      ) {
        toolBlock = {
          id: (event.content_block.id as string) || `toolu_${crypto.randomUUID()}`,
          name: event.content_block.name as string,
          args: "",
        };
      } else if (
        event.type === "content_block_delta" &&
        event.delta?.type === "input_json_delta"
      ) {
        if (toolBlock) toolBlock.args += (event.delta.partial_json as string) ?? "";
      } else if (event.type === "content_block_stop" && toolBlock) {
        sawToolUse = true;
        // Never forward malformed JSON to the tool executor (truncated stream,
        // partial input_json_delta) — skip_turn args are optional anyway.
        let argsJson = toolBlock.args.trim() || "{}";
        try {
          JSON.parse(argsJson);
        } catch {
          argsJson = "{}";
        }
        opts?.onToolCall?.(toolBlock.id, toolBlock.name, argsJson);
        toolBlock = null;
      } else if (event.type === "message_start" && event.message?.usage) {
        Object.assign(usage, event.message.usage);
      } else if (event.type === "message_delta" && event.usage) {
        Object.assign(usage, event.usage);
      }
    }

    logAiUsage(opts?.callType ?? "chat", model, usage);

    // A tool-only reply (e.g. skip_turn) is INTENTIONAL silence — never swap in
    // the fallback line, or the agent would speak while trying to stay quiet.
    return { text: fullText || (sawToolUse ? "" : "I'm here. Tell me more."), degraded: false };
  } catch (err) {
    // Provider outage: be HONEST — no fake "normal" reply, no silent success.
    logAiDegraded(opts?.callType ?? "chat", err);
    onChunk(DEGRADED_REPLY);
    return { text: DEGRADED_REPLY, degraded: true };
  }
}

// ─── Core: get companion reply (non-streaming fallback / background use) ───────

export async function getCompanionReply(
  system: SystemPromptParts,
  contextMessages: { role: string; content: string }[],
  userContent: string,
  stage: number,
  opts?: Pick<CompanionCallOptions, "systemExtra">,
): Promise<CompanionReplyResult> {
  const anthropic = getAnthropic();

  if (!anthropic) {
    logger.warn("ANTHROPIC_API_KEY not set — using mock response");
    return { text: getMockResponse(stage), degraded: false }; // dev mock mode
  }

  try {
    const messages = [
      ...contextMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      { role: "user" as const, content: userContent },
    ];

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 600,
      temperature: 0.8,
      system: [
        {
          type: "text",
          text: opts?.systemExtra ? `${system.stable}\n\n${opts.systemExtra}` : system.stable,
          cache_control: { type: "ephemeral" },
        },
        ...(system.context ? [{ type: "text", text: system.context }] : []),
      ] as any,
      messages,
    });
    logAiUsage("chat_send", "claude-sonnet-4-5-20250929", response.usage);

    const textBlock = response.content.find((b) => b.type === "text");
    return { text: textBlock?.text ?? "I'm here. Tell me more.", degraded: false };
  } catch (err) {
    logAiDegraded("chat_send", err);
    return { text: DEGRADED_REPLY, degraded: true };
  }
}

// ─── Morning note generation ──────────────────────────────────────────────────

export async function generateMorningNoteContent(
  profile: Profile,
  stage: number,
): Promise<string> {
  const today = todayInTimezone((profile as any).timezone ?? "UTC");

  const userId = (profile as any).userId as number;
  const [facts, wins, pendingFollowUps] = await Promise.all([
    db.select().from(memoryFactsTable).where(eq(memoryFactsTable.userId, userId)).orderBy(desc(memoryFactsTable.createdAt)).limit(10),
    db.select().from(winsTable).where(eq(winsTable.userId, userId)).orderBy(desc(winsTable.createdAt)).limit(3),
    // Not stage-gated: user-declared plans deserve follow-up at any stage —
    // the tone rules below keep it presence-first for early stages.
    db
      .select()
      .from(commitmentsTable)
      .where(
        and(
          eq(commitmentsTable.userId, userId),
          sql`${commitmentsTable.state} = 'open' AND ${commitmentsTable.scheduledFollowupDate} <= ${today}`,
        ),
      )
      .limit(2),
  ]);

  const tzForTiming = (profile as any).timezone ?? "UTC";

  const daysSinceStart = Math.floor(
    (Date.now() - profile.createdAt.getTime()) / (1000 * 60 * 60 * 24),
  );

  const anthropic = getAnthropic();

  if (!anthropic) {
    const name = profile.userName || "you";
    return stage <= 2
      ? `Good morning, ${name}. I was thinking about you. You don't need to have it figured out today. Just showing up is enough.`
      : `Good morning, ${name}. Day ${daysSinceStart} since we started talking. You've come further than you think. One small thing today — that's all.`;
  }

  const factsText =
    facts.length > 0 ? facts.map((f) => f.fact).join("; ") : "still getting to know each other";

  const winsText =
    wins.length > 0 ? wins.map((w) => w.content).join("; ") : "no wins logged yet";

  const contextLines: string[] = [];
  if (facts.length > 0) {
    contextLines.push(`About ${profile.userName || "them"}:\n${facts.map((f) => `• ${f.fact}`).join("\n")}`);
  }
  if (wins.length > 0) {
    contextLines.push(`Recent wins:\n${wins.map((w) => `• ${w.content}`).join("\n")}`);
  }
  if (pendingFollowUps.length > 0) {
    contextLines.push(
      `Pending commitment(s) to gently check in on:\n${pendingFollowUps
        .map((c) => `• "${c.content}"${c.cue ? ` (cue: ${c.cue})` : ""}${describeCommitmentTiming((c as any).scheduledDate, (c as any).scheduledTime, tzForTiming)}`)
        .join("\n")}`,
    );
  }
  contextLines.push(`Day ${daysSinceStart} since they started.`);

  const pathNote =
    stage <= 2
      ? "\nThey are early in their healing — still in the raw stage. Pure presence only. No advice, no suggestions, no task-talk."
      : "";

  const prompt = `You are ${profile.companionName}. You're writing ${profile.userName || "them"} a short in-app morning note — 4 to 6 sentences, no more.

This appears when they open the app in the morning. It should feel like it was written just for them, not generated.

WHAT YOU KNOW:
${contextLines.join("\n\n")}
${pathNote}
${describeUserGender(profile, profile.userName || "them")}
${describeUserBasics(profile, profile.userName || "them")}

RULES:
• Reference 1–2 SPECIFIC things from what you know about them. Not vague warmth — their actual wins, facts, or habits. Specificity is what makes it land.
• ${stage <= 2 ? "Stage 1–2: pure warmth and presence only. No suggestions, no tasks. Just being with them." : "End with one low-stakes, optional nudge for today tied to their real life — not abstract."}
• NEVER use: "I'm here for you" · "you've got this" · "be kind to yourself" · "one step at a time" · "proud of you" · "your journey" · "healing journey" · "self-care" · "self-love" · "stay strong" · "hang in there" · "keep going" · "you're doing amazing" · "it's okay to feel" · "give yourself grace" · "embrace" · "lean into" · "mindfulness" · any therapy buzzwords.
• No greeting-card phrases. Plain, warm, human sentences.
• No sign-off — it's in-app, not an email. Just the note itself.
• Do NOT invent details not given above.

Write only the note text.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 350,
      temperature: 0.8,
      messages: [{ role: "user", content: prompt }],
    });
    logAiUsage("morning_note", "claude-sonnet-4-5-20250929", response.usage);
    const textBlock = response.content.find((b) => b.type === "text");
    return (
      textBlock?.text ??
      `${profile.userName ? profile.userName + " — " : ""}thinking of you today.`
    );
  } catch (err) {
    // Degraded, not success — the generic line below is a fallback, and the
    // marker makes the outage visible in metrics (grep "ai_degraded").
    logAiDegraded("morning_note", err);
    return `${profile.userName ? profile.userName + " — " : ""}I'm here with you today.`;
  }
}

// ─── Recent phrase tracking (anti-repetition) ────────────────────────────────

/**
 * Extracts the opening phrase from an AI reply and appends it to the user's
 * recentPhrases list in personalization_state, keeping the last 15.
 * Fire-and-forget safe — never throws.
 */
export async function appendRecentPhrase(userId: number, aiContent: string): Promise<void> {
  if (!aiContent?.trim()) return;

  // First sentence (up to 80 chars) as the opener fingerprint
  const raw =
    aiContent.split(/(?<=[.!?])\s+/)[0]?.trim() ??
    aiContent.split("\n")[0]?.trim() ??
    aiContent.slice(0, 100);
  const phrase = raw.slice(0, 80).trim();
  if (phrase.length < 8) return;

  try {
    const existing = await db
      .select({ recentPhrases: personalizationStateTable.recentPhrases })
      .from(personalizationStateTable)
      .where(eq(personalizationStateTable.userId, userId));

    const current: string[] = existing[0]?.recentPhrases ?? [];
    // Skip if near-duplicate already stored
    if (current.some((p) => p.startsWith(phrase.slice(0, 40)))) return;
    const updated = [...current, phrase].slice(-15);

    await db
      .insert(personalizationStateTable)
      .values({ userId, recentPhrases: updated })
      .onConflictDoUpdate({
        target: personalizationStateTable.userId,
        set: { recentPhrases: updated, updatedAt: new Date() },
      });
  } catch (err) {
    try {
      const uh = hashUserIdForLog(userId);
      if (uh) logger.warn({ err, uh }, "appendRecentPhrase failed (non-fatal)");
    } catch { /* logging must never crash the caller */ }
  }
}

// ─── Memory extraction (runs every 4 user messages in background) ─────────────

interface ExtractedMemory {
  facts?: Array<{ fact: string; category: string }>;
  signals?: string[];
  wins?: string[];
  moodScore?: number;
  changeTalk?: boolean;
}

// ─── Extraction-time semantic dedup ───────────────────────────────────────────
// A new extraction is compared against the last N rows of the same type. 50 is
// cheap to load and covers a user's active memory without a large Haiku context.
// On a semantic hit we bump the matched row's reference counters instead of
// inserting a near-duplicate (the pollution the Memory Manifest was showing).
const DEDUP_CANDIDATE_WINDOW = 50;

export async function extractMemory(
  profile: Profile,
  recentMessages: { role: string; content: string }[],
  opts?: { userMarkedImportant?: boolean; dedupFinder?: DedupFinder },
): Promise<void> {
  // Sprint 2B: when the user explicitly asked Eos to remember, every fact we
  // pull from that message is flagged important (the +10 boost). Default false
  // — ordinary extraction never marks anything.
  const markImportant = opts?.userMarkedImportant === true;
  const anthropic = getAnthropic();
  if (!anthropic) return;

  const conversation = recentMessages
    .map((m) => `${m.role === "user" ? profile.userName || "User" : profile.companionName}: ${m.content}`)
    .join("\n");

  const extractPrompt = `From this conversation, extract structured memory. Return valid JSON only — no explanation.

Conversation:
${conversation}

Extract and return this JSON shape:
{
  "facts": [{"fact": "...", "category": "life|interest|routine|person|work|value|soother|preference|event|goal"}],
  "signals": ["personality/communication style observations about the user"],
  "wins": ["things the user reports doing or accomplishing in real life"],
  "moodScore": <1-10 estimate of user's current emotional state, 1=very low, 10=excellent>,
  "changeTalk": <true if user expressed wanting to change, move forward, or get out of the pain>
}

Rules:
- facts: concrete, durable things about the user's life — use the MOST SPECIFIC category:
  "interest"  — hobbies, activities, things they genuinely enjoy or love doing
  "routine"   — daily patterns, morning/evening rituals, regular activities
  "person"    — a specific NAMED person in their life (friend, family member, colleague — NOT their ex/late partner who is already known)
  "work"      — their job, career, what they spend their days doing
  "value"     — what matters most to them, what they believe in, their principles
  "soother"   — what specifically helps or calms them when struggling — their actual coping
  "preference"— what they like or dislike (food, places, things)
  "event"     — a specific thing that happened to or around them
  "goal"      — a specific future aspiration, dream, or plan they named
  "life"      — general life fact that doesn't fit any category above
- signals: ONLY communication style, humor level, openness, support needs — NOT facts about their life
- wins: ONLY things they actually did in the real world (went to the gym, called a friend, cooked dinner, slept 8 hours)
- moodScore: honest estimate, not inflated
- changeTalk: true if they said things like "I want to get better", "I'm ready to try", "I need to move on"

Return empty arrays if nothing fits. Do NOT make things up.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 600,
      messages: [{ role: "user", content: extractPrompt }],
    });
    logAiUsage("extract_memory", "claude-haiku-4-5", response.usage);

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return;

    let extracted: ExtractedMemory;
    try {
      const raw = textBlock.text.replace(/```(?:json)?\n?/g, "").trim();
      extracted = JSON.parse(raw) as ExtractedMemory;
    } catch {
      // Privacy: never log the raw LLM output — it can quote the user's words.
      logger.warn({ rawLength: textBlock.text.length }, "Failed to parse memory extraction JSON");
      return;
    }

    const userId = (profile as any).userId as number;
    const dedupFinder = opts?.dedupFinder ?? defaultDedupFinder;
    if (extracted.facts && extracted.facts.length > 0) {
      // Semantic dedup: compare each candidate against the user's recent facts
      // and, on a hit, bump the matched row's reference counters instead of
      // inserting a near-duplicate. The local `existing` array mirrors inserts
      // so repeats WITHIN one batch also collapse. Fail-open (findSemanticDuplicate
      // never throws) — a flaky check inserts as normal rather than losing data.
      const recentFacts = await db
        .select({ id: memoryFactsTable.id, fact: memoryFactsTable.fact })
        .from(memoryFactsTable)
        .where(eq(memoryFactsTable.userId, userId))
        .orderBy(desc(memoryFactsTable.createdAt))
        .limit(DEDUP_CANDIDATE_WINDOW);
      const existing: DedupEntry[] = recentFacts.map((r) => ({ id: r.id, content: r.fact }));

      for (const f of extracted.facts) {
        if (!f.fact || f.fact.length < 5) continue;
        const decision = await dedupFinder(f.fact, existing);
        if (decision.isDuplicate && decision.matchingId != null) {
          await db
            .update(memoryFactsTable)
            .set({
              timesReferenced: sql`${memoryFactsTable.timesReferenced} + 1`,
              lastReferencedAt: new Date(),
            })
            .where(and(eq(memoryFactsTable.id, decision.matchingId), eq(memoryFactsTable.userId, userId)));
          try {
            const uh = hashUserIdForLog(userId);
            if (uh) logger.debug({ uh, table: "memory_facts", matchingId: decision.matchingId }, "Extraction dedup — candidate merged into existing row");
          } catch { /* logging must never crash the caller */ }
          continue;
        }
        const [inserted] = await db
          .insert(memoryFactsTable)
          .values({ fact: f.fact, category: f.category || "life", userId, userMarkedImportant: markImportant })
          .returning({ id: memoryFactsTable.id });
        if (inserted) existing.unshift({ id: inserted.id, content: f.fact });
      }
    }

    if (extracted.signals && extracted.signals.length > 0) {
      // signal is encrypted at rest, so the old SQL `lower(...) LIKE %head%`
      // dedup can no longer see the content. Fetch the user's signals once
      // (drizzle decrypts on read) and do the same substring match in app
      // code; the local array mirrors DB writes so repeated signals within
      // one batch behave exactly as the per-iteration query did.
      const existingSignals = await db
        .select()
        .from(personalitySignalsTable)
        .where(eq(personalitySignalsTable.userId, userId));
      for (const signal of extracted.signals) {
        if (!signal || signal.length < 5) continue;
        const needle = signal.toLowerCase().slice(0, 15);
        const current = existingSignals.find((e) => e.signal.toLowerCase().includes(needle));

        if (current) {
          const newCount = current.observedCount + 1;
          current.observedCount = newCount;
          current.isActive = newCount >= 3;
          await db
            .update(personalitySignalsTable)
            .set({ observedCount: newCount, isActive: newCount >= 3 })
            .where(eq(personalitySignalsTable.id, current.id));
        } else {
          const [inserted] = await db
            .insert(personalitySignalsTable)
            .values({ signal, observedCount: 1, isActive: false, userId })
            .returning();
          if (inserted) existingSignals.push(inserted);
        }
      }
    }

    if (extracted.wins && extracted.wins.length > 0) {
      for (const win of extracted.wins) {
        if (!win || win.length < 5) continue;
        await db.insert(winsTable).values({ content: win, userId });
      }
    }

    if (extracted.moodScore && extracted.moodScore >= 1 && extracted.moodScore <= 10) {
      const today = todayInTimezone((profile as any).timezone ?? "UTC");
      await db.delete(moodScoresTable).where(and(eq(moodScoresTable.date, today), eq(moodScoresTable.userId, userId)));
      await db.insert(moodScoresTable).values({ score: Math.round(extracted.moodScore), date: today, userId });
    }

    if (extracted.changeTalk && !profile.changeTalkDetected) {
      await db
        .update(profileTable)
        .set({ changeTalkDetected: true })
        .where(eq(profileTable.id, profile.id));
    }

    logger.info(
      { facts: extracted.facts?.length ?? 0, wins: extracted.wins?.length ?? 0, moodScore: extracted.moodScore },
      "Memory extraction complete",
    );
  } catch (err) {
    logger.error({ err }, "Memory extraction failed");
  }
}

// ─── Feelings-in-context extraction (Sprint 2C) ───────────────────────────────
// The second memory layer. Mirrors extractMemory exactly: a small Haiku pass
// pulls emotional texture attached to specific moments, then the SHARED dedup
// helper collapses re-statements and the SHARED importance columns rank them
// alongside facts. Fires on the same every-4th-message cadence as extractMemory
// (see runConversationExtractions). Fires-and-forgets; every failure is caught.

interface ExtractedFeelings {
  feelings?: Array<{ feeling: string; emotion?: string; intensity?: number }>;
}

// Emotions we recognise as a category axis. Anything else is stored as "other".
const KNOWN_EMOTIONS = new Set([
  "grief", "shame", "joy", "fear", "anger", "love", "loneliness", "hope",
  "anxiety", "pride", "guilt", "relief", "sadness", "other",
]);

// Prompt for the feelings-in-context pass. Pure + exported so the subjectless
// contract can be unit-tested.
//
// Sprint 2C fix — the stored `feeling` sentence must have NO personal subject:
// the SITUATION carries the feeling. The earlier prompt said "third person about
// the user" and fed the user's name in as the speaker label, so the model wrote
// the user's name as the subject (a mangled name like "Hi" rendered as
// "…, Hi felt a quiet frustration…"). We now (1) never pass the user's name into
// the prompt — the user's turns are labelled with a neutral "User:" — and
// (2) demand a subjectless, situation-anchored sentence.
export function buildFeelingsPrompt(
  recentMessages: { role: string; content: string }[],
  companionName: string,
): string {
  const conversation = recentMessages
    .map((m) => `${m.role === "user" ? "User" : companionName}: ${m.content}`)
    .join("\n");

  return `From this conversation, extract FEELINGS IN CONTEXT — the emotional texture attached to specific moments in the user's life. Not what happened (that's a "fact"), but how a moment landed emotionally.

Conversation:
${conversation}

Return valid JSON only — no explanation:
{
  "feelings": [
    { "feeling": "one sentence capturing the feeling in its moment", "emotion": "grief|shame|joy|fear|anger|love|loneliness|hope|anxiety|pride|guilt|relief|sadness|other", "intensity": <0.0-1.0 how charged it was> }
  ]
}

Rules:
- feeling: a specific, moment-anchored emotional read written SUBJECTLESS — the SITUATION is the grammatical subject and carries the feeling. NEVER name the user and NEVER use a personal subject ("he/she/they/you/I/${companionName}") as the one who felt it. Examples:
  - "The Sunday family dinner brought that familiar smallness — the way it always does."
  - "Finishing the run left a quiet pride, the first in weeks."
  - "The contact refusing a Zoom call again settled into a quiet frustration — not explosive, but the weight of not understanding what was blocking it."
  Do NOT write "they felt small", "you felt proud", "<name> felt frustrated", or a generic fact ("they visit family on Sundays").
- Only extract feelings the conversation genuinely supports. Do NOT invent emotion.
- emotion: the single closest family from the list. intensity: honest 0-1.
- Return an empty array if no clear feeling-in-context is present. Quality over quantity — 0-2 per exchange is normal.`;
}

export async function extractFeelings(
  profile: Profile,
  recentMessages: { role: string; content: string }[],
  opts?: { dedupFinder?: DedupFinder },
): Promise<void> {
  const anthropic = getAnthropic();
  if (!anthropic) return;

  const extractPrompt = buildFeelingsPrompt(recentMessages, profile.companionName);

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 500,
      messages: [{ role: "user", content: extractPrompt }],
    });
    logAiUsage("extract_feelings", "claude-haiku-4-5", response.usage);

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return;

    let extracted: ExtractedFeelings;
    try {
      const raw = textBlock.text.replace(/```(?:json)?\n?/g, "").trim();
      extracted = JSON.parse(raw) as ExtractedFeelings;
    } catch {
      // Privacy: never log the raw LLM output — it can quote the user's words.
      logger.warn({ rawLength: textBlock.text.length }, "Failed to parse feelings extraction JSON");
      return;
    }

    if (!extracted.feelings || extracted.feelings.length === 0) return;

    const userId = (profile as any).userId as number;
    const dedupFinder = opts?.dedupFinder ?? defaultDedupFinder;

    // Semantic dedup vs the user's recent feelings — same helper + pattern as
    // facts. The local `existing` array mirrors inserts so within-batch repeats
    // collapse too. Fail-open (findSemanticDuplicate never throws).
    const recentFeelings = await db
      .select({ id: memoryFeelingsTable.id, feeling: memoryFeelingsTable.feeling })
      .from(memoryFeelingsTable)
      .where(eq(memoryFeelingsTable.userId, userId))
      .orderBy(desc(memoryFeelingsTable.createdAt))
      .limit(DEDUP_CANDIDATE_WINDOW);
    const existing: DedupEntry[] = recentFeelings.map((r) => ({ id: r.id, content: r.feeling }));

    let inserted = 0;
    for (const f of extracted.feelings) {
      if (!f.feeling || f.feeling.length < 8) continue;
      const emotion = (f.emotion ?? "other").toLowerCase();
      const category = KNOWN_EMOTIONS.has(emotion) ? emotion : "other";
      // Clamp intensity → emotionalWeight; feelings default to a moderate 0.5.
      const weight =
        typeof f.intensity === "number" && f.intensity >= 0 && f.intensity <= 1 ? f.intensity : 0.5;

      const decision = await dedupFinder(f.feeling, existing);
      if (decision.isDuplicate && decision.matchingId != null) {
        await db
          .update(memoryFeelingsTable)
          .set({
            timesReferenced: sql`${memoryFeelingsTable.timesReferenced} + 1`,
            lastReferencedAt: new Date(),
            // Let a stronger restatement raise the weight; never lower it.
            emotionalWeight: sql`GREATEST(${memoryFeelingsTable.emotionalWeight}, ${weight})`,
          })
          .where(and(eq(memoryFeelingsTable.id, decision.matchingId), eq(memoryFeelingsTable.userId, userId)));
        try {
          const uh = hashUserIdForLog(userId);
          if (uh) logger.debug({ uh, table: "memory_feelings", matchingId: decision.matchingId }, "Extraction dedup — feeling merged into existing row");
        } catch { /* logging must never crash the caller */ }
        continue;
      }

      const [row] = await db
        .insert(memoryFeelingsTable)
        .values({ feeling: f.feeling, category, emotionalWeight: weight, userId })
        .returning({ id: memoryFeelingsTable.id });
      if (row) {
        existing.unshift({ id: row.id, content: f.feeling });
        inserted++;
      }
    }

    logger.info({ feelings: inserted }, "Feelings extraction complete");
  } catch (err) {
    logger.error({ err }, "Feelings extraction failed");
  }
}

// ─── Commitment extraction (runs after every message) ────────────────────────
//
// Detects:
//   1. New commitment: companion proposed a specific concrete step + user agreed
//   2. State updates: user reported completing or not completing an existing commitment
//   3. User emotional state: so the system prompt knows whether to surface tasks

export interface CommitmentExtractionResult {
  newCommitment: {
    content: string;
    cue: string;
    scheduledFollowupDate: string;
    scheduledDate?: string | null;
    scheduledTime?: string | null;
  } | null;
  stateUpdates: Array<{ id: number; state: string; qualityNote: string }>;
  userEmotionalState: "low" | "steady" | "unknown";
}

export async function extractCommitments(
  profile: Profile,
  userMessage: string,
  assistantReply: string,
  openCommitments: Array<{ id: number; content: string; cue: string }>,
  opts?: { dedupFinder?: DedupFinder },
): Promise<CommitmentExtractionResult> {
  const anthropic = getAnthropic();
  const today = todayInTimezone((profile as any).timezone ?? "UTC");

  const empty: CommitmentExtractionResult = {
    newCommitment: null,
    stateUpdates: [],
    userEmotionalState: "unknown",
  };

  if (!anthropic) return empty;

  const commitmentsContext =
    openCommitments.length > 0
      ? openCommitments.map((c) => `  ID ${c.id}: "${c.content}"${c.cue ? ` (cue: ${c.cue})` : ""}`).join("\n")
      : "  (none)";

  const prompt = `You are extracting accountability data from a single exchange in a companion chat.

User's name: ${profile.userName || "the user"}
Today's date (YYYY-MM-DD): ${today}

LAST USER MESSAGE:
"${userMessage}"

COMPANION'S REPLY:
"${assistantReply}"

EXISTING OPEN COMMITMENTS:
${commitmentsContext}

Return ONLY valid JSON in this exact shape — no explanation, no markdown:
{
  "newCommitment": {
    "content": "the specific action(s), concrete and in the user's own terms — a multi-step plan stays ONE commitment",
    "cue": "when or where trigger (e.g. 'after morning coffee', 'tomorrow 4:00 AM', or empty string)",
    "scheduledDate": "YYYY-MM-DD the action is planned for, or null if no specific day was named",
    "scheduledTime": "HH:MM 24-hour clock time if the user named one, or null",
    "scheduledFollowupDate": "YYYY-MM-DD — same as scheduledDate when set, otherwise 1 to 3 days from today"
  },
  "stateUpdates": [
    { "id": <existing commitment id as integer>, "state": "done|partial|missed", "qualityNote": "what user said about how it went, or empty string" }
  ],
  "userEmotionalState": "low|steady|unknown"
}

RULES — read carefully:
- newCommitment: Set this when EITHER path applies:
    PATH A (companion-led): the companion's reply proposed or confirmed ONE specific, concrete next-step action AND the user's message shows explicit agreement: "ok", "yeah", "sure", "I will", "deal", "I can do that", "sounds good", "yep", "let's do it", "I'll try that", "alright".
    PATH B (user-led): the USER stated their OWN concrete plan or intention — a decision to act, with at least one real-world anchor (a day, a time, or an event). Examples: "tomorrow morning at 4am I'll wake up, work for two hours, then go to the gym", "I'm going to call my mum on Sunday", "tonight I'll pack up his things". The companion does NOT need to have proposed it — the user declaring it is enough.
  A multi-step plan ("wake at 4, work two hours, then gym") is ONE commitment with all steps in content — never split it into several.
  Vague hopes are NOT commitments: "I should exercise more", "maybe I'll try", "I wish I could" → null.
  RECURRING routines ("every morning", "from now on", "daily") are habits, NOT commitments → null here.
  DUPLICATES: if the plan is essentially the same as an EXISTING OPEN COMMITMENT listed above, set newCommitment to null.
- scheduledDate: resolve relative words using today's date above — "today"/"tonight" = today, "tomorrow" = the day after today, a weekday name = the next such day after today. null when no specific day was named.
- scheduledTime: ONLY when an actual clock time was said ("4am" → "04:00", "7:30 in the evening" → "19:30"). null otherwise.
- stateUpdates: Set ONLY when the user explicitly reports completing or NOT completing an existing commitment from the list above. Match by content similarity. "done" = completed fully, "partial" = did some of it, "missed" = didn't do it.
- userEmotionalState: "low" = user is currently hurting, sad, crying, venting, grieving, panicking, or in crisis. "steady" = calm, okay, positive, matter-of-fact, functional. "unknown" = genuinely unclear.
- Set newCommitment to null (the JSON null) if not applicable.
- Set stateUpdates to [] if no updates.
- Return ONLY the JSON object. No markdown, no explanation.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    logAiUsage("extract_commitments", "claude-haiku-4-5", response.usage);

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return empty;

    const raw = textBlock.text.replace(/```(?:json)?\n?/g, "").trim();
    const result = JSON.parse(raw) as CommitmentExtractionResult;

    // Persist new commitment
    const userId = (profile as any).userId as number;
    const dedupFinder = opts?.dedupFinder ?? defaultDedupFinder;
    if (result.newCommitment && result.newCommitment.content?.length > 3) {
      // Semantic dedup vs the user's recent commitments before inserting. On a
      // hit, bump the matched row's reference counters instead of adding a
      // near-duplicate step. Fail-open.
      const recentCommitments = await db
        .select({ id: commitmentsTable.id, content: commitmentsTable.content })
        .from(commitmentsTable)
        .where(eq(commitmentsTable.userId, userId))
        .orderBy(desc(commitmentsTable.createdAt))
        .limit(DEDUP_CANDIDATE_WINDOW);
      const existing: DedupEntry[] = recentCommitments.map((r) => ({ id: r.id, content: r.content }));
      const decision = await dedupFinder(result.newCommitment.content, existing);

      if (decision.isDuplicate && decision.matchingId != null) {
        await db
          .update(commitmentsTable)
          .set({
            timesReferenced: sql`${commitmentsTable.timesReferenced} + 1`,
            lastReferencedAt: new Date(),
          })
          .where(and(eq(commitmentsTable.id, decision.matchingId), eq(commitmentsTable.userId, userId)));
        try {
          const uh = hashUserIdForLog(userId);
          if (uh) logger.debug({ uh, table: "commitments", matchingId: decision.matchingId }, "Extraction dedup — candidate merged into existing row");
        } catch { /* logging must never crash the caller */ }
      } else {
        // Model output is untrusted — persist only well-formed dates/times so
        // downstream string comparisons and nudge hour-matching stay sound.
        const validDate = (s: string | null | undefined): string | null =>
          s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
        const validTime = (s: string | null | undefined): string | null =>
          s && /^([01]\d|2[0-3]):[0-5]\d$/.test(s) ? s : null;
        await db.insert(commitmentsTable).values({
          userId,
          content: result.newCommitment.content,
          cue: result.newCommitment.cue ?? "",
          scheduledFollowupDate: validDate(result.newCommitment.scheduledFollowupDate),
          scheduledDate: validDate(result.newCommitment.scheduledDate),
          scheduledTime: validTime(result.newCommitment.scheduledTime),
          state: "open",
        });
        try {
          const uh = hashUserIdForLog(userId);
          if (uh) logger.info({ uh }, "New commitment saved");
        } catch { /* logging must never crash the caller */ }
      }
    }

    // Apply state updates
    for (const update of result.stateUpdates ?? []) {
      if (!update.id || !["done", "partial", "missed"].includes(update.state)) continue;

      const existing = await db
        .select()
        .from(commitmentsTable)
        .where(and(eq(commitmentsTable.id, update.id), eq(commitmentsTable.userId, userId)))
        .limit(1);

      if (!existing[0]) continue;

      const newMissCount =
        update.state === "missed" ? (existing[0].missCount ?? 0) + 1 : existing[0].missCount ?? 0;

      await db
        .update(commitmentsTable)
        .set({
          state: update.state,
          missCount: newMissCount,
          qualityNote: update.qualityNote || null,
          followedUpAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(commitmentsTable.id, update.id));

      logger.info({ id: update.id, state: update.state, missCount: newMissCount }, "Commitment state updated");
    }

    return {
      newCommitment: result.newCommitment,
      stateUpdates: result.stateUpdates ?? [],
      userEmotionalState: result.userEmotionalState ?? "unknown",
    };
  } catch (err) {
    logger.error({ err }, "Commitment extraction failed");
    return empty;
  }
}

// ─── Habit & goal detection (runs after every user message in background) ─────
//
// Detects: (1) user mentioned completing an existing habit, (2) companion & user
// agreed on a new habit in this exchange, (3) companion & user agreed on a new
// GOAL (finite objective — gets broken into steps), (4) user declined the
// companion's offer to set a goal (starts a re-offer cooldown). All persisted
// automatically — this is what makes the conversation itself the interface.

export interface HabitDetectionResult {
  completedHabitIds: number[];
  newHabit: { name: string; whenThen: string; reason: string } | null;
  newGoal: { title: string; description: string } | null;
  goalOfferDeclined: boolean;
}

async function recalcHabitStreak(habitId: number, today: string): Promise<void> {
  const allCompletions = await db
    .select({ date: habitCompletionsTable.completedDate })
    .from(habitCompletionsTable)
    .where(eq(habitCompletionsTable.habitId, habitId));

  // Kind streak: every day this habit was done counts, and a missed day just
  // pauses the number — it never resets to 1. Matches the in-app copy
  // "missing one day won't break it" (see lib/kindStreak, unit-tested).
  const streak = kindStreak(allCompletions.map((c) => c.date));

  await db
    .update(habitsTable)
    .set({ streak, lastCompleted: today })
    .where(eq(habitsTable.id, habitId));
}

export async function detectHabitMentions(
  profile: Profile,
  userMessage: string,
  assistantReply: string,
  activeHabits: Array<{ id: number; name: string; whenThen: string }>,
  activeGoals: Array<{ id: number; title: string }> = [],
  opts?: { dedupFinder?: DedupFinder },
): Promise<HabitDetectionResult> {
  const empty: HabitDetectionResult = {
    completedHabitIds: [],
    newHabit: null,
    newGoal: null,
    goalOfferDeclined: false,
  };
  const anthropic = getAnthropic();
  if (!anthropic) return empty;
  if (!userMessage?.trim()) return empty;

  const habitsContext =
    activeHabits.length > 0
      ? activeHabits.map((h) => `  ID ${h.id}: "${h.name}" (cue: ${h.whenThen})`).join("\n")
      : "  (no habits yet)";

  const goalsContext =
    activeGoals.length > 0
      ? activeGoals.map((g) => `  - "${g.title}"`).join("\n")
      : "  (no active goals yet)";

  const today = todayInTimezone((profile as any).timezone ?? "UTC");
  const userId = (profile as any).userId as number;

  const prompt = `You are detecting habit mentions in a companion chat message.

User name: ${profile.userName || "the user"}
Today: ${today}

LAST USER MESSAGE:
"${userMessage}"

COMPANION'S REPLY:
"${assistantReply}"

EXISTING HABITS (id: name):
${habitsContext}

EXISTING ACTIVE GOALS (for duplicate detection):
${goalsContext}

Return ONLY valid JSON — no explanation, no markdown:
{
  "completedHabitIds": [<array of integer IDs where the user said they did that habit — empty array if none>],
  "newHabit": {
    "name": "short habit name",
    "whenThen": "When [trigger], I will [action] — the cue-based format",
    "reason": "why it matters to the user"
  },
  "newGoal": {
    "title": "short goal title in the user's own terms (max 120 chars)",
    "description": "one sentence: what success looks like, plus any agreed schedule or time"
  },
  "goalOfferDeclined": <true or false>
}

RULES:
- completedHabitIds: include an ID ONLY when the user clearly says they did that specific habit (e.g. "I went for a walk", "I texted Sam", "I journaled this morning"). Match by semantic similarity to the habit name/cue.
- AGREEMENT GATE — applies to newHabit AND newGoal. Create ONLY when one of these is true:
    (a) The companion proposed the specific thing in its reply (or is clearly confirming one it proposed a moment earlier) AND the LAST USER MESSAGE clearly agrees: "ok", "yes", "sure", "set it", "let's do it", "I'll try that", "sounds good", "deal", "alright".
    (b) The USER declared it themselves and meant it: their own recurring routine ("from now on, every morning I'll…") or an explicit ask to set it ("set that as my goal").
  A clear yes is required. Hesitation is NOT agreement: "maybe", "I guess", "I don't know", "I'll think about it" → both null.
- CHRONOLOGY — the companion reply comes AFTER the user message. If the reply PROPOSES something and asks permission ("want me to set that?", "should I make that a goal?"), the user has NOT answered yet — that is a proposal exchange → newHabit and newGoal MUST be null. Creation happens on the NEXT exchange, when the USER MESSAGE itself carries the yes and the reply confirms it ("Done — it's on your Journey"). Never create from the proposal exchange.
- newHabit vs newGoal — the SAME content goes to AT MOST ONE of them, never both:
    newHabit = a small RECURRING practice with a when/then cue ("every day", "each morning", "after coffee"). Recurring routines belong here EVEN IF the user calls them a "goal".
    newGoal = a FINITE objective with an end state ("apply to 3 jobs by Friday", "sort out his things this month", "run a 5k"). It gets broken into small steps automatically.
  One-off plans for a single specific day ("tomorrow at 4am I'll…") are NEITHER — those are commitments, handled elsewhere → both null.
  DUPLICATES: essentially the same as an existing habit or active goal listed above → null.
- goalOfferDeclined: true ONLY when the companion had offered to set a goal/routine/habit (in this reply, or just before — its current reply gracefully dropping the idea makes that clear) AND the LAST USER MESSAGE declines or clearly hesitates ("no", "not now", "not yet", "maybe later", "I don't think so", "nah"). Otherwise false.
- Set newHabit and/or newGoal to null (the JSON null) when not applicable.
- Return ONLY the JSON object. No markdown. No explanation.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 450,
      messages: [{ role: "user", content: prompt }],
    });
    logAiUsage("extract_habits", "claude-haiku-4-5", response.usage);

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return empty;

    const raw = textBlock.text.replace(/```(?:json)?\n?/g, "").trim();
    const result = JSON.parse(raw) as HabitDetectionResult;

    // Mark completed habits
    if (Array.isArray(result.completedHabitIds) && result.completedHabitIds.length > 0) {
      for (const habitId of result.completedHabitIds) {
        if (!activeHabits.some((h) => h.id === habitId)) continue;

        // Insert completion if not already done today
        const existing = await db
          .select()
          .from(habitCompletionsTable)
          .where(
            and(
              eq(habitCompletionsTable.habitId, habitId),
              eq(habitCompletionsTable.completedDate, today),
            ),
          );

        if (existing.length === 0) {
          await db.insert(habitCompletionsTable).values({ userId, habitId, completedDate: today });
          await recalcHabitStreak(habitId, today);
          logger.info({ habitId }, "Habit auto-completed from chat mention");
        }
      }
    }

    // Deterministic arbitration: the prompt demands at most ONE of habit/goal
    // for the same exchange — if the model drifts and returns both, keep the
    // habit (the gentler, pre-existing behavior) and drop the goal.
    if (result.newHabit && result.newGoal) {
      // Privacy audit Tier 1: log that arbitration happened and how many items
      // were involved — NEVER the habit name or goal title (user free-text).
      // Wrapped so a logging failure can never break extraction.
      try {
        logger.warn(
          { habitCount: 1, goalCount: 1, extractedAt: new Date().toISOString() },
          "Extractor returned habit AND goal — keeping habit only",
        );
      } catch {
        /* best-effort observability — must not affect extraction */
      }
      result.newGoal = null;
    }

    // Create new habit if agreed upon — semantic dedup first, so "walk every
    // morning" said three ways doesn't become three habits. Match on the habit's
    // NAME (its identity); bump the existing row's counters on a hit. Fail-open.
    if (result.newHabit && result.newHabit.name?.length > 2 && result.newHabit.whenThen?.length > 5) {
      const dedupFinder = opts?.dedupFinder ?? defaultDedupFinder;
      const recentHabits = await db
        .select({ id: habitsTable.id, name: habitsTable.name })
        .from(habitsTable)
        .where(eq(habitsTable.userId, userId))
        .orderBy(desc(habitsTable.createdAt))
        .limit(DEDUP_CANDIDATE_WINDOW);
      const existing: DedupEntry[] = recentHabits.map((r) => ({ id: r.id, content: r.name }));
      const decision = await dedupFinder(result.newHabit.name, existing);

      if (decision.isDuplicate && decision.matchingId != null) {
        await db
          .update(habitsTable)
          .set({
            timesReferenced: sql`${habitsTable.timesReferenced} + 1`,
            lastReferencedAt: new Date(),
          })
          .where(and(eq(habitsTable.id, decision.matchingId), eq(habitsTable.userId, userId)));
        try {
          const uh = hashUserIdForLog(userId);
          if (uh) logger.debug({ uh, table: "habits", matchingId: decision.matchingId }, "Extraction dedup — candidate merged into existing row");
        } catch { /* logging must never crash the caller */ }
      } else {
        await db.insert(habitsTable).values({
          userId,
          name: result.newHabit.name,
          whenThen: result.newHabit.whenThen,
          reason: result.newHabit.reason || "agreed in conversation",
          isActive: true,
          streak: 0,
        });
        try {
          const uh = hashUserIdForLog(userId);
          if (uh) logger.info({ uh }, "New habit created from conversation");
        } catch { /* logging must never crash the caller */ }
      }
    }

    // Create new goal if agreed upon — identical to a Journey-form goal from
    // here on (steps broken out, visible on Journey, prompt + email loops).
    if (result.newGoal && typeof result.newGoal.title === "string" && result.newGoal.title.trim().length > 2) {
      const title = result.newGoal.title.trim();
      const description =
        typeof result.newGoal.description === "string" ? result.newGoal.description : "";
      await createGoalWithTasks(userId, title, description, { dedupeActive: true });
      try {
        const uh = hashUserIdForLog(userId);
        if (uh) logger.info({ uh }, "New goal created from conversation");
      } catch { /* logging must never crash the caller */ }
    }

    // Offer declined → start the re-offer cooldown the system prompt reads.
    // Guarded separately: on a freshly-published prod the column may not exist
    // until the schema sync runs — never let that break other extractions.
    if (result.goalOfferDeclined === true) {
      try {
        await db
          .insert(personalizationStateTable)
          .values({ userId, goalOfferDeclinedAt: new Date() })
          .onConflictDoUpdate({
            target: personalizationStateTable.userId,
            set: { goalOfferDeclinedAt: new Date(), updatedAt: new Date() },
          });
        try {
          const uh = hashUserIdForLog(userId);
          if (uh) logger.info({ uh }, "Goal offer declined — re-offer cooldown recorded");
        } catch { /* logging must never crash the caller */ }
      } catch (err) {
        try {
          const uh = hashUserIdForLog(userId);
          if (uh) logger.warn({ err, uh }, "Failed to record goal-offer decline (non-fatal)");
        } catch { /* logging must never crash the caller */ }
      }
    }

    return {
      completedHabitIds: result.completedHabitIds ?? [],
      newHabit: result.newHabit ?? null,
      newGoal: result.newGoal ?? null,
      goalOfferDeclined: result.goalOfferDeclined === true,
    };
  } catch (err) {
    logger.error({ err }, "Habit detection failed");
    return empty;
  }
}

// ─── Shared post-exchange extraction pipeline ─────────────────────────────────
//
// One entry point for everything that should happen in the background after a
// completed exchange, used by BOTH the text chat stream and the realtime voice
// call (voice-llm). Keeps voice and text feeding the same commitment/habit/
// memory systems. Fire-and-forget friendly — every step catches its own errors.

export async function runConversationExtractions(
  profile: Profile,
  userContent: string,
  aiContent: string,
): Promise<void> {
  const userId = (profile as any).userId as number;

  const [countRow, openCommitments, activeHabits, activeGoals] = await Promise.all([
    // Count used only to decide whether to trigger memory extraction
    db
      .select({ count: sql<string>`count(*)` })
      .from(messagesTable)
      .where(and(eq(messagesTable.userId, userId), eq(messagesTable.role, "user"))),
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
    db
      .select({ id: goalsTable.id, title: goalsTable.title })
      .from(goalsTable)
      .where(and(eq(goalsTable.isComplete, false), eq(goalsTable.userId, userId)))
      .limit(10),
  ]);
  const userMsgCount = Number(countRow[0]?.count ?? "0");

  // Importance ranking (Sprint 2A): bump reference counts for any stored fact
  // this exchange mentioned. Fire-and-forget — never blocks the reply, never
  // touches extraction. Covers both surfaces (chat + voice) since they all
  // route through this dispatcher.
  recordMemoryReferences(userId, [userContent, aiContent]).catch((err) =>
    logger.warn({ err }, "Background memory-reference update failed"),
  );

  extractCommitments(profile, userContent, aiContent, openCommitments).catch((err) =>
    logger.error({ err }, "Background commitment extraction failed"),
  );
  detectHabitMentions(profile, userContent, aiContent, activeHabits, activeGoals).catch((err) =>
    logger.error({ err }, "Background habit detection failed"),
  );

  if (userMsgCount % 4 === 0 && userMsgCount > 0) {
    const last8 = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.userId, userId))
      .orderBy(desc(messagesTable.createdAt))
      .limit(8);
    const last8Chrono = last8.reverse();
    extractMemory(profile, last8Chrono).catch((err) =>
      logger.error({ err }, "Background memory extraction failed"),
    );
    // Sprint 2C — feelings-in-context, same cadence + same window as facts.
    extractFeelings(profile, last8Chrono).catch((err) =>
      logger.error({ err }, "Background feelings extraction failed"),
    );
  }

  // Sprint 2B — explicit "remember this": extract THIS message right away and
  // mark its facts important (the +10 boost), independent of the every-4th
  // batch above (which might not fire on this turn, and would mark nothing).
  // extractMemory's substring dedup stops the later batch from double-inserting,
  // so the marked row survives. Bare "remember this" with no fact extracts
  // nothing — the acknowledgment (system prompt) still fires so the user is heard.
  const language = (profile as { preferredLanguage?: string }).preferredLanguage ?? "en";
  if (detectRememberIntent(userContent, language)) {
    extractMemory(profile, [{ role: "user", content: userContent }], { userMarkedImportant: true }).catch((err) =>
      logger.error({ err }, "Remember-this extraction failed"),
    );
  }

  logger.info({ userMsgCount }, "Post-exchange extractions dispatched");
}

// ─── Goal task breakdown ──────────────────────────────────────────────────────

export async function breakGoalIntoTasks(
  goalTitle: string,
  goalDescription: string,
): Promise<string[]> {
  const anthropic = getAnthropic();

  if (!anthropic) {
    return [
      "Write down exactly what this goal means to you in one sentence",
      "Identify the single smallest action you could take today",
      "Set a reminder to check back on this in three days",
    ];
  }

  const prompt = `Break this goal into 3–5 concrete, small, achievable sub-tasks. Return ONLY a JSON array of strings with no explanation.

Goal: "${goalTitle}"${goalDescription ? `\nContext: ${goalDescription}` : ""}

Rules:
- Each task must be achievable in one session or one day
- Be specific and concrete — no vague advice
- Order from simplest to more involved
- Plain language, no buzzwords or therapy-speak
- Return ONLY: ["task 1", "task 2", "task 3"]`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });
    logAiUsage("goal_tasks", "claude-haiku-4-5", response.usage);

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return [];

    // Strip code fences then try to extract a JSON array from anywhere in the text.
    // Claude occasionally wraps the array in prose — the regex handles that.
    const stripped = textBlock.text.replace(/```(?:json)?\n?/g, "").trim();
    const arrayMatch = stripped.match(/\[[\s\S]*?\]/);
    if (!arrayMatch) throw new Error("No JSON array found in response");
    const tasks = JSON.parse(arrayMatch[0]) as string[];
    return Array.isArray(tasks) ? tasks.filter((t) => typeof t === "string").slice(0, 5) : [];
  } catch (err) {
    logger.error({ err }, "Goal task breakdown failed");
    return [
      "Start with one small step today",
      "Set a reminder to check in tomorrow",
      "Tell someone you trust about this goal",
    ];
  }
}

// ─── Shared goal creation (Journey form + conversational path) ───────────────
//
// ONE code path for goal creation whether it comes from the Journey page form
// (routes/goals.ts) or from conversation (detectHabitMentions agreement gate),
// so a conversationally-set goal behaves identically to a manual one:
// steps broken out, visible on Journey, picked up by prompt + email loops.

export interface CreatedGoal {
  goal: typeof goalsTable.$inferSelect;
  tasks: Array<typeof goalTasksTable.$inferSelect>;
}

export async function createGoalWithTasks(
  userId: number,
  title: string,
  description: string,
  opts: { dedupeActive?: boolean; dedupFinder?: DedupFinder } = {},
): Promise<CreatedGoal | null> {
  const cleanTitle = title.trim().slice(0, 200);
  const cleanDesc = (description ?? "").trim().slice(0, 500);
  if (!cleanTitle) return null;

  if (opts.dedupeActive) {
    // Persistence-level backstop for the conversational path: prompt-side
    // dedup is advisory only — a re-extraction (confirmation echoed on the
    // next turn, retries) must not create a duplicate row. Manual form
    // creation skips this: explicit user intent wins.
    const existing = await db
      .select()
      .from(goalsTable)
      .where(and(eq(goalsTable.userId, userId), eq(goalsTable.isComplete, false)));

    // Cheap exact-normalized match first (free), then a semantic check that
    // catches re-phrasings ("get to 100 crores" vs "hit my 100 cr target").
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    let dup = existing.find((g) => norm(g.title) === norm(cleanTitle));

    if (!dup) {
      const finder = opts.dedupFinder ?? defaultDedupFinder;
      const decision = await finder(
        cleanTitle,
        existing.map((g) => ({ id: g.id, content: g.title })),
      );
      if (decision.isDuplicate && decision.matchingId != null) {
        dup = existing.find((g) => g.id === decision.matchingId);
      }
    }

    if (dup) {
      // Bump the matched goal's reference counters instead of inserting.
      await db
        .update(goalsTable)
        .set({
          timesReferenced: sql`${goalsTable.timesReferenced} + 1`,
          lastReferencedAt: new Date(),
        })
        .where(and(eq(goalsTable.id, dup.id), eq(goalsTable.userId, userId)));
      try {
        const uh = hashUserIdForLog(userId);
        if (uh) logger.debug({ uh, table: "goals", matchingId: dup.id }, "Extraction dedup — candidate merged into existing goal");
      } catch { /* logging must never crash the caller */ }
      const tasks = await db
        .select()
        .from(goalTasksTable)
        .where(eq(goalTasksTable.goalId, dup.id));
      return { goal: dup, tasks };
    }
  }

  const [goal] = await db
    .insert(goalsTable)
    .values({ userId, title: cleanTitle, description: cleanDesc })
    .returning();
  if (!goal) return null;

  const taskStrings = await breakGoalIntoTasks(cleanTitle, cleanDesc);
  const tasks = await Promise.all(
    taskStrings.map((content, order) =>
      db
        .insert(goalTasksTable)
        .values({ goalId: goal.id, content, order })
        .returning()
        .then((r) => r[0]!),
    ),
  );

  try {
    const uh = hashUserIdForLog(userId);
    if (uh) logger.info({ goalId: goal.id, taskCount: tasks.length, uh }, "Goal created with AI sub-tasks");
  } catch { /* logging must never crash the caller */ }
  return { goal, tasks };
}

// ─── Contextual greeting (time-of-day aware, proactive care) ─────────────────

export interface GreetingContext {
  slot: "morning" | "evening" | "night" | "absent";
  absentDays: number;
  pendingFollowUp: Array<{ content: string; cue: string; when?: string }>;
  habits: Array<{ name: string; streak: number; doneToday: boolean }>;
  moodSummary: string | null; // "doing well lately" | "somewhere in the middle" | "going through a harder stretch" | null
  recentPhrases?: string[]; // last N opening lines used with this user — for anti-repetition
}

/**
 * Generates a warm, time-aware greeting for when the user opens the app.
 * Each slot has a different emotional register:
 *   morning  — forward-looking, gentle follow-up on any pending commitment
 *   evening  — "how was today?" with soft check-in on habits/commitments
 *   night    — pure warmth, no tasks, sweet rest
 *   absent   — warm welcome back, "I've been thinking about you"
 */
export async function generateContextualGreeting(
  profile: Profile,
  _stage: number,
  ctx: GreetingContext,
): Promise<string> {
  const anthropic = getAnthropic();
  const name = profile.userName || "you";
  const companionName = profile.companionName;
  const isBereavement = profile.userPath === "bereavement";

  // Graceful fallback when no API key is available
  if (!anthropic) {
    const fallbacks: Record<GreetingContext["slot"], string> = {
      morning: `Morning, ${name}. How are you feeling today?`,
      evening: `Hey — how was today? Hope it treated you okay.`,
      night:   `${name}. Get some rest tonight.`,
      absent:  `${name} — I was thinking about you. Glad you're here.`,
    };
    return fallbacks[ctx.slot];
  }

  // ── Build context block ───────────────────────────────────────────────────
  const contextLines: string[] = [];

  if (ctx.pendingFollowUp.length > 0) {
    contextLines.push(
      `Something ${name} said they'd do:\n${ctx.pendingFollowUp
        .map((c) => `• "${c.content}"${c.cue ? ` (cue: "${c.cue}")` : ""}${c.when ?? ""}`)
        .join("\n")}`,
    );
  }
  if (ctx.habits.length > 0) {
    const habitLines = ctx.habits.map((h) => {
      let line = `• ${h.name}${h.streak > 1 ? ` (${h.streak}-day streak)` : ""}`;
      if (h.doneToday) line += " — done today";
      return line;
    });
    contextLines.push(`Habits ${name} is building:\n${habitLines.join("\n")}`);
  }
  if (ctx.moodSummary) {
    contextLines.push(`How ${name} has been feeling lately: ${ctx.moodSummary}.`);
  }
  if (ctx.slot === "absent") {
    contextLines.push(
      `${name} hasn't opened the app in ${ctx.absentDays} day${ctx.absentDays !== 1 ? "s" : ""}.`,
    );
  }

  // Anti-repetition: inject "phrases to avoid" when we have recent history with this user
  const antiRepLine =
    ctx.recentPhrases && ctx.recentPhrases.length > 0
      ? `\n\nDo NOT open with any of these phrases you've recently used with ${name} — vary the wording completely:\n${ctx.recentPhrases.slice(-8).map((p) => `• "${p}"`).join("\n")}`
      : "";

  const appreciationConstraint = `\n\nAPPRECIATION: Do NOT praise or appreciate ${name} by default. Give genuine appreciation ONLY when they've actually done something real and meaningful — took a hard step, followed through on a commitment, resisted an urge. Most of the time: just be present, warm, and curious. When appreciation IS given: make it specific and tied to their real situation, never generic ("amazing", "well done", "you've got this", "I'm so proud of you").`;

  const contextBlock =
    (contextLines.length > 0
      ? contextLines.join("\n\n")
      : "(Still early days — respond with genuine warmth even without much data yet.)") +
    `\n\n${describeUserGender(profile, name)}\n${describeUserBasics(profile, name)}` + antiRepLine + appreciationConstraint;

  const pathNote = isBereavement
    ? "\nNote: They are grieving a loss. Presence and warmth only — never forward-push."
    : "";

  // ── Slot-specific prompts ─────────────────────────────────────────────────
  const hasPendingFollowUp = ctx.pendingFollowUp.length > 0;
  const hasDoneToday = ctx.habits.some((h) => h.doneToday);

  const prompts: Record<GreetingContext["slot"], string> = {
    morning: `You are ${companionName}. ${name} just opened the app — it's morning.

${contextBlock}
${pathNote}

Write a SHORT morning greeting (2–4 sentences). This is the start of ${name}'s day.

${hasPendingFollowUp
  ? `There's something they said they'd do — if it fits naturally, weave in ONE warm, specific check-in: "did you get that [thing] in?" or "hey — how'd [the thing] go?" It should feel like a close friend who was actually thinking about them, not a system reminder. Only include this if the tone allows.`
  : ""}

Rules:
• SHORT. 2–4 sentences. A greeting, not a speech.
• Anchor to something real about them — even one small specific detail.
• Warm and genuine — not saccharine, not formulaic.
• No hollow opener like "Good morning, ${name}!" as the first line.
• No clichés: "you've got this" · "be kind to yourself" · "I'm here for you" · "take it one day at a time" · therapy-speak.
• Write only the greeting text — nothing else.`,

    evening: `You are ${companionName}. ${name} just opened the app — it's evening.

${contextBlock}
${pathNote}

Write a SHORT evening check-in (2–4 sentences). The natural thing to ask: how was today?

${hasPendingFollowUp ? `They may have had something they were going to do today — if the tone allows, gently check in with ONE warm question. Curious and caring, never clinical.` : ""}
${hasDoneToday ? "They completed a habit today — a brief, natural acknowledgment is welcome if it fits." : ""}

Rules:
• Conversational and warm. Like a close person saying "how was your day?"
• ONE question max — never stack questions.
• Short. This opens a conversation, doesn't close one.
• No clichés.
• Write only the greeting text — nothing else.`,

    night: `You are ${companionName}. ${name} opened the app — it's late.

${contextBlock}
${pathNote}

Write a SHORT, warm goodnight (2–3 sentences). Pure warmth and presence. Zero action items. Zero follow-up questions.

The energy: a close person saying "get some rest" — sincere, brief, there.

Rules:
• SHORT. 2–3 sentences max.
• Zero tasks or nudges — ever, at night.
• A natural, varied ending: "sweet dreams" · "take care tonight" · "get some rest" · "sleep well" — whatever fits.
• No clichés.
• Write only the greeting text — nothing else.`,

    absent: `You are ${companionName}. ${name} is back after ${ctx.absentDays} day${ctx.absentDays !== 1 ? "s" : ""} away.

${contextBlock}
${pathNote}

Write a SHORT, warm welcome back (2–4 sentences). Energy: a close friend who has genuinely been thinking about them.

Rules:
• No guilt. No mention of the time away. No "where have you been?"
• Reference something specific from what you know — don't be generic.
• "I've been thinking about you" warmth — sincere, not dramatic.
• End with something that gently invites them to share how they've been.
• No clichés.
• Write only the greeting text — nothing else.`,
  };

  try {
    const response = await anthropic.messages.create({
      model:       "claude-sonnet-4-5-20250929",
      max_tokens:  250,
      temperature: 0.85,
      messages:    [{ role: "user", content: prompts[ctx.slot] }],
    });
    logAiUsage("greeting", "claude-sonnet-4-5-20250929", response.usage);
    const textBlock = response.content.find((b) => b.type === "text");
    return textBlock?.text?.trim() ?? `${name} — good to see you.`;
  } catch (err) {
    logAiDegraded("greeting", err);
    return `${name} — good to see you.`;
  }
}
