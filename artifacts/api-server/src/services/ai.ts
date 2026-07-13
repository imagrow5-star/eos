import { desc, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  memoryFactsTable,
  personalitySignalsTable,
  winsTable,
  moodScoresTable,
  profileTable,
  messagesTable,
  type Profile,
} from "@workspace/db";
import { logger } from "../lib/logger.js";
import { todayString } from "./stage.js";

// Anthropic client — lazy init so mock mode works without the key
let _anthropic: import("@anthropic-ai/sdk").Anthropic | null = null;

function getAnthropic(): import("@anthropic-ai/sdk").Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_anthropic) {
    // Dynamic import to avoid crashing when key is absent
    const Anthropic =
      require("@anthropic-ai/sdk").default ||
      require("@anthropic-ai/sdk").Anthropic;
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

// ─── Mock mode responses by stage ───────────────────────────────────────────

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

// ─── Core: get companion reply ────────────────────────────────────────────────

export async function getCompanionReply(
  systemPrompt: string,
  contextMessages: { role: string; content: string }[],
  userContent: string,
  stage: number,
): Promise<string> {
  const anthropic = getAnthropic();

  if (!anthropic) {
    logger.warn("ANTHROPIC_API_KEY not set — using mock response");
    // Simulate a short delay so typing indicator feels realistic
    await new Promise((r) => setTimeout(r, 1200 + Math.random() * 800));
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
      model: "claude-opus-4-5",
      max_tokens: 600,
      system: systemPrompt,
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
  const facts = await db
    .select()
    .from(memoryFactsTable)
    .orderBy(desc(memoryFactsTable.createdAt))
    .limit(10);

  const wins = await db
    .select()
    .from(winsTable)
    .orderBy(desc(winsTable.createdAt))
    .limit(3);

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
    facts.length > 0
      ? facts.map((f) => f.fact).join("; ")
      : "still getting to know each other";

  const winsText =
    wins.length > 0
      ? wins.map((w) => w.content).join("; ")
      : "no wins logged yet";

  const prompt =
    stage <= 2
      ? `Write a short, warm morning note (3–5 sentences) from ${profile.companionName} to ${profile.userName || "them"}. Pure warmth — no advice, no suggestions. Reference their real life naturally: ${factsText}. Day ${daysSinceStart} of their journey. Not a wellness lecture. Human and personal.`
      : `Write a short morning note (4–6 sentences) from ${profile.companionName} to ${profile.userName || "them"}. Warm and personal. Reference their real life: ${factsText}. Acknowledge their wins: ${winsText}. Day ${daysSinceStart}. Include one tiny real-world nudge for today. No emojis. No buzzwords.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    return (
      textBlock?.text ??
      `Good morning, ${profile.userName || ""}. I'm thinking of you today.`
    );
  } catch {
    return `Good morning, ${profile.userName || ""}. I'm here, thinking of you.`;
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
      // Strip markdown code fences if present
      const raw = textBlock.text.replace(/```(?:json)?\n?/g, "").trim();
      extracted = JSON.parse(raw) as ExtractedMemory;
    } catch {
      logger.warn({ text: textBlock.text }, "Failed to parse memory extraction JSON");
      return;
    }

    // Store facts (deduplicate by checking for very similar existing facts)
    if (extracted.facts && extracted.facts.length > 0) {
      const existingFacts = await db.select().from(memoryFactsTable);
      for (const f of extracted.facts) {
        if (!f.fact || f.fact.length < 5) continue;
        const isDuplicate = existingFacts.some(
          (e) =>
            e.fact.toLowerCase().includes(f.fact.toLowerCase().slice(0, 20)) ||
            f.fact.toLowerCase().includes(e.fact.toLowerCase().slice(0, 20)),
        );
        if (!isDuplicate) {
          await db.insert(memoryFactsTable).values({
            fact: f.fact,
            category: f.category || "life",
          });
        }
      }
    }

    // Store/update personality signals
    if (extracted.signals && extracted.signals.length > 0) {
      for (const signal of extracted.signals) {
        if (!signal || signal.length < 5) continue;
        const existing = await db
          .select()
          .from(personalitySignalsTable)
          .where(
            sql`lower(${personalitySignalsTable.signal}) like ${"%" + signal.toLowerCase().slice(0, 15) + "%"}`,
          );

        if (existing.length > 0) {
          const current = existing[0]!;
          const newCount = current.observedCount + 1;
          await db
            .update(personalitySignalsTable)
            .set({
              observedCount: newCount,
              isActive: newCount >= 3,
            })
            .where(eq(personalitySignalsTable.id, current.id));
        } else {
          await db.insert(personalitySignalsTable).values({
            signal,
            observedCount: 1,
            isActive: false,
          });
        }
      }
    }

    // Store wins
    if (extracted.wins && extracted.wins.length > 0) {
      for (const win of extracted.wins) {
        if (!win || win.length < 5) continue;
        await db.insert(winsTable).values({ content: win });
      }
    }

    // Store mood score
    if (
      extracted.moodScore &&
      extracted.moodScore >= 1 &&
      extracted.moodScore <= 10
    ) {
      const today = todayString();
      // One score per day — upsert by deleting existing today entry
      await db
        .delete(moodScoresTable)
        .where(eq(moodScoresTable.date, today));
      await db.insert(moodScoresTable).values({
        score: Math.round(extracted.moodScore),
        date: today,
      });
    }

    // Update change talk on profile
    if (extracted.changeTalk && !profile.changeTalkDetected) {
      await db
        .update(profileTable)
        .set({ changeTalkDetected: true })
        .where(eq(profileTable.id, profile.id));
    }

    logger.info(
      {
        facts: extracted.facts?.length ?? 0,
        wins: extracted.wins?.length ?? 0,
        moodScore: extracted.moodScore,
      },
      "Memory extraction complete",
    );
  } catch (err) {
    logger.error({ err }, "Memory extraction failed");
  }
}

// ─── Goal task breakdown ──────────────────────────────────────────────────────

export async function breakGoalIntoTasks(
  goalTitle: string,
  goalDescription: string,
): Promise<string[]> {
  const anthropic = getAnthropic();

  if (!anthropic) {
    // Sensible mock sub-tasks when no API key
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

    const raw = textBlock.text.replace(/```(?:json)?\n?/g, "").trim();
    const tasks = JSON.parse(raw) as string[];
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
