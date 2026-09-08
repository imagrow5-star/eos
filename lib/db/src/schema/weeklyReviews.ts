import { pgTable, serial, text, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { encryptedText } from "../encryptedColumns";

/**
 * Weekly review stories — one row per user per week (weekly-review-spec.md).
 *
 * Generated on Sundays (stage 3); shown on Journey as a row of circular
 * markers, each holding `fragment` — a verbatim few words the person said
 * that week; tapping one plays `cards` (3–6, JSON) as a full-screen story.
 * Both carry the person's own words, so both are encrypted at rest like
 * every other user-content column.
 *
 * `viewed_at` is the persisted viewed/unviewed state: null shows the
 * dawn-to-green ring; set once the story is opened, and never cleared.
 */
export const weeklyReviewsTable = pgTable(
  "weekly_reviews",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    /** ISO date (YYYY-MM-DD) of the week's Monday. */
    weekStart: text("week_start").notNull(),
    /** ISO date (YYYY-MM-DD) of the week's Sunday. */
    weekEnd: text("week_end").notNull(),
    fragment: encryptedText("fragment", "weekly_reviews.fragment").notNull(), // encrypted at rest
    cards: encryptedText("cards", "weekly_reviews.cards").notNull(), // encrypted JSON, 3–6 cards
    viewedAt: timestamp("viewed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("weekly_reviews_user_week_idx").on(t.userId, t.weekStart)],
);

export type WeeklyReview = typeof weeklyReviewsTable.$inferSelect;
