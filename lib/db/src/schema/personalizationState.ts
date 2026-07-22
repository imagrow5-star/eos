import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { encryptedTextArray } from "../encryptedColumns";

/**
 * Per-user personalization state.
 * - recentPhrases: opening lines from the last 15 AI messages, used to prevent
 *   the companion from repeating the same openers/phrasings with this user.
 * - goalOfferDeclinedAt: when the user last declined the companion's offer to
 *   set a goal/routine — the prompt suppresses re-offers for 7 days after.
 */
export const personalizationStateTable = pgTable("personalization_state", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  recentPhrases: encryptedTextArray("recent_phrases", "personalization_state.recent_phrases")
    .notNull()
    .default(sql`'{}'::text[]`), // element-wise encrypted at rest
  goalOfferDeclinedAt: timestamp("goal_offer_declined_at"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type PersonalizationState = typeof personalizationStateTable.$inferSelect;
