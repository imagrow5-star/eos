import { pgTable, serial, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const profileTable = pgTable("profile", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  userName: text("user_name").notNull().default(""),
  companionName: text("companion_name").notNull().default("Asha"),
  relationshipType: text("relationship_type").notNull().default("friend"), // friend | romantic
  energy: text("energy").notNull().default("calm"), // playful | calm | deep
  userPath: text("user_path").notNull().default("breakup"), // lonely | support | breakup | bereavement
  country: text("country").notNull().default(""), // US | UK | AU | other
  ageBand: text("age_band").notNull().default(""), // 18-25 | 26-35 | 36-50 | 50+
  // purpose -> name -> companionName -> country -> ageBand -> done  (also accepts legacy "path" step)
  onboardingStep: text("onboarding_step").notNull().default("purpose"),
  isOnboardingComplete: boolean("is_onboarding_complete").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  morningNoteDate: text("morning_note_date"),
  visitDates: text("visit_dates").array().notNull().default([]),
  changeTalkDetected: boolean("change_talk_detected").notNull().default(false),
  voiceId: text("voice_id").notNull().default("EXAVITQu4vr4xnSDxMaL"), // ElevenLabs voice ID — default Sarah
  voiceTone: text("voice_tone").notNull().default("auto"), // Voice-call delivery: auto | gentle | calm | upbeat
  companionGender: text("companion_gender").notNull().default("woman"), // woman | man | nonbinary
  userGender: text("user_gender"), // man | woman | custom (legacy: other) — nullable, optional
  userGenderCustom: text("user_gender_custom"), // their own words when userGender = "custom" (e.g. "non-binary")
  timezone: text("timezone").notNull().default("UTC"), // IANA timezone e.g. "America/New_York"
  // Daily email preferences
  dailyEmailOptOut: boolean("daily_email_opt_out").notNull().default(false),
  lastEmailDate: text("last_email_date"), // YYYY-MM-DD — last date we sent a daily email, per their timezone
  lastGreetingAt: timestamp("last_greeting_at"), // when we last generated a contextual greeting (morning/evening/night)
});

export const insertProfileSchema = createInsertSchema(profileTable).omit({ id: true });
export type InsertProfile = z.infer<typeof insertProfileSchema>;
export type Profile = typeof profileTable.$inferSelect;
