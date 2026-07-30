import { pgTable, serial, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { encryptedText } from "../encryptedColumns";

export const messagesTable = pgTable("messages", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  role: text("role").notNull(), // user | assistant
  content: encryptedText("content", "messages.content").notNull(), // encrypted at rest
  isMorningNote: boolean("is_morning_note").notNull().default(false),
  // Crisis floor: the user dismissed the helpline card appended to THIS
  // assistant message. Dismissal is per-message — a future crisis turn shows a
  // fresh card. False (and meaningless) for every message without a block.
  crisisBlockDismissed: boolean("crisis_block_dismissed").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertMessageSchema = createInsertSchema(messagesTable).omit({ id: true });
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type MessageRow = typeof messagesTable.$inferSelect;
