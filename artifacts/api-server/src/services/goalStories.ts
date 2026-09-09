/**
 * Goals and Routines stories — the three-state content model.
 *
 * Every morning (first hourly tick after 06:00 user-local) the sweep looks
 * at each live goal and routine and decides whether it has something to say:
 *
 *   State A — something real happened (they mentioned it, did something
 *             toward it, or hit an obstacle). The card speaks: it reflects the
 *             actual thing back in their words, acknowledges the ACTION (never
 *             the person), and may offer a forward hook as an if-then.
 *   State B — nothing happened, still live (mentioned in the last ~2 weeks).
 *             An observation, not a question, every few days, rotating which
 *             goal speaks so none of them nags. Never references the absence
 *             of action.
 *   State C — gone quiet. Silence. At a fresh start only (the first of the
 *             month) a one-time offer to let it go — a real, unpenalised
 *             option; the goal stays retrievable.
 *
 * Routines are recurring and binary, so two differences: they show a PATTERN
 * ("Most days this week", "Four of the last seven"), never a chain; and after
 * a miss the card deflates it, truthfully, with re-entry offered at landmarks.
 *
 * The model matches messages to goals and writes the prose — there is no way
 * to reflect what someone actually said without it. Everything it returns is
 * gated: excerpts must be verbatim, state-A prose must carry their words,
 * and every sentence passes the story gates (services/storyGate.ts) and the
 * kind-truth scrubs. A card that fails is DROPPED and recorded
 * (services/storyDrops.ts) — never rewritten, never retried.
 *
 * Nothing here reads prosody, mood, streaks or feelings, and nothing pushes:
 * the ring on the marker is the only signal.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import {
  db,
  goalsTable,
  goalTasksTable,
  habitsTable,
  habitCompletionsTable,
  messagesTable,
  profileTable,
  usersTable,
  storiesTable,
  chapterQuoteDismissalsTable,
  crisisEventsTable,
} from "@workspace/db";
import { isNotNull } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";
import { getAnthropic, logAiUsage } from "./ai.js";
import { isCrisisText } from "./crisis/detector.js";
import { checkKindTruth, type ProseSection, type SectionVerdict } from "./chapters/kindTruth.js";
import { localYmd, ymdAddDays } from "./chapters/generate.js";
import { insertStory, type StoryCard, type StoryKind, FRAGMENT_MAX } from "./stories.js";
import { storyGateViolations, reflectsExcerpt } from "./storyGate.js";
import { recordStoryDrop } from "./storyDrops.js";

// ── Inputs (pure) ───────────────────────────────────────────────────────────

export interface GoalInput {
  id: number;
  title: string;
  description: string;
  /** YYYY-MM-DD user-local */
  createdOn: string;
  lastReferencedOn: string | null;
  lastSpokeOn: string | null;
  letGoOfferedOn: string | null;
  tasks: Array<{ content: string; isComplete: boolean; completedOn: string | null }>;
}

export interface HabitInput {
  id: number;
  name: string;
  whenThen: string;
  createdOn: string;
  /** YYYY-MM-DD dates completed in the last 14 days (deduped). */
  completions: string[];
  lastSpokeOn: string | null;
}

export interface SubjectMessage {
  id: number;
  content: string;
  localDate: string;
}

export type SubjectState = "happened" | "live" | "quiet";
export type EvidenceKind = "action" | "obstacle" | "mention";

export interface GoalClassification {
  goalId: number;
  state: SubjectState;
  messageId?: number | null;
  excerpt?: string | null;
  kind?: EvidenceKind | null;
}

export interface GoalDecision {
  goal: GoalInput;
  state: SubjectState;
  excerpt: { messageId: number; text: string; localDate: string } | null;
  evidenceKind: EvidenceKind | null;
  tasksDone: string[];
}

export interface Speaker {
  subjectId: number;
  name: string;
  state: "happened" | "live";
  excerpt: { text: string; weekday: string } | null;
  evidenceKind: EvidenceKind | null;
  tasksDone: string[];
  /** Routines only: the deterministic pattern phrase. */
  pattern?: string | null;
}

/** The model may propose; the composer validates. Injectable for tests. */
export interface StoryModel {
  classifyGoals(input: { goals: GoalInput[]; messages: SubjectMessage[] }): Promise<GoalClassification[]>;
  writeCards(input: { kind: "goals" | "routines"; speakers: Speaker[] }): Promise<Array<{ subjectId: number; text: string }>>;
}

export type KindTruthCheck = (sections: ProseSection[]) => Promise<SectionVerdict[]>;

// ── Dates ───────────────────────────────────────────────────────────────────

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function weekdayOf(ymd: string): string {
  return WEEKDAYS[new Date(`${ymd}T12:00:00Z`).getUTCDay()]!;
}
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86_400_000);
}
function withinDays(ymd: string | null, today: string, days: number): boolean {
  if (!ymd) return false;
  const d = daysBetween(ymd, today);
  return d >= 0 && d <= days;
}
export function isFreshStart(today: string): boolean {
  return today.endsWith("-01");
}

export const HAPPENED_WINDOW_DAYS = 7;
export const LIVE_WINDOW_DAYS = 14;
export const SPEAK_EVERY_DAYS = 3; // state B cadence per subject and per story kind
export const MAX_CARDS = 3;
export const MAX_HAPPENED_CARDS = 2;

// ── Goals: decide states (pure) ─────────────────────────────────────────────

function verbatim(messages: SubjectMessage[], messageId: unknown, excerpt: unknown) {
  if (typeof messageId !== "number" || typeof excerpt !== "string") return null;
  const text = excerpt.trim();
  if (text.length < 8 || text.length > 240) return null;
  const src = messages.find((m) => m.id === messageId);
  if (!src || !src.content.includes(text)) return null;
  return { messageId, text, localDate: src.localDate };
}

export function decideGoalStates(
  goals: GoalInput[],
  classifications: GoalClassification[],
  messages: SubjectMessage[],
  today: string,
): GoalDecision[] {
  const byId = new Map(classifications.map((c) => [c.goalId, c]));
  return goals.map((goal) => {
    const c = byId.get(goal.id);
    const excerpt = c ? verbatim(messages, c.messageId, c.excerpt) : null;
    const tasksDone = goal.tasks.filter((t) => t.isComplete && withinDays(t.completedOn, today, HAPPENED_WINDOW_DAYS)).map((t) => t.content);

    // Structural signals first — a ticked step is action whatever the model says.
    if (tasksDone.length > 0) {
      return { goal, state: "happened", excerpt, evidenceKind: excerpt ? (c?.kind ?? "mention") : "action", tasksDone };
    }
    // The model may say "happened" only with their verbatim words as evidence.
    if (c?.state === "happened" && excerpt) {
      return { goal, state: "happened", excerpt, evidenceKind: c.kind ?? "mention", tasksDone };
    }
    const live =
      withinDays(goal.lastReferencedOn, today, LIVE_WINDOW_DAYS) ||
      withinDays(goal.createdOn, today, LIVE_WINDOW_DAYS) ||
      (c?.state === "live") ||
      (c?.state === "happened");
    return { goal, state: live ? "live" : "quiet", excerpt, evidenceKind: excerpt ? (c?.kind ?? "mention") : null, tasksDone };
  });
}

export interface GoalPlan {
  speakers: Speaker[];
  /** Quiet goals offered a let-go this morning (fresh start only). */
  letGoOffers: GoalInput[];
}

/** Who speaks this morning. State A goals always (cap 2). Otherwise ONE
 *  state-B goal, only when the last Goals story is ≥ 3 days old, rotating by
 *  longest-since-spoke. On the first of the month, a quiet goal that has never
 *  been offered a let-go gets the one-time offer. */
export function planGoalSpeakers(decisions: GoalDecision[], today: string, lastStoryOn: string | null): GoalPlan {
  const speakers: Speaker[] = [];
  const happened = decisions.filter((d) => d.state === "happened").slice(0, MAX_HAPPENED_CARDS);
  for (const d of happened) {
    speakers.push({
      subjectId: d.goal.id,
      name: d.goal.title,
      state: "happened",
      excerpt: d.excerpt ? { text: d.excerpt.text, weekday: weekdayOf(d.excerpt.localDate) } : null,
      evidenceKind: d.evidenceKind,
      tasksDone: d.tasksDone,
    });
  }

  const storyDue = !lastStoryOn || daysBetween(lastStoryOn, today) >= SPEAK_EVERY_DAYS;
  if (speakers.length === 0 && storyDue) {
    const live = decisions
      .filter((d) => d.state === "live" && (!d.goal.lastSpokeOn || daysBetween(d.goal.lastSpokeOn, today) >= SPEAK_EVERY_DAYS))
      .sort((a, b) => (a.goal.lastSpokeOn ?? "").localeCompare(b.goal.lastSpokeOn ?? ""));
    const pick = live[0];
    if (pick) {
      speakers.push({
        subjectId: pick.goal.id,
        name: pick.goal.title,
        state: "live",
        excerpt: pick.excerpt ? { text: pick.excerpt.text, weekday: weekdayOf(pick.excerpt.localDate) } : null,
        evidenceKind: pick.evidenceKind,
        tasksDone: [],
      });
    }
  }

  const letGoOffers = isFreshStart(today)
    ? decisions.filter((d) => d.state === "quiet" && !d.goal.letGoOfferedOn).slice(0, 1).map((d) => d.goal)
    : [];

  return { speakers, letGoOffers };
}

// ── Routines: decide (pure) ─────────────────────────────────────────────────

const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven"];

/** The pattern, never the chain. */
export function patternPhrase(completions: string[], today: string): string | null {
  const last7 = new Set(completions.filter((d) => withinDays(d, today, 6)));
  const n = last7.size;
  if (n === 0) return null;
  if (n >= 7) return "Every day this week";
  if (n >= 5) return "Most days this week";
  return `${NUMBER_WORDS[n]} of the last seven`;
}

export type RoutineDecision =
  | { habit: HabitInput; kind: "happened"; doneOn: string }
  | { habit: HabitInput; kind: "missed" }
  | { habit: HabitInput; kind: "live" }
  | { habit: HabitInput; kind: "quiet" };

export function decideRoutineStates(habits: HabitInput[], today: string): RoutineDecision[] {
  const yesterday = ymdAddDays(today, -1);
  const twoDaysAgo = ymdAddDays(today, -2);
  return habits.map((habit) => {
    const done = new Set(habit.completions);
    const recent = habit.completions.filter((d) => withinDays(d, today, 13));
    if (done.has(today) || done.has(yesterday)) {
      return { habit, kind: "happened", doneOn: done.has(today) ? today : yesterday };
    }
    // Missed exactly one day of an established routine: deflate it.
    if (done.has(twoDaysAgo) && recent.length >= 3) return { habit, kind: "missed" };
    if (recent.length > 0) return { habit, kind: "live" };
    return { habit, kind: "quiet" };
  });
}

export interface RoutinePlan {
  speakers: Speaker[];
  /** Deflation cards (spec wording, no model) for a single missed day. */
  missed: HabitInput[];
  /** First-of-month re-entry cards (spec wording) for routines gone quiet. */
  reentry: HabitInput[];
}

export function planRoutineSpeakers(decisions: RoutineDecision[], today: string, lastStoryOn: string | null): RoutinePlan {
  const storyDue = !lastStoryOn || daysBetween(lastStoryOn, today) >= SPEAK_EVERY_DAYS;
  const canSpeak = (h: HabitInput) => !h.lastSpokeOn || daysBetween(h.lastSpokeOn, today) >= SPEAK_EVERY_DAYS;

  // Deflation goes out the morning after the miss, once per routine.
  const missed = decisions
    .filter((d): d is Extract<RoutineDecision, { kind: "missed" }> => d.kind === "missed" && (!d.habit.lastSpokeOn || d.habit.lastSpokeOn < today))
    .map((d) => d.habit)
    .slice(0, 1);

  const speakers: Speaker[] = [];
  if (missed.length === 0 && storyDue) {
    const happened = decisions
      .filter((d): d is Extract<RoutineDecision, { kind: "happened" }> => d.kind === "happened" && canSpeak(d.habit))
      .sort((a, b) => (a.habit.lastSpokeOn ?? "").localeCompare(b.habit.lastSpokeOn ?? ""));
    const live = decisions
      .filter((d): d is Extract<RoutineDecision, { kind: "live" }> => d.kind === "live" && canSpeak(d.habit))
      .sort((a, b) => (a.habit.lastSpokeOn ?? "").localeCompare(b.habit.lastSpokeOn ?? ""));
    const pick = happened[0] ?? live[0];
    if (pick) {
      speakers.push({
        subjectId: pick.habit.id,
        name: pick.habit.name,
        state: pick.kind === "happened" ? "happened" : "live",
        excerpt: null,
        evidenceKind: pick.kind === "happened" ? "action" : null,
        tasksDone: pick.kind === "happened" ? [`logged on ${weekdayOf(pick.doneOn)}`] : [],
        pattern: patternPhrase(pick.habit.completions, today),
      });
    }
  }

  const reentry = isFreshStart(today)
    ? decisions.filter((d) => d.kind === "quiet" && (!d.habit.lastSpokeOn || d.habit.lastSpokeOn < today)).map((d) => d.habit).slice(0, 1)
    : [];

  return { speakers, missed, reentry };
}

// ── Spec wording for the template cards (no model) ──────────────────────────

export const MISSED_DAY_TEXT = "You missed yesterday. That’s genuinely nothing. One day never broke anything. Today’s just today.";
export const REENTRY_TEXT = "It’s the first of the month. Clean page if you want one. The old pages don’t count against you.";
export function letGoOfferText(title: string): string {
  return `You haven’t come back to ${title} in a while. No judgment. Sometimes a thing has done its job. If that’s true we can let it go. If it’s not, it’s right here.`;
}

// ── Gating (pure, plus the injectable kind-truth pass) ──────────────────────

export interface GateOutcome {
  kept: Array<{ subjectId: number; text: string }>;
  dropped: Array<{ subjectId: number; text: string; stage: "gate" | "reflection" | "kind_truth"; reasons: string[] }>;
}

export async function gateCards(
  speakers: Speaker[],
  written: Array<{ subjectId: number; text: string }>,
  kindTruth: KindTruthCheck,
): Promise<GateOutcome> {
  const out: GateOutcome = { kept: [], dropped: [] };
  const survivors: Array<{ subjectId: number; text: string }> = [];
  for (const w of written) {
    const speaker = speakers.find((s) => s.subjectId === w.subjectId);
    if (!speaker) continue;
    const text = (w.text ?? "").trim().replace(/\s+/g, " ");
    if (text.length < 20 || text.length > 420) {
      out.dropped.push({ subjectId: w.subjectId, text, stage: "gate", reasons: ["length out of range"] });
      continue;
    }
    const reasons = storyGateViolations(text);
    if (reasons.length > 0) {
      out.dropped.push({ subjectId: w.subjectId, text, stage: "gate", reasons });
      continue;
    }
    if (speaker.state === "happened" && speaker.excerpt && !reflectsExcerpt(text, speaker.excerpt.text)) {
      out.dropped.push({ subjectId: w.subjectId, text, stage: "reflection", reasons: ["does not carry their own words"] });
      continue;
    }
    survivors.push({ subjectId: w.subjectId, text });
  }
  if (survivors.length === 0) return out;
  const verdicts = await kindTruth(survivors.map((s) => ({ name: String(s.subjectId), text: s.text })));
  for (const s of survivors) {
    const v = verdicts.find((x) => x.name === String(s.subjectId));
    if (v && !v.pass) out.dropped.push({ subjectId: s.subjectId, text: s.text, stage: "kind_truth", reasons: v.reasons });
    else out.kept.push(s);
  }
  return out;
}

/** A goal or routine name for the disc: three short lines fit, so a long
 *  name is cut at a word boundary within 24 characters — whole words, no
 *  trailing dots (an ellipsis inside a circle reads as broken). */
export const NAME_FRAGMENT_MAX = 24;
export function fragmentFor(name: string): string {
  const t = name.trim().replace(/\s+/g, " ");
  const max = Math.min(NAME_FRAGMENT_MAX, FRAGMENT_MAX);
  if (t.length <= max) return t;
  const words = t.split(" ");
  let out = "";
  for (const w of words) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > max) break;
    out = next;
  }
  return out || t.slice(0, max);
}

// ── Model (Anthropic) ───────────────────────────────────────────────────────

export function buildClassifyPrompt(goals: GoalInput[], messages: SubjectMessage[]): string {
  const goalLines = goals.map((g) => {
    const steps = g.tasks.map((t) => `${t.isComplete ? "[x]" : "[ ]"} ${t.content}`).join("; ");
    return `- goal ${g.id}: "${g.title}"${g.description ? ` — ${g.description}` : ""}${steps ? ` (steps: ${steps})` : ""}`;
  });
  const msgLines = messages.slice(-60).map((m) => `[id ${m.id} | ${m.localDate}] ${m.content.length > 300 ? `${m.content.slice(0, 300)}…` : m.content}`);
  return `You are matching a person's own messages from the last week to their goals. Return valid JSON only — no explanation.

THEIR GOALS:
${goalLines.join("\n")}

THEIR MESSAGES THIS WEEK (id | date | text):
${msgLines.length > 0 ? msgLines.join("\n") : "(none)"}

For EACH goal return one entry:
{ "goals": [ { "goalId": <id>, "state": "happened" | "live" | "quiet", "messageId": <id or null>, "excerpt": "<their exact words or null>", "kind": "action" | "obstacle" | "mention" | null } ] }

Rules:
- "happened": they said they did something toward the goal ("action"), or hit a specific obstacle to it ("obstacle"). Cite the message and copy their words EXACTLY, character for character — 8 to 40 words. No paraphrase.
- "live": they mentioned the goal but nothing happened ("mention"). Cite it if you can.
- "quiet": the goal does not come up. messageId, excerpt and kind are null.
- Never invent a mention. When unsure, "quiet".`;
}

export function buildWritePrompt(kind: "goals" | "routines", speakers: Speaker[]): string {
  const items = speakers.map((s) => {
    const parts = [`- subjectId ${s.subjectId}: "${s.name}" — state: ${s.state === "happened" ? "A (something real happened)" : "B (nothing happened, still live)"}`];
    if (s.excerpt) parts.push(`  their words (${s.excerpt.weekday}): "${s.excerpt.text}"`);
    if (s.evidenceKind) parts.push(`  what it was: ${s.evidenceKind}`);
    if (s.tasksDone.length > 0) parts.push(`  done: ${s.tasksDone.join("; ")}`);
    if (s.pattern) parts.push(`  pattern this week: ${s.pattern}`);
    return parts.join("\n");
  });
  const subject = kind === "goals" ? "goal" : "routine";
  return `You are writing one short card for each ${subject} below, spoken by a warm, plain companion to an adult. Return valid JSON only — no explanation:
{ "cards": [ { "subjectId": <id>, "text": "..." } ] }

${items.join("\n")}

State A cards — something real happened. Three parts, in this order, 2 or 3 sentences, under 60 words:
1. Reflect the actual thing back, using their own words — quote at least a few consecutive words from what they said.
2. One acknowledgment of the ACTION itself, never of them as a person.
3. Optionally, a forward hook framed as if-then, offered, not imposed.
Examples:
"You said you got the first run done and your legs hated you for it. That's the one that counts. The first is the hardest to start. Same time Thursday?"
"You hit the wall you predicted: the gym after 6pm never happens. That's useful. When would it happen?"

State B cards — nothing happened, the ${subject} is still live. An observation, not a question. 1 or 2 sentences, under 40 words. Examples:
"The Spanish is still here whenever you want to pick it back up. No rush. I just didn't want it to disappear."
"Quiet week on the writing. That's allowed. It'll be here when there's room."
${kind === "routines" ? 'For routines, you may state the pattern given above ("Most days this week") but never a consecutive-day count.\n' : ""}
Never, in any card:
- reference the absence of action: not "you haven't", not "still nothing", not "you didn't";
- ask why they didn't;
- tell them what to do: no "you should", "you need to", "don't forget", "make sure", "try to";
- praise the person: no "you're so disciplined", "proud of you"; only the action;
- generic encouragement: no "you've got this", "great week", "keep it up", "well done";
- streaks, day counts in a row, scores, percentages;
- tell them what they felt.
Use contractions. No emoji. No exclamation marks.`;
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text.replace(/```(?:json)?\n?/g, "").trim()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function anthropicStoryModel(): StoryModel | null {
  const anthropic = getAnthropic();
  if (!anthropic) return null;
  return {
    async classifyGoals({ goals, messages }) {
      if (goals.length === 0) return [];
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 600,
        temperature: 0,
        messages: [{ role: "user", content: buildClassifyPrompt(goals, messages) }],
      });
      logAiUsage("story_goals_classify", "claude-haiku-4-5", response.usage);
      const block = response.content.find((b) => b.type === "text");
      const parsed = block ? parseJson(block.text) : null;
      const list = Array.isArray(parsed?.goals) ? (parsed!.goals as Array<Record<string, unknown>>) : [];
      return list
        .filter((g) => typeof g.goalId === "number")
        .map((g) => ({
          goalId: g.goalId as number,
          state: g.state === "happened" || g.state === "live" ? (g.state as SubjectState) : "quiet",
          messageId: typeof g.messageId === "number" ? g.messageId : null,
          excerpt: typeof g.excerpt === "string" ? g.excerpt : null,
          kind: g.kind === "action" || g.kind === "obstacle" || g.kind === "mention" ? (g.kind as EvidenceKind) : null,
        }));
    },
    async writeCards({ kind, speakers }) {
      if (speakers.length === 0) return [];
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 500,
        messages: [{ role: "user", content: buildWritePrompt(kind, speakers) }],
      });
      logAiUsage(kind === "goals" ? "story_goals_write" : "story_routines_write", "claude-haiku-4-5", response.usage);
      const block = response.content.find((b) => b.type === "text");
      const parsed = block ? parseJson(block.text) : null;
      const list = Array.isArray(parsed?.cards) ? (parsed!.cards as Array<Record<string, unknown>>) : [];
      return list
        .filter((c) => typeof c.subjectId === "number" && typeof c.text === "string")
        .map((c) => ({ subjectId: c.subjectId as number, text: c.text as string }));
    },
  };
}

function defaultKindTruth(): KindTruthCheck {
  const anthropic = getAnthropic();
  return (sections) => checkKindTruth(sections, anthropic as never);
}

// ── Gather ──────────────────────────────────────────────────────────────────

interface Gathered {
  tz: string;
  today: string;
  goals: GoalInput[];
  habits: HabitInput[];
  messages: SubjectMessage[];
  guardrail: boolean;
  lastGoalsStoryOn: string | null;
  lastRoutinesStoryOn: string | null;
}

async function gather(userId: number, now: Date): Promise<Gathered | null> {
  const [profile] = await db
    .select({ timezone: profileTable.timezone, userPath: profileTable.userPath })
    .from(profileTable)
    .where(eq(profileTable.userId, userId))
    .limit(1);
  if (!profile) return null;
  const tz = profile.timezone || "UTC";
  const today = localYmd(tz, now);
  const weekAgo = ymdAddDays(today, -HAPPENED_WINDOW_DAYS);
  const fortnightAgo = ymdAddDays(today, -LIVE_WINDOW_DAYS);
  const ymd = (d: Date | null) => (d ? localYmd(tz, d) : null);

  const [goalRows, taskRows, habitRows, completionRows, messageRows, dismissed, crisisRows, lastGoals, lastRoutines] = await Promise.all([
    db
      .select()
      .from(goalsTable)
      .where(and(eq(goalsTable.userId, userId), eq(goalsTable.isComplete, false), isNull(goalsTable.letGoAt)))
      .orderBy(asc(goalsTable.createdAt)),
    db
      .select({ goalId: goalTasksTable.goalId, content: goalTasksTable.content, isComplete: goalTasksTable.isComplete, completedAt: goalTasksTable.completedAt })
      .from(goalTasksTable)
      .innerJoin(goalsTable, eq(goalsTable.id, goalTasksTable.goalId))
      .where(eq(goalsTable.userId, userId)),
    db
      .select()
      .from(habitsTable)
      .where(and(eq(habitsTable.userId, userId), eq(habitsTable.isActive, true)))
      .orderBy(asc(habitsTable.createdAt)),
    db
      .select({ habitId: habitCompletionsTable.habitId, completedDate: habitCompletionsTable.completedDate })
      .from(habitCompletionsTable)
      .where(and(eq(habitCompletionsTable.userId, userId), gte(habitCompletionsTable.completedDate, fortnightAgo))),
    db
      .select({ id: messagesTable.id, content: messagesTable.content, createdAt: messagesTable.createdAt })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.userId, userId),
          eq(messagesTable.role, "user"),
          gte(messagesTable.createdAt, new Date(`${ymdAddDays(weekAgo, -1)}T00:00:00Z`)),
          lte(messagesTable.createdAt, now),
        ),
      )
      .orderBy(asc(messagesTable.createdAt)),
    db.select({ messageId: chapterQuoteDismissalsTable.messageId }).from(chapterQuoteDismissalsTable).where(eq(chapterQuoteDismissalsTable.userId, userId)),
    db
      .select({ detectedAt: crisisEventsTable.detectedAt })
      .from(crisisEventsTable)
      .where(and(eq(crisisEventsTable.userId, userId), gte(crisisEventsTable.detectedAt, new Date(`${ymdAddDays(weekAgo, -1)}T00:00:00Z`)))),
    db
      .select({ periodStart: storiesTable.periodStart })
      .from(storiesTable)
      .where(and(eq(storiesTable.userId, userId), eq(storiesTable.kind, "goals")))
      .orderBy(desc(storiesTable.periodStart))
      .limit(1),
    db
      .select({ periodStart: storiesTable.periodStart })
      .from(storiesTable)
      .where(and(eq(storiesTable.userId, userId), eq(storiesTable.kind, "routines")))
      .orderBy(desc(storiesTable.periodStart))
      .limit(1),
  ]);

  const dismissedIds = new Set(dismissed.map((d) => d.messageId));
  const allMessages = messageRows
    .map((m) => ({ id: m.id, content: m.content, localDate: localYmd(tz, m.createdAt) }))
    .filter((m) => m.localDate >= weekAgo && m.localDate <= today);
  const crisisThisWeek = crisisRows.some((c) => localYmd(tz, c.detectedAt) >= weekAgo) || allMessages.some((m) => isCrisisText(m.content));
  const messages = allMessages.filter((m) => !dismissedIds.has(m.id) && !isCrisisText(m.content));

  const tasksByGoal = new Map<number, GoalInput["tasks"]>();
  for (const t of taskRows) {
    const list = tasksByGoal.get(t.goalId) ?? [];
    list.push({ content: t.content, isComplete: t.isComplete, completedOn: ymd(t.completedAt) });
    tasksByGoal.set(t.goalId, list);
  }
  const goals: GoalInput[] = goalRows.map((g) => ({
    id: g.id,
    title: g.title,
    description: g.description,
    createdOn: localYmd(tz, g.createdAt),
    lastReferencedOn: ymd(g.lastReferencedAt),
    lastSpokeOn: ymd(g.lastSpokeAt),
    letGoOfferedOn: ymd(g.letGoOfferedAt),
    tasks: tasksByGoal.get(g.id) ?? [],
  }));

  const completionsByHabit = new Map<number, Set<string>>();
  for (const c of completionRows) {
    const set = completionsByHabit.get(c.habitId) ?? new Set<string>();
    set.add(c.completedDate);
    completionsByHabit.set(c.habitId, set);
  }
  const habits: HabitInput[] = habitRows.map((h) => ({
    id: h.id,
    name: h.name,
    whenThen: h.whenThen,
    createdOn: localYmd(tz, h.createdAt),
    completions: [...(completionsByHabit.get(h.id) ?? [])].sort(),
    lastSpokeOn: ymd(h.lastSpokeAt),
  }));

  return {
    tz,
    today,
    goals,
    habits,
    messages,
    guardrail: profile.userPath === "bereavement" || crisisThisWeek,
    lastGoalsStoryOn: lastGoals[0]?.periodStart ?? null,
    lastRoutinesStoryOn: lastRoutines[0]?.periodStart ?? null,
  };
}

// ── Generate one user ───────────────────────────────────────────────────────

export interface SubjectResult {
  userId: number;
  today: string;
  goalsStoryId?: number;
  routinesStoryId?: number;
  goalsSkipped?: string;
  routinesSkipped?: string;
  dropped: number;
}

export interface GenerateOptions {
  now?: Date;
  force?: boolean;
  model?: StoryModel | null;
  kindTruth?: KindTruthCheck;
}

export async function generateSubjectStoriesForUser(userId: number, opts: GenerateOptions = {}): Promise<SubjectResult> {
  const now = opts.now ?? new Date();
  const g = await gather(userId, now);
  if (!g) return { userId, today: "", goalsSkipped: "no_profile", routinesSkipped: "no_profile", dropped: 0 };
  const model = opts.model === undefined ? anthropicStoryModel() : opts.model;
  const kindTruth = opts.kindTruth ?? defaultKindTruth();
  const result: SubjectResult = { userId, today: g.today, dropped: 0 };

  const record = async (kind: StoryKind, drops: GateOutcome["dropped"]) => {
    for (const d of drops) {
      result.dropped++;
      await recordStoryDrop({ userId, kind, subjectId: d.subjectId, stage: d.stage, text: d.text, reasons: d.reasons });
    }
  };

  // ── Goals ──
  if (g.goals.length === 0) {
    result.goalsSkipped = "no_goals";
  } else if (!opts.force && g.lastGoalsStoryOn === g.today) {
    result.goalsSkipped = "exists";
  } else {
    const classifications = model ? await safe(() => model.classifyGoals({ goals: g.goals, messages: g.messages }), []) : [];
    const decisions = decideGoalStates(g.goals, classifications, g.messages, g.today);
    const plan = planGoalSpeakers(decisions, g.today, opts.force ? null : g.lastGoalsStoryOn);
    // The guardrail suppresses the forward-looking, celebratory register: no
    // state-A cards while a period contains crisis language or bereavement.
    const speakers = g.guardrail ? plan.speakers.filter((s) => s.state !== "happened") : plan.speakers;
    const cards: StoryCard[] = [];
    const spoke: number[] = [];
    if (speakers.length > 0 && model) {
      const written = await safe(() => model.writeCards({ kind: "goals", speakers }), []);
      const gated = await gateCards(speakers, written, kindTruth);
      await record("goals", gated.dropped);
      for (const k of gated.kept) {
        const s = speakers.find((x) => x.subjectId === k.subjectId)!;
        cards.push({ kind: "goal", eyebrow: s.name, text: k.text });
        spoke.push(k.subjectId);
      }
    }
    for (const goal of plan.letGoOffers) {
      if (cards.length >= MAX_CARDS) break;
      cards.push({ kind: "goal", eyebrow: goal.title, text: letGoOfferText(goal.title) });
      spoke.push(goal.id);
      await db.update(goalsTable).set({ letGoOfferedAt: now }).where(eq(goalsTable.id, goal.id));
    }
    if (cards.length === 0) {
      result.goalsSkipped = speakers.length === 0 && plan.letGoOffers.length === 0 ? "nothing_to_say" : "all_dropped";
    } else {
      const first = cards[0] as Extract<StoryCard, { kind: "goal" }>;
      const row = await insertStory({
        userId,
        kind: "goals",
        periodStart: g.today,
        periodEnd: g.today,
        subjectId: spoke[0] ?? null,
        fragment: fragmentFor(first.eyebrow),
        cards: cards.slice(0, MAX_CARDS),
      });
      result.goalsStoryId = row.id;
      if (spoke.length > 0) await db.update(goalsTable).set({ lastSpokeAt: now }).where(inArray(goalsTable.id, spoke));
    }
  }

  // ── Routines ──
  if (g.habits.length === 0) {
    result.routinesSkipped = "no_routines";
  } else if (!opts.force && g.lastRoutinesStoryOn === g.today) {
    result.routinesSkipped = "exists";
  } else {
    const decisions = decideRoutineStates(g.habits, g.today);
    const plan = planRoutineSpeakers(decisions, g.today, opts.force ? null : g.lastRoutinesStoryOn);
    const cards: StoryCard[] = [];
    const spoke: number[] = [];
    for (const habit of plan.missed) {
      cards.push({ kind: "routine", eyebrow: habit.name, text: MISSED_DAY_TEXT, pattern: patternPhrase(habit.completions, g.today) });
      spoke.push(habit.id);
    }
    const speakers = g.guardrail ? plan.speakers.filter((s) => s.state !== "happened") : plan.speakers;
    if (speakers.length > 0 && model) {
      const written = await safe(() => model.writeCards({ kind: "routines", speakers }), []);
      const gated = await gateCards(speakers, written, kindTruth);
      await record("routines", gated.dropped);
      for (const k of gated.kept) {
        const s = speakers.find((x) => x.subjectId === k.subjectId)!;
        cards.push({ kind: "routine", eyebrow: s.name, text: k.text, pattern: s.pattern ?? null });
        spoke.push(k.subjectId);
      }
    }
    for (const habit of plan.reentry) {
      if (cards.length >= MAX_CARDS) break;
      cards.push({ kind: "routine", eyebrow: habit.name, text: REENTRY_TEXT, pattern: null });
      spoke.push(habit.id);
    }
    if (cards.length === 0) {
      result.routinesSkipped = plan.missed.length + speakers.length + plan.reentry.length === 0 ? "nothing_to_say" : "all_dropped";
    } else {
      const first = cards[0] as Extract<StoryCard, { kind: "routine" }>;
      const row = await insertStory({
        userId,
        kind: "routines",
        periodStart: g.today,
        periodEnd: g.today,
        subjectId: spoke[0] ?? null,
        fragment: fragmentFor(first.eyebrow),
        cards: cards.slice(0, MAX_CARDS),
      });
      result.routinesStoryId = row.id;
      if (spoke.length > 0) await db.update(habitsTable).set({ lastSpokeAt: now }).where(inArray(habitsTable.id, spoke));
    }
  }

  try {
    const uh = hashUserIdForLog(userId);
    if (uh) logger.info({ uh, today: g.today, goals: result.goalsStoryId ?? result.goalsSkipped, routines: result.routinesStoryId ?? result.routinesSkipped, dropped: result.dropped }, "goals/routines stories");
  } catch { /* logging must never crash the caller */ }
  return result;
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "story model call failed — continuing without it");
    return fallback;
  }
}

// ── Sweep ───────────────────────────────────────────────────────────────────

function localHour(tz: string, d: Date): number {
  try {
    return parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hour12: false }).format(d), 10) % 24;
  } catch {
    return d.getUTCHours();
  }
}

/** From 06:00 user-local; the one-row-per-day rule does the rest. */
export function inSubjectWindow(tz: string, now: Date): boolean {
  return localHour(tz, now) >= 6;
}

export interface SubjectSweepResult {
  considered: number;
  goalsGenerated: number;
  routinesGenerated: number;
  dropped: number;
  skipped: Record<string, number>;
  failed: number;
}

export async function runSubjectStoriesSweep(
  opts: { now?: Date; onlyUserId?: number; ignoreWindow?: boolean; force?: boolean; model?: StoryModel | null; kindTruth?: KindTruthCheck } = {},
): Promise<SubjectSweepResult> {
  const now = opts.now ?? new Date();
  const users = await db
    .select({ userId: profileTable.userId, timezone: profileTable.timezone })
    .from(profileTable)
    .innerJoin(usersTable, eq(usersTable.id, profileTable.userId))
    .where(and(isNotNull(usersTable.emailVerifiedAt), eq(profileTable.isOnboardingComplete, true)));

  const result: SubjectSweepResult = { considered: 0, goalsGenerated: 0, routinesGenerated: 0, dropped: 0, skipped: {}, failed: 0 };
  const bump = (k: string | undefined) => {
    if (k) result.skipped[k] = (result.skipped[k] ?? 0) + 1;
  };
  for (const u of users) {
    if (!u.userId) continue;
    if (opts.onlyUserId && u.userId !== opts.onlyUserId) continue;
    if (!opts.ignoreWindow && !inSubjectWindow(u.timezone || "UTC", now)) continue;
    result.considered++;
    try {
      const r = await generateSubjectStoriesForUser(u.userId, { now, force: opts.force, model: opts.model, kindTruth: opts.kindTruth });
      if (r.goalsStoryId) result.goalsGenerated++;
      else bump(r.goalsSkipped && `goals:${r.goalsSkipped}`);
      if (r.routinesStoryId) result.routinesGenerated++;
      else bump(r.routinesSkipped && `routines:${r.routinesSkipped}`);
      result.dropped += r.dropped;
    } catch (err) {
      result.failed++;
      try {
        const uh = hashUserIdForLog(u.userId);
        if (uh) logger.error({ err, uh }, "goals/routines stories: generation failed");
      } catch { /* logging must never crash the caller */ }
    }
  }
  return result;
}
