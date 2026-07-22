import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ─── Web push ─────────────────────────────────────────────────────────────────
// Real web-push infrastructure (service worker + VAPID). Opt-in only
// (profile.pushOptIn, default false). Two uses today: "your chapter is ready"
// (max once/week by construction — one chapter per week) and the morning-note
// nudge. A HARD cap of 2 pushes per user per day is enforced atomically via
// push_events (conditional insert), regardless of kind.

export const pushSubscriptionsTable = pgTable("push_subscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  endpoint: text("endpoint").notNull().unique(), // push-service URL — unique per device/browser
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastSuccessAt: timestamp("last_success_at"),
  failureCount: integer("failure_count").notNull().default(0),
});

// One row per push actually attempted for a user. Doubles as the rate-cap
// ledger: the sender inserts with a conditional query that only succeeds while
// today's count is under the cap, so concurrent sends can't blow past it.
export const pushEventsTable = pgTable("push_events", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id),
  kind: text("kind").notNull(), // chapter_ready | morning_note | test
  sentAt: timestamp("sent_at").notNull().defaultNow(),
});

// Single-row server config: the VAPID keypair, generated once on first use and
// persisted so every instance (and every restart) signs with the same keys.
// Per-environment by nature (dev and prod each have their own database, and
// subscriptions are only valid against the keys they were created with).
// No user_id — deliberately outside the per-user deletion/export guards.
export const pushConfigTable = pgTable("push_config", {
  // Fixed id=1 + ON CONFLICT DO NOTHING makes first-boot key generation
  // race-safe without advisory locks: exactly one row can ever exist.
  id: integer("id").primaryKey().default(1),
  vapidPublicKey: text("vapid_public_key").notNull(),
  vapidPrivateKey: text("vapid_private_key").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type PushSubscription = typeof pushSubscriptionsTable.$inferSelect;
export type PushEvent = typeof pushEventsTable.$inferSelect;
