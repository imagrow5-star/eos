/**
 * "Continue with Google" — an ADDITIONAL sign-in option beside the existing
 * email + password + verification flow (which is untouched).
 *
 * Flow (authorization-code):
 *   GET /auth/google           → redirect to Google's consent screen
 *   GET /auth/google/callback  → exchange code, verify ID token, log in
 *   GET /auth/google/available → { available } for the frontend button
 *
 * The registered redirect URI is exactly ${APP_URL}/api/auth/google/callback
 * (built via getAppBaseUrl(), same helper the email links use) — it must
 * match what's configured in the Google Cloud console byte-for-byte.
 *
 * Account logic: a user whose GOOGLE-VERIFIED email already exists is logged
 * into that account (never a duplicate); an unknown email creates an account
 * that is born verified (Google vouched for the address — the verification
 * email exists to prove exactly that) with the Google display name on the
 * profile. Session handling mirrors POST /auth/login precisely, including
 * regeneration against session fixation.
 *
 * Failures NEVER render a raw error page: every path redirects back into the
 * SPA with ?googleError=<cancelled|failed|unavailable>, which the auth screen
 * turns into a friendly message.
 *
 * Rate limiting: the shared /api/auth limiter deliberately skips GETs (so
 * /auth/me polling can't lock anyone out), but these two GETs drive a
 * credential flow — they get their own limiter with the SAME budget/env knob
 * as the auth POST routes (AUTH_RATE_LIMIT_MAX per 15 min per IP).
 */

import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db, usersTable, profileTable } from "@workspace/db";
import { getAppBaseUrl, regenerateSession } from "./auth.js";
import { getOrCreateProfileForUser } from "./profile.js";
import {
  getGoogleAuthGateway,
  isGoogleAuthConfigured,
} from "../services/googleAuth.js";
import { logger } from "../lib/logger.js";

const router: IRouter = Router();

export const GOOGLE_CALLBACK_PATH = "/api/auth/google/callback";

function googleRedirectUri(): string {
  return `${getAppBaseUrl()}${GOOGLE_CALLBACK_PATH}`;
}

const googleAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT_MAX ?? 20),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: "Too many attempts. Please wait a few minutes and try again." });
  },
});

/** Friendly-error redirect codes the auth screen understands. */
type GoogleErrorCode = "cancelled" | "failed" | "unavailable";

function failRedirect(res: { redirect: (url: string) => void }, code: GoogleErrorCode): void {
  res.redirect(`/?googleError=${code}`);
}

// ─── GET /auth/google/available ──────────────────────────────────────────────
// Minimal public availability flag so the frontend can hide the button when
// the env vars are absent (same runtime-env pattern as lib/featureFlags.ts).

router.get("/auth/google/available", (_req, res): void => {
  res.json({ available: isGoogleAuthConfigured() });
});

// ─── GET /auth/google — begin the flow ───────────────────────────────────────

router.get("/auth/google", googleAuthLimiter, async (req, res): Promise<void> => {
  const gateway = getGoogleAuthGateway();
  if (!gateway) {
    failRedirect(res, "unavailable");
    return;
  }
  try {
    // CSRF state: random nonce bound to THIS browser session; the callback
    // only proceeds when Google echoes it back unchanged.
    const state = randomBytes(16).toString("hex");
    req.session.googleOauthState = state;
    await new Promise<void>((resolve, reject) =>
      req.session.save((err) => (err ? reject(err) : resolve())),
    );
    res.redirect(gateway.generateAuthUrl(googleRedirectUri(), state));
  } catch (err) {
    logger.error({ err }, "google-auth: could not start flow");
    failRedirect(res, "failed");
  }
});

// ─── GET /auth/google/callback — finish the flow ─────────────────────────────

router.get("/auth/google/callback", googleAuthLimiter, async (req, res): Promise<void> => {
  try {
    const gateway = getGoogleAuthGateway();
    if (!gateway) {
      failRedirect(res, "unavailable");
      return;
    }

    // User pressed "Cancel" on Google's consent screen (error=access_denied).
    if (typeof req.query.error === "string" && req.query.error) {
      failRedirect(res, "cancelled");
      return;
    }

    const code = req.query.code;
    const state = req.query.state;
    const expectedState = req.session.googleOauthState;
    delete req.session.googleOauthState; // single use, success or not

    if (
      typeof code !== "string" ||
      !code ||
      typeof state !== "string" ||
      !expectedState ||
      state !== expectedState
    ) {
      failRedirect(res, "failed");
      return;
    }

    // Exchange + FULL ID-token verification (signature via Google's certs,
    // audience, issuer, expiry) — services/googleAuth.ts. Throws on forgery.
    const identity = await gateway.exchangeCode(code, googleRedirectUri());

    // Never trust an email Google itself hasn't verified — that would let an
    // unverified Google account bypass our email-verification gate.
    if (!identity.email || identity.emailVerified !== true) {
      logger.warn("google-auth: id_token email missing or unverified — refusing login");
      failRedirect(res, "failed");
      return;
    }
    const cleanEmail = identity.email.toLowerCase().trim();

    let [user] = await db
      .select({ id: usersTable.id, emailVerifiedAt: usersTable.emailVerifiedAt })
      .from(usersTable)
      .where(eq(usersTable.email, cleanEmail))
      .limit(1);

    let created = false;
    if (!user) {
      // New account, born verified (Google vouched for the address). The
      // password slot gets a random unusable hash — the account is
      // Google-only until the user runs forgot-password to set one.
      const hashedPassword = await bcrypt.hash(randomBytes(32).toString("hex"), 12);
      try {
        [user] = await db
          .insert(usersTable)
          .values({ email: cleanEmail, hashedPassword, emailVerifiedAt: new Date() })
          .returning({ id: usersTable.id, emailVerifiedAt: usersTable.emailVerifiedAt });
        created = true;
      } catch (err) {
        // Unique-violation race with a concurrent signup — use the winner.
        if ((err as { code?: string })?.code === "23505" || (err as { cause?: { code?: string } })?.cause?.code === "23505") {
          [user] = await db
            .select({ id: usersTable.id, emailVerifiedAt: usersTable.emailVerifiedAt })
            .from(usersTable)
            .where(eq(usersTable.email, cleanEmail))
            .limit(1);
        } else {
          throw err;
        }
      }
    }
    if (!user) throw new Error("google-auth: user row unexpectedly missing");

    if (created) {
      // Seed the profile with the Google display name. Onboarding still asks
      // "what's your name?" and can overwrite it — this is just a warm start.
      const profile = await getOrCreateProfileForUser(user.id);
      if (identity.name?.trim()) {
        await db
          .update(profileTable)
          .set({ userName: identity.name.trim().slice(0, 40) })
          .where(eq(profileTable.id, profile.id));
      }
    } else if (!user.emailVerifiedAt) {
      // Existing account that never clicked its verification link: Google
      // just proved ownership of this exact address, which is all the email
      // link exists to prove — mark verified so login works.
      await db
        .update(usersTable)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(usersTable.id, user.id));
    }

    // Same session pattern as POST /auth/login: regenerate against fixation,
    // then attach the identity.
    await regenerateSession(req);
    req.session.userId = user.id;
    logger.info({ userId: user.id, created }, "User logged in via Google");

    // Land exactly where a normal email login lands: the SPA root (the
    // session cookie routes past the marketing page server-side).
    res.redirect("/");
  } catch (err) {
    logger.error({ err }, "google-auth: callback failed");
    failRedirect(res, "failed");
  }
});

export default router;
