import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  integer,
  jsonb,
  unique,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { encryptedJsonb, encryptedText } from "../encryptedColumns";

// ─── Weekly growth chapters ───────────────────────────────────────────────────
// One row per user per analyzed week (Mon–Sun). Entirely additive — nothing in
// the existing chat/goals/habits/email systems reads or writes these tables
// except the chapter engine and the daily-email "your chapter is waiting" line.
//
// themes / goalReview / microOffer are jsonb snapshots frozen at generation
// time. Every quote inside `themes` and `microOffer` carries the source
// messageId AND the exact excerpt text — the engine guarantees (programmatic
// gate, not prompt-level) that each excerpt is a verbatim substring of that
// stored message before the row is ever written.

export const weeklyChaptersTable = pgTable(
  "weekly_chapters",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    weekStart: text("week_start").notNull(), // YYYY-MM-DD (Monday of analyzed week)
    weekEnd: text("week_end").notNull(), // YYYY-MM-DD (Sunday)
    status: text("status").notNull().default("ready"), // ready | revealed
    threadOpening: encryptedText("thread_opening", "weekly_chapters.thread_opening").notNull().default(""),
    thresholdQuestion: encryptedText("threshold_question", "weekly_chapters.threshold_question").notNull(),
    thresholdAnswer: encryptedText("threshold_answer", "weekly_chapters.threshold_answer"),
    thresholdMood: integer("threshold_mood"), // 1–10, optional one-tap slider
    thresholdLoneliness: integer("threshold_loneliness"), // 1–10, optional
    thresholdSkipped: boolean("threshold_skipped").notNull().default(false),
    themes: encryptedJsonb("themes", "weekly_chapters.themes").notNull(), // ChapterTheme[] — see api-server services/chapters — encrypted at rest
    goalReview: encryptedJsonb("goal_review", "weekly_chapters.goal_review"), // { items: [...] } | null — encrypted at rest
    microOffer: encryptedJsonb("micro_offer", "weekly_chapters.micro_offer"), // seed-quote-anchored offer | null — encrypted at rest
    // Phase 2 — the sealed-note ritual + processing engine (all nullable/additive):
    noteInvite: encryptedJsonb("note_invite", "weekly_chapters.note_invite"), // { prompt: string } | null — Eos-drafted gentle prediction question offered at the end of THIS chapter — encrypted at rest
    sealResolution: encryptedJsonb("seal_resolution", "weekly_chapters.seal_resolution"), // { noteId, noteKind, notePrompt|null, noteText, resolutionText } | null — set when THIS chapter resolves an earlier sealed note; cleared if the user defers — encrypted at rest
    workingThrough: encryptedJsonb("working_through", "weekly_chapters.working_through"), // { label, entries: [{ weekLabel, text, verbatim, messageId|null, date }], reflection } | null — evolving-story relief framing — encrypted at rest
    generatedAt: timestamp("generated_at").notNull().defaultNow(),
    revealedAt: timestamp("revealed_at"),
    readAt: timestamp("read_at"),
    emailMentionedAt: timestamp("email_mentioned_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [unique("weekly_chapters_user_week").on(t.userId, t.weekStart)],
);

// One-tap permanent quote dismissal — "never show me this line again".
// Checked by the engine when building candidate pools, so a dismissed line
// can never be selected for any future chapter.
export const chapterQuoteDismissalsTable = pgTable(
  "chapter_quote_dismissals",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    messageId: integer("message_id").notNull(),
    dismissedAt: timestamp("dismissed_at").notNull().defaultNow(),
  },
  (t) => [unique("chapter_quote_dismissals_user_message").on(t.userId, t.messageId)],
);

// Accept/decline history for chapter micro-goal offers. A decline silences
// chapter offers for ~14 days (checked by the engine before composing one).
export const chapterOfferEventsTable = pgTable("chapter_offer_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  chapterId: integer("chapter_id").notNull(),
  action: text("action").notNull(), // accepted | declined
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type WeeklyChapter = typeof weeklyChaptersTable.$inferSelect;
export type ChapterQuoteDismissal = typeof chapterQuoteDismissalsTable.$inferSelect;
export type ChapterOfferEvent = typeof chapterOfferEventsTable.$inferSelect;
