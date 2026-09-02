import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

// ─── Billing foundation (phase 1 — no Paddle integration yet) ────────────────
// These tables exist BEFORE checkout goes live so phase 2 (Paddle webhooks)
// and phase 3 (voice-minute metering) have somewhere solid to write. In
// phase 1 nothing writes to them in normal operation, and a user with no
// subscriptions row gets legacy full access (services/tiers.ts) — current
// behavior is unchanged by construction.
//
// Columns are billing METADATA only (tier names, statuses, provider ids,
// timestamps) — no conversation content, so nothing here needs the
// field-level encryption used for user content elsewhere.

// One row per user. Provider (Dodo) ids are nullable so a row can exist before
// a checkout completes (e.g. a picked-but-unpaid tier, or an admin comp).
export const subscriptionsTable = pgTable(
  "subscriptions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    dodoCustomerId: text("dodo_customer_id"),
    dodoSubscriptionId: text("dodo_subscription_id"),
    tier: text("tier").notNull(), // companion | closer | always (services/tiers.ts)
    status: text("status").notNull(), // trialing | active | past_due | canceled | paused
    trialEndsAt: timestamp("trial_ends_at"),
    // Period boundaries from Dodo's webhook: previous_billing_date /
    // next_billing_date. Both stored so voice-minute metering can sum
    // usage over the user's REAL billing period instead of guessing
    // "end minus one month".
    currentPeriodStartedAt: timestamp("current_period_started_at"),
    currentPeriodEndsAt: timestamp("current_period_ends_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("subscriptions_user_idx").on(t.userId)],
);

// Webhook idempotency ledger: Paddle retries deliveries, so phase 2 must
// process each event exactly once — INSERT here first, skip if already seen.
// payload_summary is a SHORT human-readable note (e.g. "subscription.updated
// tier=closer") — NEVER the full webhook payload, which carries personal data.
// Deliberately not user-keyed: it holds provider event ids only, and is the
// audit trail that survives account deletion (no personal data inside).
export const billingEventsTable = pgTable(
  "billing_events",
  {
    id: serial("id").primaryKey(),
    eventId: text("event_id").notNull(),
    eventType: text("event_type").notNull(),
    processedAt: timestamp("processed_at").notNull().defaultNow(),
    payloadSummary: text("payload_summary"),
  },
  (t) => [uniqueIndex("billing_events_event_idx").on(t.eventId)],
);

// Durable per-call voice usage — one row per call, written by the ElevenLabs
// post-call webhook (routes/elevenLabsWebhook.ts). Monthly caps will be
// enforced by summing duration_seconds over the billing period; today the
// table is measurement only. `source` records where the duration came from
// ('elevenlabs_webhook' = the provider's own post-call report — the same
// clock they bill us by; 'client_report' remains reserved for a browser
// fallback). provider_conversation_id is ElevenLabs' conversation_id — the
// idempotency key, since post-call deliveries can be retried.
export const voiceUsageTable = pgTable(
  "voice_usage",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id),
    callStartedAt: timestamp("call_started_at").notNull(),
    callEndedAt: timestamp("call_ended_at"),
    durationSeconds: integer("duration_seconds"),
    source: text("source").notNull().default("client_report"),
    providerConversationId: text("provider_conversation_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("voice_usage_user_started_idx").on(t.userId, t.callStartedAt),
    // Unique on the provider's call id (NULLs exempt, so rows from other
    // sources are unaffected) — a retried webhook delivery inserts nothing.
    uniqueIndex("voice_usage_conversation_idx").on(t.providerConversationId),
  ],
);

export type Subscription = typeof subscriptionsTable.$inferSelect;
export type BillingEvent = typeof billingEventsTable.$inferSelect;
export type VoiceUsage = typeof voiceUsageTable.$inferSelect;
