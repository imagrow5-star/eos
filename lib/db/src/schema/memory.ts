import { pgTable, serial, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const memoryFactsTable = pgTable("memory_facts", {
  id: serial("id").primaryKey(),
  fact: text("fact").notNull(),
  category: text("category").notNull().default("life"), // life | preference | event | person | goal
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const personalitySignalsTable = pgTable("personality_signals", {
  id: serial("id").primaryKey(),
  signal: text("signal").notNull(),
  observedCount: integer("observed_count").notNull().default(1),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const winsTable = pgTable("wins", {
  id: serial("id").primaryKey(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const moodScoresTable = pgTable("mood_scores", {
  id: serial("id").primaryKey(),
  score: integer("score").notNull(), // 1-10
  date: text("date").notNull(), // YYYY-MM-DD
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const remindersTable = pgTable("reminders", {
  id: serial("id").primaryKey(),
  content: text("content").notNull(),
  dueDate: text("due_date"), // YYYY-MM-DD nullable
  isDone: boolean("is_done").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertMemoryFactSchema = createInsertSchema(memoryFactsTable).omit({ id: true });
export type InsertMemoryFact = z.infer<typeof insertMemoryFactSchema>;

export const insertWinSchema = createInsertSchema(winsTable).omit({ id: true });
export type InsertWin = z.infer<typeof insertWinSchema>;

export const insertMoodScoreSchema = createInsertSchema(moodScoresTable).omit({ id: true });
export type InsertMoodScore = z.infer<typeof insertMoodScoreSchema>;
