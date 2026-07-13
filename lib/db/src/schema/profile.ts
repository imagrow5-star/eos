import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const profileTable = pgTable("profile", {
  id: serial("id").primaryKey(),
  userName: text("user_name").notNull().default(""),
  companionName: text("companion_name").notNull().default("Aanya"),
  relationshipType: text("relationship_type").notNull().default("friend"), // friend | romantic
  energy: text("energy").notNull().default("calm"), // playful | calm | deep
  onboardingStep: text("onboarding_step").notNull().default("name"), // name | relationshipType | energy | companionName | done
  isOnboardingComplete: boolean("is_onboarding_complete").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  morningNoteDate: text("morning_note_date"), // last date morning note was generated YYYY-MM-DD
  visitDates: text("visit_dates").array().notNull().default([]),
  changeTalkDetected: boolean("change_talk_detected").notNull().default(false),
});

export const insertProfileSchema = createInsertSchema(profileTable).omit({ id: true });
export type InsertProfile = z.infer<typeof insertProfileSchema>;
export type Profile = typeof profileTable.$inferSelect;
