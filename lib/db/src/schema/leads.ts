import { pgTable, text, timestamp, serial } from "drizzle-orm/pg-core";

/**
 * Landing-page email captures (waitlist / essay list). A cold visitor's first
 * ask is an email, not a credit card: they hand over an address to receive the
 * essays, and we store the address, where it came from, and the exact consent
 * copy they agreed to (so the promise we made is auditable). No password, no
 * profile — these are prospects, not accounts.
 */
export const leadsTable = pgTable("leads", {
  id: serial("id").primaryKey(),
  // Stored lowercased + trimmed; unique so a repeat submit is idempotent.
  email: text("email").notNull().unique(),
  // Which surface captured it — e.g. "landing_hero" | "landing_footer".
  source: text("source").notNull(),
  // The exact promise shown next to the form when they submitted, versioned by
  // its wording, so we can prove what each person opted into.
  consentText: text("consent_text").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type Lead = typeof leadsTable.$inferSelect;
