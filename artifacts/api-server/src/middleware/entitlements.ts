/**
 * Entitlement middleware — phase 1: WIRED BUT PERMISSIVE.
 *
 * Runs after requireAuth + requireVerified and attaches the user's tier
 * (services/tiers.ts) to the request as `req.entitlements`, so downstream
 * code can start reading it. In this phase it must never block, gate, or
 * error a request:
 *   - no subscriptions row → legacy_full_access (today's behavior);
 *   - ANY lookup failure → legacy_full_access, logged — a billing hiccup
 *     must never take the product down.
 *
 * Phase 2/3 turn this from a tag into a gate (voice-minute caps at
 * /voice-agent/session, tier-aware usage limits) — by reading
 * req.entitlements, not by adding new lookups.
 */

import type { Request, Response, NextFunction } from "express";
import { getUserTier, needsSubscription, chatGateStatus, LEGACY_FULL_ACCESS, type UserTierResult } from "../services/tiers.js";
import { logger } from "../lib/logger.js";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";

declare global {
  namespace Express {
    interface Request {
      /** Set by attachEntitlements on every authenticated request. */
      entitlements?: UserTierResult;
    }
  }
}

export async function attachEntitlements(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    req.entitlements = await getUserTier(req.userId);
  } catch (err) {
    try {
      const uh = hashUserIdForLog(req.userId);
      if (uh) logger.error({ err, uh }, "entitlements: tier lookup failed — granting full access");
    } catch { /* logging must never crash the caller */ }
    req.entitlements = LEGACY_FULL_ACCESS;
  }
  next();
}

/**
 * Subscription gate for the endpoints where the actual money burns
 * (/chat/stream, /chat/send, /voice-agent/session). The UI gate in AuthGate
 * routes gated accounts to /pricing; this is the server-side backstop so a
 * devtools user can't call the LLM/voice APIs around it.
 *
 * Same decision as the auth/me flag (services/tiers.ts needsSubscription):
 * post-cutoff account with no live subscription row → 402. And the same one
 * unbendable rule — any lookup failure lets the request through: a database
 * hiccup must never lock a paying customer out.
 */
export async function requireSubscription(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (await needsSubscription(req.userId)) {
      res.status(402).json({
        error: "An active membership is required. Choose a plan to continue.",
        code: "subscription_required",
      });
      return;
    }
  } catch {
    // needsSubscription already fails open internally; this belt-and-braces
    // catch keeps the rule absolute even if that ever changes.
  }
  next();
}

/**
 * Chat gate for /chat/send and /chat/stream: the same 402, but a gated
 * account is still allowed while it has free messages left (see
 * services/tiers.ts chatGateStatus). This is what lets a brand-new user talk
 * to Eos before the card wall; once the free turns are spent the endpoints
 * 402 and the client shows /pricing. Voice stays on requireSubscription
 * (hard) — no free voice.
 *
 * Same one unbendable rule: any lookup failure lets the request through.
 */
export async function requireSubscriptionForChat(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const gate = await chatGateStatus(req.userId);
    if (gate.needsSubscription) {
      res.status(402).json({
        error: "You've used your free messages. Start your free trial to keep talking.",
        code: "subscription_required",
      });
      return;
    }
  } catch {
    // chatGateStatus already fails open internally; belt-and-braces.
  }
  next();
}
