/**
 * Weekly review — the store behind the Journey markers and the story they
 * open (weekly-review-spec.md). Stage 2: persistence, listing, viewed state
 * and a prototype seed. Stage 3 adds the Sunday generator, which will write
 * through insertWeeklyReview and therefore inherit every rule here.
 *
 * Hard rules enforced STRUCTURALLY at the store boundary, so no generator can
 * bypass them:
 *  - a story is 3–6 cards (fewer than three real cards → no story; the
 *    minimum-content rule is a schema constraint, not a convention);
 *  - "thenNow" has no interpretation field — two verbatim quotes and two
 *    stamps, nothing else;
 *  - no card type carries a mood, a score, a streak or a prosody value.
 */

import { z } from "zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, weeklyReviewsTable, type WeeklyReview } from "@workspace/db";
import { logger } from "../lib/logger.js";

// ── Card shapes (mirror of aanya/src/components/week/types.ts) ──────────────

const text = z.string().trim().min(1).max(400);
const stamp = z.string().trim().min(1).max(40);

// .strict() everywhere: an unknown key is a REJECTION, not silently dropped —
// that is what makes "thenNow carries no interpretation" a constraint.
export const WeekCardSchema = z.discriminatedUnion("kind", [
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
]);
export type WeekCard = z.infer<typeof WeekCardSchema>;

export const WEEK_CARD_MIN = 3;
export const WEEK_CARD_MAX = 6;
export const WeekCardsSchema = z.array(WeekCardSchema).min(WEEK_CARD_MIN).max(WEEK_CARD_MAX);

/** The marker text: a few verbatim words. Kept short so it fits a 78px disc. */
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

export interface WeeklyReviewInput {
  userId: number;
  weekStart: string;
  weekEnd: string;
  fragment: string;
  cards: WeekCard[];
  viewedAt?: Date | null;
}

/** Validates and upserts one week's story (one per user per week). Throws on
 *  a story that breaks the rules — a generator must never store one. */
export async function insertWeeklyReview(input: WeeklyReviewInput): Promise<WeeklyReview> {
  if (!ISO_DATE.test(input.weekStart) || !ISO_DATE.test(input.weekEnd)) {
    throw new Error("weekly review: weekStart/weekEnd must be YYYY-MM-DD");
  }
  const fragment = input.fragment.trim();
  if (fragment.length === 0 || fragment.length > FRAGMENT_MAX) {
    throw new Error(`weekly review: fragment must be 1–${FRAGMENT_MAX} characters`);
  }
  const cards = WeekCardsSchema.parse(input.cards); // 3–6, shapes enforced
  const [row] = await db
    .insert(weeklyReviewsTable)
    .values({
      userId: input.userId,
      weekStart: input.weekStart,
      weekEnd: input.weekEnd,
      fragment,
      cards: JSON.stringify(cards),
      viewedAt: input.viewedAt ?? null,
    })
    .onConflictDoUpdate({
      target: [weeklyReviewsTable.userId, weeklyReviewsTable.weekStart],
      set: { weekEnd: input.weekEnd, fragment, cards: JSON.stringify(cards) },
    })
    .returning();
  return row!;
}

export interface WeeklyReviewView {
  id: number;
  weekStart: string;
  weekEnd: string;
  fragment: string;
  viewed: boolean;
  cards: WeekCard[];
}

/** The most recent stories, newest first. The spec shows 4–6; the client
 *  scrolls older ones horizontally. A row whose stored cards fail the schema
 *  (never expected) is skipped and logged rather than breaking the page. */
export async function listWeeklyReviews(userId: number, limit = 6): Promise<WeeklyReviewView[]> {
  const rows = await db
    .select()
    .from(weeklyReviewsTable)
    .where(eq(weeklyReviewsTable.userId, userId))
    .orderBy(desc(weeklyReviewsTable.weekStart))
    .limit(limit);
  const out: WeeklyReviewView[] = [];
  for (const r of rows) {
    let cards: WeekCard[];
    try {
      cards = WeekCardsSchema.parse(JSON.parse(r.cards));
    } catch (err) {
      logger.error({ err, reviewId: r.id }, "weekly review: stored cards failed validation — skipping row");
      continue;
    }
    out.push({ id: r.id, weekStart: r.weekStart, weekEnd: r.weekEnd, fragment: r.fragment, viewed: r.viewedAt != null, cards });
  }
  return out;
}

/** Marks a story viewed — once, permanently. Returns false when the story
 *  isn't this user's (or doesn't exist); true otherwise, including when it
 *  was already viewed (idempotent). */
export async function markWeeklyReviewViewed(userId: number, id: number): Promise<boolean> {
  const [owned] = await db
    .select({ id: weeklyReviewsTable.id })
    .from(weeklyReviewsTable)
    .where(and(eq(weeklyReviewsTable.id, id), eq(weeklyReviewsTable.userId, userId)))
    .limit(1);
  if (!owned) return false;
  await db
    .update(weeklyReviewsTable)
    .set({ viewedAt: sql`now()` })
    .where(and(eq(weeklyReviewsTable.id, id), eq(weeklyReviewsTable.userId, userId), isNull(weeklyReviewsTable.viewedAt)));
  return true;
}

// ── Prototype seed (stage 2) ────────────────────────────────────────────────
// The four markers from eos-week-v2.html, dated relative to `now`, so the row
// can be felt on a real account before stage 3 generates anything. Only the
// newest is unviewed, as in the prototype. Used by scripts/seed-weekly-review.ts
// and the tests.

export const PROTOTYPE_CARDS: WeekCard[] = [
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

export async function seedPrototypeReviews(userId: number, now: Date = new Date()): Promise<WeeklyReview[]> {
  const out: WeeklyReview[] = [];
  for (const m of PROTOTYPE_MARKERS) {
    const { weekStart, weekEnd } = weekBounds(now, m.weeksAgo);
    out.push(
      await insertWeeklyReview({
        userId,
        weekStart,
        weekEnd,
        fragment: m.fragment,
        cards: PROTOTYPE_CARDS,
        viewedAt: m.viewed ? now : null,
      }),
    );
  }
  return out;
}
