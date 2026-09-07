import { pgTable, text, timestamp, serial } from "drizzle-orm/pg-core";

/**
 * Landing-page "Ask the founder" captures. A visitor with doubts reaches
 * Naveen directly: they leave an email and (optionally) a message, and we store
 * the address, the message, where it came from, and the exact consent copy they
 * saw (so the promise we made is auditable). No password, no profile — these
 * are prospects, not accounts. The message itself is delivered to the founder
 * by email; this row is the lightweight record.
 */
export const leadsTable = pgTable("leads", {
  id: serial("id").primaryKey(),
  // Stored lowercased + trimmed; unique so we keep one row per person (a repeat
  // submit updates the stored message rather than piling up rows).
  email: text("email").notNull().unique(),
  // What's stopping them — free text, optional. Nullable: an email-only reach
  // out is allowed.
  message: text("message"),
  // Which surface captured it — e.g. "landing_hero" | "landing_footer".
  source: text("source").notNull(),
  // The exact promise shown next to the form when they submitted, versioned by
  // its wording, so we can prove what each person was told.
  consentText: text("consent_text").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Lead = typeof leadsTable.$inferSelect;
