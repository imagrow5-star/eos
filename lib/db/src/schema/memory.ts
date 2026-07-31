import { pgTable, serial, text, boolean, timestamp, integer, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { encryptedText } from "../encryptedColumns";

export const memoryFactsTable = pgTable("memory_facts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  fact: encryptedText("fact", "memory_facts.fact").notNull(), // encrypted at rest
  category: text("category").notNull().default("life"), // life | preference | event | person | goal
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // ── Importance ranking (Sprint 2A) ─────────────────────────────────────────
  // Retrieval scores facts on recency + how often/recently they're referenced +
  // emotional weight, so an old-but-important fact (grief mentioned 8× over
  // months) stops losing to a new trivial one. All nullable/defaulted and
  // backfilled at first boot — extraction (Sprint 1) is untouched.
  // timesReferenced: how many times the fact has resurfaced in conversation.
  // Seeded from history at backfill (cap 20), then +1 per matching message.
  timesReferenced: integer("times_referenced").notNull().default(1),
  // Most recent message that referenced this fact (backfill: newest match, else
  // createdAt). Drives the recent-reference boost.
  lastReferencedAt: timestamp("last_referenced_at"),
  // 0–1 emotional charge (category + surrounding low-mood heuristic at backfill).
  emotionalWeight: real("emotional_weight").notNull().default(0.0),
  // Sprint 2B "remember this" command sets this; declared now so the score
  // formula can already honour it. Trumps every other factor when true.
  userMarkedImportant: boolean("user_marked_important").notNull().default(false),
});

export const personalitySignalsTable = pgTable("personality_signals", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  signal: encryptedText("signal", "personality_signals.signal").notNull(), // encrypted at rest
  observedCount: integer("observed_count").notNull().default(1),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const winsTable = pgTable("wins", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  content: encryptedText("content", "wins.content").notNull(), // encrypted at rest
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const moodScoresTable = pgTable("mood_scores", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  score: integer("score").notNull(), // 1-10
  date: text("date").notNull(), // YYYY-MM-DD
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const remindersTable = pgTable("reminders", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  content: text("content").notNull(),
  scheduledTime: text("scheduled_time"), // "HH:MM" 24h, nullable = no specific time
  isRecurring: boolean("is_recurring").notNull().default(false), // repeats daily at scheduledTime
  dueDate: text("due_date"), // YYYY-MM-DD for one-off reminders, nullable
  isDone: boolean("is_done").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertMemoryFactSchema = createInsertSchema(memoryFactsTable).omit({ id: true });
export type InsertMemoryFact = z.infer<typeof insertMemoryFactSchema>;

export const insertWinSchema = createInsertSchema(winsTable).omit({ id: true });
export type InsertWin = z.infer<typeof insertWinSchema>;

export const insertMoodScoreSchema = createInsertSchema(moodScoresTable).omit({ id: true });
export type InsertMoodScore = z.infer<typeof insertMoodScoreSchema>;
