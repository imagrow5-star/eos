import { Router, type IRouter, type Request } from "express";
import bcrypt from "bcryptjs";
import { eq, and, gt, isNull, desc, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db, pool } from "@workspace/db";
import { usersTable, passwordResetTokensTable, emailVerificationTokensTable } from "@workspace/db";
import { logger } from "../lib/logger.js";
import { hashUserIdForLog } from "../lib/logging/hashUserIdForLog.js";
import { hashAuthToken, tokenHashMatches } from "../lib/authTokenHash.js";

const router: IRouter = Router();

// ─── App base URL for links inside emails ────────────────────────────────────
/**
 * Resolves the public URL of the app for building email links
 * (verification, password reset, cancel links).
 *
 * Priority:
 *  1. APP_URL              — explicit override (same convention as daily-email)
 *  2. REPLIT_DOMAINS       — set in BOTH environments: the production domain
 *                            on deployments, the .replit.dev preview domain in
 *                            the workspace. First entry is the primary domain.
 *  3. REPLIT_DEV_DOMAIN    — workspace fallback
 *  4. localhost            — bare local dev
 *
 * The old code checked only REPLIT_DEV_DOMAIN, which does NOT exist on
 * deployments — so production emails linked to http://localhost:3000 and
 * users could never verify or reset from a real inbox.
 */
export function getAppBaseUrl(): string {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    const primary = domains.split(",")[0]?.trim();
    if (primary) return `https://${primary}`;
  }

  if (process.env.REPLIT_DEV_DOMAIN) {
    return `https://${process.env.REPLIT_DEV_DOMAIN}`;
  }

  // On non-Replit hosts (Render) none of the fallbacks above exist, so a
  // missing APP_URL would silently regress to localhost email links — the
  // exact historical bug this helper was written to fix. Fail loudly instead.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "APP_URL must be set in production — email links would otherwise point to localhost.",
    );
  }

  return "http://localhost:3000";
}

// ─── Email helper (Resend REST API) ──────────────────────────────────────────

async function sendPasswordResetEmail(
  toEmail: string,
  resetUrl: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Privacy audit Tier 1: never log the token or the reset URL (or userId).
    // To retrieve a token in dev, add a `pnpm token:reveal` script that reads
    // it from the DB (not built here).
    logger.warn(
      "Email delivery unavailable (RESEND_API_KEY not set). Password-reset token generated but not delivered. Retrieve via DB or set the env var.",
    );
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL ?? "Eos <hello@eoscompanion.com>",
      to: [toEmail],
      subject: "Reset your Eos password",
      html: `
        <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#fffff8;color:#1a1a2e;">
          <h1 style="font-size:32px;letter-spacing:0.25em;text-align:center;color:#b8962e;margin-bottom:8px;">EOS</h1>
          <p style="text-align:center;font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin-bottom:40px;">a new dawn</p>
          <p style="font-size:16px;line-height:1.6;">Hi there,</p>
          <p style="font-size:16px;line-height:1.6;">We received a request to reset the password for your Eos account. Click the button below to choose a new password. This link expires in 1 hour.</p>
          <div style="text-align:center;margin:36px 0;">
            <a href="${resetUrl}" style="display:inline-block;background:#b8962e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-size:14px;letter-spacing:0.1em;">Reset My Password</a>
          </div>
          <p style="font-size:13px;color:#888;line-height:1.6;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
          <p style="font-size:13px;color:#888;line-height:1.6;">Or copy this link into your browser:<br><a href="${resetUrl}" style="color:#b8962e;word-break:break-all;">${resetUrl}</a></p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

async function sendVerificationEmail(
  toEmail: string,
  verifyUrl: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Privacy audit Tier 1: never log the token or the verify URL (or userId).
    // To retrieve a token in dev, add a `pnpm token:reveal` script that reads
    // it from the DB (not built here).
    logger.warn(
      "Email delivery unavailable (RESEND_API_KEY not set). Email-verification token generated but not delivered. Retrieve via DB or set the env var.",
    );
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL ?? "Eos <hello@eoscompanion.com>",
      to: [toEmail],
      subject: "Verify your Eos email address",
      html: `
        <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#fffff8;color:#1a1a2e;">
          <h1 style="font-size:32px;letter-spacing:0.25em;text-align:center;color:#b8962e;margin-bottom:8px;">EOS</h1>
          <p style="text-align:center;font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin-bottom:40px;">a new dawn</p>
          <p style="font-size:16px;line-height:1.6;">Hi there,</p>
          <p style="font-size:16px;line-height:1.6;">Thank you for creating an Eos account. Please verify your email address to get started. This link stays valid for 7 days.</p>
          <div style="text-align:center;margin:36px 0;">
            <a href="${verifyUrl}" style="display:inline-block;background:#b8962e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-size:14px;letter-spacing:0.1em;">Verify My Email</a>
          </div>
          <p style="font-size:13px;color:#888;line-height:1.6;">If you didn't create an Eos account, you can safely ignore this email.</p>
          <p style="font-size:13px;color:#888;line-height:1.6;">Or copy this link into your browser:<br><a href="${verifyUrl}" style="color:#b8962e;word-break:break-all;">${verifyUrl}</a></p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

/**
 * Masks an email address so a notice can reference it without leaking the full
 * address. e.g. "newuser@gmail.com" -> "n***@g***.com".
 */
function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const maskedLocal = local[0] + "***";
  const dot = domain.lastIndexOf(".");
  const maskedDomain =
    dot > 0 ? domain[0] + "***" + domain.slice(dot) : domain[0] + "***";
  return `${maskedLocal}@${maskedDomain}`;
}

async function sendChangeEmailVerification(
  toEmail: string,
  verifyUrl: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Privacy audit Tier 1: never log the token or the change-email URL (or userId).
    // To retrieve a token in dev, add a `pnpm token:reveal` script that reads
    // it from the DB (not built here).
    logger.warn(
      "Email delivery unavailable (RESEND_API_KEY not set). Change-email token generated but not delivered. Retrieve via DB or set the env var.",
    );
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL ?? "Eos <hello@eoscompanion.com>",
      to: [toEmail],
      subject: "Confirm your new Eos email address",
      html: `
        <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#fffff8;color:#1a1a2e;">
          <h1 style="font-size:32px;letter-spacing:0.25em;text-align:center;color:#b8962e;margin-bottom:8px;">EOS</h1>
          <p style="text-align:center;font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin-bottom:40px;">a new dawn</p>
          <p style="font-size:16px;line-height:1.6;">Hi there,</p>
          <p style="font-size:16px;line-height:1.6;">We received a request to change the email address on your Eos account to this one. Click below to confirm this is your address. This link expires in 24 hours.</p>
          <div style="text-align:center;margin:36px 0;">
            <a href="${verifyUrl}" style="display:inline-block;background:#b8962e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-size:14px;letter-spacing:0.1em;">Confirm New Email</a>
          </div>
          <p style="font-size:13px;color:#888;line-height:1.6;">If you didn't request this change, you can safely ignore this email — nothing will change until you confirm.</p>
          <p style="font-size:13px;color:#888;line-height:1.6;">Or copy this link into your browser:<br><a href="${verifyUrl}" style="color:#b8962e;word-break:break-all;">${verifyUrl}</a></p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

/**
 * Notifies the *current* (old) email address that a change to a new address was
 * requested. Mirrors the password-reset security alert: it never reveals the
 * full new address and offers a one-click way to cancel the pending change.
 */
async function sendEmailChangeSecurityAlert(
  toEmail: string,
  maskedNewEmail: string,
  cancelUrl: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Privacy audit Tier 1: never log the token or the cancel URL (or userId).
    // To retrieve a token in dev, add a `pnpm token:reveal` script that reads
    // it from the DB (not built here).
    logger.warn(
      "Email delivery unavailable (RESEND_API_KEY not set). Email-change cancel token generated but not delivered. Retrieve via DB or set the env var.",
    );
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL ?? "Eos <hello@eoscompanion.com>",
      to: [toEmail],
      subject: "Security alert: a new email address was requested for your Eos account",
      html: `
        <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#fffff8;color:#1a1a2e;">
          <h1 style="font-size:32px;letter-spacing:0.25em;text-align:center;color:#b8962e;margin-bottom:8px;">EOS</h1>
          <p style="text-align:center;font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin-bottom:40px;">a new dawn</p>
          <p style="font-size:16px;line-height:1.6;">Hi there,</p>
          <p style="font-size:16px;line-height:1.6;">Someone just requested to change the email address on your Eos account to a new address (<strong>${maskedNewEmail}</strong>). If that was you, no action is needed — nothing changes until the new address is confirmed, and this address stays in control until then.</p>
          <p style="font-size:16px;line-height:1.6;font-weight:bold;">If you did <em>not</em> request this, click below to cancel the change immediately and keep your account safe.</p>
          <div style="text-align:center;margin:36px 0;">
            <a href="${cancelUrl}" style="display:inline-block;background:#c0392b;color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-size:14px;letter-spacing:0.1em;">No, Secure My Account</a>
          </div>
          <p style="font-size:13px;color:#888;line-height:1.6;">Clicking that link will cancel the pending email change. Your account will keep using this address, and we recommend changing your password.</p>
          <p style="font-size:13px;color:#888;line-height:1.6;">Or copy this link into your browser:<br><a href="${cancelUrl}" style="color:#c0392b;word-break:break-all;">${cancelUrl}</a></p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

/**
 * How long a signup/resend verification link stays valid. Was 24 hours; real
 * users often find the email days later (it lands in Gmail's Promotions or
 * Updates tabs), and an expired link with no self-serve resend permanently
 * locked them out.
 */
const VERIFICATION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Minimum gap between verification emails to one account (anti-flooding). */
const RESEND_COOLDOWN_MS = 60 * 1000;

/**
 * Minimum gap between password-reset requests for one account. Each request
 * sends TWO emails (reset link + security alert), so without a per-address
 * cooldown the endpoint is an email-bombing vector even behind the per-IP
 * rate limit. The response stays the generic {ok:true} either way.
 */
const RESET_EMAIL_COOLDOWN_MS = 60 * 1000;

/** Creates a verification token in the DB and fires off the email (no throw). */
async function issueAndSendVerification(userId: number, email: string): Promise<void> {
  try {
    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);

    // Store only the hash — the raw token exists solely in the email we send.
    await db.insert(emailVerificationTokensTable).values({ token: hashAuthToken(token), userId, expiresAt });

    const verifyUrl = `${getAppBaseUrl()}/?verifyToken=${token}`;

    await sendVerificationEmail(email, verifyUrl);
    try {
      const uh = hashUserIdForLog(userId);
      if (uh) logger.info({ uh }, "Verification email sent");
    } catch { /* logging must never crash the caller */ }
  } catch (err) {
    try {
      const uh = hashUserIdForLog(userId);
      if (uh) logger.error({ err, uh }, "Failed to send verification email");
    } catch { /* logging must never crash the caller */ }
  }
}

/**
 * Atomically replaces a user's signup verification token. Takes a per-user
 * advisory lock, re-checks the resend cooldown *inside* it (so parallel
 * requests can't each slip past), then deletes old signup tokens and inserts
 * the fresh one in the same transaction — no crash window in which the user
 * has zero valid tokens. Change-email staging tokens (new_email set) are
 * never touched.
 *
 * Returns the new token, or null when the cooldown applies.
 */
async function replaceVerificationTokenAtomic(userId: number): Promise<string | null> {
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(917502, ${userId})`);

    const [latest] = await tx
      .select({ createdAt: emailVerificationTokensTable.createdAt })
      .from(emailVerificationTokensTable)
      .where(
        and(
          eq(emailVerificationTokensTable.userId, userId),
          isNull(emailVerificationTokensTable.newEmail),
        ),
      )
      .orderBy(desc(emailVerificationTokensTable.createdAt))
      .limit(1);

    if (latest && Date.now() - latest.createdAt.getTime() < RESEND_COOLDOWN_MS) {
      return null;
    }

    await tx
      .delete(emailVerificationTokensTable)
      .where(
        and(
          eq(emailVerificationTokensTable.userId, userId),
          isNull(emailVerificationTokensTable.newEmail),
        ),
      );

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);
    await tx.insert(emailVerificationTokensTable).values({ token: hashAuthToken(token), userId, expiresAt });
    return token;
  });
}

/**
 * Issues a fresh session ID before an identity is attached to the session.
 * Without this, the session ID from before authentication carries over into
 * the authenticated session (session fixation).
 * Exported: the Google sign-in callback (routes/googleAuth.ts) must follow
 * the exact same pattern.
 */
export function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve())),
  );
}

// ─── POST /auth/signup ────────────────────────────────────────────────────────

router.post("/auth/signup", async (req, res): Promise<void> => {
  const { email, password } = req.body ?? {};

  if (!email || typeof email !== "string" || !email.includes("@")) {
    res.status(400).json({ error: "A valid email address is required." });
    return;
  }
  const cleanEmail = email.toLowerCase().trim();
  if (cleanEmail.length > 254) {
    res.status(400).json({ error: "Email address is too long." });
    return;
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters." });
    return;
  }

  try {
    const [existing] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, cleanEmail))
      .limit(1);

    if (existing) {
      res.status(409).json({ error: "An account with that email already exists." });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const [user] = await db
      .insert(usersTable)
      .values({ email: cleanEmail, hashedPassword })
      .returning({ id: usersTable.id, email: usersTable.email });

    await regenerateSession(req);
    req.session.userId = user!.id;
    try {
      const uh = hashUserIdForLog(user!.id);
      if (uh) logger.info({ uh }, "New user signed up");
    } catch { /* logging must never crash the caller */ }

    // Fire-and-forget: send verification email after responding
    res.status(201).json({ user: { id: user!.id, email: user!.email }, emailVerified: false });

    // Issue verification asynchronously (don't block the response)
    issueAndSendVerification(user!.id, user!.email);
  } catch (err: any) {
    if ((err as any)?.code === "23505") {
      // Race-condition unique violation
      res.status(409).json({ error: "An account with that email already exists." });
      return;
    }
    logger.error({ err }, "Signup error");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ─── POST /auth/login ─────────────────────────────────────────────────────────

router.post("/auth/login", async (req, res): Promise<void> => {
  const { email, password } = req.body ?? {};

  if (!email || typeof email !== "string" || !password || typeof password !== "string") {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }

  const cleanEmail = email.toLowerCase().trim();

  try {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, cleanEmail))
      .limit(1);

    if (!user) {
      // Same message as wrong password to prevent user enumeration
      res.status(401).json({ error: "Incorrect email or password." });
      return;
    }

    const valid = await bcrypt.compare(password, user.hashedPassword);
    if (!valid) {
      res.status(401).json({ error: "Incorrect email or password." });
      return;
    }

    await regenerateSession(req);
    req.session.userId = user.id;
    try {
      const uh = hashUserIdForLog(user.id);
      if (uh) logger.info({ uh }, "User logged in");
    } catch { /* logging must never crash the caller */ }
    res.json({
      user: { id: user.id, email: user.email },
      emailVerified: user.emailVerifiedAt !== null,
    });
  } catch (err) {
    logger.error({ err }, "Login error");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────

router.post("/auth/logout", (req, res): void => {
  req.session.destroy((err) => {
    if (err) logger.error({ err }, "Session destroy error");
    res.clearCookie("sid");
    res.json({ ok: true });
  });
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────

router.get("/auth/me", async (req, res): Promise<void> => {
  const userId = req.session?.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const [user] = await db
    .select({ id: usersTable.id, email: usersTable.email, emailVerifiedAt: usersTable.emailVerifiedAt })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);

  if (!user) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "Session invalid" });
    return;
  }

  res.json({ user: { id: user.id, email: user.email }, emailVerified: user.emailVerifiedAt !== null });
});

// ─── GET /auth/verify-email ───────────────────────────────────────────────────

router.get("/auth/verify-email", async (req, res): Promise<void> => {
  const { token } = req.query;

  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "Verification token is required." });
    return;
  }

  try {
    const now = new Date();

    const [row] = await db
      .select()
      .from(emailVerificationTokensTable)
      .where(
        and(
          eq(emailVerificationTokensTable.token, hashAuthToken(token)),
          gt(emailVerificationTokensTable.expiresAt, now),
        ),
      )
      .limit(1);

    if (!row || !tokenHashMatches(row.token, token)) {
      res.status(400).json({ error: "This verification link is invalid or has expired." });
      return;
    }

    // ── Email-change confirmation ──
    // A token with `newEmail` set stages a pending change. Confirming it swaps
    // the account's email over to the new address atomically and marks it verified.
    if (row.newEmail) {
      try {
        await db
          .update(usersTable)
          .set({ email: row.newEmail, emailVerifiedAt: now })
          .where(eq(usersTable.id, row.userId));
      } catch (err: any) {
        // Drizzle wraps driver errors in a DrizzleQueryError, so the pg unique
        // violation code can live on the error or on its `cause`.
        if (err?.code === "23505" || err?.cause?.code === "23505") {
          // Someone else claimed this address between request and confirmation.
          // Drop the stale token so the user can start over.
          await db
            .delete(emailVerificationTokensTable)
            .where(eq(emailVerificationTokensTable.token, hashAuthToken(token)));
          res.status(409).json({
            error: "That email address is now in use by another account.",
          });
          return;
        }
        throw err;
      }

      await db
        .delete(emailVerificationTokensTable)
        .where(eq(emailVerificationTokensTable.userId, row.userId));

      try {
        const uh = hashUserIdForLog(row.userId);
        if (uh) logger.info({ uh }, "Email address changed and verified");
      } catch { /* logging must never crash the caller */ }
      res.json({ ok: true, emailChanged: true });
      return;
    }

    // ── Ordinary signup verification ──
    // Mark the user as verified
    await db
      .update(usersTable)
      .set({ emailVerifiedAt: now })
      .where(and(eq(usersTable.id, row.userId), isNull(usersTable.emailVerifiedAt)));

    // Delete all verification tokens for this user (clean up)
    await db
      .delete(emailVerificationTokensTable)
      .where(eq(emailVerificationTokensTable.userId, row.userId));

    try {
      const uh = hashUserIdForLog(row.userId);
      if (uh) logger.info({ uh }, "Email verified");
    } catch { /* logging must never crash the caller */ }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "verify-email error");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ─── POST /auth/resend-verification ──────────────────────────────────────────

router.post("/auth/resend-verification", async (req, res): Promise<void> => {
  const sessionUserId = req.session?.userId;

  // The unauthenticated path always answers with this exact body, so the
  // endpoint can't be used to probe which addresses have accounts.
  const generic = {
    ok: true,
    message: "If an account exists for that address, a new verification link is on its way.",
  };

  try {
    let user:
      | { id: number; email: string; emailVerifiedAt: Date | null }
      | undefined;

    if (sessionUserId) {
      // Logged-in path — used by the verification gate screen.
      [user] = await db
        .select({ id: usersTable.id, email: usersTable.email, emailVerifiedAt: usersTable.emailVerifiedAt })
        .from(usersTable)
        .where(eq(usersTable.id, sessionUserId))
        .limit(1);

      if (!user) {
        res.status(401).json({ error: "Session invalid" });
        return;
      }
      if (user.emailVerifiedAt !== null) {
        res.status(400).json({ error: "Your email is already verified." });
        return;
      }
    } else {
      // Email-based path — lets users whose link expired request a fresh one
      // without needing to remember to log back in first.
      const rawEmail = (req.body as { email?: unknown } | undefined)?.email;
      if (typeof rawEmail !== "string" || !rawEmail.trim()) {
        res.status(400).json({ error: "Enter your email address." });
        return;
      }
      const cleanEmail = rawEmail.toLowerCase().trim();
      if (cleanEmail.length > 254) {
        res.status(400).json({ error: "Email address is too long." });
        return;
      }

      [user] = await db
        .select({ id: usersTable.id, email: usersTable.email, emailVerifiedAt: usersTable.emailVerifiedAt })
        .from(usersTable)
        .where(eq(usersTable.email, cleanEmail))
        .limit(1);

      // Unknown address or already verified → same generic answer, no send.
      if (!user || user.emailVerifiedAt !== null) {
        res.json(generic);
        return;
      }
    }

    // Atomically re-check the cooldown and swap the signup token under a
    // per-user lock — parallel requests can't each slip past the cooldown.
    const token = await replaceVerificationTokenAtomic(user.id);

    if (token === null) {
      // Cooldown: a token was issued less than a minute ago.
      if (sessionUserId) {
        res.status(429).json({ error: "We just sent one — wait a minute, then try again." });
      } else {
        res.json(generic); // stay silent on the email path
      }
      return;
    }

    // Token is committed — respond now, send the email in the background.
    res.json(sessionUserId ? { ok: true } : generic);

    const targetEmail = user.email;
    const targetUserId = user.id;
    void (async () => {
      try {
        const verifyUrl = `${getAppBaseUrl()}/?verifyToken=${token}`;
        await sendVerificationEmail(targetEmail, verifyUrl);
        try {
          const uh = hashUserIdForLog(targetUserId);
          if (uh) logger.info({ uh }, "Verification email sent");
        } catch { /* logging must never crash the caller */ }
      } catch (err) {
        try {
          const uh = hashUserIdForLog(targetUserId);
          if (uh) logger.error({ err, uh }, "Failed to send verification email");
        } catch { /* logging must never crash the caller */ }
      }
    })();
  } catch (err) {
    logger.error({ err }, "resend-verification error");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ─── POST /auth/change-email ─────────────────────────────────────────────────
// Authenticated users request a change to a new email address. The current
// address (and its verified status) is kept until the user confirms the new one
// via a link sent to that new address.

router.post("/auth/change-email", async (req, res): Promise<void> => {
  const userId = req.session?.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const { newEmail, password } = req.body ?? {};

  if (!newEmail || typeof newEmail !== "string" || !newEmail.includes("@")) {
    res.status(400).json({ error: "A valid email address is required." });
    return;
  }
  const cleanEmail = newEmail.toLowerCase().trim();
  if (cleanEmail.length > 254) {
    res.status(400).json({ error: "Email address is too long." });
    return;
  }
  if (!password || typeof password !== "string") {
    res.status(400).json({ error: "Your current password is required to change your email." });
    return;
  }

  try {
    const [user] = await db
      .select({ id: usersTable.id, email: usersTable.email, hashedPassword: usersTable.hashedPassword })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!user) {
      res.status(401).json({ error: "Session invalid" });
      return;
    }

    const valid = await bcrypt.compare(password, user.hashedPassword);
    if (!valid) {
      res.status(403).json({ error: "That password is incorrect." });
      return;
    }

    if (cleanEmail === user.email) {
      res.status(400).json({ error: "That's already your email address." });
      return;
    }

    // Reject if another account already uses this address.
    const [taken] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, cleanEmail))
      .limit(1);

    if (taken) {
      res.status(409).json({ error: "An account with that email already exists." });
      return;
    }

    // Clear any prior pending verification/change tokens, then stage this change.
    await db
      .delete(emailVerificationTokensTable)
      .where(eq(emailVerificationTokensTable.userId, userId));

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await db
      .insert(emailVerificationTokensTable)
      .values({ token: hashAuthToken(token), userId, newEmail: cleanEmail, expiresAt });

    const domain = getAppBaseUrl();
    const verifyUrl = `${domain}/?verifyToken=${token}`;
    const cancelUrl = `${domain}/?cancelEmailChange=${token}`;

    // Respond before sending so a slow email provider doesn't hang the request.
    res.json({ ok: true, pendingEmail: cleanEmail });

    // Confirmation goes to the NEW address; a security notice goes to the OLD
    // (current) address so the rightful owner can react before it's confirmed.
    try {
      await Promise.all([
        sendChangeEmailVerification(cleanEmail, verifyUrl),
        sendEmailChangeSecurityAlert(user.email, maskEmail(cleanEmail), cancelUrl),
      ]);
      try {
        const uh = hashUserIdForLog(userId);
        if (uh) logger.info({ uh }, "Change-email verification and security alert sent");
      } catch { /* logging must never crash the caller */ }
    } catch (err) {
      try {
        const uh = hashUserIdForLog(userId);
        if (uh) logger.error({ err, uh }, "Failed to send change-email emails");
      } catch { /* logging must never crash the caller */ }
    }
  } catch (err) {
    logger.error({ err }, "change-email error");
    if (!res.headersSent) {
      res.status(500).json({ error: "Something went wrong. Please try again." });
    }
  }
});

async function sendSecurityAlertEmail(
  toEmail: string,
  cancelUrl: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Privacy audit Tier 1: never log the token or the cancel URL (or userId).
    // To retrieve a token in dev, add a `pnpm token:reveal` script that reads
    // it from the DB (not built here).
    logger.warn(
      "Email delivery unavailable (RESEND_API_KEY not set). Reset-cancel token generated but not delivered. Retrieve via DB or set the env var.",
    );
    return;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL ?? "Eos <hello@eoscompanion.com>",
      to: [toEmail],
      subject: "Security alert: password reset requested for your Eos account",
      html: `
        <div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#fffff8;color:#1a1a2e;">
          <h1 style="font-size:32px;letter-spacing:0.25em;text-align:center;color:#b8962e;margin-bottom:8px;">EOS</h1>
          <p style="text-align:center;font-size:12px;letter-spacing:0.2em;color:#888;text-transform:uppercase;margin-bottom:40px;">a new dawn</p>
          <p style="font-size:16px;line-height:1.6;">Hi there,</p>
          <p style="font-size:16px;line-height:1.6;">Someone just requested a password reset for your Eos account. If that was you, you can ignore this message — a separate email with the reset link was sent to you.</p>
          <p style="font-size:16px;line-height:1.6;font-weight:bold;">If you did <em>not</em> request this, click below to cancel the reset immediately and keep your account safe.</p>
          <div style="text-align:center;margin:36px 0;">
            <a href="${cancelUrl}" style="display:inline-block;background:#c0392b;color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-size:14px;letter-spacing:0.1em;">No, Secure My Account</a>
          </div>
          <p style="font-size:13px;color:#888;line-height:1.6;">Clicking that link will invalidate the pending reset request. Your password will remain unchanged.</p>
          <p style="font-size:13px;color:#888;line-height:1.6;">Or copy this link into your browser:<br><a href="${cancelUrl}" style="color:#c0392b;word-break:break-all;">${cancelUrl}</a></p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

// ─── POST /auth/cancel-reset ──────────────────────────────────────────────────

router.post("/auth/cancel-reset", async (req, res): Promise<void> => {
  const { token } = req.body ?? {};

  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "Token is required." });
    return;
  }

  try {
    // Look up the user from the token (expired or not — we still want to cancel)
    const [row] = await db
      .select({ userId: passwordResetTokensTable.userId, token: passwordResetTokensTable.token })
      .from(passwordResetTokensTable)
      .where(
        and(
          eq(passwordResetTokensTable.token, hashAuthToken(token)),
          isNull(passwordResetTokensTable.usedAt),
        ),
      )
      .limit(1);

    if (!row || !tokenHashMatches(row.token, token)) {
      // Token doesn't exist or was already used — treat as success to avoid enumeration
      res.json({ ok: true });
      return;
    }

    // Delete ALL pending reset tokens for this user
    await db
      .delete(passwordResetTokensTable)
      .where(
        and(
          eq(passwordResetTokensTable.userId, row.userId),
          isNull(passwordResetTokensTable.usedAt),
        ),
      );

    try {
      const uh = hashUserIdForLog(row.userId);
      if (uh) logger.info({ uh }, "Password reset cancelled by user via security alert");
    } catch { /* logging must never crash the caller */ }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "cancel-reset error");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ─── POST /auth/cancel-email-change ───────────────────────────────────────────
// Reached from the security notice sent to the OLD email address. Cancels the
// pending change by dropping the staged change token so the account keeps its
// current address. No session required — the token is the proof of ownership.

router.post("/auth/cancel-email-change", async (req, res): Promise<void> => {
  const { token } = req.body ?? {};

  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "Token is required." });
    return;
  }

  try {
    // Only match change tokens (newEmail set); expiry doesn't matter — we still
    // want to be able to cancel.
    const [row] = await db
      .select({ userId: emailVerificationTokensTable.userId, token: emailVerificationTokensTable.token })
      .from(emailVerificationTokensTable)
      .where(eq(emailVerificationTokensTable.token, hashAuthToken(token)))
      .limit(1);

    if (!row || !tokenHashMatches(row.token, token)) {
      // Token doesn't exist (or was already confirmed/cleared) — treat as success.
      res.json({ ok: true });
      return;
    }

    // Drop every pending change/verification token for this user so the staged
    // change can no longer be confirmed.
    await db
      .delete(emailVerificationTokensTable)
      .where(eq(emailVerificationTokensTable.userId, row.userId));

    try {
      const uh = hashUserIdForLog(row.userId);
      if (uh) logger.info({ uh }, "Email change cancelled by user via security alert");
    } catch { /* logging must never crash the caller */ }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "cancel-email-change error");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ─── POST /auth/forgot-password ───────────────────────────────────────────────

router.post("/auth/forgot-password", async (req, res): Promise<void> => {
  const { email } = req.body ?? {};

  if (!email || typeof email !== "string") {
    res.status(400).json({ error: "A valid email address is required." });
    return;
  }

  const cleanEmail = email.toLowerCase().trim();

  // Always respond with success to prevent user enumeration
  res.json({ ok: true });

  // Do the heavy work asynchronously after responding
  try {
    const [user] = await db
      .select({ id: usersTable.id, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.email, cleanEmail))
      .limit(1);

    if (!user) {
      // No account — silently do nothing (already responded 200)
      return;
    }

    // Per-address cooldown: if a reset token was issued moments ago, skip the
    // send silently (the caller already got the generic success response).
    const [latestToken] = await db
      .select({ createdAt: passwordResetTokensTable.createdAt })
      .from(passwordResetTokensTable)
      .where(eq(passwordResetTokensTable.userId, user.id))
      .orderBy(desc(passwordResetTokensTable.createdAt))
      .limit(1);

    if (latestToken && Date.now() - latestToken.createdAt.getTime() < RESET_EMAIL_COOLDOWN_MS) {
      try {
        const uh = hashUserIdForLog(user.id);
        if (uh) logger.info({ uh }, "Password reset re-requested within cooldown — send skipped");
      } catch { /* logging must never crash the caller */ }
      return;
    }

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.insert(passwordResetTokensTable).values({
      token: hashAuthToken(token), // raw token exists only in the reset email
      userId: user.id,
      expiresAt,
    });

    const domain = getAppBaseUrl();
    const resetUrl = `${domain}/?resetToken=${token}`;
    const cancelUrl = `${domain}/?cancelReset=${token}`;

    // Send both, but never let one failure hide the other — and if the RESET
    // email failed, discard the token row so the per-address cooldown can't
    // silently swallow the user's retry (previously a single failed send
    // meant every attempt inside the cooldown window was skipped: the exact
    // "reset isn't letting me" dead end a tester hit).
    const [resetSend, alertSend] = await Promise.allSettled([
      sendPasswordResetEmail(user.email, resetUrl),
      sendSecurityAlertEmail(user.email, cancelUrl),
    ]);
    if (resetSend.status === "rejected") {
      await db
        .delete(passwordResetTokensTable)
        .where(eq(passwordResetTokensTable.token, hashAuthToken(token)));
      logger.error(
        { err: resetSend.reason },
        "Password-reset email FAILED — token discarded so the next attempt is not cooldown-blocked. If this repeats, check RESEND_API_KEY / sender domain.",
      );
    } else {
      try {
        const uh = hashUserIdForLog(user.id);
        if (uh) logger.info({ uh }, "Password reset email sent");
      } catch { /* logging must never crash the caller */ }
    }
    if (alertSend.status === "rejected") {
      logger.error({ err: alertSend.reason }, "Security-alert email failed (reset email unaffected)");
    }
  } catch (err) {
    logger.error({ err }, "forgot-password background error");
  }
});

// ─── POST /auth/reset-password ────────────────────────────────────────────────

router.post("/auth/reset-password", async (req, res): Promise<void> => {
  const { token, password } = req.body ?? {};

  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "Reset token is required." });
    return;
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    res.status(400).json({ error: "Password must be at least 8 characters." });
    return;
  }

  try {
    const now = new Date();

    // First, look up the token without any expiry/used filter so we can give
    // a precise error message (expired vs never-existed vs already used).
    const [anyRow] = await db
      .select()
      .from(passwordResetTokensTable)
      .where(eq(passwordResetTokensTable.token, hashAuthToken(token)))
      .limit(1);

    if (!anyRow || !tokenHashMatches(anyRow.token, token)) {
      res.status(400).json({
        error: "This reset link is invalid.",
        code: "TOKEN_INVALID",
      });
      return;
    }

    if (anyRow.usedAt !== null) {
      res.status(400).json({
        error: "This reset link has already been used. Please request a new one if you need to reset your password again.",
        code: "TOKEN_USED",
      });
      return;
    }

    if (anyRow.expiresAt <= now) {
      res.status(400).json({
        error: "This reset link has expired. Please request a new one.",
        code: "TOKEN_EXPIRED",
      });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // Atomically mark the token as used (conditional — guards against concurrent replay)
    const consumed = await pool.query<{ user_id: number }>(
      `UPDATE password_reset_tokens
          SET used_at = NOW()
        WHERE token = $1
          AND used_at IS NULL
          AND expires_at > NOW()
        RETURNING user_id`,
      [hashAuthToken(token)],
    );

    if (consumed.rowCount === 0) {
      // Another request beat us to it (race condition) — treat as expired
      res.status(400).json({
        error: "This reset link has expired. Please request a new one.",
        code: "TOKEN_EXPIRED",
      });
      return;
    }

    // Update the password now that we own the token
    await db
      .update(usersTable)
      .set({ hashedPassword })
      .where(eq(usersTable.id, anyRow.userId));

    // Invalidate all existing sessions for this user
    await pool.query(
      `DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = $1::text`,
      [String(anyRow.userId)],
    );

    try {
      const uh = hashUserIdForLog(anyRow.userId);
      if (uh) logger.info({ uh }, "Password reset successfully");
    } catch { /* logging must never crash the caller */ }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "reset-password error");
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ─── DELETE /auth/account ─────────────────────────────────────────────────────

router.delete("/auth/account", async (req, res): Promise<void> => {
  const userId = req.session?.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  // Acquire a dedicated client so we can issue BEGIN/COMMIT explicitly.
  // pool.query() does not support multiple statements in a single parameterised call.
  const client = await pool.connect();
  try {
    // Delete all user-owned data in a single transaction, ordered to respect FK constraints.
    //
    // ── DIRECT tables (have a typed `user_id` column, deleted by `user_id = $1`) ──
    //   password_reset_tokens, email_verification_tokens, messages, memory_facts,
    //   memory_feelings, personality_signals, wins, mood_scores, reminders, habit_completions,
    //   habits, goals, commitments, profile.
    //   The `users` row itself is deleted last, by its own PK (`id = $1`).
    //
    // ── INDIRECT tables (store the user's ID some other way) ─────────────────────
    // These do NOT have a `user_id` column, so a naive "delete every table with
    // a user_id column" sweep would miss them. Each must be handled here AND
    // registered in the INDIRECT_TABLES map in account-deletion.test.ts, whose
    // FK-graph guard fails the build if a new indirect table is added without
    // coverage. When you add a new indirect table, update BOTH places.
    //
    //   1. user_sessions — the user id lives inside the `sess` jsonb column
    //      (`sess->>'userId'`), not as a typed column. Deleted via the jsonb
    //      query below. (Registered with strategy "jsonb".)
    //   2. goal_tasks — has only a `goal_id` FK to `goals` (no `user_id`). Its
    //      rows ON DELETE CASCADE when the parent `goals` row is deleted, so we
    //      do NOT delete it explicitly; deleting `goals` clears it. (Registered
    //      with strategy "cascade".)
    // ── Paddle first (phase 2): a deleted account must never keep billing.
    // Cancellation is scheduled via Paddle's API BEFORE the wipe; if Paddle
    // is unreachable the deletion still proceeds (the user's right to erase
    // beats our bookkeeping) — the error is logged loudly so the founder can
    // cancel manually in the Paddle dashboard.
    try {
      const subRow = await client.query<{ paddle_subscription_id: string | null; status: string }>(
        `SELECT paddle_subscription_id, status FROM subscriptions WHERE user_id = $1`,
        [userId],
      );
      const paddleSubId = subRow.rows[0]?.paddle_subscription_id;
      const subStatus = subRow.rows[0]?.status;
      if (paddleSubId && subStatus !== "canceled") {
        const { cancelPaddleSubscription } = await import("../services/paddle.js");
        await cancelPaddleSubscription(paddleSubId);
        try {
          const uh = hashUserIdForLog(userId);
          if (uh) logger.info({ uh }, "Account deletion: Paddle subscription cancellation scheduled");
        } catch { /* logging must never crash the caller */ }
      }
    } catch (err) {
      try {
        const uh = hashUserIdForLog(userId);
        if (uh)
          logger.error(
            { err, uh },
            "Account deletion: PADDLE CANCEL FAILED — deletion proceeds; cancel this subscription " +
              "manually in the Paddle dashboard to stop future charges.",
          );
      } catch { /* logging must never crash the caller */ }
    }

    await client.query("BEGIN");
    await client.query(`DELETE FROM user_sessions WHERE sess::jsonb->>'userId' = $1::text`, [String(userId)]);
    await client.query(`DELETE FROM password_reset_tokens WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM email_verification_tokens WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM crisis_events     WHERE user_id = $1`, [userId]); // before messages (message_id FK)
    await client.query(`DELETE FROM messages          WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM memory_facts      WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM memory_feelings   WHERE user_id = $1`, [userId]); // Sprint 2C (also ON DELETE CASCADE, but explicit for parity)
    await client.query(`DELETE FROM reflection_reports WHERE user_id = $1`, [userId]); // (also ON DELETE CASCADE, but explicit for parity)
    await client.query(`DELETE FROM personality_signals WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM wins              WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM mood_scores       WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM reminders         WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM habit_completions WHERE habit_id IN (SELECT id FROM habits WHERE user_id = $1)`, [userId]);
    await client.query(`DELETE FROM habits            WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM goals             WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM commitments       WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM sealed_notes      WHERE user_id = $1`, [userId]); // before weekly_chapters (resolved_chapter_id FK)
    await client.query(`DELETE FROM weekly_chapters   WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM chapter_quote_dismissals WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM chapter_offer_events WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM story_threads     WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM push_subscriptions WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM push_events       WHERE user_id = $1`, [userId]);
    // billing_events is intentionally NOT deleted here: it holds provider
    // event ids only (no personal data) and is the processed-webhook audit
    // trail. The Paddle cancel call happened BEFORE this transaction (see
    // above) so a deleted account can never keep billing.
    await client.query(`DELETE FROM voice_usage       WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM subscriptions     WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM personalization_state WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM profile           WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM users             WHERE id = $1`, [userId]);
    await client.query("COMMIT");

    try {
      const uh = hashUserIdForLog(userId);
      if (uh) logger.info({ uh }, "Account deleted — all data wiped");
    } catch { /* logging must never crash the caller */ }

    // Destroy the session and clear the cookie before responding
    req.session.destroy((err) => {
      if (err) logger.error({ err }, "Session destroy error after account deletion");
      res.clearCookie("sid");
      res.json({ ok: true });
    });
  } catch (err) {
    logger.error({ err }, "Account deletion error");
    try { await client.query("ROLLBACK"); } catch {}
    res.status(500).json({ error: "Something went wrong. Please try again." });
  } finally {
    client.release();
  }
});

export default router;
