import { desc, eq, and, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  memoryFactsTable,
  personalitySignalsTable,
  winsTable,
  moodScoresTable,
  profileTable,
  messagesTable,
  commitmentsTable,
  habitsTable,
  habitCompletionsTable,
  type Profile,
} from "@workspace/db";
import { logger } from "../lib/logger.js";
import { todayInTimezone } from "./stage.js";

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

// ─── Core: stream companion reply (primary path) ──────────────────────────────
// Uses Anthropic streaming + prompt caching on the system prompt.
// Calls onChunk with each text delta so the caller can push it to the client
// in real-time. Returns the full accumulated text when the stream ends.

export async function streamCompanionReply(
  systemPrompt: string,
  contextMessages: { role: string; content: string }[],
  userContent: string,
  stage: number,
  onChunk: (text: string) => void,
): Promise<string> {
  const anthropic = getAnthropic();

  if (!anthropic) {
    logger.warn("ANTHROPIC_API_KEY not set — streaming mock response");
    const mock = getMockResponse(stage);
    const words = mock.split(" ");
    for (let i = 0; i < words.length; i++) {
      await new Promise((r) => setTimeout(r, 55 + Math.random() * 65));
      onChunk((i === 0 ? "" : " ") + words[i]);
    }
    return mock;
  }

  try {
    const messages = [
      ...contextMessages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
      { role: "user" as const, content: userContent },
    ];

    let fullText = "";

    // Use cache_control on the system block so the large static system prompt
    // is cached by Anthropic for 5 min — cuts both latency and cost on repeat messages.
    const stream = await (anthropic.messages.create as any)({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 600,
      temperature: 0.8,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages,
      stream: true,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta"
      ) {
        const chunk = event.delta.text as string;
        fullText += chunk;
        onChunk(chunk);
      }
    }

    return fullText || "I'm here. Tell me more.";
  } catch (err) {
    logger.error({ err }, "Anthropic streaming error, falling back to mock");
    const mock = getMockResponse(stage);
    onChunk(mock);
    return mock;
  }
}

// ─── Core: get companion reply (non-streaming fallback / background use) ───────

export async function getCompanionReply(
  systemPrompt: string,
  contextMessages: { role: string; content: string }[],
  userContent: string,
  stage: number,
): Promise<string> {
  const anthropic = getAnthropic();

  if (!anthropic) {
    logger.warn("ANTHROPIC_API_KEY not set — using mock response");
    return getMockResponse(stage);
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
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ] as any,
      messages,
    });

    const textBlock = response.content.find((b) => b.type === "text");
    return textBlock?.text ?? "I'm here. Tell me more.";
  } catch (err) {
    logger.error({ err }, "Anthropic API error, falling back to mock");
    return getMockResponse(stage);
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
    stage >= 3
      ? db
          .select()
          .from(commitmentsTable)
          .where(
            and(
              eq(commitmentsTable.userId, userId),
              sql`${commitmentsTable.state} = 'open' AND ${commitmentsTable.scheduledFollowupDate} <= ${today}`,
            ),
          )
          .limit(2)
      : Promise.resolve([]),
  ]);

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

  const followUpText =
    pendingFollowUps.length > 0
      ? `\nThere are pending commitments to gently and warmly check in on (ONLY if the note's tone allows — never robotic, never guilt-inducing): ${pendingFollowUps.map((c) => `"${c.content}"${c.cue ? ` (cue: ${c.cue})` : ""}`).join("; ")}`
      : "";

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
        .map((c) => `• "${c.content}"${c.cue ? ` (cue: ${c.cue})` : ""}`)
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
    const textBlock = response.content.find((b) => b.type === "text");
    return (
      textBlock?.text ??
      `${profile.userName ? profile.userName + " — " : ""}thinking of you today.`
    );
  } catch {
    return `${profile.userName ? profile.userName + " — " : ""}I'm here with you today.`;
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

export async function extractMemory(
  profile: Profile,
  recentMessages: { role: string; content: string }[],
): Promise<void> {
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
  "facts": [{"fact": "...", "category": "life|preference|event|person|goal"}],
  "signals": ["personality/communication style observations about the user"],
  "wins": ["things the user reports doing or accomplishing in real life"],
  "moodScore": <1-10 estimate of user's current emotional state, 1=very low, 10=excellent>,
  "changeTalk": <true if user expressed wanting to change, move forward, or get out of the pain>
}

Rules:
- facts: concrete, durable things about the user's life (job, interests, people in their life, events)
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

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return;

    let extracted: ExtractedMemory;
    try {
      const raw = textBlock.text.replace(/```(?:json)?\n?/g, "").trim();
      extracted = JSON.parse(raw) as ExtractedMemory;
    } catch {
      logger.warn({ text: textBlock.text }, "Failed to parse memory extraction JSON");
      return;
    }

    const userId = (profile as any).userId as number;
    if (extracted.facts && extracted.facts.length > 0) {
      const existingFacts = await db.select().from(memoryFactsTable).where(eq(memoryFactsTable.userId, userId));
      for (const f of extracted.facts) {
        if (!f.fact || f.fact.length < 5) continue;
        const isDuplicate = existingFacts.some(
          (e) =>
            e.fact.toLowerCase().includes(f.fact.toLowerCase().slice(0, 20)) ||
            f.fact.toLowerCase().includes(e.fact.toLowerCase().slice(0, 20)),
        );
        if (!isDuplicate) {
          await db.insert(memoryFactsTable).values({ fact: f.fact, category: f.category || "life", userId });
        }
      }
    }

    if (extracted.signals && extracted.signals.length > 0) {
      for (const signal of extracted.signals) {
        if (!signal || signal.length < 5) continue;
        const existing = await db
          .select()
          .from(personalitySignalsTable)
          .where(
            and(
              eq(personalitySignalsTable.userId, userId),
              sql`lower(${personalitySignalsTable.signal}) like ${"%" + signal.toLowerCase().slice(0, 15) + "%"}`,
            ),
          );

        if (existing.length > 0) {
          const current = existing[0]!;
          const newCount = current.observedCount + 1;
          await db
            .update(personalitySignalsTable)
            .set({ observedCount: newCount, isActive: newCount >= 3 })
            .where(eq(personalitySignalsTable.id, current.id));
        } else {
          await db.insert(personalitySignalsTable).values({ signal, observedCount: 1, isActive: false, userId });
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

// ─── Commitment extraction (runs after every message) ────────────────────────
//
// Detects:
//   1. New commitment: companion proposed a specific concrete step + user agreed
//   2. State updates: user reported completing or not completing an existing commitment
//   3. User emotional state: so the system prompt knows whether to surface tasks

export interface CommitmentExtractionResult {
  newCommitment: { content: string; cue: string; scheduledFollowupDate: string } | null;
  stateUpdates: Array<{ id: number; state: string; qualityNote: string }>;
  userEmotionalState: "low" | "steady" | "unknown";
}

export async function extractCommitments(
  profile: Profile,
  userMessage: string,
  assistantReply: string,
  openCommitments: Array<{ id: number; content: string; cue: string }>,
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
    "content": "the exact specific action (one concrete step with who/what)",
    "cue": "when or where trigger (e.g. 'after morning coffee', 'tomorrow evening', or empty string)",
    "scheduledFollowupDate": "YYYY-MM-DD — 1 to 3 days from today"
  },
  "stateUpdates": [
    { "id": <existing commitment id as integer>, "state": "done|partial|missed", "qualityNote": "what user said about how it went, or empty string" }
  ],
  "userEmotionalState": "low|steady|unknown"
}

RULES — read carefully:
- newCommitment: Set this ONLY when ALL of the following are true:
    (a) The companion's reply proposed or confirmed ONE specific, concrete next-step action (not vague, not a general suggestion)
    (b) The user's message shows explicit agreement: "ok", "yeah", "sure", "I will", "deal", "I can do that", "sounds good", "yep", "let's do it", "I'll try that", "alright"
    (c) The commitment has a real-world cue (time, event, or trigger) — if the companion didn't give one, set cue to empty string
    If ANY condition fails, set newCommitment to null.
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

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return empty;

    const raw = textBlock.text.replace(/```(?:json)?\n?/g, "").trim();
    const result = JSON.parse(raw) as CommitmentExtractionResult;

    // Persist new commitment
    const userId = (profile as any).userId as number;
    if (result.newCommitment && result.newCommitment.content?.length > 3) {
      await db.insert(commitmentsTable).values({
        userId,
        content: result.newCommitment.content,
        cue: result.newCommitment.cue ?? "",
        scheduledFollowupDate: result.newCommitment.scheduledFollowupDate ?? null,
        state: "open",
      });
      logger.info({ content: result.newCommitment.content }, "New commitment saved");
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

// ─── Habit detection (runs after every user message in background) ────────────
//
// Detects: (1) user mentioned completing an existing habit, (2) companion & user
// agreed on a new habit in this exchange. Both are persisted automatically.

export interface HabitDetectionResult {
  completedHabitIds: number[];
  newHabit: { name: string; whenThen: string; reason: string } | null;
}

async function recalcHabitStreak(habitId: number, today: string): Promise<void> {
  const allCompletions = await db
    .select({ date: habitCompletionsTable.completedDate })
    .from(habitCompletionsTable)
    .where(eq(habitCompletionsTable.habitId, habitId));

  const completedDates = new Set(allCompletions.map((c) => c.date));

  let streak = 0;
  let checkDate = today;

  if (!completedDates.has(today)) {
    const d = new Date(today);
    d.setDate(d.getDate() - 1);
    const yesterday = d.toISOString().slice(0, 10);
    if (!completedDates.has(yesterday)) {
      streak = 0;
    } else {
      checkDate = yesterday;
    }
  }

  if (completedDates.has(checkDate)) {
    while (completedDates.has(checkDate)) {
      streak++;
      const d = new Date(checkDate);
      d.setDate(d.getDate() - 1);
      checkDate = d.toISOString().slice(0, 10);
    }
  }

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
): Promise<HabitDetectionResult> {
  const empty: HabitDetectionResult = { completedHabitIds: [], newHabit: null };
  const anthropic = getAnthropic();
  if (!anthropic) return empty;
  if (!userMessage?.trim()) return empty;

  const habitsContext =
    activeHabits.length > 0
      ? activeHabits.map((h) => `  ID ${h.id}: "${h.name}" (cue: ${h.whenThen})`).join("\n")
      : "  (no habits yet)";

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

Return ONLY valid JSON — no explanation, no markdown:
{
  "completedHabitIds": [<array of integer IDs where the user said they did that habit — empty array if none>],
  "newHabit": {
    "name": "short habit name",
    "whenThen": "When [trigger], I will [action] — the cue-based format",
    "reason": "why it matters to the user"
  }
}

RULES:
- completedHabitIds: include an ID ONLY when the user clearly says they did that specific habit (e.g. "I went for a walk", "I texted Sam", "I journaled this morning"). Match by semantic similarity to the habit name/cue.
- newHabit: set ONLY when BOTH are true:
    (a) The companion explicitly suggested a specific new habit with a clear when/then cue in its reply
    (b) The user agreed to it ("ok", "yeah", "sure", "I'll try that", "sounds good", "alright", "deal")
  Otherwise set newHabit to null.
- Return ONLY the JSON object. No markdown. No explanation.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 250,
      messages: [{ role: "user", content: prompt }],
    });

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

    // Create new habit if agreed upon
    if (result.newHabit && result.newHabit.name?.length > 2 && result.newHabit.whenThen?.length > 5) {
      await db.insert(habitsTable).values({
        userId,
        name: result.newHabit.name,
        whenThen: result.newHabit.whenThen,
        reason: result.newHabit.reason || "agreed in conversation",
        isActive: true,
        streak: 0,
      });
      logger.info({ name: result.newHabit.name }, "New habit created from conversation");
    }

    return {
      completedHabitIds: result.completedHabitIds ?? [],
      newHabit: result.newHabit ?? null,
    };
  } catch (err) {
    logger.error({ err }, "Habit detection failed");
    return empty;
  }
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

// ─── Contextual greeting (time-of-day aware, proactive care) ─────────────────

export interface GreetingContext {
  slot: "morning" | "evening" | "night" | "absent";
  absentDays: number;
  pendingFollowUp: Array<{ content: string; cue: string }>;
  habits: Array<{ name: string; streak: number; doneToday: boolean }>;
  moodSummary: string | null; // "doing well lately" | "somewhere in the middle" | "going through a harder stretch" | null
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
        .map((c) => `• "${c.content}"${c.cue ? ` (cue: "${c.cue}")` : ""}`)
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

  const contextBlock = contextLines.length > 0
    ? contextLines.join("\n\n")
    : "(Still early days — respond with genuine warmth even without much data yet.)";

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
    const textBlock = response.content.find((b) => b.type === "text");
    return textBlock?.text?.trim() ?? `${name} — good to see you.`;
  } catch (err) {
    logger.error({ err }, "Contextual greeting generation failed");
    return `${name} — good to see you.`;
  }
}
