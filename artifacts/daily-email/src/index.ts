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
 *   RESEND_FROM_EMAIL    — e.g. "Eos <noreply@itslexa.com>"
 *   SESSION_SECRET       — Signs unsubscribe tokens (same as api-server)
 *   APP_URL              — Production URL (optional)
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
} from "@workspace/db";
import { eq, and, desc, sql, isNotNull } from "drizzle-orm";
import Anthropic from "@anthropic-ai/sdk";

// ─── Config ───────────────────────────────────────────────────────────────────

const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const RESEND_FROM     = process.env.RESEND_FROM_EMAIL ?? "Eos <noreply@itslexa.com>";
const APP_URL         = (process.env.APP_URL ?? "https://eos-companion.replit.app").replace(/\/$/, "");
const SESSION_SECRET  = process.env.SESSION_SECRET ?? "";
const ANTHROPIC_KEY   = process.env.ANTHROPIC_API_KEY;

// Local hour window: only send between 06:00–09:59 in the user's timezone
const SEND_HOUR_START = 6;
const SEND_HOUR_END   = 9;

// ─── Logging ──────────────────────────────────────────────────────────────────

const log = (msg: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...data }));

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
  moodSummary: string | null;
  pendingCommitment: string | null;
}

async function gatherContext(
  userId: number,
  email: string,
  profile: {
    userName: string;
    companionName: string;
    timezone: string;
    userPath: string;
    createdAt: Date;
  },
): Promise<UserContext | null> {
  const today = todayLocal(profile.timezone);

  // 7 days ago as YYYY-MM-DD string for SQL comparison
  const d7 = new Date();
  d7.setDate(d7.getDate() - 7);
  const sevenDaysAgo = d7.toISOString().slice(0, 10);

  const [facts, wins, habits, moods, pending] = await Promise.all([
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

    db.select({ content: commitmentsTable.content, cue: commitmentsTable.cue })
      .from(commitmentsTable)
      .where(and(
        eq(commitmentsTable.userId, userId),
        sql`${commitmentsTable.state} = 'open'`,
        sql`${commitmentsTable.scheduledFollowupDate} IS NOT NULL AND ${commitmentsTable.scheduledFollowupDate} <= ${today}`,
      ))
      .limit(1),
  ]);

  // Skip if no personal data at all — generic email would feel worse than nothing
  if (facts.length === 0 && wins.length === 0 && habits.length === 0) return null;

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

  return {
    userId,
    email,
    name:        profile.userName || "there",
    companionName: profile.companionName,
    timezone:    profile.timezone,
    userPath:    profile.userPath,
    daysSinceStart,
    facts:       facts.map((f) => f.fact),
    wins:        wins.map((w) => w.content),
    habits:      habitsWithWeekData,
    moodSummary,
    pendingCommitment: pending[0]
      ? `${pending[0].content}${pending[0].cue ? ` (cue: "${pending[0].cue}")` : ""}`
      : null,
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

  const prompt = `You are ${ctx.companionName}. You're writing ${ctx.name} a short morning note — 4 to 7 sentences, no more.

This lands in their inbox first thing. It should feel like it was written just for them this morning by someone who has genuinely been paying attention — not generated, not a wellness newsletter, not therapy.

WHAT YOU KNOW ABOUT ${ctx.name.toUpperCase()}:
${lines.join("\n\n")}
${pathNote}

HOW TO WRITE IT:
• Pick 1–2 specific things from what you know and reference them directly. Not "you've been working hard" — their actual habit, their actual win, a real detail. Specificity is what makes it feel human.
• End with one low-stakes, concrete, optional nudge for today tied to something real in their life. Not abstract. Not "do something nice for yourself." Something that fits them.
• Plain human sentences. No bullet points, no lists, no em-dashes for effect.
• Don't start with "Good morning" — that's a template opener.
• No sign-off at the end (no "Warmly," "Love," etc.). The note just ends on its last thought.
• Vary the tone day to day — sometimes observational, sometimes a bit playful, sometimes quieter.

FORBIDDEN — never use these or close variants:
"I'm here for you" · "you've got this" · "be kind to yourself" · "one step/day at a time" · "proud of you" · "your journey" · "healing journey" · "growth mindset" · "self-care" · "self-love" · "stay strong" · "hang in there" · "keep going" · "you're doing amazing" · "it's okay to feel" · "give yourself grace" · "show up for yourself" · "embrace" · "lean into" · "hold space" · "safe space" · "honor your feelings" · "check in with yourself" · "practice" · "mindfulness" · "intentional" · "gentle reminder" · any therapy jargon.

Do NOT invent people, places, events, or memories. Everything must come from the information given above.

Write only the note text itself — nothing else.`;

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

  try {
    const response = await anthropic.messages.create({
      model:      "claude-sonnet-4-5-20250929",
      max_tokens: 450,
      temperature: 0.8,
      messages:   [{ role: "user", content: prompt }],
    });
    const textBlock = response.content.find((b) => b.type === "text");
    return textBlock?.text?.trim() ?? `${ctx.name} — thinking of you today.`;
  } catch (err) {
    logErr("Claude generation failed", err, { userId: ctx.userId });
    return `${ctx.name} — day ${ctx.daysSinceStart}. You're still here. That's not nothing.`;
  }
}

// ─── HTML email template (Intimate Dusk) ─────────────────────────────────────

function buildHtml(ctx: UserContext, noteText: string): string {
  const paragraphs = noteText
    .split(/\n+/)
    .filter((p) => p.trim())
    .map(
      (p) =>
        `<p style="margin:0 0 18px 0;font-size:17px;line-height:1.75;color:#EFE6D6;font-family:Georgia,'Times New Roman',serif;">${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`,
    )
    .join("");

  const token = unsubToken(ctx.userId);
  const unsubUrl = `${APP_URL}/api/email/unsubscribe?uid=${ctx.userId}&token=${token}`;

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

// ─── Mark sent (update lastEmailDate on profile) ──────────────────────────────

async function markSent(userId: number, date: string): Promise<void> {
  await db
    .update(profileTable)
    .set({ lastEmailDate: date })
    .where(eq(profileTable.userId, userId));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  log("Daily email job starting");

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

  let sent = 0, skipped = 0, failed = 0;

  for (const user of users) {
    if (!user.userId || !user.email) { skipped++; continue; }

    // Respect opt-out
    if (user.dailyEmailOptOut) { skipped++; continue; }

    const tz    = user.timezone ?? "UTC";
    const today = todayLocal(tz);
    const hour  = localHour(tz);

    // Already sent today (in this user's timezone)
    if (user.lastEmailDate === today) { skipped++; continue; }

    // Not in the 6–9 AM morning window
    if (hour < SEND_HOUR_START || hour > SEND_HOUR_END) { skipped++; continue; }

    try {
      // Gather personalized data
      const ctx = await gatherContext(user.userId, user.email, {
        userName:      user.userName,
        companionName: user.companionName,
        timezone:      tz,
        userPath:      user.userPath,
        createdAt:     user.createdAt,
      });

      if (!ctx) {
        // Not enough data yet — skip gracefully
        log("Skipping user — not enough data yet", { userId: user.userId });
        skipped++;
        continue;
      }

      // Generate text + HTML
      const noteText = await generateNoteText(ctx);
      const html     = buildHtml(ctx, noteText);
      const dayName  = dayOfWeekName(tz);
      const subject  = `${ctx.companionName} — ${dayName}`;

      await sendEmail(user.email, subject, html);
      await markSent(user.userId, today);

      log("Email sent", { userId: user.userId, day: today });
      sent++;

    } catch (err) {
      logErr("Failed to send email to user", err, { userId: user.userId });
      failed++;
    }
  }

  log("Daily email job complete", { sent, skipped, failed });
}

// ─── Entry point ─────────────────────────────────────────────────────────────

run()
  .then(() => process.exit(0))
  .catch((err) => {
    logErr("Fatal error in daily email job", err);
    process.exit(1);
  })
  .finally(() => pool.end().catch(() => {}));
