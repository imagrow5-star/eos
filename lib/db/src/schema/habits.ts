import { pgTable, serial, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { encryptedText } from "../encryptedColumns";

// name/whenThen/reason come from conversation ("reason" is the user's own
// "why this matters to me") — free text, encrypted at rest. isActive/streak/
// dates stay plain: queries filter and sort on them in SQL.
export const habitsTable = pgTable("habits", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  name: encryptedText("name", "habits.name").notNull(),
  whenThen: encryptedText("when_then", "habits.when_then").notNull(),
  reason: encryptedText("reason", "habits.reason").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  streak: integer("streak").notNull().default(0),
  lastCompleted: text("last_completed"), // YYYY-MM-DD
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const habitCompletionsTable = pgTable("habit_completions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  habitId: integer("habit_id").notNull(),
  completedDate: text("completed_date").notNull(), // YYYY-MM-DD
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertHabitSchema = createInsertSchema(habitsTable).omit({ id: true });
export type InsertHabit = z.infer<typeof insertHabitSchema>;

export const insertHabitCompletionSchema = createInsertSchema(habitCompletionsTable).omit({ id: true });
export type InsertHabitCompletion = z.infer<typeof insertHabitCompletionSchema>;

export type Habit = typeof habitsTable.$inferSelect;
