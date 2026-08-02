import { pgTable, serial, text, boolean, timestamp, integer, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { encryptedText } from "../encryptedColumns";

// ─── Feelings-in-context (Sprint 2C) ──────────────────────────────────────────
// The second memory layer. Where memory_facts stores WHAT the user said ("she
// has parents to visit"), memory_feelings stores the emotional texture attached
// to a specific moment ("the Sunday family dinner made her feel small in the way
// it always does").
//
// Deliberately a near-exact mirror of memory_facts (Sprint 2A): same encrypted
// content column, same category axis, same importance-ranking columns — so the
// SAME extraction pattern, the SAME dedup helper (services/memory/dedup.ts), and
// the SAME importance scorer (services/memory/importance.ts) all apply without a
// second implementation. The only conceptual difference is what `category` means:
// here it's the emotion family rather than a fact taxonomy.
//
// ON DELETE CASCADE on user_id: a deleted account takes its feelings with it
// even if some future deletion path forgets to sweep this table (the sweep in
// routes/auth.ts still deletes it explicitly, matching the rest of the codebase).
export const memoryFeelingsTable = pgTable("memory_feelings", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  // The feeling in its moment — one sentence, encrypted at rest.
  feeling: encryptedText("feeling", "memory_feelings.feeling").notNull(),
  // Emotion family: grief | shame | joy | fear | anger | love | loneliness |
  // hope | anxiety | pride | other. Free-ish text (model-supplied), defaulted so
  // a bad/blank value never breaks the insert.
  category: text("category").notNull().default("other"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // ── Importance ranking (shared with facts, Sprint 2A) ───────────────────────
  // Identical columns to memory_facts so scoreFactImportance ranks feelings and
  // facts together. emotionalWeight is seeded at extraction from the emotion's
  // intensity (feelings carry charge by nature), not left at 0 like facts.
  timesReferenced: integer("times_referenced").notNull().default(1),
  lastReferencedAt: timestamp("last_referenced_at"),
  emotionalWeight: real("emotional_weight").notNull().default(0.5),
  // Reserved for a future "remember this feeling" — declared now so the shared
  // score formula already honours it (parity with facts).
  userMarkedImportant: boolean("user_marked_important").notNull().default(false),
});

export const insertMemoryFeelingSchema = createInsertSchema(memoryFeelingsTable).omit({ id: true });
export type InsertMemoryFeeling = z.infer<typeof insertMemoryFeelingSchema>;
export type MemoryFeeling = typeof memoryFeelingsTable.$inferSelect;
