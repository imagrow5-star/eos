import { pgTable, serial, text, timestamp, integer, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { encryptedText } from "../encryptedColumns";

// ─── Stories — everything behind the Journey markers ─────────────────────────
// One row per story the marker row can open: a weekly review, a monthly
// story, the pinned first-week story, or the day's Goals / Routines cards.
// `cards` is the JSON card list the story shell renders (3–6 for period
// stories; 1–3 for goals/routines), validated by api-server services/stories
// before it is written. `fragment` is what sits inside the circle: a
// verbatim fragment of something the person said, or the goal / routine
// name. Both are the user's own words → encrypted at rest.
//
// Never stored here, by design: prosody, mood, streaks, scores.

export const storiesTable = pgTable(
  "stories",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    kind: text("kind").notNull(), // week | month | first | goals | routines
    periodStart: text("period_start").notNull(), // YYYY-MM-DD (week Monday, month 1st, or the day a goals/routines story was written)
    periodEnd: text("period_end").notNull(), // YYYY-MM-DD
    subjectId: integer("subject_id"), // goal / habit the story is chiefly about (goals / routines), else null
    fragment: encryptedText("fragment", "stories.fragment").notNull(),
    cards: encryptedText("cards", "stories.cards").notNull(),
    viewedAt: timestamp("viewed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("stories_user_kind_period_idx").on(t.userId, t.kind, t.periodStart)],
);

export type Story = typeof storiesTable.$inferSelect;
export type InsertStory = typeof storiesTable.$inferInsert;

// ─── Story drops — every card the gates refused, and why ─────────────────────
// A card the model wrote that failed a language gate is never rewritten or
// retried: it is dropped, and the attempt is kept here so the prompt and the
// gates can be tuned against what the model actually tries to write. The
// text can quote the user's words → encrypted at rest; the reasons are gate
// names only. Read with api-server scripts/story-drops.ts.

export const storyDropsTable = pgTable("story_drops", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  kind: text("kind").notNull(), // goals | routines | week | month | first
  subjectId: integer("subject_id"),
  stage: text("stage").notNull(), // gate | kind_truth | reflection | schema
  text: encryptedText("text", "story_drops.text").notNull(),
  reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type StoryDrop = typeof storyDropsTable.$inferSelect;
