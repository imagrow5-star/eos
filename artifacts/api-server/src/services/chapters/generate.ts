// ─── Weekly chapter generation engine ─────────────────────────────────────────
// Builds one "chapter" per user per week: 2–4 dominant themes, each anchored
// to then/now quote pairs taken VERBATIM from the user's own stored messages.
//
// Non-negotiable gates enforced here (not in prompts):
//   • every quote is validated as an exact substring of the referenced stored
//     message (quotes.ts) — fabricated/paraphrased quotes are dropped
//   • crisis-level messages never enter the candidate pools (crisis.ts)
//   • dismissed quotes never enter the pools (chapter_quote_dismissals)
//   • all Eos prose passes the kind-truth check (kindTruth.ts) with
//     regeneration, then safe fallbacks
//   • a micro-goal offer without a validated seed quote is impossible —
//     the offer is built FROM the seed, not the other way around
//   • language signals are computed internally and never persisted/returned

import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import {
  db,
  messagesTable,
  profileTable,
  usersTable,
  goalsTable,
  goalTasksTable,
  habitsTable,
  habitCompletionsTable,
  weeklyChaptersTable,
  chapterQuoteDismissalsTable,
  chapterOfferEventsTable,
  sealedNotesTable,
} from "@workspace/db";
import { isNotNull } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { logAiUsage } from "../ai.js";
import { isCrisisText } from "./crisis.js";
import { computeSignals, describeSignalShift } from "./signals.js";
import {
  validateExcerpt,
  nearIdentical,
  type QuoteSource,
  type ValidatedQuote,
} from "./quotes.js";
import { checkKindTruth, deterministicViolations, type ProseSection } from "./kindTruth.js";
import {
  fetchPendingSealedNote,
  resolutionPrompt,
  CRISIS_NOTE_RESOLUTION,
  FALLBACK_RESOLUTION,
  FALLBACK_NOTE_PROMPT,
} from "./sealedNotes.js";
import {
  updateStoryThreads,
  pickWorkingThroughThread,
  buildWorkingThroughEntries,
  FALLBACK_WORKING_REFLECTION,
  type WorkingThrough,
  type WorkingThroughEntry,
} from "./storyThreads.js";
import { sendPushToUser } from "../push.js";

// ─── Public shapes (stored as jsonb on weekly_chapters) ───────────────────────

export interface ChapterQuote {
  messageId: number;
  text: string;
  date: string; // YYYY-MM-DD user-local
  kind: "then" | "now";
}

export interface ChapterTheme {
  key: string;
  title: string;
  kind: "standard" | "social-expectation";
  stillTrue: boolean;
  quotes: ChapterQuote[];
  reflection: string;
  eraNote?: string;
}

export interface GoalReviewItem {
  refKind: "goal" | "habit";
  refId: number;
  title: string;
  verdict: "working" | "wobbly" | "resting";
  text: string;
}

export interface MicroOffer {
  seedMessageId: number;
  seedQuote: string;
  seedDate: string;
  text: string;
  goalTitle: string;
  goalDescription: string;
  status: "pending" | "accepted" | "declined";
}

export interface NoteInvite {
  /** Eos's gentle prediction question for the end-of-chapter sealed note. */
  prompt: string;
}

export interface SealResolution {
  noteId: number;
  noteKind: string; // free | prediction
  notePrompt: string | null;
  /** The user's verbatim words — null for crisis-flagged notes (never quoted back). */
  noteText: string | null;
  crisisFlagged: boolean;
  /** Eos's warm resolution paragraph, shown after the seal breaks. */
  text: string;
}

export type SkipReason =
  | "no_ai"
  | "no_profile"
  | "cold_start"
  | "quiet_week"
  | "exists"
  | "no_valid_themes";

export interface GenerationResult {
  userId: number;
  weekStart: string;
  chapterId?: number;
  skipped?: SkipReason;
}

// ─── Models & client ──────────────────────────────────────────────────────────

const SONNET = "claude-sonnet-4-5-20250929";

type AnthropicClient = {
  messages: { create: (opts: Record<string, unknown>) => Promise<{ content: unknown; usage?: unknown }> };
};

let _anthropic: AnthropicClient | null = null;
function getAnthropic(): AnthropicClient | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!_anthropic) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk").Anthropic;
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

async function callClaude(
  anthropic: AnthropicClient,
  callType: string,
  prompt: string,
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const response = await anthropic.messages.create({
    model: SONNET,
    max_tokens: maxTokens,
    temperature,
    messages: [{ role: "user", content: prompt }],
  });
  logAiUsage(callType, SONNET, (response as { usage?: unknown }).usage);
  const blocks = (response as { content: Array<{ type: string; text?: string }> }).content;
  return blocks?.find((b) => b.type === "text")?.text ?? "";
}

function parseJson<T>(raw: string): T | null {
  try {
    const cleaned = raw.replace(/```(?:json)?\n?/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

// ─── Local-date helpers (user timezone) ───────────────────────────────────────

const ymdFormatters = new Map<string, Intl.DateTimeFormat>();
export function localYmd(tz: string, d: Date): string {
  let fmt = ymdFormatters.get(tz);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
    }
    ymdFormatters.set(tz, fmt);
  }
  return fmt.format(d);
}

export function ymdAddDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function localWeekday(tz: string, d: Date): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(d);
  }
}

function localHour(tz: string, d: Date): number {
  try {
    return parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(d), 10);
  } catch {
    return d.getUTCHours();
  }
}

/**
 * The analyzed week is the most recent complete-or-completing Mon→Sun span:
 * on Sunday the week ends today; any other day it ends last Sunday.
 */
export function weekBoundsFor(tz: string, now: Date): { weekStart: string; weekEnd: string } {
  const today = localYmd(tz, now);
  const weekday = localWeekday(tz, now); // "Monday" … "Sunday"
  const idx = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].indexOf(weekday);
  const daysSinceSunday = idx === 6 ? 0 : idx + 1;
  const weekEnd = ymdAddDays(today, -daysSinceSunday);
  return { weekStart: ymdAddDays(weekEnd, -6), weekEnd };
}

function prettyDate(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", day: "numeric" }).format(d);
}

// ─── Pure gating helpers (unit-tested) ────────────────────────────────────────

export function isOfferEligible(opts: {
  activeGoalCount: number;
  activeHabitCount: number;
  lastDeclineAt: Date | null;
  now?: Date;
}): boolean {
  if (opts.activeGoalCount > 0 || opts.activeHabitCount > 0) return false;
  if (opts.lastDeclineAt) {
    const now = opts.now ?? new Date();
    const days = (now.getTime() - opts.lastDeclineAt.getTime()) / 86_400_000;
    if (days < 14) return false;
  }
  return true;
}

export function habitVerdict(completions7d: number, habitAgeDays: number): GoalReviewItem["verdict"] {
  if (completions7d >= 4) return "working";
  if (completions7d >= 1) return "wobbly";
  return habitAgeDays < 7 ? "wobbly" : "resting";
}

export function goalVerdict(tasksDone: number, tasksTotal: number, goalAgeDays: number): GoalReviewItem["verdict"] {
  if (tasksTotal > 0 && tasksDone / tasksTotal >= 0.6) return "working";
  if (tasksDone > 0) return "wobbly";
  return goalAgeDays < 14 ? "wobbly" : "resting";
}

/** Digit-free phrase for how often something happened this week. */
export function countToPhrase(n: number): string {
  if (n <= 0) return "didn't get to it this week";
  if (n === 1) return "got to it once this week";
  if (n === 2) return "got to it twice this week";
  if (n <= 4) return "showed up for it several times this week";
  return "showed up for it nearly every day this week";
}

// ─── Candidate pools ──────────────────────────────────────────────────────────

interface MessageRow {
  id: number;
  content: string;
  createdAt: Date;
  localDate: string;
}

function buildPool(rows: MessageRow[]): Map<number, QuoteSource> {
  const map = new Map<number, QuoteSource>();
  for (const r of rows) {
    map.set(r.id, { id: r.id, content: r.content, createdAt: r.createdAt, localDate: r.localDate });
  }
  return map;
}

function sampleEvenly<T>(rows: T[], cap: number): T[] {
  if (rows.length <= cap) return rows;
  const out: T[] = [];
  const step = rows.length / cap;
  for (let i = 0; i < cap; i++) out.push(rows[Math.floor(i * step)]!);
  return out;
}

function listingFor(rows: MessageRow[]): string {
  return rows
    .map((r) => {
      const oneLine = r.content.replace(/\s+/g, " ").trim();
      const shown = oneLine.length > 320 ? `${oneLine.slice(0, 320)}…` : oneLine;
      return `[id ${r.id} | ${r.localDate}] ${shown}`;
    })
    .join("\n");
}

// ─── Theme selection call ─────────────────────────────────────────────────────

interface RawThemeProposal {
  title?: string;
  kind?: string;
  nowQuote?: { messageId?: number; excerpt?: string } | null;
  thenQuote?: { messageId?: number; excerpt?: string } | null;
  stillTrue?: boolean;
  reflection?: string;
  eraNote?: string | null;
}

function themePrompt(opts: {
  companionName: string;
  userName: string;
  pathNote: string;
  signalGuidance: string;
  nowListing: string;
  thenListing: string;
  hadCrisisAdjacentWeek: boolean;
  retryFeedback?: string;
}): string {
  return `You are ${opts.companionName}, writing the "mirror" section of a weekly chapter for ${opts.userName} — a letter that shows them their own growth using ONLY their own words.${opts.pathNote}

THIS WEEK'S MESSAGES (the "now" pool — now-quotes must come from here):
${opts.nowListing}

EARLIER MESSAGES (the "then" pool — then-quotes must come from here):
${opts.thenListing}

${opts.signalGuidance}

Choose the 2–4 themes that genuinely dominated their week, and for each build a then/now quote pair.

HARD RULES for quotes — violations get discarded by a machine check:
- "excerpt" must be copied VERBATIM, character for character, from ONE message's visible text. No paraphrasing, no fixing typos, no added ellipses, no stitching two sentences from different messages.
- Excerpts are 12–360 characters, and both quotes in a pair must belong to the SAME theme.
- nowQuote.messageId must be an id from the NOW pool; thenQuote.messageId from the THEN pool.
- Never choose a pair where then and now say nearly the same thing — that reads as documented failure. If nothing genuinely changed on a theme, set "stillTrue": true, keep ONLY the strongest single quote (in nowQuote, thenQuote null), and frame the reflection as "this has stayed true for you — that says how much it matters", never as stagnation.

THEME KINDS:
- "standard" — an ordinary emotional thread (sleep, the ex, work dread, small joys...).
- "social-expectation" — use when a recurring thread is them predicting other people's rejection for them ("they wouldn't want me there", "I'd just ruin the night"). The reflection must mirror the pattern with gentle curiosity — an honest question that loosens the belief — never argue with them or issue a correction.

REFLECTIONS (2–4 sentences each, your voice — warm, plain, specific):
- Anchor every observation to the quoted words. If you can't point at their words, don't say it.
- Any hard observation must hand agency back in the same breath (a door, a choice, their own evidence).
- No advice unless it is literally their own idea reflected back to them.
- Never: clinical labels, verdicts, counts of behavior, timestamps, percentages, comparisons to other people, "progress" scoring.
${opts.hadCrisisAdjacentWeek ? `- Some of their heaviest messages were withheld from these pools on purpose. You may acknowledge that era softly in ONE theme's "eraNote" ("some nights this week carried real weight") — never quote it, never describe what they said, never name it clinically.\n` : ""}${opts.retryFeedback ? `\nPREVIOUS ATTEMPT FAILED MACHINE VALIDATION:\n${opts.retryFeedback}\nFix exactly these problems. Copy excerpts character-for-character this time.\n` : ""}
Respond with ONLY valid JSON:
{"themes":[{"title":"...","kind":"standard","nowQuote":{"messageId":123,"excerpt":"..."},"thenQuote":{"messageId":45,"excerpt":"..."},"stillTrue":false,"reflection":"...","eraNote":null}]}`;
}

interface ValidatedThemeDraft {
  title: string;
  kind: "standard" | "social-expectation";
  stillTrue: boolean;
  nowQuote: ValidatedQuote;
  thenQuote: ValidatedQuote | null;
  reflection: string;
  eraNote?: string;
}

function validateThemes(
  proposals: RawThemeProposal[],
  nowPool: Map<number, QuoteSource>,
  thenPool: Map<number, QuoteSource>,
): { valid: ValidatedThemeDraft[]; failures: string[] } {
  const valid: ValidatedThemeDraft[] = [];
  const failures: string[] = [];

  for (const p of proposals.slice(0, 4)) {
    const title = (p.title ?? "").trim().slice(0, 80);
    const reflection = (p.reflection ?? "").trim();
    if (!title || reflection.length < 20) {
      failures.push(`theme "${title || "?"}": missing title or reflection`);
      continue;
    }
    const now = validateExcerpt(p.nowQuote?.messageId, p.nowQuote?.excerpt, nowPool);
    if (!now) {
      failures.push(`theme "${title}": nowQuote is not a verbatim substring of message ${p.nowQuote?.messageId ?? "?"} (or wrong pool)`);
      continue;
    }
    let then: ValidatedQuote | null = null;
    let stillTrue = p.stillTrue === true;
    if (p.thenQuote && !stillTrue) {
      then = validateExcerpt(p.thenQuote.messageId, p.thenQuote.excerpt, thenPool);
      if (!then) {
        failures.push(`theme "${title}": thenQuote failed verbatim validation against message ${p.thenQuote.messageId ?? "?"} — pair dropped to still-true single quote`);
        stillTrue = true;
      } else if (nearIdentical(then.text, now.text)) {
        // Near-identical pair reads as documented failure → collapse.
        then = null;
        stillTrue = true;
      }
    }
    valid.push({
      title,
      kind: p.kind === "social-expectation" ? "social-expectation" : "standard",
      stillTrue,
      nowQuote: now,
      thenQuote: then,
      reflection,
      eraNote: typeof p.eraNote === "string" && p.eraNote.trim() ? p.eraNote.trim() : undefined,
    });
  }
  return { valid, failures };
}

// ─── Composition call (opening, threshold question, review, offer) ───────────

interface RawCompose {
  threadOpening?: string;
  thresholdQuestion?: string;
  notePrompt?: string;
  reviewItems?: Array<{ refKind?: string; refId?: number; text?: string }>;
  offer?: { messageId?: number; excerpt?: string; offerText?: string; goalTitle?: string; goalDescription?: string } | null;
}

const FALLBACK_QUESTION = "What took up the most room in your head this week?";
const FALLBACK_OPENING = "Another week, and here we are — still talking. That's the part that matters, and the rest of this letter is just me showing you what I noticed.";

function workingReflectionPrompt(opts: {
  companionName: string;
  userName: string;
  label: string;
  entries: WorkingThroughEntry[];
}): string {
  const timeline = opts.entries.map((e) => `${e.weekLabel}: ${e.verbatim ? `"${e.text}"` : e.text}`).join("\n");
  return `You are ${opts.companionName}. In ${opts.userName}'s weekly chapter there is a small section called "Working it through" about "${opts.label}" — a story they have returned to more than once. It shows how THEIR OWN question about it has moved:

${timeline}

Write 2–3 sentences of quiet relief-framing: the movement of their questions IS them working it through.

HARD RULES: never imply an earlier question was wrong or a worse version of them; no digits, no counts, no clinical words ("processing", "rumination", "trauma"), no advice, no homework; never suggest they are stuck or slow; the point is motion, not verdict. End on warmth, not a lesson.

Respond with ONLY the paragraph text.`;
}

function composePrompt(opts: {
  companionName: string;
  userName: string;
  pathNote: string;
  openLoop: string;
  themesSummary: string;
  reviewBrief: string | null;
  offerBrief: string | null;
  retryFeedback?: string;
}): string {
  return `You are ${opts.companionName}, assembling the remaining pieces of ${opts.userName}'s weekly chapter — a warm letter, never a report card.${opts.pathNote}

WHERE LAST WEEK LEFT OFF:
${opts.openLoop}

THIS WEEK'S MIRROR THEMES (already written — for continuity only):
${opts.themesSummary}

WRITE THESE PIECES:

1. "threadOpening" — EXACTLY two sentences that pick up last week's thread before anything else. Warm, specific, zero digits or percentages. If something they were carrying looks lighter, say it's "easing" or "quietly resting" — never "improved by" anything. If it wobbled, frame recovery as nonlinear and them as still in motion — never regression.

2. "thresholdQuestion" — ONE gentle question inviting them to guess at their week before they read it (in the spirit of "What took up the most room in your head this week?" — vary the wording, keep it that soft).
${opts.reviewBrief ? `
3. "reviewItems" — for EACH tracked item below, 1–3 sentences of honest, kind review in your voice:
${opts.reviewBrief}
Rules: if it's working — specific appreciation tied to what it gives them, no generic praise. If it's wobbly or resting — zero shame; offer ONE smaller version as a question ("would twice this week feel more like yours?"). If they kept it up but it isn't helping — honor the discipline and gently ask whether it has done its job and could be retired. Never digits, never streak talk, never "you only did".` : ""}${opts.offerBrief ? `
4. "offer" — they have no active goals right now, so you may offer ONE tiny promise built from something THEY once said. Pick one line from the SEED CANDIDATES below where they named something that helped them, lit them up, or that they wished they did more.
${opts.offerBrief}
Copy the seed line VERBATIM into "excerpt" with its messageId. Then write "offerText": start from what they said (the UI shows the quote and its date first), ask if it's still true, and offer one small concrete promise before Sunday with the promise that you'll ask them about it — e.g. 'Is that still true? Want to promise yourself one run before Sunday? I'll ask.' Keep it that small. "goalTitle" (max 8 words) and "goalDescription" (one sentence) describe the tiny promise itself. If NO seed candidate genuinely fits, set "offer": null — a generic offer is worse than none.` : ""}

5. "notePrompt" — ONE gentle forward-looking question inviting them to seal a one-sentence guess for next-week's self, anchored to whichever theme above feels most alive (in the spirit of "Where do you think the apartment worry will sit by next Sunday?"). Soft, curious, zero pressure, zero digits. It should feel like a small game, not an assignment.

VOICE RULES for every piece: no clinical language, no verdicts, no counts or timestamps of their behavior, no generic self-help advice, nothing that reads as a score. Kindness that tells the truth.
${opts.retryFeedback ? `\nPREVIOUS ATTEMPT FAILED REVIEW:\n${opts.retryFeedback}\nRewrite the failing pieces obeying every rule.\n` : ""}
Respond with ONLY valid JSON:
{"threadOpening":"...","thresholdQuestion":"...","notePrompt":"...","reviewItems":[{"refKind":"goal","refId":1,"text":"..."}],"offer":null}`;
}

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadReviewData(userId: number, now: Date) {
  const [goals, habits] = await Promise.all([
    db.select().from(goalsTable).where(and(eq(goalsTable.userId, userId), eq(goalsTable.isComplete, false))).orderBy(desc(goalsTable.createdAt)),
    db.select().from(habitsTable).where(and(eq(habitsTable.userId, userId), eq(habitsTable.isActive, true))),
  ]);

  const goalIds = goals.map((g) => g.id);
  const tasks = goalIds.length
    ? await db.select().from(goalTasksTable).where(inArray(goalTasksTable.goalId, goalIds))
    : [];

  const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
  const habitIds = habits.map((h) => h.id);
  const completions = habitIds.length
    ? await db
        .select()
        .from(habitCompletionsTable)
        .where(and(eq(habitCompletionsTable.userId, userId), inArray(habitCompletionsTable.habitId, habitIds), gte(habitCompletionsTable.completedDate, sevenDaysAgo)))
    : [];

  const goalItems = goals.slice(0, 2).map((g) => {
    const gt = tasks.filter((t) => t.goalId === g.id);
    const done = gt.filter((t) => t.isComplete).length;
    const ageDays = (now.getTime() - new Date(g.createdAt).getTime()) / 86_400_000;
    return {
      refKind: "goal" as const,
      refId: g.id,
      title: g.title,
      verdict: goalVerdict(done, gt.length, ageDays),
      progressPhrase:
        gt.length === 0
          ? "no small steps written down yet"
          : done === 0
            ? "the small steps are still waiting"
            : done === gt.length
              ? "every small step is done"
              : "some of the small steps are done",
    };
  });

  const habitItems = habits.slice(0, 2).map((h) => {
    const c7 = completions.filter((c) => c.habitId === h.id).length;
    const ageDays = (now.getTime() - new Date(h.createdAt).getTime()) / 86_400_000;
    return {
      refKind: "habit" as const,
      refId: h.id,
      title: h.name,
      verdict: habitVerdict(c7, ageDays),
      progressPhrase: countToPhrase(c7),
    };
  });

  return { goals, habits, reviewCandidates: [...goalItems, ...habitItems] };
}

// ─── Main generation ──────────────────────────────────────────────────────────

export async function generateChapterForUser(
  userId: number,
  opts: { now?: Date; force?: boolean } = {},
): Promise<GenerationResult> {
  const now = opts.now ?? new Date();
  const anthropic = getAnthropic();

  const [profile] = await db.select().from(profileTable).where(eq(profileTable.userId, userId));
  if (!profile || !profile.isOnboardingComplete) {
    return { userId, weekStart: "", skipped: "no_profile" };
  }
  const tz = profile.timezone || "UTC";
  const { weekStart, weekEnd } = weekBoundsFor(tz, now);

  if (!anthropic) return { userId, weekStart, skipped: "no_ai" };

  // Dedup / force
  const existing = await db
    .select({ id: weeklyChaptersTable.id })
    .from(weeklyChaptersTable)
    .where(and(eq(weeklyChaptersTable.userId, userId), eq(weeklyChaptersTable.weekStart, weekStart)));
  if (existing.length > 0) {
    if (!opts.force) return { userId, weekStart, skipped: "exists" };
    await db.delete(weeklyChaptersTable).where(eq(weeklyChaptersTable.id, existing[0]!.id));
  }

  // ── Messages → pools ──
  const allMessages = await db
    .select({ id: messagesTable.id, role: messagesTable.role, content: messagesTable.content, createdAt: messagesTable.createdAt })
    .from(messagesTable)
    .where(eq(messagesTable.userId, userId))
    .orderBy(asc(messagesTable.createdAt));

  const userMessages: MessageRow[] = allMessages
    .filter((m) => m.role === "user")
    .map((m) => ({ id: m.id, content: m.content, createdAt: m.createdAt, localDate: localYmd(tz, m.createdAt) }));

  if (userMessages.length === 0) return { userId, weekStart, skipped: "cold_start" };
  const firstDate = userMessages[0]!.localDate;
  const weeksTogether = Math.floor((new Date(`${localYmd(tz, now)}T12:00:00Z`).getTime() - new Date(`${firstDate}T12:00:00Z`).getTime()) / (7 * 86_400_000));
  if (weeksTogether < 3) return { userId, weekStart, skipped: "cold_start" };

  const weekMsgs = userMessages.filter((m) => m.localDate >= weekStart && m.localDate <= weekEnd);
  if (weekMsgs.length < 5) return { userId, weekStart, skipped: "quiet_week" };

  const dismissals = await db
    .select({ messageId: chapterQuoteDismissalsTable.messageId })
    .from(chapterQuoteDismissalsTable)
    .where(eq(chapterQuoteDismissalsTable.userId, userId));
  const dismissed = new Set(dismissals.map((d) => d.messageId));

  const quotable = (m: MessageRow) =>
    !dismissed.has(m.id) && m.content.trim().length >= 25 && m.content.length <= 2000 && !isCrisisText(m.content);

  const nowRows = sampleEvenly(weekMsgs.filter(quotable), 60);
  const thenRowsAll = userMessages.filter((m) => m.localDate < weekStart).filter(quotable);
  const thenRows = sampleEvenly(thenRowsAll, 160);
  const hadCrisisAdjacentWeek = weekMsgs.some((m) => isCrisisText(m.content));

  if (nowRows.length < 3 || thenRows.length < 3) return { userId, weekStart, skipped: "quiet_week" };

  const nowPool = buildPool(nowRows);
  const thenPool = buildPool(thenRows);

  // ── Internal-only language signals ──
  const priorWindowStart = ymdAddDays(weekStart, -21);
  const priorTexts = userMessages.filter((m) => m.localDate >= priorWindowStart && m.localDate < weekStart).map((m) => m.content);
  const signalGuidance = describeSignalShift(computeSignals(priorTexts), computeSignals(weekMsgs.map((m) => m.content)));

  const pathNote =
    profile.userPath === "bereavement"
      ? " They are grieving someone they lost — be gentle and present, never solution-focused."
      : profile.userPath === "breakup"
        ? " They are processing the end of a relationship."
        : "";
  const userName = profile.userName || "them";
  const companionName = profile.companionName || "Eos";

  // ── Themes (with one validation-feedback retry) ──
  let themes: ValidatedThemeDraft[] = [];
  let retryFeedback: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callClaude(
      anthropic,
      "chapter_themes",
      themePrompt({
        companionName,
        userName,
        pathNote,
        signalGuidance,
        nowListing: listingFor(nowRows),
        thenListing: listingFor(thenRows),
        hadCrisisAdjacentWeek,
        retryFeedback,
      }),
      2400,
      attempt === 0 ? 0.7 : 0.4,
    );
    const parsed = parseJson<{ themes?: RawThemeProposal[] }>(raw);
    const { valid, failures } = validateThemes(parsed?.themes ?? [], nowPool, thenPool);
    themes = valid;
    const hasPair = valid.some((t) => t.thenQuote !== null);
    if (valid.length >= 2 && (hasPair || thenRowsAll.length === 0)) break;
    if (valid.length >= 1 && attempt === 1) break;
    retryFeedback = failures.length ? failures.join("\n") : "Fewer than 2 themes survived validation — copy excerpts verbatim from the listed text.";
  }
  if (themes.length === 0) {
    logger.warn({ userId, weekStart }, "chapter: no themes survived verbatim validation — skipping week");
    return { userId, weekStart, skipped: "no_valid_themes" };
  }

  // ── Review + offer data ──
  const { goals, habits, reviewCandidates } = await loadReviewData(userId, now);

  const declineEvents = await db
    .select({ createdAt: chapterOfferEventsTable.createdAt })
    .from(chapterOfferEventsTable)
    .where(and(eq(chapterOfferEventsTable.userId, userId), eq(chapterOfferEventsTable.action, "declined")))
    .orderBy(desc(chapterOfferEventsTable.createdAt))
    .limit(1);
  const offerEligible = isOfferEligible({
    activeGoalCount: goals.length,
    activeHabitCount: habits.length,
    lastDeclineAt: declineEvents[0]?.createdAt ?? null,
    now,
  });

  // Seed candidates: lines where they named something that helped / lit them up.
  const SEED_RE = /\b(helped|helps|felt (so )?(good|better|alive|like me)|i love[d]?|used to love|miss(ed)? (doing|going|being)|always wanted|wish i (still )?(did|could|had time)|calm(s|ed)? me|clear(s|ed)? my head)\b/i;
  const seedRows = [...thenRows, ...nowRows].filter((r) => SEED_RE.test(r.content)).slice(-24);
  const seedPool = buildPool(seedRows);

  // ── Last chapter → open loop ──
  const [lastChapter] = await db
    .select()
    .from(weeklyChaptersTable)
    .where(eq(weeklyChaptersTable.userId, userId))
    .orderBy(desc(weeklyChaptersTable.weekStart))
    .limit(1);

  let openLoop = "This is their first chapter — open by welcoming them into this new weekly ritual: a letter made of their own words.";
  if (lastChapter) {
    const parts: string[] = [];
    const lastThemes = (lastChapter.themes as ChapterTheme[] | null) ?? [];
    if (lastThemes.length) parts.push(`Last week's letter sat with: ${lastThemes.map((t) => `"${t.title}"`).join(", ")}.`);
    const lastOffer = lastChapter.microOffer as MicroOffer | null;
    if (lastOffer?.status === "accepted") parts.push(`They accepted a tiny promise: "${lastOffer.goalTitle}" — its current state is in the tracked items below (or it may already be complete).`);
    if (lastOffer?.status === "declined") parts.push("They passed on last week's tiny offer — that choice gets respected, not revisited.");
    if (lastChapter.thresholdAnswer) parts.push(`Before reading it, they guessed their week had been about: "${String(lastChapter.thresholdAnswer).slice(0, 200)}".`);
    for (const item of reviewCandidates) {
      parts.push(`Tracked now: ${item.refKind} "${item.title}" — ${item.progressPhrase} (${item.verdict}).`);
    }
    openLoop = parts.join("\n") || "Nothing specific was left open last week — open by simply settling in beside them.";
  } else if (reviewCandidates.length) {
    openLoop += `\nTracked: ${reviewCandidates.map((i) => `${i.refKind} "${i.title}" — ${i.progressPhrase}`).join("; ")}.`;
  }

  const reviewBrief = reviewCandidates.length
    ? reviewCandidates.map((i) => `- ${i.refKind} refId=${i.refId} "${i.title}" — state: ${i.verdict}; this week they ${i.progressPhrase}`).join("\n")
    : null;
  const offerBrief =
    offerEligible && seedRows.length > 0
      ? `SEED CANDIDATES:\n${listingFor(seedRows)}`
      : null;

  const themesSummary = themes
    .map((t) => `- "${t.title}"${t.stillTrue ? " (still true)" : ""}: now — "${t.nowQuote.text.slice(0, 120)}"`)
    .join("\n");

  // ── Compose ──
  let opening = FALLBACK_OPENING;
  let question = FALLBACK_QUESTION;
  let notePromptText = FALLBACK_NOTE_PROMPT;
  let reviewItems: GoalReviewItem[] = [];
  let microOffer: MicroOffer | null = null;

  const composeRaw = await callClaude(
    anthropic,
    "chapter_compose",
    composePrompt({ companionName, userName, pathNote, openLoop, themesSummary, reviewBrief, offerBrief }),
    1800,
    0.7,
  );
  const compose = parseJson<RawCompose>(composeRaw);
  if (compose) {
    if (typeof compose.threadOpening === "string" && compose.threadOpening.trim().length >= 20) opening = compose.threadOpening.trim();
    if (typeof compose.thresholdQuestion === "string" && compose.thresholdQuestion.trim().length >= 10) question = compose.thresholdQuestion.trim().slice(0, 200);
    if (typeof compose.notePrompt === "string" && compose.notePrompt.trim().length >= 10) notePromptText = compose.notePrompt.trim().slice(0, 240);

    for (const ri of compose.reviewItems ?? []) {
      const match = reviewCandidates.find((c) => c.refKind === ri.refKind && c.refId === ri.refId);
      if (match && typeof ri.text === "string" && ri.text.trim().length >= 15) {
        reviewItems.push({ refKind: match.refKind, refId: match.refId, title: match.title, verdict: match.verdict, text: ri.text.trim() });
      }
    }
    // Every tracked item must be reviewed — fill gaps with safe templates.
    for (const c of reviewCandidates) {
      if (!reviewItems.some((r) => r.refKind === c.refKind && r.refId === c.refId)) {
        reviewItems.push({
          refKind: c.refKind,
          refId: c.refId,
          title: c.title,
          verdict: c.verdict,
          text: `"${c.title}" is still yours, and there's no scorecard here. Whenever you want, we can look at how it's sitting together.`,
        });
      }
    }

    // Offer: ONLY from a validated seed quote. No seed → no offer, by construction.
    if (offerBrief && compose.offer && typeof compose.offer === "object") {
      const seed = validateExcerpt(compose.offer.messageId, compose.offer.excerpt, seedPool);
      const offerText = (compose.offer.offerText ?? "").trim();
      const goalTitle = (compose.offer.goalTitle ?? "").trim().slice(0, 100);
      const goalDescription = (compose.offer.goalDescription ?? "").trim().slice(0, 400);
      if (seed && offerText.length >= 20 && goalTitle) {
        microOffer = {
          seedMessageId: seed.messageId,
          seedQuote: seed.text,
          seedDate: seed.date,
          text: offerText,
          goalTitle,
          goalDescription: goalDescription || goalTitle,
          status: "pending",
        };
      }
    }
  } else {
    for (const c of reviewCandidates) {
      reviewItems.push({
        refKind: c.refKind,
        refId: c.refId,
        title: c.title,
        verdict: c.verdict,
        text: `"${c.title}" is still yours, and there's no scorecard here. Whenever you want, we can look at how it's sitting together.`,
      });
    }
  }

  // ── Story threads (processing vs stuck) — weekly indexing pass ──
  // Failures here never block the chapter: threads are enrichment; the letter
  // is the product. Frozen threads are structurally excluded from chapters.
  let workingThrough: WorkingThrough | null = null;
  try {
    const { threads } = await updateStoryThreads({
      userId,
      weekStart,
      weekMessages: nowRows,
      llm: (prompt, maxTokens, temperature) => callClaude(anthropic, "chapter_story_threads", prompt, maxTokens, temperature),
      parseJson,
    });
    const chosen = pickWorkingThroughThread(threads);
    if (chosen) {
      const entries = buildWorkingThroughEntries(chosen, weekStart);
      if (entries.length >= 2) {
        let reflection = FALLBACK_WORKING_REFLECTION;
        try {
          const raw = await callClaude(
            anthropic,
            "chapter_working_through",
            workingReflectionPrompt({ companionName, userName, label: chosen.label, entries }),
            400,
            0.7,
          );
          if (raw.trim().length >= 30) reflection = raw.trim();
        } catch (err) {
          logger.warn({ err, userId }, "chapter: working-through reflection failed — using fallback");
        }
        workingThrough = { label: chosen.label, entries, reflection };
      }
    }
  } catch (err) {
    logger.warn({ err, userId }, "chapter: story-thread pass failed — continuing without");
  }

  // ── Sealed note from the last chapter → resolution in this one ──
  let sealResolution: SealResolution | null = null;
  try {
    const pendingNote = await fetchPendingSealedNote(userId);
    if (pendingNote) {
      if (pendingNote.crisisFlagged) {
        // A crisis-flagged note is NEVER quoted back — fixed warm acknowledgment.
        sealResolution = {
          noteId: pendingNote.id,
          noteKind: pendingNote.kind,
          notePrompt: pendingNote.prompt,
          noteText: null,
          crisisFlagged: true,
          text: CRISIS_NOTE_RESOLUTION,
        };
      } else {
        let text = FALLBACK_RESOLUTION;
        try {
          const raw = await callClaude(
            anthropic,
            "chapter_seal_resolution",
            resolutionPrompt({
              companionName,
              userName,
              noteKind: pendingNote.kind,
              notePrompt: pendingNote.prompt,
              noteText: pendingNote.text,
              weekBrief: themesSummary,
            }),
            500,
            0.7,
          );
          if (raw.trim().length >= 30) text = raw.trim();
        } catch (err) {
          logger.warn({ err, userId }, "chapter: seal-resolution call failed — using fallback");
        }
        sealResolution = {
          noteId: pendingNote.id,
          noteKind: pendingNote.kind,
          notePrompt: pendingNote.prompt,
          noteText: pendingNote.text,
          crisisFlagged: false,
          text,
        };
      }
    }
  } catch (err) {
    logger.warn({ err, userId }, "chapter: sealed-note lookup failed — continuing without");
  }

  // ── Kind-truth check with one repair round, then fallbacks ──
  const sections: ProseSection[] = [
    { name: "opening", text: opening },
    { name: "question", text: question },
    ...themes.map((t, i) => ({ name: `theme:${i}`, text: `${t.reflection}${t.eraNote ? `\n${t.eraNote}` : ""}` })),
    ...reviewItems.map((r) => ({ name: `review:${r.refKind}:${r.refId}`, text: r.text })),
    ...(microOffer ? [{ name: "offer", text: microOffer.text }] : []),
    ...(workingThrough ? [{ name: "workingThrough", text: workingThrough.reflection }] : []),
    ...(sealResolution && !sealResolution.crisisFlagged ? [{ name: "sealResolution", text: sealResolution.text }] : []),
    { name: "noteInvite", text: notePromptText },
  ];
  let verdicts = await checkKindTruth(sections, anthropic as never);
  let failing = verdicts.filter((v) => !v.pass);

  if (failing.length > 0) {
    const failBrief = failing
      .map((f) => {
        const original = sections.find((s) => s.name === f.name)?.text ?? "";
        return `[${f.name}] problems: ${f.reasons.join("; ")}\noriginal: ${original}`;
      })
      .join("\n\n");
    const repairRaw = await callClaude(
      anthropic,
      "chapter_repair",
      `You are ${companionName}. These chapter sections for ${userName} failed a kindness-and-truth review. Rewrite EACH ONE so it keeps its meaning but obeys: no clinical labels, no verdicts, no digits counting their behavior, no timestamps, no percentages, no generic advice, every hard observation hands agency back, distress is never regression. Keep each rewrite roughly the same length.\n\n${failBrief}\n\nRespond ONLY with JSON: {"rewrites":[{"name":"...","text":"..."}]}`,
      1400,
      0.4,
    );
    const repairs = parseJson<{ rewrites?: Array<{ name?: string; text?: string }> }>(repairRaw);
    const repairedNames = new Set<string>();
    for (const r of repairs?.rewrites ?? []) {
      if (!r?.name || typeof r.text !== "string" || r.text.trim().length < 15) continue;
      if (deterministicViolations(r.text).length > 0) continue; // repair still dirty
      const idx = sections.findIndex((s) => s.name === r.name);
      if (idx === -1) continue;
      sections[idx] = { name: r.name, text: r.text.trim() };
      repairedNames.add(r.name);
    }
    // Re-check only what claims to be repaired; everything else falls back.
    const recheck = repairedNames.size
      ? await checkKindTruth(sections.filter((s) => repairedNames.has(s.name)), anthropic as never)
      : [];
    const stillFailing = new Set(failing.map((f) => f.name));
    for (const v of recheck) if (v.pass) stillFailing.delete(v.name);

    // Apply fallbacks for anything still failing.
    for (const name of stillFailing) {
      if (name === "opening") {
        const i = sections.findIndex((s) => s.name === name);
        sections[i] = { name, text: FALLBACK_OPENING };
      } else if (name === "question") {
        const i = sections.findIndex((s) => s.name === name);
        sections[i] = { name, text: FALLBACK_QUESTION };
      } else if (name.startsWith("theme:")) {
        const idx = Number(name.split(":")[1]);
        themes[idx] = null as never; // drop below
      } else if (name.startsWith("review:")) {
        const [, refKind, refIdStr] = name.split(":");
        const item = reviewItems.find((r) => r.refKind === refKind && r.refId === Number(refIdStr));
        if (item) {
          item.text = `"${item.title}" is still yours, and there's no scorecard here. Whenever you want, we can look at how it's sitting together.`;
          // Keep sections in sync so the fold-back below can't resurrect the
          // failing text over this safe fallback.
          const i = sections.findIndex((s) => s.name === name);
          if (i !== -1) sections[i] = { name, text: item.text };
        }
      } else if (name === "offer") {
        microOffer = null;
      } else if (name === "workingThrough") {
        const i = sections.findIndex((s) => s.name === name);
        if (i !== -1) sections[i] = { name, text: FALLBACK_WORKING_REFLECTION };
      } else if (name === "sealResolution") {
        const i = sections.findIndex((s) => s.name === name);
        if (i !== -1) sections[i] = { name, text: FALLBACK_RESOLUTION };
      } else if (name === "noteInvite") {
        const i = sections.findIndex((s) => s.name === name);
        if (i !== -1) sections[i] = { name, text: FALLBACK_NOTE_PROMPT };
      }
    }
  }

  // Fold possibly-repaired section text back into structures.
  const sectionText = (name: string) => sections.find((s) => s.name === name)?.text;
  opening = sectionText("opening") ?? FALLBACK_OPENING;
  question = sectionText("question") ?? FALLBACK_QUESTION;
  const finalThemes: ChapterTheme[] = [];
  themes.forEach((t, i) => {
    if (!t) return; // dropped by kind-truth fallback
    const combined = sectionText(`theme:${i}`) ?? t.reflection;
    const [reflection, eraNote] = t.eraNote ? [combined.split("\n")[0] ?? combined, combined.split("\n").slice(1).join("\n") || t.eraNote] : [combined, undefined];
    const quotes: ChapterQuote[] = [];
    if (t.thenQuote) quotes.push({ ...t.thenQuote, kind: "then" });
    quotes.push({ ...t.nowQuote, kind: "now" });
    finalThemes.push({
      key: `t${i}`,
      title: t.title,
      kind: t.kind,
      stillTrue: t.stillTrue,
      quotes,
      reflection: reflection.trim(),
      ...(eraNote ? { eraNote: eraNote.trim() } : {}),
    });
  });
  for (const r of reviewItems) {
    const repaired = sectionText(`review:${r.refKind}:${r.refId}`);
    if (repaired) r.text = repaired;
  }
  if (microOffer) {
    const repaired = sectionText("offer");
    if (repaired) microOffer.text = repaired;
  }
  if (workingThrough) {
    const repaired = sectionText("workingThrough");
    if (repaired) workingThrough.reflection = repaired;
  }
  if (sealResolution && !sealResolution.crisisFlagged) {
    const repaired = sectionText("sealResolution");
    if (repaired) sealResolution.text = repaired;
  }
  notePromptText = sectionText("noteInvite") ?? notePromptText;

  if (finalThemes.length === 0) {
    logger.warn({ userId, weekStart }, "chapter: all themes failed kind-truth — skipping week");
    return { userId, weekStart, skipped: "no_valid_themes" };
  }

  // ── Final hard gate before persisting: re-verify every quote verbatim ──
  const allIds = new Set<number>();
  for (const t of finalThemes) for (const q of t.quotes) allIds.add(q.messageId);
  if (microOffer) allIds.add(microOffer.seedMessageId);
  const sourceRows = allIds.size
    ? await db
        .select({ id: messagesTable.id, userId: messagesTable.userId, role: messagesTable.role, content: messagesTable.content })
        .from(messagesTable)
        .where(inArray(messagesTable.id, [...allIds]))
    : [];
  const sourceById = new Map(sourceRows.map((r) => [r.id, r]));
  const quoteIsSafe = (messageId: number, text: string) => {
    const src = sourceById.get(messageId);
    return !!src && src.userId === userId && src.role === "user" && src.content.includes(text) && !isCrisisText(src.content) && !dismissed.has(messageId);
  };
  const persistThemes = finalThemes
    .map((t) => ({ ...t, quotes: t.quotes.filter((q) => quoteIsSafe(q.messageId, q.text)) }))
    .filter((t) => t.quotes.some((q) => q.kind === "now"));
  if (microOffer && !quoteIsSafe(microOffer.seedMessageId, microOffer.seedQuote)) microOffer = null;
  if (persistThemes.length === 0) {
    return { userId, weekStart, skipped: "no_valid_themes" };
  }

  // Chapter insert + note resolution move together or not at all — a chapter
  // that claims to resolve a note which stays 'sealed' (or vice versa) would
  // let a later week resolve the same note twice.
  const resolutionForTx = sealResolution;
  const inserted = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(weeklyChaptersTable)
      .values({
        userId,
        weekStart,
        weekEnd,
        status: "ready",
        threadOpening: opening,
        thresholdQuestion: question,
        themes: persistThemes,
        goalReview: reviewItems.length ? { items: reviewItems } : null,
        microOffer,
        noteInvite: { prompt: notePromptText },
        sealResolution: resolutionForTx,
        workingThrough,
      })
      .onConflictDoNothing()
      .returning({ id: weeklyChaptersTable.id });

    // Mark the note resolved only when THIS insert actually created the chapter
    // (onConflictDoNothing → no id → another writer won; leave the note sealed).
    if (row?.id && resolutionForTx) {
      const updated = await tx
        .update(sealedNotesTable)
        .set({ status: "resolved", resolvedChapterId: row.id, resolvedAt: new Date() })
        .where(and(eq(sealedNotesTable.id, resolutionForTx.noteId), eq(sealedNotesTable.status, "sealed")))
        .returning({ id: sealedNotesTable.id });
      // The note vanished or was already resolved by another writer — roll the
      // whole chapter back rather than persist a resolution pointing nowhere.
      if (updated.length === 0) throw new Error(`sealed note ${resolutionForTx.noteId} not resolvable`);
    }
    return row;
  });

  logger.info(
    { userId, weekStart, chapterId: inserted?.id, themes: persistThemes.length, hasOffer: !!microOffer, reviewItems: reviewItems.length },
    "chapter: generated",
  );
  return { userId, weekStart, chapterId: inserted?.id };
}

// ─── Weekly sweep (called hourly via internal endpoint) ───────────────────────

export interface SweepDryRunDecision {
  userId: number;
  decision: string;
}

export interface SweepResult {
  considered: number;
  generated: number;
  skipped: Record<string, number>;
  failed: number;
  /** Present only when the sweep ran in dry-run mode. */
  dryRun?: boolean;
  decisions?: SweepDryRunDecision[];
}

/**
 * Read-only preview of generateChapterForUser's cheap eligibility gates —
 * same order, zero writes, zero AI calls. Deliberately selects only
 * id/role/createdAt from messages (never content) so no decryption or
 * quote work happens; "would-generate-chapter" therefore means "the real
 * run would ATTEMPT generation" (it could still skip on no_valid_themes,
 * which is unknowable without calling the model).
 */
async function previewChapterDecision(userId: number, tz: string, now: Date, force: boolean): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) return "no_ai";
  const { weekStart, weekEnd } = weekBoundsFor(tz, now);

  const existing = await db
    .select({ id: weeklyChaptersTable.id })
    .from(weeklyChaptersTable)
    .where(and(eq(weeklyChaptersTable.userId, userId), eq(weeklyChaptersTable.weekStart, weekStart)));
  if (existing.length > 0 && !force) return "exists";

  const rows = await db
    .select({ id: messagesTable.id, role: messagesTable.role, createdAt: messagesTable.createdAt })
    .from(messagesTable)
    .where(eq(messagesTable.userId, userId))
    .orderBy(asc(messagesTable.createdAt));
  const userMsgs = rows.filter((m) => m.role === "user");
  if (userMsgs.length === 0) return "cold_start";
  const firstDate = localYmd(tz, userMsgs[0]!.createdAt);
  const weeksTogether = Math.floor(
    (new Date(`${localYmd(tz, now)}T12:00:00Z`).getTime() - new Date(`${firstDate}T12:00:00Z`).getTime()) / (7 * 86_400_000),
  );
  if (weeksTogether < 3) return "cold_start";
  const weekMsgCount = userMsgs.filter((m) => {
    const d = localYmd(tz, m.createdAt);
    return d >= weekStart && d <= weekEnd;
  }).length;
  if (weekMsgCount < 5) return "quiet_week";
  return "would-generate-chapter";
}

/**
 * Generates chapters for every eligible user whose LOCAL clock is inside the
 * delivery window: Sunday 18:00 → Monday 09:59. UNIQUE(userId, weekStart)
 * makes repeated hourly calls naturally idempotent.
 *
 * Dry run (opts.dryRun): mirrors the daily-email DAILY_EMAIL_DRY_RUN
 * guarantee — logs exactly one decision per candidate user, performs ZERO
 * writes, pushes nothing, and never calls the model.
 */
export async function runWeeklySweep(
  opts: { now?: Date; onlyUserId?: number; ignoreWindow?: boolean; force?: boolean; dryRun?: boolean } = {},
): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const users = await db
    .select({ userId: profileTable.userId, timezone: profileTable.timezone })
    .from(profileTable)
    .innerJoin(usersTable, eq(usersTable.id, profileTable.userId))
    .where(and(isNotNull(usersTable.emailVerifiedAt), eq(profileTable.isOnboardingComplete, true)));

  const result: SweepResult = { considered: 0, generated: 0, skipped: {}, failed: 0 };
  if (dryRun) {
    result.dryRun = true;
    result.decisions = [];
    logger.info({ dryRun: true, candidates: users.length }, "DRY RUN — weekly chapter sweep: nothing will be generated, written, or pushed");
  }
  const recordDecision = (userId: number, decision: string) => {
    result.decisions!.push({ userId, decision });
    logger.info({ dryRun: true, sweep: "chapters", userId, decision }, "dry-run decision");
  };

  for (const u of users) {
    if (!u.userId) continue;
    if (opts.onlyUserId && u.userId !== opts.onlyUserId) continue;

    const tz = u.timezone || "UTC";
    if (!opts.ignoreWindow) {
      const weekday = localWeekday(tz, now);
      const hour = localHour(tz, now);
      const inWindow = (weekday === "Sunday" && hour >= 18) || (weekday === "Monday" && hour <= 9);
      if (!inWindow) {
        if (dryRun) recordDecision(u.userId, "outside-window");
        continue;
      }
    }

    if (dryRun) {
      result.considered++;
      try {
        recordDecision(u.userId, await previewChapterDecision(u.userId, tz, now, opts.force === true));
      } catch (err) {
        result.failed++;
        logger.error({ err, userId: u.userId }, "chapter dry run: preview failed");
      }
      continue;
    }

    result.considered++;
    try {
      const r = await generateChapterForUser(u.userId, { now, force: opts.force });
      if (r.chapterId) {
        result.generated++;
        // r.chapterId is set only on a REAL insert → this fires at most once
        // per user per week. The atomic daily cap still applies underneath.
        try {
          await sendPushToUser(u.userId, "chapter_ready", {
            title: "Eos",
            body: "Your chapter is ready — a letter from your week, in your own words.",
            url: "/chapters",
          });
        } catch (err) {
          logger.warn({ err, userId: u.userId }, "chapter: ready-push failed");
        }
      } else if (r.skipped) result.skipped[r.skipped] = (result.skipped[r.skipped] ?? 0) + 1;
    } catch (err) {
      result.failed++;
      logger.error({ err, userId: u.userId }, "chapter: generation failed");
    }
  }
  return result;
}
