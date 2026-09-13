import { pgTable, serial, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { encryptedText, encryptedBoolean } from "../encryptedColumns";
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
  // Detector pattern name, e.g. "explicit_suicidal_ideation". Encrypted at
  // rest (security audit): the name alone reveals the user's crisis state, so
  // a database dump must not expose it. NEVER compare this column in SQL —
  // ciphertexts of the same name differ (random IV); dedup happens in JS
  // (see api-server services/crisis/events.ts).
  patternMatched: encryptedText("pattern_matched", "crisis_events.pattern_matched").notNull(),
  // Which country's helplines were served, chat|voice, and whether the card
  // was dismissed: all encrypted at rest (security review). Only the two
  // timestamps stay plaintext — the rolling windows filter on them in SQL.
  // NEVER compare these three in SQL; filter in JS (services/crisis/events.ts).
  countryServed: encryptedText("country_served", "crisis_events.country_served").notNull(), // ISO-2 or "fallback"
  // The DB default only ever lands via raw SQL (tests, backfills) as a plaintext
  // "chat" that the next boot sweep encrypts; the app always writes source.
  source: encryptedText("source", "crisis_events.source").notNull().default("chat"), // chat | voice
  blockDismissed: encryptedBoolean("block_dismissed", "crisis_events.block_dismissed").notNull().default(false),
  dismissedAt: timestamp("dismissed_at"), // powers the rolling 7-day review-flag window
});

export type CrisisEvent = typeof crisisEventsTable.$inferSelect;
