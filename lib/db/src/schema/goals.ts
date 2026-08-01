import { pgTable, serial, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { encryptedText } from "../encryptedColumns";

// title/description/task content are set from emotional conversation context
// (or the Journey form) — free text, encrypted at rest. isComplete/order stay
// plain: queries filter on them in SQL.

export const goalsTable = pgTable("goals", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  title: encryptedText("title", "goals.title").notNull(),
  description: encryptedText("description", "goals.description").notNull().default(""),
  isComplete: boolean("is_complete").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // ── Dedup reference tracking (Sprint: dedup) ────────────────────────────────
  // Bumped when extraction detects the user re-stating an existing goal instead
  // of inserting a duplicate. Additive + defaulted so legacy rows stay valid.
  timesReferenced: integer("times_referenced").notNull().default(1),
  lastReferencedAt: timestamp("last_referenced_at"),
});

export const goalTasksTable = pgTable("goal_tasks", {
  id: serial("id").primaryKey(),
  goalId: integer("goal_id")
    .notNull()
    .references(() => goalsTable.id, { onDelete: "cascade" }),
  content: encryptedText("content", "goal_tasks.content").notNull(),
  order: integer("order").notNull().default(0),
  isComplete: boolean("is_complete").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
