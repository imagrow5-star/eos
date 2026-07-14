import { pgTable, serial, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const memoryFactsTable = pgTable("memory_facts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  fact: text("fact").notNull(),
  category: text("category").notNull().default("life"), // life | preference | event | person | goal
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const personalitySignalsTable = pgTable("personality_signals", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  signal: text("signal").notNull(),
  observedCount: integer("observed_count").notNull().default(1),
  isActive: boolean("is_active").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const winsTable = pgTable("wins", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  content: text("content").notNull(),
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
