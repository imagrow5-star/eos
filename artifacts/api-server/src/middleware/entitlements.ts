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
import { getUserTier, LEGACY_FULL_ACCESS, type UserTierResult } from "../services/tiers.js";
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
