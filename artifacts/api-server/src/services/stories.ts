/**
 * Stories — the store behind every Journey marker.
 *
 * A story is a kind (week | month | first | goals | routines), a period, a
 * fragment for the circle, and 1–6 cards the story shell plays. Period
 * stories (week / month / first) carry 3–6 cards — fewer than three real
 * cards is no story, never padded. Goals and Routines stories carry 1–3
 * cards, one per goal or routine that had something to say.
 *
 * Hard rules enforced STRUCTURALLY at this boundary, so no generator can
 * bypass them:
 *  - every card shape is `.strict()`: an unknown key is a rejection;
 *  - "thenNow" has no interpretation field — two verbatim quotes, two stamps;
 *  - no card type carries a mood, a score, a streak or a prosody value.
 */

import { z } from "zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, storiesTable, type Story } from "@workspace/db";
import { logger } from "../lib/logger.js";

// ── Kinds ───────────────────────────────────────────────────────────────────

export const STORY_KINDS = ["week", "month", "first", "goals", "routines"] as const;
export type StoryKind = (typeof STORY_KINDS)[number];
export const StoryKindSchema = z.enum(STORY_KINDS);

/** Kinds whose stories are generated for a period and must carry ≥ 3 cards. */
export const PERIOD_KINDS: ReadonlySet<StoryKind> = new Set(["week", "month", "first"]);

// ── Card shapes (mirror of aanya/src/components/week/types.ts) ──────────────

const text = z.string().trim().min(1).max(400);
const stamp = z.string().trim().min(1).max(60);

export const StoryCardSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("moment"), eyebrow: stamp, text }).strict(),
  z.object({ kind: z.literal("did"), eyebrow: stamp, text }).strict(),
  z
    .object({
      kind: z.literal("thenNow"),
      eyebrow: stamp,
      then: z.object({ stamp, quote: text }).strict(),
      now: z.object({ stamp, quote: text }).strict(),
    })
    .strict(),
  z.object({ kind: z.literal("open"), eyebrow: stamp, text }).strict(),
  z.object({ kind: z.literal("pattern"), eyebrow: stamp, phrase: text, said: stamp }).strict(),
  z.object({ kind: z.literal("forward"), text, sub: text.nullable() }).strict(),
  // Goals / Routines: the eyebrow is the goal or routine name; `text` is the
  // card's prose; `pattern` (routines only) is the deterministic pattern
  // phrase — "Most days this week", "Four of the last seven" — never a chain.
  z.object({ kind: z.literal("goal"), eyebrow: stamp, text }).strict(),
  z.object({ kind: z.literal("routine"), eyebrow: stamp, text, pattern: stamp.nullable() }).strict(),
]);
export type StoryCard = z.infer<typeof StoryCardSchema>;

export const PERIOD_CARD_MIN = 3;
export const CARD_MAX = 6;
export const PeriodCardsSchema = z.array(StoryCardSchema).min(PERIOD_CARD_MIN).max(CARD_MAX);
export const SubjectCardsSchema = z.array(StoryCardSchema).min(1).max(3);

export function cardsSchemaFor(kind: StoryKind) {
  return PERIOD_KINDS.has(kind) ? PeriodCardsSchema : SubjectCardsSchema;
}

/** The marker text: a few verbatim words, or a goal / routine name. Kept short so it fits a 78px disc. */
export const FRAGMENT_MAX = 40;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ── Dates ───────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The Monday (UTC) of the week containing `d`. */
export function mondayOf(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  m.setUTCDate(m.getUTCDate() - day);
  return m;
}

/** ISO week bounds (Monday → Sunday) for the week that is `weeksAgo` weeks
 *  before the one containing `now`. */
export function weekBounds(now: Date, weeksAgo: number): { weekStart: string; weekEnd: string } {
  const monday = new Date(mondayOf(now).getTime() - weeksAgo * 7 * DAY_MS);
  const sunday = new Date(monday.getTime() + 6 * DAY_MS);
  return { weekStart: isoDate(monday), weekEnd: isoDate(sunday) };
}

// ── Store ───────────────────────────────────────────────────────────────────

export interface StoryInput {
  userId: number;
  kind: StoryKind;
  periodStart: string;
  periodEnd: string;
  subjectId?: number | null;
  fragment: string;
  cards: StoryCard[];
  viewedAt?: Date | null;
}

/** Validates and upserts one story (one per user per kind per period).
 *  Throws on a story that breaks the rules — a generator must never store one. */
export async function insertStory(input: StoryInput): Promise<Story> {
  if (!ISO_DATE.test(input.periodStart) || !ISO_DATE.test(input.periodEnd)) {
    throw new Error("story: periodStart/periodEnd must be YYYY-MM-DD");
  }
  const kind = StoryKindSchema.parse(input.kind);
  const fragment = input.fragment.trim();
  if (fragment.length === 0 || fragment.length > FRAGMENT_MAX) {
    throw new Error(`story: fragment must be 1–${FRAGMENT_MAX} characters`);
  }
  const cards = cardsSchemaFor(kind).parse(input.cards);
  const [row] = await db
    .insert(storiesTable)
    .values({
      userId: input.userId,
      kind,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      subjectId: input.subjectId ?? null,
      fragment,
      cards: JSON.stringify(cards),
      viewedAt: input.viewedAt ?? null,
    })
    .onConflictDoUpdate({
      target: [storiesTable.userId, storiesTable.kind, storiesTable.periodStart],
      set: {
        periodEnd: input.periodEnd,
        subjectId: input.subjectId ?? null,
        fragment,
        cards: JSON.stringify(cards),
      },
    })
    .returning();
  return row!;
}

export interface StoryView {
  id: number;
  kind: StoryKind;
  periodStart: string;
  periodEnd: string;
  subjectId: number | null;
  fragment: string;
  viewed: boolean;
  cards: StoryCard[];
}

function toView(r: Story): StoryView | null {
  const kind = StoryKindSchema.safeParse(r.kind);
  if (!kind.success) return null;
  try {
    const cards = cardsSchemaFor(kind.data).parse(JSON.parse(r.cards));
    return {
      id: r.id,
      kind: kind.data,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      subjectId: r.subjectId ?? null,
      fragment: r.fragment,
      viewed: r.viewedAt != null,
      cards,
    };
  } catch (err) {
    logger.error({ err, storyId: r.id }, "story: stored cards failed validation — skipping row");
    return null;
  }
}

/** The most recent stories of a kind, newest first. */
export async function listStoriesOfKind(userId: number, kind: StoryKind, limit: number): Promise<StoryView[]> {
  const rows = await db
    .select()
    .from(storiesTable)
    .where(and(eq(storiesTable.userId, userId), eq(storiesTable.kind, kind)))
    .orderBy(desc(storiesTable.periodStart))
    .limit(limit);
  return rows.map(toView).filter((v): v is StoryView => v != null);
}

/** What the marker row shows, in row order: the newest Goals story, the
 *  newest Routines story, then the most recent weekly stories (newest
 *  first). Month and first-week stories join in build step 2. */
export async function listMarkerStories(userId: number): Promise<StoryView[]> {
  const [goals, routines, weeks] = await Promise.all([
    listStoriesOfKind(userId, "goals", 1),
    listStoriesOfKind(userId, "routines", 1),
    listStoriesOfKind(userId, "week", 6),
  ]);
  return [...goals, ...routines, ...weeks];
}

/** Marks a story viewed — once, permanently. Returns false when the story
 *  isn't this user's (or doesn't exist); true otherwise, including when it
 *  was already viewed (idempotent). */
export async function markStoryViewed(userId: number, id: number): Promise<boolean> {
  const [owned] = await db
    .select({ id: storiesTable.id })
    .from(storiesTable)
    .where(and(eq(storiesTable.id, id), eq(storiesTable.userId, userId)))
    .limit(1);
  if (!owned) return false;
  await db
    .update(storiesTable)
    .set({ viewedAt: sql`now()` })
    .where(and(eq(storiesTable.id, id), eq(storiesTable.userId, userId), isNull(storiesTable.viewedAt)));
  return true;
}

// ── Prototype seed (weekly) ─────────────────────────────────────────────────
// The four weekly markers from eos-week-v2.html, dated relative to `now`, so
// the row can be felt on a local account. Only the newest is unviewed, as in
// the prototype. Used by scripts/seed-weekly-review.ts and the tests.

export const PROTOTYPE_CARDS: StoryCard[] = [
  { kind: "moment", eyebrow: "2–8 September", text: "You talked about your dad’s garden again on Tuesday." },
  { kind: "did", eyebrow: "And on Thursday", text: "You went for the walk you’d been putting off since Sunday." },
  {
    kind: "thenNow",
    eyebrow: "Your words",
    then: { stamp: "Three weeks ago", quote: "“I don’t want to be a burden to anyone.”" },
    now: { stamp: "Friday", quote: "“I texted my sister back. She just said finally.”" },
  },
  { kind: "open", eyebrow: "Still sitting there", text: "You said you wanted to call your brother. You haven’t yet." },
  { kind: "pattern", eyebrow: "Something you keep saying", phrase: "“steady”", said: "Four times this month." },
  { kind: "forward", text: "You’re not who you were in August.", sub: "There’s a note here you wrote to yourself on the 14th. It isn’t time yet." },
];

export const PROTOTYPE_MARKERS: Array<{ weeksAgo: number; fragment: string; viewed: boolean }> = [
  { weeksAgo: 0, fragment: "“she just said finally”", viewed: false },
  { weeksAgo: 1, fragment: "“the flat is too quiet”", viewed: true },
  { weeksAgo: 3, fragment: "“I'm fine, honestly”", viewed: true },
  { weeksAgo: 4, fragment: "first night", viewed: true },
];

export async function seedPrototypeReviews(userId: number, now: Date = new Date()): Promise<Story[]> {
  const out: Story[] = [];
  for (const m of PROTOTYPE_MARKERS) {
    const { weekStart, weekEnd } = weekBounds(now, m.weeksAgo);
    out.push(
      await insertStory({
        userId,
        kind: "week",
        periodStart: weekStart,
        periodEnd: weekEnd,
        fragment: m.fragment,
        cards: PROTOTYPE_CARDS,
        viewedAt: m.viewed ? now : null,
      }),
    );
  }
  return out;
}
