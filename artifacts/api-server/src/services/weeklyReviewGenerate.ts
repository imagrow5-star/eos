/**
 * Weekly review — stage 3, the Sunday generator.
 *
 * Gathers one user's week from what already exists (their own messages, the
 * wins extracted from them, this week's chapter quote pairs, open
 * commitments, a pending sealed note), asks the model for at most two small
 * proposals (the "moment" sentence and a marker excerpt) and hands everything
 * to the pure composer (weeklyReviewCompose.ts), which validates the
 * proposals and shapes the cards. The result is written through
 * insertWeeklyReview, so the store's schema rules apply on top.
 *
 * Cadence: the hourly daily-email job calls /internal/weekly-reviews/run;
 * a user is generated for once their local time is Sunday evening (18:00+)
 * or Monday morning (≤ 09:00), for the Monday–Sunday week just ended. One
 * row per user per week (unique index) — calling every hour is safe.
 *
 * Things this file deliberately never reads: voice prosody, mood scores,
 * streaks, feelings-in-context (inferred emotion). See the composer's header.
 */

import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import {
  db,
  messagesTable,
  profileTable,
  usersTable,
  winsTable,
  commitmentsTable,
  weeklyChaptersTable,
  chapterQuoteDismissalsTable,
  crisisEventsTable,
  memoryFactsTable,
  weeklyReviewsTable,
} from "@workspace/db";
import { isNotNull } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";
import { getAnthropic, logAiUsage } from "./ai.js";
import { isCrisisText } from "./crisis/detector.js";
import { localYmd, ymdAddDays, type ChapterTheme } from "./chapters/generate.js";
import { fetchPendingSealedNote } from "./chapters/sealedNotes.js";
import { insertWeeklyReview, weekBounds } from "./weeklyReview.js";
import {
  composeStory,
  type WeekSources,
  type WeekMessage,
  type ModelProposal,
  type ComposeSkip,
} from "./weeklyReviewCompose.js";

export type GenerateSkip = "no_profile" | "exists" | ComposeSkip;

export interface GenerateResult {
  userId: number;
  weekStart: string;
  weekEnd: string;
  reviewId?: number;
  skipped?: GenerateSkip;
}

// ── Week selection ──────────────────────────────────────────────────────────

function localWeekday(tz: string, d: Date): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(d);
  }
}

function localHour(tz: string, d: Date): number {
  try {
    return parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(d), 10) % 24;
  } catch {
    return d.getUTCHours();
  }
}

/** The week a run at `now` (user-local) writes: on Sunday, the week that is
 *  ending; on any other day, the week that ended last Sunday. */
export function targetWeek(tz: string, now: Date): { weekStart: string; weekEnd: string } {
  const localToday = localYmd(tz, now);
  const weekday = localWeekday(tz, now);
  return weekBounds(new Date(`${localToday}T12:00:00Z`), weekday === "Sunday" ? 0 : 1);
}

export function inGenerationWindow(tz: string, now: Date): boolean {
  const weekday = localWeekday(tz, now);
  const hour = localHour(tz, now);
  return (weekday === "Sunday" && hour >= 18) || (weekday === "Monday" && hour <= 9);
}

// ── Sources ─────────────────────────────────────────────────────────────────

interface ProfileBits {
  userName: string | null;
  companionName: string;
  timezone: string;
  userPath: string;
}

async function loadProfile(userId: number): Promise<ProfileBits | null> {
  const [p] = await db
    .select({
      userName: profileTable.userName,
      companionName: profileTable.companionName,
      timezone: profileTable.timezone,
      userPath: profileTable.userPath,
    })
    .from(profileTable)
    .where(eq(profileTable.userId, userId))
    .limit(1);
  if (!p) return null;
  return {
    userName: p.userName?.trim() ? p.userName.trim() : null,
    companionName: p.companionName || "Eos",
    timezone: p.timezone || "UTC",
    userPath: p.userPath,
  };
}

/** Message rows in a local-date range, decrypted by the ORM. The UTC query
 *  window is padded a day each side and trimmed by local date afterwards. */
async function userMessagesBetween(userId: number, tz: string, fromYmd: string, toYmd: string) {
  const rows = await db
    .select({ id: messagesTable.id, content: messagesTable.content, createdAt: messagesTable.createdAt })
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.userId, userId),
        eq(messagesTable.role, "user"),
        gte(messagesTable.createdAt, new Date(`${ymdAddDays(fromYmd, -1)}T00:00:00Z`)),
        lte(messagesTable.createdAt, new Date(`${ymdAddDays(toYmd, 1)}T23:59:59Z`)),
      ),
    )
    .orderBy(asc(messagesTable.createdAt));
  return rows
    .map((r) => ({ id: r.id, content: r.content, localDate: localYmd(tz, r.createdAt) }))
    .filter((r) => r.localDate >= fromYmd && r.localDate <= toYmd);
}

export interface GatheredWeek {
  profile: ProfileBits;
  sources: WeekSources;
  /** Facts named this week (person / event) — only ever shown to the model, as prompts for the moment card. */
  factsThisWeek: Array<{ fact: string; localDate: string }>;
}

export async function gatherWeek(userId: number, weekStart: string, weekEnd: string): Promise<GatheredWeek | null> {
  const profile = await loadProfile(userId);
  if (!profile) return null;
  const tz = profile.timezone;
  const monthStart = ymdAddDays(weekEnd, -27);

  const [monthRaw, dismissed, crisisRows, winRows, chapterRows, commitmentRows, pendingNote, firstMsg, factRows] =
    await Promise.all([
      userMessagesBetween(userId, tz, monthStart, weekEnd),
      db
        .select({ messageId: chapterQuoteDismissalsTable.messageId })
        .from(chapterQuoteDismissalsTable)
        .where(eq(chapterQuoteDismissalsTable.userId, userId)),
      db
        .select({ detectedAt: crisisEventsTable.detectedAt })
        .from(crisisEventsTable)
        .where(
          and(
            eq(crisisEventsTable.userId, userId),
            gte(crisisEventsTable.detectedAt, new Date(`${ymdAddDays(weekStart, -1)}T00:00:00Z`)),
          ),
        ),
      db
        .select({ content: winsTable.content, createdAt: winsTable.createdAt })
        .from(winsTable)
        .where(and(eq(winsTable.userId, userId), gte(winsTable.createdAt, new Date(`${ymdAddDays(weekStart, -1)}T00:00:00Z`)))),
      db
        .select({ themes: weeklyChaptersTable.themes })
        .from(weeklyChaptersTable)
        .where(and(eq(weeklyChaptersTable.userId, userId), eq(weeklyChaptersTable.weekStart, weekStart)))
        .limit(1),
      db
        .select({
          content: commitmentsTable.content,
          createdAt: commitmentsTable.createdAt,
          scheduledDate: commitmentsTable.scheduledDate,
        })
        .from(commitmentsTable)
        .where(and(eq(commitmentsTable.userId, userId), eq(commitmentsTable.state, "open"))),
      fetchPendingSealedNote(userId),
      db
        .select({ createdAt: messagesTable.createdAt })
        .from(messagesTable)
        .where(and(eq(messagesTable.userId, userId), eq(messagesTable.role, "user")))
        .orderBy(asc(messagesTable.createdAt))
        .limit(1),
      db
        .select({ fact: memoryFactsTable.fact, category: memoryFactsTable.category, createdAt: memoryFactsTable.createdAt })
        .from(memoryFactsTable)
        .where(
          and(
            eq(memoryFactsTable.userId, userId),
            inArray(memoryFactsTable.category, ["person", "event"]),
            gte(memoryFactsTable.createdAt, new Date(`${ymdAddDays(weekStart, -1)}T00:00:00Z`)),
          ),
        ),
    ]);

  // Crisis: a detection this week, or a crisis line among this week's
  // messages, trips the guardrail. Crisis lines and dismissed quotes never
  // enter any pool — over-excluding is always safe.
  const dismissedIds = new Set(dismissed.map((d) => d.messageId));
  const weekRaw = monthRaw.filter((m) => m.localDate >= weekStart);
  const crisisThisWeek =
    crisisRows.some((c) => {
      const d = localYmd(tz, c.detectedAt);
      return d >= weekStart && d <= weekEnd;
    }) || weekRaw.some((m) => isCrisisText(m.content));
  const clean = (rows: WeekMessage[]) => rows.filter((m) => !dismissedIds.has(m.id) && !isCrisisText(m.content));
  const monthMessages = clean(monthRaw);
  const messages = monthMessages.filter((m) => m.localDate >= weekStart);

  const wins = winRows
    .map((w) => ({ content: w.content, localDate: localYmd(tz, w.createdAt) }))
    .filter((w) => w.localDate >= weekStart && w.localDate <= weekEnd);

  const quotePairs: WeekSources["quotePairs"] = [];
  const themes = (chapterRows[0]?.themes ?? []) as ChapterTheme[];
  for (const t of Array.isArray(themes) ? themes : []) {
    if (t.stillTrue) continue;
    const then = t.quotes?.find((q) => q.kind === "then");
    const now = t.quotes?.find((q) => q.kind === "now");
    if (then && now) quotePairs.push({ then: { text: then.text, date: then.date }, now: { text: now.text, date: now.date } });
  }

  const openCommitments = commitmentRows
    .map((c) => ({ content: c.content, localDate: localYmd(tz, c.createdAt), scheduledDate: c.scheduledDate ?? null }))
    .filter((c) => c.localDate <= weekEnd);

  const sources: WeekSources = {
    weekStart,
    weekEnd,
    userName: profile.userName,
    companionName: profile.companionName,
    messages,
    monthMessages,
    wins,
    quotePairs,
    openCommitments,
    pendingNoteDate: pendingNote ? localYmd(tz, pendingNote.createdAt) : null,
    firstMessageDate: firstMsg[0] ? localYmd(tz, firstMsg[0].createdAt) : null,
    guardrail: profile.userPath === "bereavement" || crisisThisWeek,
  };

  const factsThisWeek = factRows
    .map((f) => ({ fact: f.fact, localDate: localYmd(tz, f.createdAt) }))
    .filter((f) => f.localDate >= weekStart && f.localDate <= weekEnd);

  return { profile, sources, factsThisWeek };
}

// ── Model proposals ─────────────────────────────────────────────────────────
// Two small proposals, both validated by the composer before use. The model
// sees only this week's user messages (crisis-filtered) and the person/event
// facts named this week — nothing about mood, prosody or streaks exists in
// the prompt. If there is no client (tests, misconfiguration) the story is
// built without a moment card and with a deterministic fragment.

export function buildProposalPrompt(g: GatheredWeek): string {
  const shown = g.sources.messages.slice(-40).map((m) => {
    const text = m.content.length > 300 ? `${m.content.slice(0, 300)}…` : m.content;
    return `[id ${m.id} | ${m.localDate}] ${text}`;
  });
  const facts = g.factsThisWeek.slice(0, 12).map((f) => `- (${f.localDate}) ${f.fact}`);
  return `You are helping write a weekly review for someone, made only of their own words and what they did. Return valid JSON only — no explanation.

THIS WEEK'S MESSAGES FROM THEM (id | date | text):
${shown.join("\n")}

PEOPLE AND MOMENTS THEY NAMED THIS WEEK:
${facts.length > 0 ? facts.join("\n") : "(none recorded)"}

Return this JSON shape:
{
  "moment": "one sentence or null",
  "fragment": { "messageId": <id>, "excerpt": "..." } | null
}

Rules for "moment" — a specific thing they brought up this week (a person, a place, a thing, an event), stated plainly:
- ONE sentence, second person, starting with "You", ending with a full stop, under 100 characters.
- Say WHAT they talked about and WHEN (the weekday from the date). Example: "You talked about your dad's garden again on Tuesday."
- State only what is in the messages. No feelings, no praise, no verdicts, no reading between the lines — not "you seemed", not "you felt", not "well done", not "progress".
- null if nothing specific was named.

Rules for "fragment" — a few of their own words for a small circle on their page:
- 2 to 6 consecutive words copied EXACTLY from ONE message above, character for character. Do not fix spelling or punctuation, do not paraphrase.
- Choose the most alive phrase of the week — something with a person, a place, a decision, a change in it. Not a greeting, not filler.
- null if nothing fits.`;
}

async function proposeWithModel(g: GatheredWeek): Promise<ModelProposal> {
  const anthropic = getAnthropic();
  if (!anthropic) return {};
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 300,
      messages: [{ role: "user", content: buildProposalPrompt(g) }],
    });
    logAiUsage("weekly_review_proposal", "claude-haiku-4-5", response.usage);
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return {};
    const raw = textBlock.text.replace(/```(?:json)?\n?/g, "").trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const fragment =
      parsed.fragment && typeof parsed.fragment === "object"
        ? (parsed.fragment as { messageId?: unknown; excerpt?: unknown })
        : null;
    return {
      moment: typeof parsed.moment === "string" ? parsed.moment : null,
      fragment:
        fragment && typeof fragment.messageId === "number" && typeof fragment.excerpt === "string"
          ? { messageId: fragment.messageId, excerpt: fragment.excerpt }
          : null,
    };
  } catch (err) {
    // Privacy: never log the raw output — it quotes the user's words.
    logger.warn({ err: (err as Error)?.message }, "weekly review: model proposal failed — composing without it");
    return {};
  }
}

// ── Generate one user ───────────────────────────────────────────────────────

export async function generateWeeklyReviewForUser(
  userId: number,
  opts: { now?: Date; force?: boolean; withModel?: boolean } = {},
): Promise<GenerateResult> {
  const now = opts.now ?? new Date();
  const profile = await loadProfile(userId);
  if (!profile) return { userId, weekStart: "", weekEnd: "", skipped: "no_profile" };
  const { weekStart, weekEnd } = targetWeek(profile.timezone, now);

  if (!opts.force) {
    const [existing] = await db
      .select({ id: weeklyReviewsTable.id })
      .from(weeklyReviewsTable)
      .where(and(eq(weeklyReviewsTable.userId, userId), eq(weeklyReviewsTable.weekStart, weekStart)))
      .limit(1);
    if (existing) return { userId, weekStart, weekEnd, skipped: "exists" };
  }

  const gathered = await gatherWeek(userId, weekStart, weekEnd);
  if (!gathered) return { userId, weekStart, weekEnd, skipped: "no_profile" };

  // Cheap pre-check before spending a model call on a quiet week.
  const dry = composeStory(gathered.sources, {});
  if (dry.skipped === "quiet_week") return { userId, weekStart, weekEnd, skipped: "quiet_week" };

  const proposal = opts.withModel === false ? {} : await proposeWithModel(gathered);
  const composed = composeStory(gathered.sources, proposal);
  if (composed.skipped) return { userId, weekStart, weekEnd, skipped: composed.skipped };

  const row = await insertWeeklyReview({
    userId,
    weekStart,
    weekEnd,
    fragment: composed.story.fragment,
    cards: composed.story.cards,
  });
  try {
    const uh = hashUserIdForLog(userId);
    if (uh) logger.info({ uh, weekStart, cards: composed.story.cards.map((c) => c.kind) }, "weekly review generated");
  } catch { /* logging must never crash the caller */ }
  return { userId, weekStart, weekEnd, reviewId: row.id };
}

// ── Sweep ───────────────────────────────────────────────────────────────────

export interface WeeklyReviewSweepResult {
  considered: number;
  generated: number;
  skipped: Record<string, number>;
  failed: number;
}

export async function runWeeklyReviewSweep(
  opts: { now?: Date; onlyUserId?: number; ignoreWindow?: boolean; force?: boolean } = {},
): Promise<WeeklyReviewSweepResult> {
  const now = opts.now ?? new Date();
  const users = await db
    .select({ userId: profileTable.userId, timezone: profileTable.timezone })
    .from(profileTable)
    .innerJoin(usersTable, eq(usersTable.id, profileTable.userId))
    .where(and(isNotNull(usersTable.emailVerifiedAt), eq(profileTable.isOnboardingComplete, true)));

  const result: WeeklyReviewSweepResult = { considered: 0, generated: 0, skipped: {}, failed: 0 };
  for (const u of users) {
    if (!u.userId) continue;
    if (opts.onlyUserId && u.userId !== opts.onlyUserId) continue;
    if (!opts.ignoreWindow && !inGenerationWindow(u.timezone || "UTC", now)) continue;
    result.considered++;
    try {
      const r = await generateWeeklyReviewForUser(u.userId, { now, force: opts.force });
      if (r.reviewId) result.generated++;
      else if (r.skipped) result.skipped[r.skipped] = (result.skipped[r.skipped] ?? 0) + 1;
    } catch (err) {
      result.failed++;
      try {
        const uh = hashUserIdForLog(u.userId);
        if (uh) logger.error({ err, uh }, "weekly review: generation failed");
      } catch { /* logging must never crash the caller */ }
    }
  }
  return result;
}
