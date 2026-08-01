import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { encryptedText } from "../encryptedColumns";

// ─── Tracked commitments (accountability loop) ────────────────────────────────
//
// A commitment is a concrete, cue-anchored next step that the companion and
// user agree to together in conversation. The companion's extraction pass
// detects agreement → saves here. Completion / non-completion is also
// detected from conversation and updates state automatically.

export const commitmentsTable = pgTable("commitments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),

  // The specific action: "text Sam tomorrow after your coffee" — verbatim
  // conversation-derived free text, encrypted at rest
  content: encryptedText("content", "commitments.content").notNull(),

  // When/where cue: "after morning coffee", "tomorrow evening", etc. — encrypted at rest
  cue: encryptedText("cue", "commitments.cue").notNull().default(""),

  // Lifecycle state
  state: text("state").notNull().default("open"), // open | done | partial | missed

  // Counts how many times missed (after 2, companion shrinks or drops the task)
  missCount: integer("miss_count").notNull().default(0),

  // What the user said about how it went (their own words) — encrypted at rest
  qualityNote: encryptedText("quality_note", "commitments.quality_note"),

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

  // ── Dedup reference tracking (Sprint: dedup) ────────────────────────────────
  // Bumped when extraction detects the user re-stating an existing commitment
  // (semantically equivalent) instead of inserting a duplicate row. Additive +
  // defaulted so legacy rows stay valid without a backfill.
  timesReferenced: integer("times_referenced").notNull().default(1),
  lastReferencedAt: timestamp("last_referenced_at"),
});

export type Commitment = typeof commitmentsTable.$inferSelect;
export type InsertCommitment = typeof commitmentsTable.$inferInsert;
