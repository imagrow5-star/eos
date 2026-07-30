import { pgTable, serial, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { encryptedText } from "../encryptedColumns";

export const profileTable = pgTable("profile", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id),
  userName: encryptedText("user_name", "profile.user_name").notNull().default(""), // encrypted at rest
  // "Eos" is also set explicitly on every insert (getOrCreateProfileForUser);
  // this default only guards rows created outside the app. The DB column keeps
  // its old default until the next `drizzle-kit push`.
  companionName: text("companion_name").notNull().default("Eos"),
  relationshipType: text("relationship_type").notNull().default("friend"), // friend | romantic
  energy: text("energy").notNull().default("calm"), // playful | calm | deep
  userPath: text("user_path").notNull().default("breakup"), // lonely | support | breakup | bereavement
  country: text("country").notNull().default(""), // US | UK | AU | other
  ageBand: text("age_band").notNull().default(""), // 18-25 | 26-35 | 36-50 | 50+ (derived from birthYear when known)
  birthYear: integer("birth_year"), // approximate birth year (from age number or DOB) — nullable; adults only (18+)
  // purpose -> name -> companionName -> country -> ageBand -> done  (also accepts legacy "path" step)
  onboardingStep: text("onboarding_step").notNull().default("purpose"),
  isOnboardingComplete: boolean("is_onboarding_complete").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  morningNoteDate: text("morning_note_date"),
  visitDates: text("visit_dates").array().notNull().default([]),
  changeTalkDetected: boolean("change_talk_detected").notNull().default(false),
  voiceId: text("voice_id").notNull().default("EXAVITQu4vr4xnSDxMaL"), // ElevenLabs voice ID — default Sarah
  voiceTone: text("voice_tone").notNull().default("auto"), // Voice-call delivery: auto | gentle | calm | upbeat
  // ── Language & voice picker (Sprint 1.5) ─────────────────────────────────
  // preferredLanguage: what language Eos speaks — en | nl | de | fr | es | it
  // | pt | sv | no | da | pl (services/settings/languages.ts is the source of
  // truth). Only "en" is conversationally ACTIVE in 1.5; other values are
  // stored so 1.6 can flip them on once safety detection covers the language.
  preferredLanguage: text("preferred_language").notNull().default("en"),
  // voiceAccent: English accent family for the voice picker — us | gb | au |
  // in | ca | ie. The column default doubles as the backfill: ADD COLUMN with
  // DEFAULT fills every existing row with 'us'.
  voiceAccent: text("voice_accent").default("us"),
  // voiceGender: the VOICE's gender — female | male — a separate concept from
  // companionGender (who she IS) that merely DEFAULTS from it. Null = never
  // explicitly chosen: reads derive female/male from companionGender (a boot
  // backfill in api-server stamps man→male / woman→female; nonbinary stays
  // null and displays as female until the user picks).
  voiceGender: text("voice_gender"),
  companionGender: text("companion_gender").notNull().default("woman"), // woman | man | nonbinary
  userGender: text("user_gender"), // man | woman | custom (legacy: other) — nullable, optional
  userGenderCustom: encryptedText("user_gender_custom", "profile.user_gender_custom"), // their own words when userGender = "custom" (e.g. "non-binary") — encrypted at rest
  timezone: text("timezone").notNull().default("UTC"), // IANA timezone e.g. "America/New_York"
  // Daily email preferences
  dailyEmailOptOut: boolean("daily_email_opt_out").notNull().default(false),
  // Web push — opt-in only, default OFF; flipped by subscribe/unsubscribe routes
  pushOptIn: boolean("push_opt_in").notNull().default(false),
  lastEmailDate: text("last_email_date"), // YYYY-MM-DD — last date we sent a daily email, per their timezone
  lastGreetingAt: timestamp("last_greeting_at"), // when we last generated a contextual greeting (morning/evening/night)
  // ── Privacy & consent (Phase A) ───────────────────────────────────────────
  consentVersion: text("consent_version"), // version tag of the consent copy the user accepted (null = never consented)
  consentAt: timestamp("consent_at"), // server timestamp when they accepted
  dataSharingOptIn: boolean("data_sharing_opt_in").notNull().default(false), // placeholder for future data-sharing — nothing shares today; default OFF
});

export const insertProfileSchema = createInsertSchema(profileTable).omit({ id: true });
export type InsertProfile = z.infer<typeof insertProfileSchema>;
export type Profile = typeof profileTable.$inferSelect;
