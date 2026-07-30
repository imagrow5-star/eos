import { pgTable, serial, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { messagesTable } from "./messages";

// ─── Crisis floor event log ───────────────────────────────────────────────────
// One row per deterministic crisis detection in live chat or voice. Records
// WHICH pattern fired and WHICH country's helplines were served — NEVER the
// message content (the message itself is already encrypted in messages).
//
// Used for: per-message helpline-card dismissal state, the 3-dismissals-in-7-
// days review flag, and the voice-call on-screen overlay (the voice UI polls
// for undismissed events because the spoken reply deliberately carries no
// helpline text).

export const crisisEventsTable = pgTable("crisis_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  // The ASSISTANT message carrying the helpline block. Null on the voice path:
  // voice turns persist asynchronously with dedup, so the event can't wait for
  // a message id (the on-call card keys off the event row instead).
  messageId: integer("message_id").references(() => messagesTable.id),
  detectedAt: timestamp("detected_at").notNull().defaultNow(),
  patternMatched: text("pattern_matched").notNull(), // detector pattern name, e.g. "explicit_suicidal_ideation"
  countryServed: text("country_served").notNull(), // ISO-2 or "fallback"
  source: text("source").notNull().default("chat"), // chat | voice
  blockDismissed: boolean("block_dismissed").notNull().default(false),
  dismissedAt: timestamp("dismissed_at"), // powers the rolling 7-day review-flag window
});

export type CrisisEvent = typeof crisisEventsTable.$inferSelect;
