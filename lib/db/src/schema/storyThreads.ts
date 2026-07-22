import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  jsonb,
  unique,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { encryptedJsonb } from "../encryptedColumns";

// ─── Story threads — the processing-vs-stuck engine ──────────────────────────
// One row per recurring episode/story a user retells across weeks (the airport
// goodbye, the failed exam). Each weekly generation appends a retelling record
// and re-assesses whether the story is EVOLVING (new angles, new questions,
// shifted perspective) or staying FROZEN (same framing repeatedly).
//
// Product invariants enforced by the engine:
// - chapters only ever show the RELIEF framing (evolution of the user's own
//   questions) — never retelling counts, never the word "stuck";
// - a frozen verdict requires multi-week, high-confidence evidence
//   (streak of same-framing weeks spanning a minimum number of days);
// - a confirmed frozen loop is NEVER stated in a chapter — it is raised softly
//   in live conversation only (image, not verdict), with a long cooldown;
// - frozen + worsening tone across weeks escalates to a warm professional-
//   support suggestion under the existing care rules, also conversation-only.

export type StoryRetelling = {
  weekStart: string; // YYYY-MM-DD Monday of the analyzed week
  summary: string; // one-line neutral summary of how they told it this week
  question: string | null; // the question they were asking (verbatim excerpt when possible)
  questionMessageId: number | null; // source message when the excerpt is verbatim
  framing: string; // short description of the angle/tense/perspective
  sameAsPrior: boolean; // did this retelling stay in the same framing as last time?
  confidence: number; // 0..1 — model confidence in sameAsPrior
};

export const storyThreadsTable = pgTable(
  "story_threads",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    slug: text("slug").notNull(), // stable machine key, e.g. "airport-goodbye"
    label: text("label").notNull(), // short neutral human label, e.g. "the airport goodbye"
    state: text("state").notNull().default("watch"), // watch | evolving | frozen
    frozenStreak: integer("frozen_streak").notNull().default(0), // consecutive high-confidence same-framing weeks
    retellings: encryptedJsonb("retellings", "story_threads.retellings").notNull().default([]), // StoryRetelling[] (append-only, capped) — encrypted at rest
    firstSeenWeek: text("first_seen_week").notNull(),
    lastSeenWeek: text("last_seen_week").notNull(),
    raisedAt: timestamp("raised_at"), // last time Eos softly raised this frozen loop in conversation
    supportSuggestedAt: timestamp("support_suggested_at"), // last professional-support escalation
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [unique("story_threads_user_slug").on(t.userId, t.slug)],
);

export type StoryThread = typeof storyThreadsTable.$inferSelect;
