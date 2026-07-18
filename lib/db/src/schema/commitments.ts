import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ─── Tracked commitments (accountability loop) ────────────────────────────────
//
// A commitment is a concrete, cue-anchored next step that the companion and
// user agree to together in conversation. The companion's extraction pass
// detects agreement → saves here. Completion / non-completion is also
// detected from conversation and updates state automatically.

export const commitmentsTable = pgTable("commitments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),

  // The specific action: "text Sam tomorrow after your coffee"
  content: text("content").notNull(),

  // When/where cue: "after morning coffee", "tomorrow evening", etc.
  cue: text("cue").notNull().default(""),

  // Lifecycle state
  state: text("state").notNull().default("open"), // open | done | partial | missed

  // Counts how many times missed (after 2, companion shrinks or drops the task)
  missCount: integer("miss_count").notNull().default(0),

  // What the user said about how it went (quality check, not just a tick)
  qualityNote: text("quality_note"),

  // YYYY-MM-DD: when the companion should gently follow up
  scheduledFollowupDate: text("scheduled_followup_date"),

  // YYYY-MM-DD: the day the action itself is planned for ("tomorrow 4am" → tomorrow)
  scheduledDate: text("scheduled_date"),

  // HH:MM 24h local time when the user named a clock time ("4am" → "04:00")
  scheduledTime: text("scheduled_time"),

  // When the timed email nudge for this commitment was sent (dedup guard)
  nudgeSentAt: timestamp("nudge_sent_at"),

  // When the companion actually followed up on this
  followedUpAt: timestamp("followed_up_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Commitment = typeof commitmentsTable.$inferSelect;
export type InsertCommitment = typeof commitmentsTable.$inferInsert;
