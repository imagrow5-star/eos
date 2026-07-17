import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

/**
 * Per-user personalization state.
 * - recentPhrases: opening lines from the last 15 AI messages, used to prevent
 *   the companion from repeating the same openers/phrasings with this user.
 */
export const personalizationStateTable = pgTable("personalization_state", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  recentPhrases: text("recent_phrases")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type PersonalizationState = typeof personalizationStateTable.$inferSelect;
