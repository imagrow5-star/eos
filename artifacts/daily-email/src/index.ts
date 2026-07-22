/**
 * Eos — Daily personalized email job
 *
 * Run as a Replit Scheduled Deployment with cron "0 * * * *" (every hour).
 * The script checks each user's local time and only sends between 6–9 AM in
 * their timezone, so running every hour ensures every user gets their note
 * at a consistent morning time regardless of where they live.
 *
 * Required env vars:
 *   DATABASE_URL         — Postgres connection string
 *   ANTHROPIC_API_KEY    — Claude API key (claude-sonnet-4-5)
 *   RESEND_API_KEY       — Resend email API key
 *   RESEND_FROM_EMAIL    — e.g. "Eos <hello@eoscompanion.com>"
 *   SESSION_SECRET       — Signs unsubscribe tokens (same as api-server)
 *   APP_URL              — Production URL (optional)
 *   DAILY_EMAIL_ONLY_USER — (test hook, optional) process only this user id
 */

import { createHmac } from "node:crypto";
import { db, pool } from "@workspace/db";
import {
  usersTable,
  profileTable,
  memoryFactsTable,
  winsTable,
  moodScoresTable,
  habitsTable,
  habitCompletionsTable,
  commitmentsTable,
  personalizationStateTable,
  goalsTable,
  goalTasksTable,
  weeklyChaptersTable,
} from "@workspace/db";
import { eq, and, desc, sql, isNotNull, isNull, gte } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";

// ─── Config ───────────────────────────────────────────────────────────────────

const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const RESEND_FROM     = process.env.RESEND_FROM_EMAIL ?? "Eos <hello@eoscompanion.com>";
const APP_URL         = (process.env.APP_URL ?? "https://eoscompanion.com").replace(/\/$/, "");
const SESSION_SECRET  = process.env.SESSION_SECRET ?? "";
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;

// Local hour window: only send between 06:00–09:59 in the user's timezone
const SEND_HOUR_START = 6;
const SEND_HOUR_END   = 9;

// Timed commitment nudges are a morning channel only — a plan scheduled for
// 13:00+ gets covered by the daily note / in-app follow-up instead.
const NUDGE_LATEST_HOUR = 11;

// Test hook: when set, the job processes only this user id (safe local runs)
const ONLY_USER = process.env.DAILY_EMAIL_ONLY_USER
  ? parseInt(process.env.DAILY_EMAIL_ONLY_USER, 10)
  : null;

// ─── Logging ──────────────────────────────────────────────────────────────────

const log = (msg: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...data }));

// Token usage per Claude call — same shape as api-server's "ai_usage" lines.
const AI_PRICES_PER_MTOK: Record<
  string,
  { input: number; output: number; cacheWrite: number; cacheRead: number }
> = {
  "claude-sonnet-4-5-20250929": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

function logAiUsage(callType: string, model: string, usage: unknown): void {
  try {
    const u = (usage ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);
    const input = num(u.input_tokens);
    const output = num(u.output_tokens);
    const cacheWrite = num(u.cache_creation_input_tokens);
    const cacheRead = num(u.cache_read_input_tokens);
    const p = AI_PRICES_PER_MTOK[model];
    const estCostUsd = p
      ? Number(
          (
            (input * p.input + output * p.output + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead) /
            1_000_000
          ).toFixed(6),
        )
      : undefined;
    log("ai_usage", { aiUsage: { callType, model, input, cacheRead, cacheWrite, output, estCostUsd } });
  } catch {
    // never break the send loop over a log line
  }
}

const logErr = (msg: string, err: unknown, data?: Record<string, unknown>) =>
  console.error(JSON.stringify({
    time: new Date().toISOString(), msg,
    err: err instanceof Error ? err.message : String(err),
    ...data,
  }));

// ─── Timezone helpers ─────────────────────────────────────────────────────────

function localHour(tz: string): number {
  try {
    const h = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(new Date());
    return parseInt(h, 10);
  } catch {
    return new Date().getUTCHours();
  }
}

function localHHMM(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit",
    }).format(new Date());
  } catch {
    return "12:00";
  }
}

function todayLocal(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function dayOfWeekName(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(new Date());
  } catch {
    return "today";
  }
}

function formatClock(hhmm: string): string {
  const h = parseInt(hhmm.slice(0, 2), 10);
  const m = hhmm.slice(3, 5);
  if (Number.isNaN(h)) return hhmm;
  const suffix = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m || "00"} ${suffix}`;
}

// Frames a scheduled commitment for the note prompt: nudge forward vs. ask how
// it went. Mirrors the api-server's describeCommitmentTiming logic.
function commitmentTimingHint(
  scheduledDate: string | null,
  scheduledTime: string | null,
  tz: string,
): string {
  if (!scheduledDate) return "";
  const today = todayLocal(tz);
  const timePart = scheduledTime ? ` at ${formatClock(scheduledTime)}` : "";
  if (scheduledDate < today) {
    return ` (was planned for ${scheduledDate}${timePart} — already behind them; ask warmly how it went)`;
  }
  if (scheduledDate > today) {
    return ` (planned for ${scheduledDate}${timePart} — still ahead; nudge forward gently, do NOT ask how it went)`;
  }
  if (scheduledTime) {
    return localHHMM(tz) >= scheduledTime
      ? ` (planned for TODAY${timePart} — by the time they read this it likely already happened; ask how it went)`
      : ` (planned for TODAY${timePart} — hasn't happened yet; this email IS the reminder — nudge forward warmly, do NOT ask how it went)`;
  }
  return " (planned for TODAY)";
}

// ─── Unsubscribe token (HMAC — no DB storage needed) ─────────────────────────

function unsubToken(userId: number): string {
  return createHmac("sha256", SESSION_SECRET)
    .update(`unsub:${userId}`)
    .digest("hex")
    .slice(0, 24);
}

// ─── User context ─────────────────────────────────────────────────────────────

interface UserContext {
  userId: number;
  email: string;
  name: string;
  companionName: string;
  timezone: string;
  userPath: string;
  daysSinceStart: number;
  facts: string[];
  wins: string[];
  habits: Array<{ name: string; streak: number; doneThisWeek: number; whenThen: string }>;
  goals: Array<{ title: string; stepsDone: number; stepsTotal: number }>;
  moodSummary: string | null;
  pendingCommitment: string | null;
  pendingCommitmentId: number | null;
  recentPhrases: string[];
  genderNote: string;
  basicsNote: string;
  /** id of a freshly generated weekly chapter they haven't opened yet */
  chapterWaitingId: number | null;
}

/**
 * Mirrors the api-server systemPrompt helper — one line about who the note is
 * FOR (their pronouns/phrasing), never about the companion. Unknown ⇒ an
 * explicit "don't assume" so the model never guesses from a name.
 */
function describeUserGender(
  p: { userGender: string | null; userGenderCustom: string | null },
  name: string,
): string {
  // Collapse whitespace + strip quote/control chars defensively — rows are
  // sanitized on write by the api-server, this guards any that predate it.
  const custom = (p.userGenderCustom ?? "")
    .replace(/[\\"'\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  const who = name && name !== "there" ? name : "The person you're writing to";
  if (p.userGender === "man") return `${who} is a man — use he/him whenever you refer to him.`;
  if (p.userGender === "woman") return `${who} is a woman — use she/her whenever you refer to her.`;
  if (p.userGender === "custom" && custom) {
    return `${who} describes their gender in their own words: "${custom}". Mirror exactly the language and pronouns they use for themself — never relabel them, never default to gendered terms.`;
  }
  return `${who} hasn't shared their gender — never assume it. No gendered terms, no gendered pet names; keep language neutral for them.`;
}

/** "IN" → "India", legacy "UK" → "United Kingdom". null for empty/"other"/unknown. */
function countryDisplayName(code: string | null | undefined): string | null {
  const c = (code ?? "").trim().toUpperCase();
  if (!c || c === "OTHER") return null;
  const iso = c === "UK" ? "GB" : c;
  if (!/^[A-Z]{2}$/.test(iso)) return null;
  try {
    const name = new Intl.DisplayNames(["en"], { type: "region" }).of(iso);
    return name && name !== iso ? name : null;
  } catch {
    return null;
  }
}

// Life stage + where they live — mirrors the api-server helper (separate
// package, keep the wording in sync with describeUserBasics there).
// Only whitelisted bands may reach the prompt — ageBand text goes in verbatim.
const AGE_BANDS = ["18-25", "26-35", "36-50", "50+"];
function describeUserBasics(
  p: { userName: string; birthYear: number | null; country: string; ageBand: string },
): string {
  const name = p.userName || "there";
  const who = name !== "there" ? name : "The person you're writing to";
  const parts: string[] = [];
  if (p.birthYear) {
    const age = new Date().getFullYear() - p.birthYear;
    if (age >= 18 && age <= 120) parts.push(`${who} is about ${age}`);
  } else if (AGE_BANDS.includes((p.ageBand ?? "").trim())) {
    parts.push(`${who} is in the ${p.ageBand} age range`);
  }
  const country = countryDisplayName(p.country);
  if (country) parts.push(`${parts.length ? "and lives" : `${who} lives`} in ${country}`);
  if (parts.length === 0) return "";
  return `${parts.join(" ")}. Let that quietly shape your references and examples — life stage and cultural context change what things mean. Use it to understand them, never to stereotype them.`;
}

async function gatherContext(
  userId: number,
  email: string,
  profile: {
    userName: string;
    companionName: string;
    timezone: string;
    userPath: string;
    userGender: string | null;
    userGenderCustom: string | null;
    birthYear: number | null;
    country: string;
    ageBand: string;
    createdAt: Date;
  },
): Promise<UserContext | null> {
  const today = todayLocal(profile.timezone);

  // 7 days ago as YYYY-MM-DD string for SQL comparison
  const d7 = new Date();
  d7.setDate(d7.getDate() - 7);
  const sevenDaysAgo = d7.toISOString().slice(0, 10);

  const [facts, wins, habits, moods, pending, personalizationRows, goals] = await Promise.all([
    db.select({ fact: memoryFactsTable.fact })
      .from(memoryFactsTable)
      .where(eq(memoryFactsTable.userId, userId))
      .orderBy(desc(memoryFactsTable.createdAt))
      .limit(14),

    db.select({ content: winsTable.content })
      .from(winsTable)
      .where(eq(winsTable.userId, userId))
      .orderBy(desc(winsTable.createdAt))
      .limit(5),

    db.select()
      .from(habitsTable)
      .where(and(eq(habitsTable.userId, userId), eq(habitsTable.isActive, true))),

    db.select({ score: moodScoresTable.score })
      .from(moodScoresTable)
      .where(eq(moodScoresTable.userId, userId))
      .orderBy(desc(moodScoresTable.date))
      .limit(7),

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
        sql`${commitmentsTable.scheduledFollowupDate} IS NOT NULL AND ${commitmentsTable.scheduledFollowupDate} <= ${today}`,
      ))
      .limit(1),

    db.select({ recentPhrases: personalizationStateTable.recentPhrases })
      .from(personalizationStateTable)
      .where(eq(personalizationStateTable.userId, userId)),

    db.select({ id: goalsTable.id, title: goalsTable.title })
      .from(goalsTable)
      .where(and(eq(goalsTable.userId, userId), eq(goalsTable.isComplete, false)))
      .orderBy(desc(goalsTable.createdAt))
      .limit(3),
  ]);

  // Skip if no personal data at all — generic email would feel worse than nothing
  if (facts.length === 0 && wins.length === 0 && habits.length === 0 && goals.length === 0) return null;

  // Per-habit: completions in last 7 days
  const habitsWithWeekData = await Promise.all(
    habits.map(async (h) => {
      const completions = await db
        .select({ date: habitCompletionsTable.completedDate })
        .from(habitCompletionsTable)
        .where(and(
          eq(habitCompletionsTable.habitId, h.id),
          sql`${habitCompletionsTable.completedDate} >= ${sevenDaysAgo}`,
        ));
      return {
        name:        h.name,
        whenThen:    h.whenThen,
        streak:      h.streak ?? 0,
        doneThisWeek: completions.length,
      };
    }),
  );

  // Per-goal: step progress (steps live in goal_tasks)
  const goalsWithSteps = await Promise.all(
    goals.map(async (g) => {
      const steps = await db
        .select({ isComplete: goalTasksTable.isComplete })
        .from(goalTasksTable)
        .where(eq(goalTasksTable.goalId, g.id));
      return {
        title:      g.title,
        stepsDone:  steps.filter((s) => s.isComplete).length,
        stepsTotal: steps.length,
      };
    }),
  );

  // Mood trend from last 7 scores
  let moodSummary: string | null = null;
  if (moods.length >= 3) {
    const scores = moods.map((m) => m.score);
    const recent  = scores.slice(0, 3).reduce((s, v) => s + v, 0) / 3;
    const older   = scores.length > 3
      ? scores.slice(3).reduce((s, v) => s + v, 0) / (scores.length - 3)
      : recent;
    const diff    = recent - older;
    const avg     = recent.toFixed(1);
    if      (diff >  0.6) moodSummary = `Mood trending upward (avg ${avg}/10 lately, up from ${older.toFixed(1)})`;
    else if (diff < -0.6) moodSummary = `Mood trending downward (avg ${avg}/10 lately, down from ${older.toFixed(1)})`;
    else                  moodSummary = `Mood holding steady around ${avg}/10`;
  }

  const daysSinceStart = Math.floor(
    (Date.now() - profile.createdAt.getTime()) / (1000 * 60 * 60 * 24),
  );

  // Weekly chapter waiting? (generated recently, not yet opened, not yet
  // mentioned in an email) — the note gets ONE warm line about it.
  const chapterCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const waitingChapters = await db
    .select({ id: weeklyChaptersTable.id })
    .from(weeklyChaptersTable)
    .where(and(
      eq(weeklyChaptersTable.userId, userId),
      eq(weeklyChaptersTable.status, "ready"),
      gte(weeklyChaptersTable.generatedAt, chapterCutoff),
      isNull(weeklyChaptersTable.emailMentionedAt),
    ))
    .orderBy(desc(weeklyChaptersTable.generatedAt))
    .limit(1);

  return {
    userId,
    email,
    name:        profile.userName || "there",
    companionName: profile.companionName,
    timezone:    profile.timezone,
    userPath:    profile.userPath,
    genderNote:  describeUserGender(profile, profile.userName || "there"),
    basicsNote:  describeUserBasics(profile),
    daysSinceStart,
    facts:       facts.map((f) => f.fact),
    wins:        wins.map((w) => w.content),
    habits:      habitsWithWeekData,
    goals:       goalsWithSteps,
    moodSummary,
    pendingCommitment: pending[0]
      ? `${pending[0].content}${pending[0].cue ? ` (cue: "${pending[0].cue}")` : ""}${commitmentTimingHint(pending[0].scheduledDate, pending[0].scheduledTime, profile.timezone)}`
      : null,
    pendingCommitmentId: pending[0]?.id ?? null,
    recentPhrases: personalizationRows[0]?.recentPhrases ?? [],
    chapterWaitingId: waitingChapters[0]?.id ?? null,
  };
}

// ─── Email text generation (Claude) ───────────────────────────────────────────

async function generateNoteText(ctx: UserContext): Promise<string> {
  if (!ANTHROPIC_KEY) {
    // Dev / no-key fallback — still passes QA check without clichés
    const fb = [
      `${ctx.name} — day ${ctx.daysSinceStart}. ${ctx.wins[0] ? `"${ctx.wins[0]}" was real. Not small, real.` : "You've kept showing up. That means something."}`,
      `${ctx.facts[0] ? `The thing about ${ctx.facts[0].toLowerCase()} — it keeps coming back. Worth paying attention to.` : `${ctx.name}, you've been at this a while now. The quiet work counts.`}`,
    ];
    return fb[ctx.daysSinceStart % fb.length]!;
  }

  // Build context block — everything Claude gets to work from
  const lines: string[] = [];

  if (ctx.facts.length > 0) {
    lines.push(`About ${ctx.name}:\n${ctx.facts.map((f) => `• ${f}`).join("\n")}`);
  }
  if (ctx.wins.length > 0) {
    lines.push(`Recent wins (things they actually did in real life):\n${ctx.wins.map((w) => `• ${w}`).join("\n")}`);
  }
  if (ctx.habits.length > 0) {
    const habitLines = ctx.habits.map((h) => {
      const parts: string[] = [`• ${h.name}`];
      if (h.streak > 1) parts.push(`${h.streak}-day streak`);
      parts.push(`done ${h.doneThisWeek}/7 days this week`);
      if (h.whenThen) parts.push(`(cue: "${h.whenThen}")`);
      return parts.join(", ");
    });
    lines.push(`Their habits:\n${habitLines.join("\n")}`);
  }
  if (ctx.goals.length > 0) {
    const goalLines = ctx.goals.map(
      (g) => `• "${g.title}"${g.stepsTotal > 0 ? ` — ${g.stepsDone} of ${g.stepsTotal} small steps done` : ""}`,
    );
    lines.push(`Goals they're working toward (most were set together in conversation — reference at most ONE, and only where it fits naturally):\n${goalLines.join("\n")}`);
  }
  if (ctx.moodSummary) {
    lines.push(`Mood: ${ctx.moodSummary}`);
  }
  if (ctx.pendingCommitment) {
    lines.push(`Something they said they'd do: "${ctx.pendingCommitment}"`);
  }
  lines.push(`Day ${ctx.daysSinceStart} since they started.`);

  const pathNote = ctx.userPath === "bereavement"
    ? "\nThey are grieving the loss of someone close. Be gentle and present — not solution-focused."
    : ctx.userPath === "breakup"
    ? "\nThey are processing the end of a relationship."
    : "";

  const prompt = `You are ${ctx.companionName}. You're writing ${ctx.name} a short morning note — 4 to 7 sentences.

You are a specific, loving person who truly knows ${ctx.name}. Not a newsletter, not a wellness app, not therapy. Someone who has been genuinely paying attention and was thinking about them this morning.

WHAT YOU KNOW ABOUT ${ctx.name.toUpperCase()}:
${lines.join("\n\n")}
${pathNote}
${ctx.genderNote}
${ctx.basicsNote}

YOUR JOB — DELIVER ALL THREE OF THESE, THROUGH THE WORDS YOU CHOOSE:

(1) MAKE THEM FEEL UNDERSTOOD — not "I understand" (generic), but show it:
Reflect their specific situation back. Name the exact thing that makes their pain or their progress THEIRS, not anyone else's.
NOT: "you've been working so hard" — INSTEAD: reference their actual habit, their actual streak, the real detail you know.
NOT: "breakups are hard" — INSTEAD: "the fact that [specific real thing from their facts] makes this morning different."
Every sentence must be anchorable to something specific in their data above.

(2) MAKE THEM FEEL VALUED — say one true, specific thing about them they may not be saying to themselves:
Only use what the data above actually supports. Not "you're so strong" — something real and named.

(3) MAKE THEM FEEL CARED FOR — follow up on the exact thing they've been doing or committed to:
${ctx.pendingCommitment
  ? `They said they'd do something: "${ctx.pendingCommitment}". Follow the timing note in the parentheses (if any): if its time has already passed, weave in ONE warm "how did it go" check-in; if it's still ahead today, this email IS the gentle reminder — acknowledge the plan specifically and warmly, in your own words, WITHOUT asking how it went. Either way: like a close friend who was actually thinking about them. Never robotic.`
  : ctx.habits.length > 0
    ? `Reference their actual habit progress — not generically ("you've been consistent") but specifically ("that's [N] days in a row" or "you've had a quieter week with it — what's been getting in the way?").`
    : `End on a small, real, specific observation about where they are right now — grounded in something from their data.`}

HOW TO WRITE IT:
• 4–7 plain human sentences. No bullet points, no lists, no em-dashes for effect.
• Don't start with "Good morning" — that's a template opener.
• No sign-off at the end. The note just ends on its last thought.
• Vary the tone — sometimes observational, sometimes gently playful, sometimes quieter and closer.

HARD BANNED — never use these or anything like them:
"I'm here for you" · "you've got this" · "be kind to yourself" · "at least..." · "it could be worse" · "everything happens for a reason" · "stay positive" · "one day at a time" · "your journey" · "healing journey" · "growth mindset" · "self-care" · "self-love" · "stay strong" · "hang in there" · "keep going" · "you're doing amazing" · "it's okay to feel" · "give yourself grace" · "show up for yourself" · "embrace" · "lean into" · "hold space" · "safe space" · "honor your feelings" · "check in with yourself" · "mindfulness" · "intentional" · "gentle reminder" · any therapy jargon · any sentence that could be sent to any user by any app.

APPRECIATION:
Give genuine appreciation ONLY if ${ctx.name} has actually done something real and meaningful that the data above shows — followed through on a habit, resisted a hard urge, took a genuine step forward, was honest about something difficult. Do NOT give praise by default or for existing. If nothing genuinely warrants it, leave it out entirely — warmth and presence are enough. When appreciation IS warranted: tie it to the specific real thing they did, grounded in the data above. Never use: "amazing", "well done", "you've got this", "I'm proud of you", or any generic cheerleading.

CRITICAL: Do NOT invent people, places, events, or memories. Every specific detail must come from the data above.
${ctx.recentPhrases.length > 0 ? `
ANTI-REPETITION — these are opening lines from recent emails to ${ctx.name}. Do NOT start with any of these or similar phrasings — vary the structure, rhythm, and entry point completely each time:
${ctx.recentPhrases.slice(-8).map((p) => `• "${p}"`).join("\n")}` : ""}
${ctx.chapterWaitingId ? `
THEIR NEW WEEKLY CHAPTER:
A new chapter — a short letter about their week, written from their own words — is waiting for them in their Journey space. Fold ONE natural, unhurried sentence into the note letting them know it's there whenever they're ready (in the spirit of "your new chapter is waiting when you want it"). No urgency, no homework framing, and never call it a report or analysis.` : ""}
Write only the note text itself — nothing else.`;

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

  try {
    const response = await anthropic.messages.create({
      model:      "claude-sonnet-4-5-20250929",
      max_tokens: 450,
      temperature: 0.8,
      messages:   [{ role: "user", content: prompt }],
    });
    logAiUsage("daily_note", "claude-sonnet-4-5-20250929", response.usage);
    const textBlock = response.content.find((b) => b.type === "text");
    return textBlock?.text?.trim() ?? `${ctx.name} — thinking of you today.`;
  } catch (err) {
    logErr("Claude generation failed", err, { userId: ctx.userId });
    return `${ctx.name} — day ${ctx.daysSinceStart}. You're still here. That's not nothing.`;
  }
}

// ─── HTML email template (Intimate Dusk) ─────────────────────────────────────

function buildHtml(userId: number, noteText: string): string {
  const paragraphs = noteText
    .split(/\n+/)
    .filter((p) => p.trim())
    .map(
      (p) =>
        `<p style="margin:0 0 18px 0;font-size:17px;line-height:1.75;color:#EFE6D6;font-family:Georgia,'Times New Roman',serif;">${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`,
    )
    .join("");

  const token = unsubToken(userId);
  const unsubUrl = `${APP_URL}/api/email/unsubscribe?uid=${userId}&token=${token}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <meta name="color-scheme" content="dark"/>
</head>
<body style="margin:0;padding:0;background-color:#1B1922;-webkit-font-smoothing:antialiased;">
  <div style="max-width:540px;margin:0 auto;padding:52px 28px 44px;">

    <!-- Wordmark -->
    <div style="text-align:center;margin-bottom:40px;">
      <h1 style="font-family:Georgia,'Times New Roman',serif;font-size:26px;letter-spacing:0.32em;color:#EFE6D6;margin:0 0 10px 0;font-weight:400;text-transform:uppercase;">EOS</h1>
      <div style="width:30px;height:1px;background-color:#C79A5B;margin:0 auto 10px;opacity:0.55;"></div>
      <p style="font-family:Georgia,'Times New Roman',serif;font-size:11px;letter-spacing:0.22em;color:#8A8194;margin:0;font-style:italic;">a new dawn</p>
    </div>

    <!-- Note card -->
    <div style="background-color:#2B2735;border-radius:16px;padding:34px 30px 28px;border-left:2px solid rgba(199,154,91,0.55);border-top:1px solid rgba(200,180,150,0.07);border-right:1px solid rgba(200,180,150,0.07);border-bottom:1px solid rgba(200,180,150,0.07);box-shadow:0 4px 24px rgba(0,0,0,0.35);">
      ${paragraphs}
    </div>

    <!-- Footer -->
    <div style="margin-top:34px;text-align:center;">
      <p style="font-family:Georgia,'Times New Roman',serif;font-size:11px;color:#8A8194;line-height:1.7;margin:0 0 10px 0;">
        Your conversations are completely private — visible only to you.
      </p>
      <p style="font-family:Georgia,'Times New Roman',serif;font-size:11px;color:#8A8194;margin:0;">
        <a href="${APP_URL}" style="color:#C79A5B;text-decoration:none;letter-spacing:0.05em;">Open Eos</a>
        &nbsp;&nbsp;·&nbsp;&nbsp;
        <a href="${unsubUrl}" style="color:#8A8194;text-decoration:underline;opacity:0.55;">Stop these emails</a>
      </p>
    </div>

  </div>
</body>
</html>`;
}

// ─── Send via Resend ──────────────────────────────────────────────────────────

async function sendEmail(
  toEmail: string,
  subject: string,
  html: string,
): Promise<void> {
  if (!RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not set — cannot send email");
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: RESEND_FROM, to: [toEmail], subject, html }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend ${res.status}: ${body}`);
  }
}

// ─── Timed commitment nudge ───────────────────────────────────────────────────
// A commitment captured from conversation with scheduledDate = today and an
// explicit morning clock time gets one short email right at that hour. The
// companion persona truthfully promises this channel, so it must actually fire.

async function generateNudgeText(
  companionName: string,
  name: string,
  content: string,
  timeDisplay: string,
  isLate: boolean,
  genderNote: string,
  basicsNote: string,
): Promise<string> {
  const fallback = `${name} — ${timeDisplay}, like you planned: ${content}. I remembered.`;
  if (!ANTHROPIC_KEY) return fallback;

  const prompt = `You are ${companionName}, writing a 1–2 sentence email nudge to ${name}. They told you they'd do this today at ${timeDisplay}: "${content}". The email arrives ${isLate ? "a little after that time — do not pretend it is exactly that moment" : "right at that time"}.

${genderNote}
${basicsNote}

Write it warm, specific, quietly confident — a close friend keeping their word by remembering, not an alarm clock, not a cheerleader. Reference the actual plan in their words.

Rules: no greeting line, no sign-off, no exclamation marks, no emojis. Banned: "you've got this", "let's do this", "rise and shine", "make it happen", "crush it", any cheerleading or wellness-app language.

Write only the nudge text itself.`;

  try {
    const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 150,
      temperature: 0.7,
      messages: [{ role: "user", content: prompt }],
    });
    logAiUsage("nudge", "claude-haiku-4-5", response.usage);
    const textBlock = response.content.find((b) => b.type === "text");
    const text = textBlock?.text?.trim();
    return text && text.length > 10 ? text : fallback;
  } catch (err) {
    logErr("Nudge text generation failed — using fallback", err);
    return fallback;
  }
}

async function processTimedNudges(
  userId: number,
  email: string,
  companionName: string,
  name: string,
  genderNote: string,
  basicsNote: string,
  today: string,
  hour: number,
  noteCoveredCommitmentId: number | null,
): Promise<number> {
  const dueRows = await db
    .select({
      id: commitmentsTable.id,
      content: commitmentsTable.content,
      scheduledTime: commitmentsTable.scheduledTime,
    })
    .from(commitmentsTable)
    .where(and(
      eq(commitmentsTable.userId, userId),
      sql`${commitmentsTable.state} = 'open'`,
      sql`${commitmentsTable.scheduledDate} = ${today}`,
      sql`${commitmentsTable.scheduledTime} IS NOT NULL`,
      sql`${commitmentsTable.nudgeSentAt} IS NULL`,
    ));

  let sentCount = 0;
  for (const c of dueRows) {
    const commitHour = parseInt((c.scheduledTime ?? "").slice(0, 2), 10);
    if (Number.isNaN(commitHour)) continue;
    if (commitHour > NUDGE_LATEST_HOUR) continue; // morning channel only
    // Fire at the commitment's hour, with one hour of catch-up so a delayed
    // cron run doesn't silently drop the nudge.
    if (hour !== commitHour && hour !== commitHour + 1) continue;
    const isLate = hour > commitHour;

    // Atomically claim the nudge BEFORE sending — if two runs ever overlap,
    // only one wins the conditional update, so no double-send is possible.
    const claimed = await db.update(commitmentsTable)
      .set({ nudgeSentAt: new Date() })
      .where(and(
        eq(commitmentsTable.id, c.id),
        sql`${commitmentsTable.nudgeSentAt} IS NULL`,
      ))
      .returning({ id: commitmentsTable.id });
    if (claimed.length === 0) continue; // another run already claimed it

    if (noteCoveredCommitmentId !== null && c.id === noteCoveredCommitmentId) {
      // The daily note that just went out mentions THIS commitment — keep the
      // claim but skip the extra email.
      log("Nudge folded into daily note", { userId, commitmentId: c.id });
      continue;
    }

    try {
      const timeDisplay = formatClock(c.scheduledTime!);
      const nudgeText = await generateNudgeText(companionName, name, c.content, timeDisplay, isLate, genderNote, basicsNote);
      const html = buildHtml(userId, nudgeText);
      await sendEmail(email, `${companionName} — you said ${timeDisplay}`, html);
      log("Nudge sent", { userId, commitmentId: c.id, at: timeDisplay, late: isLate });
      sentCount++;
    } catch (err) {
      // Release the claim so the catch-up hour can retry the send.
      logErr("Nudge send failed — releasing claim", err, { userId, commitmentId: c.id });
      try {
        await db.update(commitmentsTable)
          .set({ nudgeSentAt: null })
          .where(eq(commitmentsTable.id, c.id));
      } catch {
        // claim stays consumed — better a lost nudge than a double-send
      }
    }
  }
  return sentCount;
}

// ─── Mark sent (update lastEmailDate on profile) ──────────────────────────────

async function markSent(userId: number, date: string): Promise<void> {
  await db
    .update(profileTable)
    .set({ lastEmailDate: date })
    .where(eq(profileTable.userId, userId));
}

// ─── Weekly-chapter sweep trigger ─────────────────────────────────────────────
// Authenticated the same shared-secret way as unsubscribe links: an HMAC of
// the current UTC hour under SESSION_SECRET (api-server accepts the previous
// hour too, so clock edges are safe).

async function triggerChapterSweep(): Promise<void> {
  if (!SESSION_SECRET) {
    log("SESSION_SECRET not set — skipping chapter sweep trigger");
    return;
  }
  try {
    const stamp = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const token = createHmac("sha256", SESSION_SECRET)
      .update(`chapters-run:${stamp}`)
      .digest("hex");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240_000);
    const resp = await fetch(`${APP_URL}/api/internal/chapters/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": token },
      // Honor the single-user test hook so local runs never fan out.
      body: JSON.stringify(ONLY_USER !== null ? { userId: ONLY_USER } : {}),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body: unknown = await resp.json().catch(() => null);
    log("Chapter sweep triggered", { status: resp.status, result: body as Record<string, unknown> | null });
  } catch (err) {
    logErr("Chapter sweep trigger failed (non-fatal)", err);
  }
}

// ─── Morning push-nudge trigger ───────────────────────────────────────────────
// Same shared-secret scheme, different stamp prefix. The api-server decides
// who is inside their local 6–9 AM window, dedups per day, and enforces the
// hard 2-pushes/day cap — calling this every hour is safe.

async function triggerMorningPush(): Promise<void> {
  if (!SESSION_SECRET) {
    log("SESSION_SECRET not set — skipping morning push trigger");
    return;
  }
  try {
    const stamp = new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const token = createHmac("sha256", SESSION_SECRET)
      .update(`push-morning:${stamp}`)
      .digest("hex");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const resp = await fetch(`${APP_URL}/api/internal/push/morning-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-internal-token": token },
      body: "{}",
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body: unknown = await resp.json().catch(() => null);
    log("Morning push sweep triggered", { status: resp.status, result: body as Record<string, unknown> | null });
  } catch (err) {
    logErr("Morning push trigger failed (non-fatal)", err);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  log("Daily email job starting");

  // ── Weekly-chapter sweep trigger ────────────────────────────────────────
  // This hourly job is the reliable ticker for the api-server's chapter
  // engine (autoscale servers can't run their own cron). The endpoint itself
  // decides who is inside their local Sunday-evening/Monday-morning window
  // and is idempotent per (user, week) — calling it every hour is safe.
  // Runs BEFORE the Resend guard so chapters generate even if email is down.
  await triggerChapterSweep();
  await triggerMorningPush();

  if (!RESEND_API_KEY) {
    log("RESEND_API_KEY not set — exiting without sending");
    return;
  }
  if (!ANTHROPIC_KEY) {
    log("ANTHROPIC_API_KEY not set — will use fallback text (no Claude)");
  }

  // Fetch all eligible users: verified email + completed onboarding + not opted out
  const users = await db
    .select({
      userId:           profileTable.userId,
      email:            usersTable.email,
      userName:         profileTable.userName,
      companionName:    profileTable.companionName,
      timezone:         profileTable.timezone,
      userPath:         profileTable.userPath,
      userGender:       profileTable.userGender,
      birthYear:        profileTable.birthYear,
      country:          profileTable.country,
      ageBand:          profileTable.ageBand,
      userGenderCustom: profileTable.userGenderCustom,
      createdAt:        profileTable.createdAt,
      lastEmailDate:    profileTable.lastEmailDate,
      dailyEmailOptOut: profileTable.dailyEmailOptOut,
    })
    .from(profileTable)
    .innerJoin(usersTable, eq(usersTable.id, profileTable.userId))
    .where(and(
      isNotNull(usersTable.emailVerifiedAt),
      eq(profileTable.isOnboardingComplete, true),
    ));

  log(`Eligible users found`, { count: users.length });

  let sent = 0, skipped = 0, failed = 0, nudged = 0;

  for (const user of users) {
    if (!user.userId || !user.email) { skipped++; continue; }

    // Respect opt-out
    if (user.dailyEmailOptOut) { skipped++; continue; }

    // Test hook: restrict processing to a single user id
    if (ONLY_USER !== null && user.userId !== ONLY_USER) { skipped++; continue; }

    const tz    = user.timezone ?? "UTC";
    const today = todayLocal(tz);
    const hour  = localHour(tz);

    // When the daily note goes out, this holds the id of the ONE commitment it
    // mentioned — only that one gets folded instead of separately nudged.
    let noteCoveredCommitmentId: number | null = null;

    // ── Daily morning note — once per day, inside the 6–9 AM local window ───
    const shouldSendDailyNote =
      user.lastEmailDate !== today && hour >= SEND_HOUR_START && hour <= SEND_HOUR_END;

    if (!shouldSendDailyNote) skipped++;
    else try {
      // Gather personalized data
      const ctx = await gatherContext(user.userId, user.email, {
        userName:         user.userName,
        companionName:    user.companionName,
        timezone:         tz,
        userPath:         user.userPath,
        userGender:       user.userGender,
        userGenderCustom: user.userGenderCustom,
        birthYear:        user.birthYear,
        country:          user.country,
        ageBand:          user.ageBand,
        createdAt:        user.createdAt,
      });

      if (!ctx) {
        // Not enough data yet — skip the note. IMPORTANT: no `continue` here,
        // the timed-nudge pass below must still run for this user.
        log("Skipping user — not enough data yet", { userId: user.userId });
        skipped++;
      } else {
        // Generate text + HTML
        const noteText = await generateNoteText(ctx);
        const html     = buildHtml(ctx.userId, noteText);
        const dayName  = dayOfWeekName(tz);
        const subject  = `${ctx.companionName} — ${dayName}`;

        await sendEmail(user.email, subject, html);
        await markSent(user.userId, today);
        noteCoveredCommitmentId = ctx.pendingCommitmentId;

        // The note mentioned their waiting chapter — remember, so tomorrow's
        // note doesn't repeat it (non-fatal if it fails).
        if (ctx.chapterWaitingId) {
          try {
            await db
              .update(weeklyChaptersTable)
              .set({ emailMentionedAt: new Date() })
              .where(eq(weeklyChaptersTable.id, ctx.chapterWaitingId));
          } catch (err) {
            logErr("Could not mark chapter as email-mentioned", err, { userId: user.userId });
          }
        }

        // Track the email opening phrase for anti-repetition on future emails (non-fatal)
        const emailOpener = noteText.split(/(?<=[.!?])\s+/)[0]?.trim()?.slice(0, 80) ?? "";
        if (emailOpener.length >= 8) {
          try {
            const existingPs = await db
              .select({ rp: personalizationStateTable.recentPhrases })
              .from(personalizationStateTable)
              .where(eq(personalizationStateTable.userId, user.userId));
            const currentPs: string[] = existingPs[0]?.rp ?? [];
            if (!currentPs.some((p) => p.startsWith(emailOpener.slice(0, 40)))) {
              const updatedPs = [...currentPs, emailOpener].slice(-15);
              await db
                .insert(personalizationStateTable)
                .values({ userId: user.userId, recentPhrases: updatedPs })
                .onConflictDoUpdate({
                  target: personalizationStateTable.userId,
                  set: { recentPhrases: updatedPs, updatedAt: new Date() },
                });
            }
          } catch {
            // non-fatal — skip phrase tracking on error
          }
        }

        log("Email sent", { userId: user.userId, day: today });
        sent++;
      }

    } catch (err) {
      logErr("Failed to send email to user", err, { userId: user.userId });
      failed++;
    }

    // ── Timed commitment nudge — fires at the commitment's own morning hour ──
    try {
      nudged += await processTimedNudges(
        user.userId,
        user.email,
        user.companionName,
        user.userName || "there",
        describeUserGender(user, user.userName || "there"),
        describeUserBasics(user),
        today,
        hour,
        noteCoveredCommitmentId,
      );
    } catch (err) {
      logErr("Nudge pass failed", err, { userId: user.userId });
    }
  }

  log("Daily email job complete", { sent, skipped, failed, nudged });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logErr("Fatal error in daily email job", err);
    process.exit(1);
  })
  .finally(() => pool.end().catch(() => {}));
