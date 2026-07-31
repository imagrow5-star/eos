/**
 * Central tier configuration — THE single source of truth for plans.
 *
 * Everything that describes a tier (display name, price, Paddle price-id env
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
import { db, subscriptionsTable } from "@workspace/db";
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
   * NAME of the env var that will hold this tier's Paddle price id in
   * phase 2 (values are set in the Paddle dashboard, never in code).
   */
  paddlePriceIdEnvVar: string;
  /** Voice-call allowance per billing month, in minutes. */
  voiceMinutesPerMonth: number;
  /** Card-upfront free-trial length, in days. */
  trialDays: number;
}

export const TIERS: Record<TierId, TierConfig> = {
  companion: {
    id: "companion",
    displayName: "Companion",
    monthlyPriceCents: 1999,
    paddlePriceIdEnvVar: "PADDLE_PRICE_COMPANION",
    voiceMinutesPerMonth: 150,
    trialDays: 7,
  },
  closer: {
    id: "closer",
    displayName: "Closer",
    monthlyPriceCents: 3999,
    paddlePriceIdEnvVar: "PADDLE_PRICE_CLOSER",
    voiceMinutesPerMonth: 400,
    trialDays: 7,
  },
  always: {
    id: "always",
    displayName: "Always",
    monthlyPriceCents: 5999,
    paddlePriceIdEnvVar: "PADDLE_PRICE_ALWAYS",
    voiceMinutesPerMonth: 1000,
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

/** Phase 2: resolve a tier's Paddle price id from its env var (null until set). */
export function getPaddlePriceId(tier: TierId): string | null {
  return process.env[TIERS[tier].paddlePriceIdEnvVar]?.trim() || null;
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
