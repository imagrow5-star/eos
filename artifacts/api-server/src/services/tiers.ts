/**
 * Central tier configuration — THE single source of truth for plans.
 *
 * Everything that describes a tier (display name, price, Dodo product-id env
 * var, voice-minute allowance, trial length) lives HERE and nowhere else in
 * code, so pricing can never drift between three files. The marketing copy in
 * welcome.html mirrors these numbers; if either side changes, change both
 * deliberately.
 *
 * Phase 1 contract (critical): a user with NO subscriptions row gets
 * `legacy_full_access` — unlimited everything, exactly today's behavior. No
 * existing user notices any change until phase 2 flips checkout on, and even
 * then only users who never subscribe stay legacy until the founder decides
 * otherwise.
 */

import { eq } from "drizzle-orm";
import { db, subscriptionsTable, usersTable } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";

export type TierId = "companion" | "closer" | "always";

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "paused";

export interface TierConfig {
  id: TierId;
  displayName: string;
  /** Monthly price in US cents (source of truth: $19.99/$39.99/$59.99). */
  monthlyPriceCents: number;
  /**
   * NAME of the env var that holds this tier's Dodo product id (values are
   * set in the Dodo Payments dashboard, never in code).
   */
  dodoProductIdEnvVar: string;
  /** Voice-call allowance per billing month, in minutes. */
  voiceMinutesPerMonth: number;
  /** Card-upfront free-trial length, in days. */
  trialDays: number;
}

export const TIERS: Record<TierId, TierConfig> = {
  companion: {
    id: "companion",
    displayName: "Essential",
    monthlyPriceCents: 1999,
    dodoProductIdEnvVar: "DODO_PRODUCT_ESSENTIAL",
    voiceMinutesPerMonth: 120,
    trialDays: 7,
  },
  closer: {
    id: "closer",
    displayName: "Standard",
    monthlyPriceCents: 3999,
    dodoProductIdEnvVar: "DODO_PRODUCT_STANDARD",
    voiceMinutesPerMonth: 300,
    trialDays: 7,
  },
  always: {
    id: "always",
    displayName: "Full",
    monthlyPriceCents: 5999,
    dodoProductIdEnvVar: "DODO_PRODUCT_FULL",
    voiceMinutesPerMonth: 500,
    trialDays: 7,
  },
};

export function isTierId(v: unknown): v is TierId {
  return v === "companion" || v === "closer" || v === "always";
}

const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  "trialing",
  "active",
  "past_due",
  "canceled",
  "paused",
];

export function isSubscriptionStatus(v: unknown): v is SubscriptionStatus {
  return SUBSCRIPTION_STATUSES.includes(v as SubscriptionStatus);
}

/** Resolve a tier's Dodo product id from its env var (null until set). */
export function getDodoProductId(tier: TierId): string | null {
  return process.env[TIERS[tier].dodoProductIdEnvVar]?.trim() || null;
}

export type UserTierResult =
  | {
      kind: "legacy_full_access";
      /** null = unlimited — pre-billing users keep everything. */
      voiceMinutesPerMonth: null;
    }
  | {
      kind: "subscribed";
      tier: TierId;
      status: SubscriptionStatus;
      config: TierConfig;
      voiceMinutesPerMonth: number;
      trialEndsAt: Date | null;
      currentPeriodEndsAt: Date | null;
    };

export const LEGACY_FULL_ACCESS: UserTierResult = {
  kind: "legacy_full_access",
  voiceMinutesPerMonth: null,
};

/**
 * The one lookup everything tier-aware goes through. No subscription row →
 * legacy full access (today's behavior, unchanged). A row with an unknown
 * tier or status string — which should never exist, but a bad webhook in
 * phase 2 must not lock a paying user out — ALSO falls back to full access,
 * loudly logged.
 */
export async function getUserTier(userId: number): Promise<UserTierResult> {
  const [row] = await db
    .select()
    .from(subscriptionsTable)
    .where(eq(subscriptionsTable.userId, userId))
    .limit(1);

  if (!row) return LEGACY_FULL_ACCESS;

  if (!isTierId(row.tier) || !isSubscriptionStatus(row.status)) {
    try {
      const uh = hashUserIdForLog(userId);
      if (uh)
        logger.error(
          { uh, tier: row.tier, status: row.status },
          "tiers: subscription row has unknown tier/status — granting full access, investigate",
        );
    } catch { /* logging must never crash the caller */ }
    return LEGACY_FULL_ACCESS;
  }

  const config = TIERS[row.tier];
  return {
    kind: "subscribed",
    tier: row.tier,
    status: row.status,
    config,
    voiceMinutesPerMonth: config.voiceMinutesPerMonth,
    trialEndsAt: row.trialEndsAt,
    currentPeriodEndsAt: row.currentPeriodEndsAt,
  };
}

// ─── Subscription gate (entitlement stage) ───────────────────────────────────

/**
 * THE cutoff for the subscription gate — the single place it is defined.
 *
 * Accounts created ON OR BEFORE this instant are grandfathered: they keep
 * full access forever, whatever their subscription row says (testers who
 * try a trial and cancel fall back to legacy access, never lose it).
 * Accounts created AFTER it need a live subscription row (trialing, active,
 * or past_due) to use the product; no row, canceled, or paused routes them
 * to /pricing instead of chat.
 *
 * Set 2026-08-27: every account existing then is a known tester; everyone
 * from that point on subscribes. Moving it is this one line. The env var of
 * the same name overrides it (tests push it far-future so suite-created
 * users aren't gated; ops can move it without a deploy) — an UNPARSEABLE
 * override falls back to the literal rather than gating everyone: the gate
 * must never fail closed on a typo.
 */
function resolveCutoff(): Date {
  const fallback = new Date("2026-08-27T00:00:00Z");
  const env = process.env.SUBSCRIPTION_REQUIRED_AFTER?.trim();
  if (!env) return fallback;
  const parsed = new Date(env);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}
export const SUBSCRIPTION_REQUIRED_AFTER = resolveCutoff();

/** Row statuses that keep access for a gated (post-cutoff) account.
 *  past_due is deliberate grace: Dodo's on_hold means the card is being
 *  retried — a bank hiccup must not lock someone out; if dunning fails the
 *  webhook flips the row to canceled and the gate closes then. */
const ACCESS_KEEPING_STATUSES: readonly SubscriptionStatus[] = ["trialing", "active", "past_due"];

export type AccessDecision = "granted" | "needs_subscription";

/**
 * Pure gate decision — no I/O, fully unit-tested.
 *  - created on/before cutoff → granted (grandfather wins over row state);
 *  - live row (trialing/active/past_due) → granted;
 *  - row with an UNKNOWN status string → granted (fail open, consistent
 *    with getUserTier: a bad webhook must never lock a paying user out);
 *  - no row, canceled, or paused → needs_subscription.
 */
export function resolveAccess(
  row: { status: string } | null,
  userCreatedAt: Date,
  cutoff: Date = SUBSCRIPTION_REQUIRED_AFTER,
): AccessDecision {
  if (userCreatedAt.getTime() <= cutoff.getTime()) return "granted";
  if (row) {
    if (!isSubscriptionStatus(row.status)) return "granted";
    if (ACCESS_KEEPING_STATUSES.includes(row.status)) return "granted";
  }
  return "needs_subscription";
}

/** DB lookups behind the gate — injectable so tests can prove fail-open. */
export interface GateLookups {
  userCreatedAt(userId: number): Promise<Date | null>;
  subscriptionRow(userId: number): Promise<{ status: string } | null>;
}

const defaultGateLookups: GateLookups = {
  async userCreatedAt(userId) {
    const [u] = await db
      .select({ createdAt: usersTable.createdAt })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);
    return u?.createdAt ?? null;
  },
  async subscriptionRow(userId) {
    const [row] = await db
      .select({ status: subscriptionsTable.status })
      .from(subscriptionsTable)
      .where(eq(subscriptionsTable.userId, userId))
      .limit(1);
    return row ?? null;
  },
};

/**
 * Whether the gate is closed for this user. THE ONE UNBENDABLE RULE: any
 * lookup failure returns false (access granted) — a database hiccup must
 * let a paying customer through, never lock them out. Gating happens only
 * on POSITIVELY ESTABLISHED facts: a real created_at past the cutoff and a
 * real absence (or dead state) of the subscription row.
 */
export async function needsSubscription(
  userId: number,
  lookups: GateLookups = defaultGateLookups,
): Promise<boolean> {
  try {
    const createdAt = await lookups.userCreatedAt(userId);
    if (!createdAt) return false; // can't establish the cutoff side — fail open
    const row = await lookups.subscriptionRow(userId);
    return resolveAccess(row, createdAt) === "needs_subscription";
  } catch (err) {
    try {
      const uh = hashUserIdForLog(userId);
      if (uh) logger.error({ err, uh }, "subscription-gate: lookup failed — granting access (fail open)");
    } catch { /* logging must never crash the caller */ }
    return false;
  }
}
